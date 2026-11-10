import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderConfig, ProviderInfo, ProviderModel, Settings } from '@shared/types';
import { modelReasoningLevels } from '@shared/model-reasoning';
import { api } from '@/lib/api';
import { Modal } from './Modal';
import { IconBook, IconChevronDown, IconPanel, IconTranslate } from './icons';
import DesktopMenu from './DesktopMenu';
import './settings.css';
import { LibraryImportPanel } from './LibraryImportPanel';
import { SelectionGroup } from './SelectionGroup';
import { useContentTransition } from '@/lib/motion';

export type SettingsSection = 'appearance' | 'reading' | 'translation' | 'library';

interface Props {
  settings: Settings;
  providers: ProviderInfo[];
  onSave: (patch: Settings) => Promise<void>;
  onClose: () => void;
  onLibraryImported: () => Promise<void>;
  initialSection?: SettingsSection;
}
const LANGS = [['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'], ['ja', '日本語'],
  ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['ru', 'Русский']];
const SECTIONS = [
  { id: 'appearance', title: '外观', icon: IconPanel },
  { id: 'reading', title: '阅读排版', icon: IconBook },
  { id: 'translation', title: '翻译服务', icon: IconTranslate },
  { id: 'library', title: '文献库导入', icon: IconBook },
] as const;

function settingsError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function AppearancePreview({ theme }: { theme: Settings['theme'] }) {
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const resolved = theme === 'auto' ? systemDark ? 'dark' : 'light' : theme;
  return <figure className="appearance-preview" data-preview-theme={resolved} aria-label={`${resolved === 'dark' ? '深色' : '浅色'}界面预览`}>
    <div className="preview-window" aria-hidden="true">
      <aside className="preview-sidebar">
        <strong><IconBook />文献库</strong>
        <span className="preview-current">全部文献 <small>12</small></span>
        <span>最近阅读</span><span>我的收藏</span>
        <div className="preview-brand">ScholarLite</div>
      </aside>
      <div className="preview-reader">
        <div className="preview-toolbar"><span>论文阅读</span><span>原文 · 译文</span></div>
        <article>
          <span className="preview-eyebrow">READING & DISCOVERY</span>
          <h4>A little space for<br />a deeper understanding.</h4>
          <p>Good ideas begin with a closer look.<br />Read, reflect, and connect the dots.</p>
          <div className="preview-translation"><IconTranslate /><p>留一点空间，让理解更深入。<br />在阅读中发现，让想法逐渐清晰。</p></div>
        </article>
      </div>
    </div>
    <figcaption>界面预览 · 保存后应用主题</figcaption>
  </figure>;
}

function MagpieModels({ baseUrl, selected, onSelect, onModels }: { baseUrl: string; selected: string; onSelect: (model: ProviderModel) => void; onModels: (baseUrl: string, models: ProviderModel[]) => void }) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(''); setModels([]);
    const timer = setTimeout(() => {
      void api.settings.magpieModels(baseUrl).then(result => {
        if (!cancelled) { setModels(result); onModels(baseUrl, result); setLoading(false); }
      }).catch(reason => {
        if (!cancelled) { setError(settingsError(reason)); setLoading(false); }
      });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [baseUrl, revision, onModels]);
  return <div className="settings-field"><span>模型</span>
    <div className="gateway-model-control">
      <DesktopMenu ariaLabel="Magpie 模型" className="settings-menu" width={330} align="end" disabled={loading}
        searchable={models.length > 8} searchPlaceholder="搜索模型…"
        items={models.map(model => ({
          id: model.id, label: model.label, selected: model.id === selected, onSelect: () => onSelect(model),
        }))}><span>{loading ? '正在读取模型…' : models.find(model => model.id === selected)?.label ?? (selected || '选择模型')}</span><IconChevronDown aria-hidden="true" /></DesktopMenu>
      <button type="button" className="btn ghost gateway-refresh" disabled={loading} onClick={() => setRevision(value => value + 1)}>刷新</button>
    </div>
    <p className={error ? 'gateway-error' : undefined} role={error ? 'alert' : 'status'}>{loading ? '正在连接 Magpie 网关' : error || (models.length ? `已连接 · ${models.length} 个可用模型` : '网关没有返回可用模型，请检查 Magpie 中的模型配置。')}</p>
  </div>;
}

function ProviderModelField({
  provider,
  baseUrl,
  apiKey,
  needsKey,
  value,
  placeholder,
  onChange,
}: {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  needsKey: boolean;
  value: string;
  placeholder?: string;
  onChange: (model: string) => void;
}) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const canFetch = !needsKey || Boolean(apiKey?.trim());
  useEffect(() => {
    if (!canFetch || typeof api.settings?.providerModels !== 'function') {
      setLoading(false);
      setError('');
      setModels([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      void api.settings.providerModels(provider, { baseUrl, apiKey }).then(result => {
        if (!cancelled) {
          setModels(result);
          setLoading(false);
        }
      }).catch(reason => {
        if (!cancelled) {
          setModels([]);
          setError(settingsError(reason));
          setLoading(false);
        }
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [provider, baseUrl, apiKey, revision, canFetch]);

  return <div className="settings-field"><label htmlFor="translation-model">模型</label>
    <div className="gateway-model-control provider-model-control">
      <input id="translation-model" type="text" value={value} placeholder={placeholder} spellCheck={false}
        onChange={e => onChange(e.target.value)} />
      {models.length > 0 && (
        <DesktopMenu ariaLabel="可用模型列表" className="settings-menu provider-model-picker" width={310} align="end" disabled={loading}
          searchable={models.length > 8} searchPlaceholder="搜索模型…"
          items={models.map(model => ({
            id: model.id,
            label: model.label === model.id ? model.id : `${model.label} (${model.id})`,
            selected: model.id === value,
            onSelect: () => onChange(model.id),
          }))}>
          <span>列表</span><IconChevronDown aria-hidden="true" />
        </DesktopMenu>
      )}
      <button type="button" className="btn ghost gateway-refresh" disabled={loading || !canFetch}
        onClick={() => setRevision(v => v + 1)}>
        {models.length ? '刷新' : '获取'}
      </button>
    </div>
    <p className={error ? 'gateway-error' : undefined} role={error ? 'alert' : 'status'}>
      {loading
        ? '正在拉取可用模型列表…'
        : error || (models.length
          ? `已获取 ${models.length} 个可用模型，可从下拉列表选择或直接输入`
          : needsKey && !apiKey?.trim()
            ? '填写 API Key 后自动拉取可用模型列表，也可直接手动输入。'
            : '可点击「获取」拉取可用模型列表，或直接手动输入。')}
    </p>
  </div>;
}

export function SettingsDialog({ settings, providers, onSave, onClose, onLibraryImported, initialSection = 'appearance' }: Props) {
  const [draft, setDraft] = useState<Settings>(() => structuredClone(settings));
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const contentRef = useRef<HTMLElement>(null);
  useContentTransition(contentRef, section);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [catalogue, setCatalogue] = useState<{ baseUrl: string; models: ProviderModel[] } | null>(null);
  const receiveModels = useCallback((baseUrl: string, models: ProviderModel[]) => setCatalogue({ baseUrl, models }), []);
  const activeId = draft.translate.activeProvider;
  const active = draft.translate.providers[activeId] ?? {};
  const info = providers.find(p => p.id === activeId);
  const thinkingLabels: Record<string, string> = { default: '模型默认', none: '关闭（none）', minimal: '最少（minimal）', low: '低（low）', medium: '中（medium）', high: '高（high）', xhigh: '更高（xhigh）', max: '最高（max）' };
  const currentCatalogue = activeId === 'magpie' && catalogue && catalogue.baseUrl === (active.baseUrl ?? '') ? catalogue.models : undefined;
  const selectedModel = currentCatalogue?.find(model => model.id === active.model);
  const thinkingOptions = ['default', ...modelReasoningLevels(selectedModel?.reasoningLevels)];
  const effort = active.reasoningEffort ?? 'default';
  const thinkingError = effort !== 'default' && (activeId === 'magpie'
    ? currentCatalogue !== undefined && !thinkingOptions.includes(effort)
    : ['openai', 'deepseek'].includes(activeId))
    ? activeId === 'magpie'
      ? `当前模型不支持已设置的思考程度（${effort}），请在翻译服务中选择模型默认或受支持的档位。`
      : '当前接口未提供模型思考能力，请在翻译服务中选择模型默认后保存。'
    : '';
  const patchReading = (patch: Partial<Settings['reading']>) => setDraft(prev => ({ ...prev, reading: { ...prev.reading, ...patch } }));
  const patchProvider = (patch: Partial<ProviderConfig>) => setDraft(prev => ({
    ...prev, translate: { ...prev.translate, providers: {
      ...prev.translate.providers, [activeId]: { ...prev.translate.providers[activeId], ...patch },
    } },
  }));
  const save = async () => {
    if (saving) return;
    if (thinkingError) { setError(thinkingError); return; }
    if (!Number.isInteger(draft.translate.concurrency) || draft.translate.concurrency < 1 || draft.translate.concurrency > 16) {
      setError('翻译并发数必须是 1–16 的整数');
      return;
    }
    setSaving(true); setError('');
    try { await onSave(draft); onClose(); }
    catch (reason) { setError(settingsError(reason)); }
    finally { setSaving(false); }
  };
  return <Modal title="设置" className={`reader-settings settings-${section}`} onClose={onClose} busy={saving || importBusy} footer={<>
    {(error || thinkingError) && <p className="settings-error" role="alert">{error || thinkingError}</p>}
    <button className="btn ghost" disabled={saving || importBusy} onClick={onClose}>关闭</button>
    <button className="btn primary" disabled={saving || importBusy || Boolean(thinkingError)} onClick={() => void save()}>{saving ? '正在保存…' : '保存设置'}</button>
  </>}>
    <div className="settings-layout">
      <SelectionGroup as="nav" className="settings-navigation" aria-label="设置分类">
        {SECTIONS.map(({ id, title, icon: Icon }) => <button key={id} type="button" className="settings-nav-item"
          aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>
          <Icon aria-hidden="true" /><span>{title}</span>
        </button>)}
      </SelectionGroup>
      <section ref={contentRef} className="settings-content" aria-label={SECTIONS.find(item => item.id === section)?.title}>
        {section === 'appearance' && <>
          <div className="settings-section-heading"><h3>外观</h3></div>
          <div className="settings-field settings-theme-row"><span id="theme-label">界面主题</span>
            <SelectionGroup className="appearance-options" role="radiogroup" aria-labelledby="theme-label">
              {([['light', '浅色'], ['dark', '深色'], ['auto', '跟随系统']] as const).map(([value, label]) =>
                <label className="appearance-option" key={value}>
                  <input type="radio" name="reader-theme" value={value} checked={draft.theme === value}
                    onChange={() => setDraft(prev => ({ ...prev, theme: value }))} />
                  <span>{label}</span>
                </label>)}
            </SelectionGroup>
          </div>
          <AppearancePreview theme={draft.theme} />
        </>}
        {section === 'reading' && <>
          <div className="settings-section-heading"><h3>阅读排版</h3></div>
          <div className="settings-field"><span>正文字体</span>
            <DesktopMenu ariaLabel="正文字体" className="settings-menu" width={200} align="end" items={[
              { id: 'serif', label: '衬线字体', selected: draft.reading.fontFamily === 'serif', onSelect: () => patchReading({ fontFamily: 'serif' }) },
              { id: 'sans', label: '无衬线字体', selected: draft.reading.fontFamily === 'sans', onSelect: () => patchReading({ fontFamily: 'sans' }) },
            ]}><span>{draft.reading.fontFamily === 'serif' ? '衬线字体' : '无衬线字体'}</span><IconChevronDown aria-hidden="true" /></DesktopMenu>
          </div>
          <div className="settings-slider"><label htmlFor="reading-size">字号</label>
            <div className="settings-range"><input id="reading-size" type="range" min={14} max={24} step={1} value={draft.reading.fontSize} onChange={e => patchReading({ fontSize: Number(e.target.value) })} /><output htmlFor="reading-size">{draft.reading.fontSize} px</output></div>
          </div>
          <div className="settings-slider"><label htmlFor="reading-height">行距</label>
            <div className="settings-range"><input id="reading-height" type="range" min={1.4} max={2.4} step={0.05} value={draft.reading.lineHeight} onChange={e => patchReading({ lineHeight: Number(e.target.value) })} /><output htmlFor="reading-height">{draft.reading.lineHeight.toFixed(2)}</output></div>
          </div>
          <div className="settings-slider"><label htmlFor="reading-width">正文最大宽度</label>
            <div className="settings-range"><input id="reading-width" type="range" min={560} max={1100} step={20} value={draft.reading.maxWidth} onChange={e => patchReading({ maxWidth: Number(e.target.value) })} /><output htmlFor="reading-width">{draft.reading.maxWidth} px</output></div>
          </div>
          <div className="reading-preview" style={{ fontFamily: draft.reading.fontFamily === 'serif' ? 'var(--serif)' : 'var(--sans)', fontSize: draft.reading.fontSize, lineHeight: draft.reading.lineHeight }}>
            <span>排版预览</span><p>阅读，让想法逐渐清晰。<br />A little space for a deeper understanding.</p>
          </div>
        </>}
        {section === 'translation' && <>
          <div className="settings-section-heading"><h3>翻译服务</h3></div>
          <div className="settings-field"><label htmlFor="translation-concurrency">并发数</label>
            <input id="translation-concurrency" type="number" min={1} max={16} step={1} value={Number.isFinite(draft.translate.concurrency) ? draft.translate.concurrency : ''}
              onChange={e => setDraft(prev => ({ ...prev, translate: { ...prev.translate, concurrency: e.target.value === '' ? Number.NaN : Number(e.target.value) } }))} />
            <p>1–16 个请求同时翻译，默认 4；阅读中的当前页优先。</p>
          </div>
          <div className="settings-field"><span>服务提供方</span>
            <DesktopMenu ariaLabel="服务提供方" className="settings-menu" width={250} align="end" items={providers.map(provider => ({
              id: provider.id, label: provider.label, selected: provider.id === activeId,
              onSelect: () => setDraft(prev => ({ ...prev, translate: { ...prev.translate, activeProvider: provider.id } })),
            }))}><span>{info?.label ?? activeId}</span><IconChevronDown aria-hidden="true" /></DesktopMenu>
            {info?.hint && <p>{info.hint}</p>}
          </div>
          {info?.needsBaseUrl && <div className="settings-field"><label htmlFor="translation-base">接口地址</label>
            <input id="translation-base" type="url" value={active.baseUrl ?? ''} placeholder={activeId === 'magpie' ? 'http://127.0.0.1:3425/v1' : 'https://api.openai.com/v1'} spellCheck={false}
              onChange={e => patchProvider({ baseUrl: e.target.value })} />
          </div>}
          {activeId === 'deepl' && <div className="settings-field"><label htmlFor="translation-endpoint">DeepL 接口地址</label>
            <input id="translation-endpoint" type="url" value={active.endpoint ?? 'https://api-free.deepl.com/v2/translate'} spellCheck={false}
              onChange={e => patchProvider({ endpoint: e.target.value })} />
          </div>}
          {info?.needsKey && <div className="settings-field"><label htmlFor="translation-key">API Key</label>
            <input id="translation-key" type="password" value={active.apiKey ?? ''} placeholder="输入 API Key" spellCheck={false} autoComplete="off"
              onChange={e => patchProvider({ apiKey: e.target.value })} />
            <p>密钥保存在本机，用于向所选服务验证请求。</p>
          </div>}
          {['openai', 'deepseek', 'ollama'].includes(activeId) && (
            <ProviderModelField
              provider={activeId}
              baseUrl={active.baseUrl}
              apiKey={active.apiKey}
              needsKey={Boolean(info?.needsKey)}
              value={active.model ?? ''}
              placeholder={info?.defaultModel}
              onChange={model => patchProvider({ model })}
            />
          )}
          {activeId === 'magpie' && <MagpieModels baseUrl={active.baseUrl ?? ''} selected={active.model ?? ''}
            onModels={receiveModels}
            onSelect={model => patchProvider({ model: model.id, api: model.api,
              reasoningEffort: modelReasoningLevels(model.reasoningLevels).includes(effort) ? effort : 'default' })} />}
          {(activeId === 'magpie' || (['openai', 'deepseek'].includes(activeId) && (thinkingOptions.length > 1 || effort !== 'default'))) && <div className="settings-field"><span>思考程度</span>
            <DesktopMenu ariaLabel="思考程度" className="settings-menu" width={220} align="end" items={thinkingOptions.map(level => ({
              id: level, label: thinkingLabels[level], selected: (active.reasoningEffort ?? 'default') === level,
              onSelect: () => patchProvider({ reasoningEffort: level as ProviderConfig['reasoningEffort'] }),
            }))}><span>{thinkingLabels[active.reasoningEffort ?? 'default']}</span><IconChevronDown aria-hidden="true" /></DesktopMenu>
            <p>{activeId === 'magpie'
              ? currentCatalogue ? '可选档位来自当前模型的网关能力；模型默认不发送思考参数。' : '尚未取得当前网关的模型能力，仅可选择模型默认；已保存的档位保持不变。'
              : '当前接口未提供模型思考能力，请重置为模型默认后保存。'}</p>
          </div>}
          <div className="settings-field"><span>目标语言</span>
            <DesktopMenu ariaLabel="目标语言" className="settings-menu" width={200} align="end" items={LANGS.map(([code, label]) => ({
              id: code, label, selected: draft.targetLang === code,
              onSelect: () => setDraft(prev => ({ ...prev, targetLang: code })),
            }))}><span>{LANGS.find(([code]) => code === draft.targetLang)?.[1] ?? draft.targetLang}</span><IconChevronDown aria-hidden="true" /></DesktopMenu>
          </div>
        </>}
        <LibraryImportPanel hidden={section !== 'library'} onBusyChange={setImportBusy} onImported={onLibraryImported} />
      </section>
    </div>
  </Modal>;
}
