/** Decode only user-visible output; reasoning deltas never enter translations. */
export class TranslationFormatError extends Error {}
export class TranslationIncompleteError extends Error {}
export class TranslationServiceError extends Error {}
/** Tag failures at fetch/body-read boundaries, rather than retrying application TypeErrors. */
export class TranslationNetworkError extends Error {
  constructor(cause: TypeError) { super('翻译服务连接中断', { cause }); }
}

export interface TranslationUsage { input?: number; output?: number; total?: number }
export type TranslationWireApi = 'chat' | 'responses' | 'ollama';
const segmentMarker = /^\s*⟦SEG:(\d+)⟧\s*$/;

export class TranslationSegments {
  private pending = '';
  private raw = '';
  private current: number | null = null;
  private content = '';
  private marked = false;
  private seen = new Set<number>();
  private allowed: Set<number>;

  constructor(private ids: number[], private publish: (index: number, text: string) => void) {
    this.allowed = new Set(ids);
  }

  feed(text: string) {
    this.raw += text;
    this.pending += text;
    let end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end).replace(/\r$/, '');
      this.pending = this.pending.slice(end + 1);
      this.line(line);
    }
  }

  private commit() {
    if (this.current !== null && !this.seen.has(this.current)) {
      this.seen.add(this.current);
      this.publish(this.current, this.content.trim());
    }
    this.content = '';
  }

  private line(line: string) {
    const match = segmentMarker.exec(line);
    if (match) {
      this.marked = true;
      this.commit();
      const id = Number(match[1]);
      this.current = this.allowed.has(id) && !this.seen.has(id) ? id : null;
    } else if (this.current !== null) this.content += `${line}\n`;
  }

  /** The trailing segment is safe only after a normal protocol completion. */
  finish() {
    if (this.pending) { this.line(this.pending); this.pending = ''; }
    this.commit();
    if (this.marked) return;
    // A complete single output has an unambiguous ID even on older services.
    if (this.ids.length === 1) { this.publish(this.ids[0], this.raw.trim()); return; }
    // Accept an already-completed legacy JSON/SSE response without a second call.
    const legacy = this.raw.trim().split(/\s*⟦SEG⟧\s*/);
    if (legacy.length === this.ids.length) legacy.forEach((text, i) => this.publish(this.ids[i], text.trim()));
  }
}

async function* responseLines(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new TranslationFormatError('翻译服务没有返回响应内容');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch (error) {
        if (error instanceof TypeError) throw new TranslationNetworkError(error);
        throw error;
      }
      const { value, done } = chunk;
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        yield pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
      }
      if (done) { if (pending) yield pending; return; }
    }
  } finally {
    try { await reader.cancel(); } catch { /* The owning AbortSignal may already have closed it. */ }
    reader.releaseLock();
  }
}

function jsonValue(text: string): any {
  try { return JSON.parse(text); }
  catch { throw new TranslationFormatError('翻译服务返回了无效的 JSON 数据'); }
}
function visibleContent(value: any): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(part => part?.type === 'text').map(part => part.text ?? '').join('');
}
function responseText(value: any): string {
  if (typeof value?.output_text === 'string') return value.output_text;
  return (value?.output ?? []).filter((item: any) => item.type === 'message')
    .flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === 'output_text')
    .map((part: any) => part.text ?? '').join('');
}
function usageOf(value: any): TranslationUsage | undefined {
  const usage = value?.usage;
  const input = usage?.input_tokens ?? usage?.prompt_tokens ?? value?.prompt_eval_count;
  const output = usage?.output_tokens ?? usage?.completion_tokens ?? value?.eval_count;
  const total = usage?.total_tokens;
  const result: TranslationUsage = {};
  if (typeof input === 'number') result.input = input;
  if (typeof output === 'number') result.output = output;
  if (typeof total === 'number') result.total = total;
  return Object.keys(result).length ? result : undefined;
}
function ensureNormal(reason: unknown) {
  if (reason && reason !== 'stop' && reason !== 'end_turn') {
    throw new TranslationIncompleteError('翻译响应未正常完成，已保留完整段落');
  }
}

function completeJson(json: any, api: TranslationWireApi, segments: TranslationSegments,
  onUsage?: (usage: TranslationUsage) => void): TranslationUsage | undefined {
  const usage = usageOf(json);
  if (usage) onUsage?.(usage);
  if (json?.error || json?.status === 'failed') throw new TranslationServiceError('翻译服务返回了错误响应');
  if (api === 'responses') {
    segments.feed(responseText(json));
    if ((json?.status && json.status !== 'completed') || json?.incomplete_details) throw new TranslationIncompleteError('翻译响应未完成，已保留完整段落');
  } else if (api === 'ollama') {
    segments.feed(visibleContent(json?.message?.content));
    ensureNormal(json?.done_reason);
    if (json?.done === false) throw new TranslationIncompleteError('翻译响应未完成，已保留完整段落');
  } else {
    segments.feed(visibleContent(json?.choices?.[0]?.message?.content));
    ensureNormal(json?.choices?.[0]?.finish_reason);
  }
  segments.finish();
  return usage;
}

export async function consumeTranslationResponse(response: Response, api: TranslationWireApi, segments: TranslationSegments,
  onUsage?: (usage: TranslationUsage) => void): Promise<TranslationUsage | undefined> {
  const type = response.headers.get('content-type')?.toLowerCase() ?? '';
  const sse = type.includes('text/event-stream');
  const ndjson = type.includes('ndjson') || type.includes('jsonl');
  if (!sse && !ndjson) {
    let text: string;
    try { text = await response.text(); }
    catch (error) {
      if (error instanceof TypeError) throw new TranslationNetworkError(error);
      throw error;
    }
    return completeJson(jsonValue(text), api, segments, onUsage);
  }

  let completed = false;
  let deltas = false;
  let usage: TranslationUsage | undefined;
  const event = (data: string) => {
    if (!data.trim()) return;
    if (data.trim() === '[DONE]') { if (api === 'chat') completed = true; return; }
    const json = jsonValue(data);
    const latestUsage = usageOf(json?.response ?? json);
    if (latestUsage) { usage = latestUsage; onUsage?.(usage); }
    if (json?.error || json?.type === 'error' || json?.type === 'response.failed') {
      throw new TranslationServiceError('翻译服务流返回了错误响应');
    }
    if (api === 'responses') {
      if (json.type === 'response.output_text.delta' && typeof json.delta === 'string') {
        segments.feed(json.delta); deltas = true;
      } else if (json.type === 'response.output_text.done' && !deltas && typeof json.text === 'string') {
        segments.feed(json.text); deltas = true;
      } else if (json.type === 'response.completed') {
        if (json.response?.status && json.response.status !== 'completed') throw new TranslationIncompleteError('翻译响应未完成');
        if (!deltas) segments.feed(responseText(json.response));
        completed = true;
      } else if (json.type === 'response.incomplete') throw new TranslationIncompleteError('翻译响应被截断，已保留完整段落');
    } else if (api === 'ollama') {
      if (typeof json?.message?.content === 'string') segments.feed(json.message.content);
      if (json.done) { ensureNormal(json.done_reason); completed = true; }
    } else {
      const choice = json?.choices?.[0];
      if (choice) {
        const text = visibleContent(choice.delta?.content);
        if (text) segments.feed(text);
        ensureNormal(choice.finish_reason);
        if (choice.finish_reason === 'stop' || choice.finish_reason === 'end_turn') completed = true;
      }
    }
  };

  if (ndjson) {
    for await (const line of responseLines(response)) {
      if (line.trim()) event(line);
      if (completed) break;
    }
  } else {
    let data: string[] = [];
    for await (const line of responseLines(response)) {
      if (!line) {
        if (data.length) { event(data.join('\n')); data = []; }
        if (completed) break;
      } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) event(data.join('\n'));
  }
  if (!completed) throw new TranslationIncompleteError('翻译连接提前结束，已保留完整段落');
  segments.finish();
  return usage;
}
