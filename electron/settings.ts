import fs from 'node:fs';
import { paths } from './paths.js';
import type { DeepPartial, Settings } from '../shared/types.js';
import { MAGPIE_BASE_URL, magpieBaseUrl, magpieReasoningEffort, openaiCompatibleBaseUrl } from './magpie.js';
import { REASONING_EFFORTS } from '../shared/model-reasoning.js';

const DEFAULTS: Settings = {
  targetLang: 'zh-CN',
  theme: 'auto',
  translate: {
    activeProvider: 'openai',
    concurrency: 4,
    providers: {
      magpie: { baseUrl: MAGPIE_BASE_URL, model: '', temperature: 0.2 },
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini',
        temperature: 0.2,
      },
      deepseek: {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
        model: 'deepseek-chat',
        temperature: 0.2,
      },
      ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b' },
      deepl: { apiKey: '', endpoint: 'https://api-free.deepl.com/v2/translate' },
      google: { apiKey: '' },
      echo: {},
    },
  },
  reading: { fontSize: 17, lineHeight: 1.85, maxWidth: 760, fontFamily: 'serif' },
  reflow: { keepFigures: true },
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObject(base) || !isObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isObject(current) && isObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

let cache: Settings | null = null;

export const settings = {
  get(): Settings {
    if (cache) return cache;
    try {
      const raw = fs.readFileSync(paths.config(), 'utf8');
      cache = deepMerge(DEFAULTS, JSON.parse(raw));
    } catch {
      cache = structuredClone(DEFAULTS);
    }
    return cache;
  },

  set(patch: DeepPartial<Settings>): Settings {
    const next = deepMerge(settings.get(), patch);
    if (!Number.isInteger(next.translate.concurrency) || next.translate.concurrency < 1 || next.translate.concurrency > 16) {
      throw new Error('翻译并发数必须是 1–16 的整数');
    }
    for (const [provider, config] of Object.entries(next.translate.providers)) {
      if (config.reasoningEffort !== undefined && !REASONING_EFFORTS.includes(config.reasoningEffort)) {
        throw new Error(`${provider} 的思考程度无效，请重新选择`);
      }
    }
    for (const [provider, defaultBase, label] of [
      ['openai', 'https://api.openai.com/v1', 'OpenAI 兼容接口'],
      ['deepseek', 'https://api.deepseek.com/v1', 'DeepSeek 接口'],
    ] as const) {
      const config = next.translate.providers[provider];
      if (typeof config?.baseUrl === 'string' && config.baseUrl.trim()) {
        next.translate = {
          ...next.translate,
          providers: {
            ...next.translate.providers,
            [provider]: { ...config, baseUrl: openaiCompatibleBaseUrl(config.baseUrl, defaultBase, label) },
          },
        };
      }
    }
    if (next.translate.activeProvider === 'magpie') {
      const config = next.translate.providers.magpie;
      if (typeof config?.model !== 'string' || !config.model.trim()) {
        throw new Error('请先获取并选择 Magpie 模型');
      }
      magpieReasoningEffort(config);
      next.translate = {
        ...next.translate,
        providers: {
          ...next.translate.providers,
          magpie: { ...config, baseUrl: magpieBaseUrl(config.baseUrl ?? ''), model: config.model.trim() },
        },
      };
    }
    const tmp = `${paths.config()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, paths.config());
    cache = next;
    try {
      fs.chmodSync(paths.config(), 0o600);
    } catch {
      /* 忽略不支持 chmod 的文件系统 */
    }
    return next;
  },

  providers() {
    const s = settings.get();
    return [
      {
        id: 'magpie',
        label: 'Magpie 网关',
        needsKey: false,
        needsBaseUrl: true,
        hint: '连接本机 Magpie，直接选择网关已启用的模型，无需另外填写 API Key',
      },
      {
        id: 'openai',
        label: 'OpenAI 兼容接口',
        needsKey: true,
        needsBaseUrl: true,
        defaultModel: s.translate.providers.openai?.model ?? 'gpt-4o-mini',
        hint: '任何兼容 /chat/completions 的服务都可用（OpenAI、SiliconFlow、Azure 网关、vLLM…）',
      },
      {
        id: 'deepseek',
        label: 'DeepSeek',
        needsKey: true,
        needsBaseUrl: true,
        defaultModel: 'deepseek-chat',
        hint: 'https://api.deepseek.com/v1',
      },
      {
        id: 'ollama',
        label: '本地 Ollama',
        needsKey: false,
        needsBaseUrl: true,
        defaultModel: 'qwen2.5:7b',
        hint: '完全离线，需先 `ollama pull qwen2.5:7b`',
      },
      {
        id: 'deepl',
        label: 'DeepL',
        needsKey: true,
        needsBaseUrl: false,
        hint: '免费额度用 api-free.deepl.com，付费版改 api.deepl.com',
      },
      {
        id: 'google',
        label: 'Google 翻译',
        needsKey: true,
        needsBaseUrl: false,
        hint: '需要启用 Cloud Translation API 的 key',
      },
      {
        id: 'echo',
        label: 'Echo（调试用，不联网）',
        needsKey: false,
        needsBaseUrl: false,
        hint: '原样回显，用于验证排版与缓存',
      },
    ];
  },
};

export { DEFAULTS };
