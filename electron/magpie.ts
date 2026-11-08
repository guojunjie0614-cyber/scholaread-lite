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
