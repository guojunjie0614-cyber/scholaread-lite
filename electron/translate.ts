import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProviderConfig, TranslateResult, TranslationPriority, TranslationOrigin, CachedTranslation, TranslationFailure } from '../shared/types.js';
import { settings } from './settings.js';
import { translations } from './db.js';
import { legacyTranslationSource, protectTranslationMath, restoreCachedTranslationMath, translatedRuns } from '../shared/translation-scripts.js';
import { MAGPIE_BASE_URL, magpieBaseUrl, magpieReasoningEffort } from './magpie.js';
import {
  consumeTranslationResponse, TranslationSegments, TranslationFormatError, TranslationIncompleteError, TranslationNetworkError,
  type TranslationUsage, type TranslationWireApi,
} from './translation-stream.js';

const LANG_NAMES: Record<string, string> = {
  'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語', ko: '한국어',
  de: 'Deutsch', fr: 'Français', es: 'Español', ru: 'Русский',
};
const MAX_CHARS_PER_REQUEST = 5000;
export type BackendTranslationOptions = {
  getPriority?: () => TranslationPriority;
  onSegment?: (index: number, text: string, origin?: TranslationOrigin) => void;
  refresh?: boolean;
};

export class TranslationBatchFailure extends Error {
  constructor(message: string, readonly result: TranslateResult) { super(message); }
}
export class TranslateError extends Error {
  constructor(message: string, readonly provider: string, options?: ErrorOptions) { super(message, options); }
}
export class TranslationHttpError extends TranslateError {
  constructor(provider: string, readonly status: number, readonly retryAfter: string | null, readonly detail?: string) {
    super(
      detail ? `${provider} 接口返回 ${status}：${detail}` : `${provider} 接口返回 ${status}，请检查服务设置或稍后重试`,
      provider,
    );
  }
}

async function readHttpErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const raw = (await response.text()).trim();
    if (!raw) return undefined;
    try {
      const json = JSON.parse(raw);
      const msg = json?.error?.message ?? (typeof json?.error === 'string' ? json.error : undefined) ?? json?.message ?? json?.detail;
      if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 300);
    } catch { /* fall back to plain text */ }
    return raw.replace(/\s+/g, ' ').slice(0, 300);
  } catch {
    return undefined;
  }
}
const hashOf = (provider: string, model: string, target: string, text: string) =>
  createHash('sha256').update(`${provider}|${model}|${target}|${text}`).digest('hex');

const contentHash = (target: string, source: string) => createHash('sha256').update(JSON.stringify([target, source])).digest('hex');

/** Adopt legacy results lazily, preserving their provider/model and selected version. */
export function readCachedTranslations(texts: string[], target: string): (CachedTranslation | null)[] {
  return texts.map(source => {
    const key = contentHash(target, source);
    let legacy: string;
    try { legacy = legacyTranslationSource(source); } catch { return null; }
    for (const candidateSource of legacy === source ? [source] : [source, legacy]) {
      for (const hit of translations.candidates(contentHash(target, candidateSource), target, candidateSource)) {
        if (!hit.result.trim()) continue;
        let text: string;
        try { text = restoreCachedTranslationMath(source, hit.result); } catch { continue; }
        // Adopt under the new geometry-aware key, leaving the legacy record intact.
        const hash = candidateSource === source ? hit.hash : hashOf(hit.provider, hit.model, target, source);
        if (candidateSource !== source) translations.set(hash, target, hit.provider, hit.model, source, text);
        translations.choose(key, hash);
        return { text, provider: hit.provider, model: hit.model };
      }
    }
    return null;
  });
}
class TranslationTimeoutError extends Error {
  constructor(phase: 'queue' | 'request') { super(phase === 'queue' ? '翻译排队超时，请重试' : '翻译响应超时，已保留完成段落，请重试'); }
}

const priorityRank: Record<TranslationPriority, number> = { interactive: 3, visible: 2, background: 1 };
type QueuedRequest = { getPriority: () => TranslationPriority; start: () => void };
const activeRequests = new Set<QueuedRequest>();
const requestQueue: QueuedRequest[] = [];

/** Re-read priorities after navigation and reserve capacity for foreground work. */
export function refreshTranslationQueue(): void {
  const cap = settings.get().translate.concurrency ?? 4;
  const backgroundCap = Math.max(1, cap - 1);
  while (activeRequests.size < cap && requestQueue.length) {
    requestQueue.sort((a, b) => priorityRank[b.getPriority()] - priorityRank[a.getPriority()]);
    const backgroundActive = [...activeRequests].filter(entry => entry.getPriority() === 'background').length;
    const next = requestQueue.findIndex(entry => entry.getPriority() !== 'background' || backgroundActive < backgroundCap);
    if (next < 0) return;
    requestQueue.splice(next, 1)[0].start();
  }
}

interface Timing {
  id: number; started: number; provider: string; model: string; queueMs: number;
  headersMs: number[]; firstSegmentMs?: number; cacheHits: number; retries: number;
  rateLimits: number; formatRecoveries: number; requestCount: number; usage: TranslationUsage;
}
let nextTrace = 0;
const elapsed = (start: number) => Math.round(performance.now() - start);
function observe(timing: Timing, event: string, fields: Record<string, unknown>) {
  console.info('[translation]', { event, trace: timing.id, provider: timing.provider, model: timing.model, ...fields });
}
async function requestSlot<T>(signal: AbortSignal, getPriority: () => TranslationPriority, timing: Timing, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const queuedAt = performance.now();
  const waitingSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  let entry: QueuedRequest;
  await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      const index = requestQueue.indexOf(entry);
      if (index >= 0) requestQueue.splice(index, 1);
      timing.queueMs += elapsed(queuedAt);
      reject(signal.aborted ? signal.reason : new TranslationTimeoutError('queue'));
      refreshTranslationQueue();
    };
    entry = { getPriority, start: () => {
      waitingSignal.removeEventListener('abort', cancel);
      activeRequests.add(entry);
      timing.queueMs += elapsed(queuedAt);
      resolve();
    } };
    requestQueue.push(entry);
    waitingSignal.addEventListener('abort', cancel, { once: true });
    refreshTranslationQueue();
  });
  try { signal.throwIfAborted(); return await work(); }
  finally { activeRequests.delete(entry!); refreshTranslationQueue(); }
}
function addUsage(timing: Timing, usage?: TranslationUsage) {
  if (!usage) return;
  for (const name of ['input', 'output', 'total'] as const) {
    if (usage[name] !== undefined) timing.usage[name] = (timing.usage[name] ?? 0) + usage[name]!;
  }
}

async function providerRequest<T>(url: string, init: RequestInit, provider: string, signal: AbortSignal,
  getPriority: () => TranslationPriority, timing: Timing, consume: (response: Response) => Promise<T>): Promise<T> {
  return requestSlot(signal, getPriority, timing, async () => {
    const started = performance.now();
    const request = ++timing.requestCount;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
    let response: Response;
    try { response = await fetch(url, { ...init, signal: requestSignal }); }
    catch (error) {
      if (!signal.aborted && requestSignal.aborted) throw new TranslationTimeoutError('request');
      if (error instanceof TypeError) throw new TranslationNetworkError(error);
      throw error;
    }
    const headersMs = elapsed(started);
    timing.headersMs.push(headersMs);
    observe(timing, 'headers', { request, headersMs, status: response.status, priority: getPriority() });
    if (!response.ok) {
      if (response.status === 429) timing.rateLimits++;
      const detail = await readHttpErrorDetail(response);
      observe(timing, 'http-error', { request, status: response.status, ...(detail ? { detail } : {}) });
      throw new TranslationHttpError(provider, response.status, response.headers.get('retry-after'), detail);
    }
    try { return await consume(response); }
    catch (error) {
      if (!signal.aborted && requestSignal.aborted) throw new TranslationTimeoutError('request');
      throw error;
    }
  });
}
function systemPrompt(target: string): string {
  return [
    `你是学术文献的翻译引擎。把用户给出的每一段学术文本翻译成${LANG_NAMES[target] ?? target}。`,
    '1. 保持专业术语准确，首次出现可保留英文原词并附译名。',
    '2. 数学符号、变量、公式和引用标记原样保留。',
    '3. 每段输入以单独一行 ⟦SEG:数字⟧ 开始。输出必须先原样写该段标记，再换行写译文；每个标记只输出一次，数字不得更改、增删或重新编号。',
    '4. 不要合并段落，不要输出原文、解释、总结或代码围栏。',
    '5. <sub>...</sub> 和 <sup>...</sup> 是科学上下标，标签、内部字符和出现顺序必须逐字保留。',
    '6. ⟦SLMATH:段号:序号⟧ 是已保护的数学内容。必须逐字保留，每个仅出现一次，保持顺序，不翻译、不展开、不猜测其内容。',
  ].join('\n');
}
const markedInput = (texts: string[], ids: number[]) => ids.map(id => `⟦SEG:${id}⟧\n${texts[id]}`).join('\n');

interface ProviderContext {
  provider: string; model: string; cfg: ProviderConfig; target: string; signal: AbortSignal;
  getPriority: () => TranslationPriority; timing: Timing; publish: (index: number, text: string) => void;
}
async function llmRequest(texts: string[], ids: number[], context: ProviderContext): Promise<void> {
  const { provider, cfg, target, signal, getPriority, timing, publish } = context;
  let url: string;
  let payload: Record<string, unknown>;
  let api: TranslationWireApi;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const input = markedInput(texts, ids);
  if (provider === 'ollama') {
    api = 'ollama';
    url = `${(cfg.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')}/api/chat`;
    payload = { model: context.model, stream: true, options: { temperature: cfg.temperature ?? 0.2 },
      messages: [{ role: 'system', content: systemPrompt(target) }, { role: 'user', content: input }] };
  } else {
    const magpie = provider === 'magpie';
    const baseUrl = magpie ? magpieBaseUrl(cfg.baseUrl ?? MAGPIE_BASE_URL) : (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    if (!context.model.trim()) throw new TranslateError('请先在设置 → 翻译服务中选择模型', provider);
    if (!magpie && !cfg.apiKey) throw new TranslateError(`${provider} 未配置 API Key（设置 → 翻译）`, provider);
    if (!magpie) headers.authorization = `Bearer ${cfg.apiKey}`;
    const effort = magpie ? magpieReasoningEffort(cfg) : cfg.reasoningEffort === 'default' ? undefined : cfg.reasoningEffort;
    api = cfg.api === 'responses' ? 'responses' : 'chat';
    url = `${baseUrl}/${api === 'responses' ? 'responses' : 'chat/completions'}`;
    payload = api === 'responses'
      ? { model: context.model, stream: true, ...(effort ? { reasoning: { effort } } : {}), instructions: systemPrompt(target), input }
      : { model: context.model, stream: true, temperature: cfg.temperature ?? 0.2,
        ...(effort ? { reasoning_effort: effort } : {}),
        messages: [{ role: 'system', content: systemPrompt(target) }, { role: 'user', content: input }] };
  }
  const segments = new TranslationSegments(ids, publish);
  let usage: TranslationUsage | undefined;
  try {
    try {
      await providerRequest(url, { method: 'POST', headers, body: JSON.stringify(payload) }, provider,
        signal, getPriority, timing, response => consumeTranslationResponse(response, api, segments, value => { usage = value; }));
    } catch (error) {
      const hasOptionalParams = payload.temperature !== undefined || payload.reasoning_effort !== undefined || payload.reasoning !== undefined;
      if (error instanceof TranslationHttpError && error.status === 400 && hasOptionalParams && provider !== 'ollama') {
        const fallbackPayload = { ...payload };
        delete fallbackPayload.temperature;
        delete fallbackPayload.reasoning_effort;
        delete fallbackPayload.reasoning;
        timing.retries++;
        observe(timing, 'retry-without-optional-params', { status: 400, ...(error.detail ? { detail: error.detail } : {}) });
        await providerRequest(url, { method: 'POST', headers, body: JSON.stringify(fallbackPayload) }, provider,
          signal, getPriority, timing, response => consumeTranslationResponse(response, api, segments, value => { usage = value; }));
      } else {
        throw error;
      }
    }
  } finally { addUsage(timing, usage); }
}

async function textApiRequest(texts: string[], ids: number[], context: ProviderContext): Promise<void> {
  const { provider, cfg, target, signal, getPriority, timing, publish } = context;
  if (!cfg.apiKey) throw new TranslateError(`${provider} 未配置 API Key`, provider);
  let url: string;
  const headers: Record<string, string> = {};
  const body = new URLSearchParams();
  if (provider === 'deepl') {
    url = cfg.endpoint ?? 'https://api-free.deepl.com/v2/translate';
    headers.authorization = `DeepL-Auth-Key ${cfg.apiKey}`;
    headers['content-type'] = 'application/x-www-form-urlencoded';
    ids.forEach(id => body.append('text', texts[id]));
    body.append('target_lang', target.toUpperCase().startsWith('ZH') ? 'ZH' : target.toUpperCase());
  } else {
    const endpoint = new URL('https://translation.googleapis.com/language/translate/v2');
    endpoint.searchParams.set('key', cfg.apiKey);
    url = endpoint.toString();
    ids.forEach(id => body.append('q', texts[id]));
    body.append('target', target); body.append('format', 'text');
  }
  const json = await providerRequest(url, { method: 'POST', headers, body }, provider, signal, getPriority, timing,
    async response => {
      try { return await response.json(); }
      catch (error) {
        if (error instanceof SyntaxError) throw new TranslationFormatError('翻译服务返回了无效的 JSON 响应');
        if (error instanceof TypeError) throw new TranslationNetworkError(error);
        throw error;
      }
    });
  const results = provider === 'deepl' ? json?.translations?.map((part: any) => part.text)
    : json?.data?.translations?.map((part: any) => part.translatedText);
  if (!Array.isArray(results) || results.length !== ids.length) throw new TranslationFormatError('翻译服务返回的段落数量不匹配');
  results.forEach((text, i) => { if (typeof text === 'string') publish(ids[i], text); });
}
async function callProvider(texts: string[], ids: number[], context: ProviderContext): Promise<void> {
  context.signal.throwIfAborted();
  if (context.provider === 'echo') ids.forEach(id => context.publish(id, `〔译〕${texts[id]}`));
  else if (context.provider === 'deepl' || context.provider === 'google') await textApiRequest(texts, ids, context);
  else await llmRequest(texts, ids, context);
}

function chunksFor(ids: number[], texts: string[], maxChars = MAX_CHARS_PER_REQUEST, maxCount = Infinity): number[][] {
  const chunks: number[][] = [];
  let current: number[] = [], size = 0;
  ids.forEach(id => {
    if (current.length && (size + texts[id].length > maxChars || current.length >= maxCount)) {
      chunks.push(current); current = []; size = 0;
    }
    current.push(id); size += texts[id].length;
  });
  if (current.length) chunks.push(current);
  return chunks;
}
function retryDelay(error: unknown): number | null {
  if (error instanceof TranslationHttpError) {
    if (error.status !== 429 && error.status < 500) return null;
    const value = error.retryAfter;
    if (!value) return 500;
    const seconds = Number(value);
    const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    if (milliseconds > 10_000) return null;
    return Number.isFinite(milliseconds) ? Math.max(500, milliseconds) : 500;
  }
  return error instanceof TranslationNetworkError ? 500 : null;
}

async function performBatch(texts: string[], target: string, provider: string, model: string, cfg: ProviderConfig,
  signal: AbortSignal, getPriority: () => TranslationPriority, publish: (index: number, text: string, origin?: TranslationOrigin) => void, refresh = false): Promise<TranslateResult> {
  const timing: Timing = { id: ++nextTrace, started: performance.now(), provider, model, queueMs: 0, headersMs: [],
    cacheHits: 0, retries: 0, rateLimits: 0, formatRecoveries: 0, requestCount: 0, usage: {} };
  const deadline = AbortSignal.timeout(600_000);
  const combined = AbortSignal.any([signal, deadline]);
  const out = new Array<string>(texts.length).fill('');
  const origins: (TranslationOrigin | null)[] = texts.map(() => null);
  const pending = new Set<number>();
  const invalid = new Set<number>();
  const validationErrors = new Map<number, string>();
  const sourceErrors = new Map<number, string>();
  const protectedTexts = texts.map((text, index) => {
    try { return protectTranslationMath(text, index); }
    catch (error) { sourceErrors.set(index, error instanceof Error ? error.message : String(error)); return null; }
  });
  const wireTexts = protectedTexts.map((value, index) => value?.text ?? texts[index]);
  let status = 'failed';
  const commit = (index: number, value: string) => {
    combined.throwIfAborted();
    if (!pending.has(index)) return;
    const text = value.trim();
    try {
      if (!text) throw new TranslationFormatError('翻译结果缺少段落');
      translatedRuns(texts[index], text);
    } catch (error) { invalid.add(index); validationErrors.set(index, error instanceof Error ? error.message : String(error)); return; }
    const hash = hashOf(provider, model, target, texts[index]);
    translations.set(hash, target, provider, model, texts[index], text);
    if (provider !== 'echo') translations.choose(contentHash(target, texts[index]), hash);
    origins[index] = { provider, model };
    out[index] = text; pending.delete(index); invalid.delete(index); validationErrors.delete(index);
    if (timing.firstSegmentMs === undefined) timing.firstSegmentMs = elapsed(timing.started);
    publish(index, text, origins[index]!);
  };
  const context: ProviderContext = { provider, model, cfg, target, signal: combined, getPriority, timing, publish(index, value) {
    let restored: string;
    try { restored = protectedTexts[index]!.restore(value); }
    catch (error) { combined.throwIfAborted(); invalid.add(index); validationErrors.set(index, error instanceof Error ? error.message : String(error)); return; }
    commit(index, restored);
  } };
  try {
    combined.throwIfAborted();
    const hits = provider === 'echo' || refresh ? texts.map(() => null) : readCachedTranslations(texts, target);
    texts.forEach((text, index) => {
      if (!text.trim()) return;
      if (sourceErrors.has(index)) { pending.add(index); return; }
      const hit = hits[index];
      if (hit) {
        out[index] = hit.text; origins[index] = { provider: hit.provider, model: hit.model }; timing.cacheHits++;
        if (timing.firstSegmentMs === undefined) timing.firstSegmentMs = elapsed(timing.started);
        publish(index, hit.text, origins[index]!);
      } else pending.add(index);
    });
    const cached = pending.size === 0;
    for (const ids of chunksFor([...pending].filter(index => !sourceErrors.has(index)), wireTexts)) {
      let error: unknown;
      try { await callProvider(wireTexts, ids, context); }
      catch (caught) { combined.throwIfAborted(); error = caught; }
      const missing = ids.filter(id => pending.has(id));
      if (!missing.length) continue;
      const http400Split = error instanceof TranslationHttpError && error.status === 400 && missing.length > 1;
      const formatIssue = error === undefined || error instanceof TranslationFormatError || error instanceof TranslationIncompleteError || http400Split;
      const backoff = formatIssue ? null : retryDelay(error);
      if (!formatIssue && backoff === null) throw error;
      let groups: number[][];
      if (formatIssue) {
        timing.formatRecoveries++;
        observe(timing, 'format-recovery', { remaining: missing.length, invalid: invalid.size });
        // Keep confirmed paragraphs and recover only missing IDs in smaller parallel groups.
        groups = chunksFor(missing, wireTexts, 2500, http400Split ? 1 : Math.max(1, Math.ceil(missing.length / 2)));
      } else {
        timing.retries++;
        observe(timing, 'retry', { remaining: missing.length, waitMs: backoff,
          ...(error instanceof TranslationHttpError ? { status: error.status } : {}) });
        await delay(backoff!, undefined, { signal: combined });
        groups = [missing];
      }
      const recovered = await Promise.allSettled(groups.map(async group => {
        await callProvider(wireTexts, group, context);
        if (group.some(id => pending.has(id))) {
          const invalidId = group.find(id => pending.has(id) && validationErrors.has(id));
          throw new TranslationFormatError(invalidId !== undefined ? validationErrors.get(invalidId)! : '翻译结果缺少段落，请重试');
        }
      }));
      combined.throwIfAborted();
      const failure = recovered.find((item): item is PromiseRejectedResult => item.status === 'rejected');
      if (failure) throw failure.reason;
    }
    if (sourceErrors.size) throw new Error([...sourceErrors.values()][0]);
    status = 'completed';
    return { results: out, provider, model, cached, origins };
  } catch (error) {
    if (signal.aborted) { status = 'cancelled'; throw signal.reason; }
    if (deadline.aborted) status = 'timeout';
    const retryAfterMs = error instanceof TranslationTimeoutError ? 1000 : retryDelay(error);
    const retryable = !deadline.aborted && (retryAfterMs !== null || error instanceof TranslationFormatError || error instanceof TranslationIncompleteError);
    const message = deadline.aborted ? '翻译任务等待过久，已保留完成段落，请重试'
      : error instanceof TranslationNetworkError ? `${provider} 请求失败，请检查网络或稍后重试`
      : error instanceof Error ? error.message : String(error);
    const failures: TranslationFailure[] = texts.flatMap((text, index) => text.trim() && !out[index]
      ? [{ index, message: sourceErrors.get(index) ?? validationErrors.get(index) ?? message, retryable: sourceErrors.has(index) ? false : retryable,
        ...(!sourceErrors.has(index) && retryAfterMs !== null ? { retryAfterMs } : {}) }] : []);
    throw new TranslationBatchFailure(message, { results: out, provider, model, cached: false, origins, failures });
  } finally {
    observe(timing, 'complete', { status, totalMs: elapsed(timing.started), queueMs: timing.queueMs,
      responseHeadersMs: timing.headersMs, firstValidatedSegmentMs: timing.firstSegmentMs,
      segments: texts.length, completed: texts.filter((text, index) => text.trim() && out[index]).length,
      cacheHits: timing.cacheHits, requests: timing.requestCount, retries: timing.retries,
      rateLimits: timing.rateLimits, formatRecoveries: timing.formatRecoveries,
      ...(Object.keys(timing.usage).length ? { tokens: timing.usage } : {}) });
  }
}

type Consumer = { options: BackendTranslationOptions };
type Flight = {
  controller: AbortController; promise: Promise<TranslateResult>; consumers: Set<Consumer>;
  segments: Map<number, { text: string; origin?: TranslationOrigin }>; settled: boolean;
};
const inFlight = new Map<string, Flight>();
function notify(consumer: Consumer, index: number, text: string, origin?: TranslationOrigin) {
  try { consumer.options.onSegment?.(index, text, origin); }
  catch { console.warn('[translation] 完成段落通知未能送达消费者'); }
}

/** Share work and replay validated segments without sharing consumer cancellation. */
export function translateBatch(texts: string[], targetOverride?: string, signal?: AbortSignal,
  options: BackendTranslationOptions = {}): Promise<TranslateResult> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const s = settings.get();
  const provider = s.translate.activeProvider;
  const target = targetOverride ?? s.targetLang;
  const cfg = { ...s.translate.providers[provider] };
  const source = [...texts];
  const model = cfg.model ?? (provider === 'ollama' ? 'qwen2.5:7b' : provider === 'echo' || provider === 'deepl' || provider === 'google' ? provider : provider === 'magpie' ? '' : 'gpt-4o-mini');
  const key = JSON.stringify([provider, cfg, target, source, options.refresh === true]);
  let flight = inFlight.get(key);
  if (!flight) {
    const controller = new AbortController();
    const consumers = new Set<Consumer>();
    const segments = new Map<number, { text: string; origin?: TranslationOrigin }>();
    const getPriority = (): TranslationPriority => {
      let priority: TranslationPriority = 'background';
      for (const consumer of consumers) {
        const candidate = consumer.options.getPriority?.() ?? 'interactive';
        if (priorityRank[candidate] > priorityRank[priority]) priority = candidate;
      }
      return priority;
    };
    const publish = (index: number, text: string, origin?: TranslationOrigin) => {
      segments.set(index, { text, origin });
      for (const consumer of consumers) notify(consumer, index, text, origin);
    };
    flight = { controller, consumers, segments, settled: false,
      promise: Promise.resolve().then(() => performBatch(source, target, provider, model, cfg, controller.signal, getPriority, publish, options.refresh)) };
    inFlight.set(key, flight);
    const current = flight;
    const finish = () => { current.settled = true; if (inFlight.get(key) === current) inFlight.delete(key); };
    current.promise.then(finish, finish);
  }
  const current = flight;
  const consumer: Consumer = { options };
  current.consumers.add(consumer);
  return new Promise((resolve, reject) => {
    let finished = false;
    const leave = () => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener('abort', abort);
      current.consumers.delete(consumer);
      refreshTranslationQueue();
      return true;
    };
    const abort = () => {
      if (!leave()) return;
      reject(signal!.reason);
      if (!current.consumers.size && !current.settled) {
        if (inFlight.get(key) === current) inFlight.delete(key);
        current.controller.abort();
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    for (const [index, segment] of current.segments) {
      if (finished) break;
      notify(consumer, index, segment.text, segment.origin);
    }
    current.promise.then(value => { if (leave()) resolve(value); }, error => { if (leave()) reject(error); });
    if (signal?.aborted) abort();
    refreshTranslationQueue();
  });
}
