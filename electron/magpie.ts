import { z } from 'zod';
import type { ProviderConfig, ProviderModel } from '../shared/types.js';
import { modelReasoningLevels } from '../shared/model-reasoning.js';
import { appFetch } from './http.js';

const MagpieModelEntrySchema = z.object({
  id: z.string().optional(),
  magpie_label: z.string().optional(),
  display_name: z.string().optional(),
  native_endpoints: z.array(z.unknown()).optional(),
  reasoning: z.boolean().optional(),
  reasoning_levels: z.array(z.unknown()).optional(),
}).passthrough();

const MagpieCatalogueSchema = z.object({ data: z.array(z.unknown()) }).passthrough();

const OllamaModelEntrySchema = z.object({
  name: z.string().optional(),
  model: z.string().optional(),
  id: z.string().optional(),
}).passthrough();

const OllamaModelsSchema = z.union([
  z.object({ models: z.array(z.unknown()) }),
  z.object({ data: z.array(z.unknown()) }),
]);

const OpenAIModelEntrySchema = z.union([
  z.string(),
  z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    display_name: z.string().optional(),
    label: z.string().optional(),
  }).passthrough(),
]);

const OpenAIModelsSchema = z.union([
  z.object({ data: z.array(z.unknown()) }),
  z.object({ models: z.array(z.unknown()) }),
]);

const ProviderErrorSchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string().optional() }).passthrough()]).optional(),
  message: z.string().optional(),
  detail: z.string().optional(),
}).passthrough();

export const MAGPIE_BASE_URL = 'http://127.0.0.1:3425/v1';
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const modelCatalogues = new Map<string, ProviderModel[]>();
const probedBaseUrls = new Map<string, string>();
const ENDPOINT_SUFFIX_RE = /(?:\/chat\/completions|\/completions|\/responses|\/models)+$/i;
const OLLAMA_SUFFIX_RE = /(?:\/api\/chat|\/api\/tags|\/v1\/chat\/completions|\/v1\/models|\/models|\/v1)+$/i;

function isLoopbackHost(hostname: string): boolean {
  const clean = hostname.toLowerCase();
  return clean === '127.0.0.1' || clean === 'localhost' || clean === '::1' || clean === '[::1]' ||
    clean.endsWith('.localhost') || clean.endsWith('.local');
}

function parseCleanHttpUrl(raw: string, fallback: string, displayLabel: string): URL {
  let url: URL;
  try {
    url = new URL((raw.trim() || fallback).trim());
  } catch {
    throw new Error(`请输入有效的 ${displayLabel}地址，例如 ${fallback}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${displayLabel}地址必须是无账号、查询参数和片段的 HTTP(S) 地址`);
  }
  return url;
}

export function magpieBaseUrl(value: string): string {
  if (!value.trim()) {
    throw new Error('请输入有效的 Magpie 网关地址，例如 http://127.0.0.1:3425/v1');
  }
  const url = parseCleanHttpUrl(value, MAGPIE_BASE_URL, 'Magpie 网关');
  const strippedPath = url.pathname.replace(/\/+$/, '').replace(ENDPOINT_SUFFIX_RE, '').replace(/\/+$/, '');
  url.pathname = strippedPath || '/v1';
  return url.toString().replace(/\/+$/, '');
}

/** Canonicalize Ollama service root URL across settings, model discovery, and chat streaming. */
export function ollamaBaseUrl(raw = ''): string {
  const url = parseCleanHttpUrl(raw, OLLAMA_BASE_URL, 'Ollama 接口');
  const strippedPath = url.pathname.replace(/\/+$/, '').replace(OLLAMA_SUFFIX_RE, '').replace(/\/+$/, '');
  url.pathname = strippedPath;
  return url.toString().replace(/\/+$/, '');
}

/** Record a live-verified base URL for a bare-origin OpenAI-compatible gateway. */
export function pinProbedBaseUrl(verifiedBaseUrl: string): void {
  try {
    const url = new URL(verifiedBaseUrl);
    probedBaseUrls.set(url.origin, verifiedBaseUrl.replace(/\/+$/, ''));
  } catch {
    /* Ignore malformed probe URLs */
  }
}

/**
 * Return ordered candidate base URLs `[primary, fallback?]` for an OpenAI-compatible provider.
 * Explicit paths (e.g. `/v1`, `/api/v1`, `/api/paas/v4`) produce one exact candidate;
 * bare origins without a path produce `[primary, alternate]` so `/models` and `/v1/models`
 * can be contract-probed without hardcoded vendor domain lists.
 */
export function openaiCompatibleBaseCandidates(
  raw: string,
  fallback = 'https://api.openai.com/v1',
  label = 'OpenAI 兼容接口',
): string[] {
  const displayLabel = label.endsWith('接口') || label.endsWith('网关') || label.endsWith('服务') ? label : `${label} 接口`;
  const trimmedRaw = raw.trim();
  const url = parseCleanHttpUrl(trimmedRaw, fallback, displayLabel);
  const strippedPath = url.pathname.replace(/\/+$/, '').replace(ENDPOINT_SUFFIX_RE, '').replace(/\/+$/, '');
  if (strippedPath) {
    url.pathname = strippedPath;
    return [url.toString().replace(/\/+$/, '')];
  }
  if (!trimmedRaw) {
    url.pathname = /\/v1\/?$/i.test(fallback) ? '/v1' : '';
    return [url.toString().replace(/\/+$/, '')];
  }
  const pinned = probedBaseUrls.get(url.origin);
  const rootBase = url.origin;
  const v1Base = `${url.origin}/v1`;
  if (pinned === rootBase) return [rootBase, v1Base];
  if (pinned === v1Base) return [v1Base, rootBase];
  return isLoopbackHost(url.hostname) ? [rootBase, v1Base] : [v1Base, rootBase];
}

export function openaiCompatibleBaseUrl(
  raw: string,
  fallback = 'https://api.openai.com/v1',
  label = 'OpenAI 兼容接口',
): string {
  return openaiCompatibleBaseCandidates(raw, fallback, label)[0];
}

/** Reuse capability evidence gathered by settings; translation never fetches a catalogue. */
export function magpieReasoningEffort(config: ProviderConfig): ProviderConfig['reasoningEffort'] | undefined {
  const effort = config.reasoningEffort;
  if (!effort || effort === 'default') return undefined;
  const catalogue = modelCatalogues.get(magpieBaseUrl(config.baseUrl ?? MAGPIE_BASE_URL));
  // An existing configuration remains usable before the first successful catalogue fetch.
  if (!catalogue) return effort;
  const model = catalogue.find(item => item.id === config.model?.trim());
  if (!model || !modelReasoningLevels(model.reasoningLevels).includes(effort)) {
    throw new Error(`Magpie 当前模型不支持已设置的思考程度（${effort}），请在设置 → 翻译服务中选择模型默认或受支持的档位`);
  }
  return effort;
}

/** Use the public model catalogue; Magpie manages upstream credentials itself. */
export async function magpieModels(baseUrl: string): Promise<ProviderModel[]> {
  const base = magpieBaseUrl(baseUrl);
  let response: Response;
  try {
    response = await appFetch(`${base}/models`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error(`无法连接 Magpie 网关（${base}），请确认网关已启动及地址正确`);
  }
  if (!response.ok) {
    throw new Error(`Magpie 模型列表请求失败（HTTP ${response.status}），请检查网关地址与访问设置`);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error('Magpie 返回了无效的模型列表，请检查网关地址是否包含 /v1');
  }
  const parsedCatalogue = MagpieCatalogueSchema.safeParse(json);
  if (!parsedCatalogue.success) throw new Error('Magpie 模型列表格式无效：缺少 data 数组');
  const models = new Map<string, ProviderModel>();
  for (const rawItem of parsedCatalogue.data.data) {
    const entry = MagpieModelEntrySchema.safeParse(rawItem);
    if (!entry.success) continue;
    const item = entry.data;
    const id = item.id?.trim() ?? '';
    if (!id) continue;
    const endpoints = item.native_endpoints;
    const api = Array.isArray(endpoints) && !endpoints.includes('/v1/chat/completions')
      ? endpoints.includes('/v1/responses') ? 'responses' : null
      : 'chat-completions';
    if (!api || models.has(id)) continue;
    const label = [item.magpie_label, item.display_name, id]
      .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))!;
    const reasoningLevels = item.reasoning !== false && Array.isArray(item.reasoning_levels)
      ? modelReasoningLevels(item.reasoning_levels.filter((level: unknown): level is string => typeof level === 'string'))
      : [];
    models.set(id, { id, label, api, ...(reasoningLevels.length ? { reasoningLevels } : {}) });
  }
  if (!models.size) throw new Error('Magpie 当前未提供可用于翻译的模型，请先在网关中启用模型');
  const catalogue = [...models.values()];
  modelCatalogues.set(base, catalogue);
  return catalogue;
}

const NON_CHAT_MODEL = /\b(?:embedding|embeddings|moderation|whisper|tts|dall-e|davinci-002|babbage-002|text-embedding|audio|realtime|transcribe)\b/i;

/** Fetch available models for OpenAI-compatible, DeepSeek, Ollama, or Magpie providers. */
export async function providerModels(
  provider: string,
  config: { baseUrl?: string; apiKey?: string },
): Promise<ProviderModel[]> {
  if (provider === 'magpie') {
    return magpieModels(config.baseUrl ?? MAGPIE_BASE_URL);
  }
  if (provider === 'ollama') {
    const root = ollamaBaseUrl(config.baseUrl ?? '');
    let response: Response;
    try {
      response = await appFetch(`${root}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        response = await appFetch(`${root}/v1/models`, { signal: AbortSignal.timeout(10_000) });
      }
    } catch {
      throw new Error(`无法连接 Ollama 服务（${root}），请确认 Ollama 已启动及地址正确`);
    }
    if (!response.ok) {
      throw new Error(`Ollama 模型列表请求失败（HTTP ${response.status}），请检查服务地址`);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error('Ollama 返回了无效的模型列表响应');
    }
    const parsedOllama = OllamaModelsSchema.safeParse(json);
    const items: unknown[] = parsedOllama.success
      ? ('models' in parsedOllama.data ? parsedOllama.data.models : parsedOllama.data.data)
      : [];
    const models = new Map<string, ProviderModel>();
    for (const rawItem of items) {
      const entry = OllamaModelEntrySchema.safeParse(rawItem);
      if (!entry.success) continue;
      const id = (entry.data.name ?? entry.data.model ?? entry.data.id ?? '').trim();
      if (!id || models.has(id)) continue;
      models.set(id, { id, label: id, api: 'chat-completions' });
    }
    if (!models.size) throw new Error('Ollama 当前未检测到已安装模型，请先使用 ollama pull 下载模型');
    return [...models.values()];
  }
  if (provider === 'openai' || provider === 'deepseek') {
    const defaultBase = provider === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1';
    const label = provider === 'deepseek' ? 'DeepSeek 接口' : 'OpenAI 兼容接口';
    const candidates = openaiCompatibleBaseCandidates(config.baseUrl ?? '', defaultBase, label);
    const primaryBase = candidates[0];
    const apiKey = config.apiKey?.trim() ?? '';
    if (!apiKey) throw new Error('请先输入 API Key 以拉取可用模型列表');

    const fetchModelsAt = (base: string) => appFetch(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    let activeBase = primaryBase;
    let response: Response;
    try {
      response = await fetchModelsAt(primaryBase);
    } catch {
      throw new Error(`无法连接 ${label}（${primaryBase}），请检查接口地址与网络连接`);
    }
    if (response.status === 404 && candidates.length > 1) {
      try {
        const probe = await fetchModelsAt(candidates[1]);
        if (probe.ok) {
          response = probe;
          activeBase = candidates[1];
        }
      } catch {
        /* Keep primary 404 response if alternate probe fails */
      }
    }
    if (!response.ok) {
      let detail = '';
      try {
        const parsedErr = ProviderErrorSchema.safeParse(await response.json());
        if (parsedErr.success) {
          const errField = parsedErr.data.error;
          const nestedMsg = typeof errField === 'string' ? errField : errField?.message;
          const msg = nestedMsg ?? parsedErr.data.message ?? parsedErr.data.detail;
          if (typeof msg === 'string' && msg.trim()) detail = `：${msg.trim().slice(0, 160)}`;
        }
      } catch { /* ignore */ }
      throw new Error(`模型列表请求失败（HTTP ${response.status}${detail}），请检查接口地址与 API Key`);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      if (candidates.length > 1 && activeBase === primaryBase) {
        try {
          const probe = await fetchModelsAt(candidates[1]);
          if (probe.ok) {
            json = await probe.json();
            activeBase = candidates[1];
          }
        } catch { /* fall through */ }
      }
      if (json === undefined) {
        throw new Error(`${label} 返回了无效的模型列表 JSON，请检查接口地址是否包含 /v1`);
      }
    }
    const parsedModels = OpenAIModelsSchema.safeParse(json);
    if (!parsedModels.success) {
      throw new Error(`${label} 模型列表格式无效：缺少 data 数组`);
    }
    if (candidates.length > 1) {
      pinProbedBaseUrl(activeBase);
    }
    const rawList = 'data' in parsedModels.data ? parsedModels.data.data : parsedModels.data.models;
    const allModels = new Map<string, ProviderModel>();
    const chatModels = new Map<string, ProviderModel>();
    for (const rawItem of rawList) {
      const parsedItem = OpenAIModelEntrySchema.safeParse(rawItem);
      if (!parsedItem.success) continue;
      const item = parsedItem.data;
      const id = (typeof item === 'string' ? item : item.id ?? item.name ?? '').trim();
      if (!id || allModels.has(id)) continue;
      const itemLabel = (typeof item === 'string'
        ? id
        : [item.display_name, item.label, id].find((v): v is string => typeof v === 'string' && Boolean(v.trim()))!);
      const entry: ProviderModel = { id, label: itemLabel, api: 'chat-completions' };
      allModels.set(id, entry);
      if (!NON_CHAT_MODEL.test(id)) chatModels.set(id, entry);
    }
    const selected = chatModels.size ? chatModels : allModels;
    if (!selected.size) throw new Error('接口未返回任何可用模型');
    return [...selected.values()];
  }
  throw new Error(`当前服务提供方（${provider}）不支持拉取模型列表`);
}
