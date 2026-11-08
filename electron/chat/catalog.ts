import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { jsonProcess } from './process.js';
import { agyEnvironment } from './agy-environment.js';
import type { AgentInfo, AgentId, ChatCatalog, ChatModel } from '../../shared/chat-types.js';

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const levels = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter(text))] : [];
const modelId = (providerId: AgentId, model: string) => `${providerId}:${model || 'default'}`;
const defaultLabels: Record<AgentId, string> = { codex: 'Codex 默认', claude: 'Claude 默认', agy: 'agy 默认' };

export function codexModels(rows: unknown): ChatModel[] {
  if (!Array.isArray(rows)) throw new Error('模型目录格式无效');
  return rows.filter(row => row && !row.hidden && text(row.model)).map(row => ({
    id: modelId('codex', row.model), providerId: 'codex', model: row.model,
    label: text(row.displayName) ? row.displayName : row.model,
    reasoningLevels: levels(row.supportedReasoningEfforts?.map((entry: any) => entry.reasoningEffort)),
    defaultReasoningEffort: text(row.defaultReasoningEffort) ? row.defaultReasoningEffort : undefined,
    images: Array.isArray(row.inputModalities) ? row.inputModalities.includes('image') : undefined,
    isDefault: row.isDefault === true, source: 'runtime',
  }));
}

export function claudeModels(rows: unknown): ChatModel[] {
  if (!Array.isArray(rows)) throw new Error('模型目录格式无效');
  return rows.filter(row => row && text(row.value)).map(row => {
    const model = row.value === 'default' ? '' : row.value;
    return { id: modelId('claude', model), providerId: 'claude' as const, model,
      label: row.value === 'default' ? text(row.displayName) && !/^(default|默认)(?:\s|$)/i.test(row.displayName) ? row.displayName : defaultLabels.claude : text(row.displayName) ? row.displayName : model,
      reasoningLevels: row.supportsEffort === false ? [] : levels(row.supportedEffortLevels),
      images: true, isDefault: row.value === 'default', source: 'runtime' as const };
  });
}

const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function agyFamilies(models: ChatModel[]): ChatModel[] {
  const families = new Map<string, ChatModel>();
  for (const model of models) {
    const suffix = /^(.*?)\s+\(([^()]+)\)$/.exec(model.label);
    const effort = suffix?.[2].toLowerCase();
    if (!suffix || !effort || !effortOrder.includes(effort) || !model.model.endsWith(`-${effort}`)) {
      families.set(model.model, model); continue;
    }
    const family = model.model.slice(0, -effort.length - 1);
    const previous = families.get(family);
    if (previous && previous.label !== suffix[1]) throw new Error('模型家族目录存在冲突');
    const reasoningVariants = { ...previous?.reasoningVariants, [effort]: model.model };
    const reasoningLevels = effortOrder.filter(level => reasoningVariants[level]);
    families.set(family, { ...model, id: modelId('agy', family), model: family, label: suffix[1],
      reasoningVariants, reasoningLevels, defaultReasoningEffort: reasoningVariants.medium ? 'medium' : reasoningLevels[0] });
  }
  return [...families.values()];
}

/** Group only explicit label/slug effort pairs actually returned by the native runtime. */
export function agyModels(output: string): ChatModel[] {
  const listing = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
  if (!/^[\[{]/.test(listing)) {
    const rows = listing.split(/\r?\n/).map(line => /^([a-z0-9][a-z0-9._:/-]*)(?:\t+| {2,})(\S.*)$/.exec(line));
    if (!rows.length || rows.some(row => !row)) throw new Error('模型目录文本格式无效');
    return agyFamilies(rows.map(row => ({ id: modelId('agy', row![1]), providerId: 'agy', model: row![1],
      label: row![2].trim(), reasoningLevels: [], source: 'runtime' })));
  }
  const data = JSON.parse(listing);
  const rows = Array.isArray(data) ? data : data.models ?? data.data;
  if (!Array.isArray(rows)) throw new Error('模型目录格式无效');
  return agyFamilies(rows.filter(row => row && text(row.id ?? row.model)).map(row => {
    const model = row.id ?? row.model;
    return { id: modelId('agy', model), providerId: 'agy' as const, model,
      label: row.displayName ?? row.display_name ?? row.name ?? model,
      reasoningLevels: levels(row.supportedEffortLevels ?? row.supported_effort_levels ?? row.reasoningLevels),
      defaultReasoningEffort: row.defaultReasoningEffort ?? row.default_effort,
      images: row.supportsImages ?? row.supports_images ?? true,
      isDefault: row.isDefault === true, source: 'runtime' as const };
  }));
}

/** Legacy saved AGY variants remain usable while new conversations store family plus effort. */
export function normalizeAgySelection(models: ChatModel[], model: string, effort: string) {
  const option = models.find(option => option.providerId === 'agy' && option.model === model)
    ?? models.find(option => option.providerId === 'agy' && Object.values(option.reasoningVariants ?? {}).includes(model));
  if (!option?.reasoningVariants) return { model, effort, option };
  const variantEffort = Object.entries(option.reasoningVariants).find(([, slug]) => slug === model)?.[0];
  return { model: option.model, effort: effort || variantEffort || option.defaultReasoningEffort || '', option };
}

function jsonCatalog(provider: AgentInfo, cwd: string): Promise<ChatModel[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, models?: ChatModel[]) => {
      if (settled) return;
      settled = true; clearTimeout(timer); proc.close();
      if (error) reject(error); else resolve(models!);
    };
    const args = provider.id === 'codex' ? ['app-server', '--stdio', '-c', 'features.hooks=false', '-c', 'features.plugins=false', '-c', 'mcp_servers={}']
      : ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--safe-mode', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-prompts', 'none'];
    let requestId = 2;
    const rows: any[] = [];
    const proc = jsonProcess(provider.executablePath!, args, cwd, message => {
      if (provider.id === 'codex') {
        if (message.id === 1) {
          if (message.error) return finish(new Error('模型目录初始化失败'));
          proc.send({ method: 'initialized', params: {} });
          proc.send({ id: requestId, method: 'model/list', params: { limit: 100 } });
        } else if (message.id === requestId) {
          if (message.error) return finish(new Error('模型目录读取失败'));
          rows.push(...(message.result?.data ?? []));
          const cursor = message.result?.nextCursor;
          if (cursor && requestId < 12) proc.send({ id: ++requestId, method: 'model/list', params: { limit: 100, cursor } });
          else finish(undefined, codexModels(rows));
        }
      } else if (message.type === 'control_response' && message.response?.request_id === 'scholarlite-models') {
        if (message.response.subtype !== 'success') return finish(new Error('模型目录初始化失败'));
        // Do not expose account metadata, token sources, or command descriptions to the renderer.
        finish(undefined, claudeModels(message.response.response?.models));
      }
    });
    const timer = setTimeout(() => finish(new Error('模型目录读取超时，请检查本机连接后刷新。程序或配置在外置磁盘时，请检查可移动宗卷访问权限。')), 6000);
    void proc.done.then(() => { if (!settled) finish(new Error('模型目录连接已关闭')); }, () => finish(new Error('模型目录读取失败，请检查本机登录或连接')));
    if (provider.id === 'codex') proc.send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'scholarlite-models', version: '0.1.0' }, capabilities: {} } });
    else proc.send({ type: 'control_request', request_id: 'scholarlite-models', request: { subtype: 'initialize' } });
  });
}

async function agyCatalog(provider: AgentInfo, cwd: string): Promise<ChatModel[]> {
  const env = await agyEnvironment();
  return new Promise((resolve, reject) => {
    execFile(provider.executablePath!, ['models'], { cwd, env, timeout: 6000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error('模型目录读取失败或超时，请检查本机连接后刷新'));
      try { resolve(agyModels(stdout)); }
      catch { reject(new Error('当前命令行返回的模型目录格式无法读取，可使用已配置模型')); }
    });
  });
}

export function createModelCatalog(root: string, getProviders: () => AgentInfo[]) {
  let cache: { key: string; value: ChatCatalog } | undefined;
  let pending: { key: string; promise: Promise<ChatCatalog> } | undefined;
  const cwd = path.join(root, 'catalog'); fs.mkdirSync(cwd, { recursive: true });
  return async (refresh = false): Promise<ChatCatalog> => {
    if (typeof refresh !== 'boolean') throw new Error('模型目录刷新参数无效');
    const providers = getProviders(), key = JSON.stringify(providers.map(provider => [provider.id, provider.executablePath, provider.config, provider.available, provider.unavailableReason]));
    if (!refresh && cache?.key === key) return cache.value;
    if (pending?.key === key) return pending.promise;
    const promise = (async () => {
      const results = await Promise.all(providers.map(async provider => {
        if (!provider.available) return { provider, models: [] as ChatModel[], error: provider.unavailableReason ?? '未找到本机连接，请在连接设置中检查可执行文件' };
        try { return { provider, models: provider.id === 'agy' ? await agyCatalog(provider, cwd) : await jsonCatalog(provider, cwd) }; }
        catch (error) { return { provider, models: [] as ChatModel[], error: error instanceof Error ? error.message : '模型目录读取失败' }; }
      }));
      const models: ChatModel[] = [], errors: NonNullable<ChatCatalog['errors']> = [];
      for (const result of results) {
        models.push(...result.models);
        if (result.error) errors.push({ providerId: result.provider.id, message: result.error });
        if (result.provider.available && !result.models.some(model => model.model === '')) {
          const nativeDefault = result.models.find(model => model.isDefault);
          models.push({ ...nativeDefault, id: modelId(result.provider.id, ''), providerId: result.provider.id,
            model: '', label: defaultLabels[result.provider.id], reasoningLevels: nativeDefault?.reasoningLevels ?? [],
            images: nativeDefault?.images ?? result.provider.images, isDefault: true, source: nativeDefault ? 'runtime' : 'default' });
        }
        const configured = result.provider.config.model;
        if (configured && !result.models.some(model => model.model === configured || Object.values(model.reasoningVariants ?? {}).includes(configured))) models.push({
          id: modelId(result.provider.id, configured), providerId: result.provider.id, model: configured,
          label: configured, reasoningLevels: [], images: result.provider.images, source: 'configured',
        });
      }
      const value: ChatCatalog = { models, ...(errors.length ? { errors } : {}) };
      cache = { key, value }; return value;
    })();
    pending = { key, promise };
    try { return await promise; } finally { if (pending?.promise === promise) pending = undefined; }
  };
}
