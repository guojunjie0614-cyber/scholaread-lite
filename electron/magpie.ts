import type { ProviderConfig, ProviderModel } from '../shared/types.js';
import { modelReasoningLevels } from '../shared/model-reasoning.js';

export const MAGPIE_BASE_URL = 'http://127.0.0.1:3425/v1';
const modelCatalogues = new Map<string, ProviderModel[]>();

export function magpieBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('请输入有效的 Magpie 网关地址，例如 http://127.0.0.1:3425/v1');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Magpie 网关地址必须是无账号、查询参数和片段的 HTTP(S) 地址');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/v1';
  return url.toString().replace(/\/+$/, '');
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
    response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(10_000) });
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
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error('Magpie 模型列表格式无效：缺少 data 数组');
  const models = new Map<string, ProviderModel>();
  for (const item of data) {
    if (typeof item?.id !== 'string' || !item.id.trim()) continue;
    const endpoints: unknown = item.native_endpoints;
    const api = Array.isArray(endpoints) && !endpoints.includes('/v1/chat/completions')
      ? endpoints.includes('/v1/responses') ? 'responses' : null
      : 'chat-completions';
    if (!api || models.has(item.id)) continue;
    const label = [item.magpie_label, item.display_name, item.id]
      .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))!;
    const reasoningLevels = item.reasoning !== false && Array.isArray(item.reasoning_levels)
      ? modelReasoningLevels(item.reasoning_levels.filter((level: unknown): level is string => typeof level === 'string'))
      : [];
    models.set(item.id, { id: item.id, label, api, ...(reasoningLevels.length ? { reasoningLevels } : {}) });
  }
  if (!models.size) throw new Error('Magpie 当前未提供可用于翻译的模型，请先在网关中启用模型');
  const catalogue = [...models.values()];
  modelCatalogues.set(base, catalogue);
  return catalogue;
}

function normalizeHttpBaseUrl(raw: string, fallback: string, label: string): string {
  let url: URL;
  try {
    url = new URL((raw.trim() || fallback).trim());
  } catch {
    throw new Error(`请输入有效的 ${label} 接口地址，例如 ${fallback}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} 接口地址必须是无账号、查询参数和片段的 HTTP(S) 地址`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
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
    const base = normalizeHttpBaseUrl(config.baseUrl ?? '', 'http://127.0.0.1:11434', 'Ollama');
    const root = base.replace(/\/v1$/i, '');
    let response: Response;
    try {
      response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        response = await fetch(`${root}/v1/models`, { signal: AbortSignal.timeout(10_000) });
      }
    } catch {
      throw new Error(`无法连接 Ollama 服务（${root}），请确认 Ollama 已启动及地址正确`);
    }
    if (!response.ok) {
      throw new Error(`Ollama 模型列表请求失败（HTTP ${response.status}），请检查服务地址`);
    }
    let json: any;
    try {
      json = await response.json();
    } catch {
      throw new Error('Ollama 返回了无效的模型列表响应');
    }
    const items: any[] = Array.isArray(json?.models) ? json.models : Array.isArray(json?.data) ? json.data : [];
    const models = new Map<string, ProviderModel>();
    for (const item of items) {
      const id = typeof item?.name === 'string' ? item.name.trim()
        : typeof item?.model === 'string' ? item.model.trim()
        : typeof item?.id === 'string' ? item.id.trim() : '';
      if (!id || models.has(id)) continue;
      models.set(id, { id, label: id, api: 'chat-completions' });
    }
    if (!models.size) throw new Error('Ollama 当前未检测到已安装模型，请先使用 ollama pull 下载模型');
    return [...models.values()];
  }
  if (provider === 'openai' || provider === 'deepseek') {
    const defaultBase = provider === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1';
    const label = provider === 'deepseek' ? 'DeepSeek' : 'OpenAI 兼容';
    const base = normalizeHttpBaseUrl(config.baseUrl ?? '', defaultBase, label);
    const apiKey = config.apiKey?.trim() ?? '';
    if (!apiKey) throw new Error('请先输入 API Key 以拉取可用模型列表');
    let response: Response;
    try {
      response = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error(`无法连接 ${label} 接口（${base}/models），请检查接口地址与网络连接`);
    }
    if (!response.ok) {
      let detail = '';
      try {
        const errJson: any = await response.json();
        const msg = errJson?.error?.message ?? errJson?.message ?? errJson?.detail;
        if (typeof msg === 'string' && msg.trim()) detail = `：${msg.trim().slice(0, 160)}`;
      } catch { /* ignore */ }
      throw new Error(`模型列表请求失败（HTTP ${response.status}${detail}），请检查接口地址与 API Key`);
    }
    let json: any;
    try {
      json = await response.json();
    } catch {
      throw new Error(`${label} 返回了无效的模型列表 JSON，请检查接口地址是否包含 /v1`);
    }
    const rawList: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    if (!Array.isArray(json?.data) && !Array.isArray(json?.models)) {
      throw new Error(`${label} 模型列表格式无效：缺少 data 数组`);
    }
    const allModels = new Map<string, ProviderModel>();
    const chatModels = new Map<string, ProviderModel>();
    for (const item of rawList) {
      const id = typeof item === 'string' ? item.trim()
        : typeof item?.id === 'string' ? item.id.trim()
        : typeof item?.name === 'string' ? item.name.trim() : '';
      if (!id || allModels.has(id)) continue;
      const itemLabel = [item?.display_name, item?.label, id]
        .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))!;
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
