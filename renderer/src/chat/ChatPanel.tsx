import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { Paper } from '@shared/types';
import type { AgentConfig, AgentId, AgentInfo, ChatAttachment, ChatConversation, ChatMessage, ChatRequest,
  ChatState, ChatCatalog, ChatModel, MessageReference, PaperReference } from '@shared/chat-types';
import { api } from '@/lib/api';
import { Modal } from '@/components/Modal';
import { ChatHistory } from './ChatHistory';
import { VisualAnswer } from './VisualAnswer';
import { ChatSelectionAction } from './ChatSelectionAction';
import DesktopMenu from '@/components/DesktopMenu';
import { IconChevronDown, IconPlus, IconClose, IconMore, IconBook, IconRefresh, IconTrash, IconEdit } from '@/components/icons';
import './chat.css';

const chat = api.chat;
const uid = () => crypto.randomUUID();
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const effortLabels: Record<string, string> = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };
const effortLabel = (value: string) => value ? effortLabels[value] ?? value : 'Default';
interface Draft { text: string; references: PaperReference[]; messageReferences: MessageReference[]; attachments: ChatAttachment[] }
const emptyDraft = (): Draft => ({ text: '', references: [], messageReferences: [], attachments: [] });
const drafts = new Map<string, Draft>();
const conversationDrafts = new Map<string, Draft>();
const modelPreferenceKey = 'scholarlite-chat-model';
const readModelPreference = (): { providerId: AgentId; model: string; effort: string } | null => {
  try { return JSON.parse(localStorage.getItem(modelPreferenceKey) ?? 'null'); } catch { return null; }
};
const selectionKey = (paperId: string) => `scholarlite-chat-conversation:${paperId}`;
const readSelection = (paperId: string) => { try { return localStorage.getItem(selectionKey(paperId)); } catch { return null; } };
const saveSelection = (paperId: string, id: string) => { try { localStorage.setItem(selectionKey(paperId), id); } catch { /* Chat storage is still persisted by the main process. */ } };

export interface ChatPanelProps {
  paper: Paper; request: ChatRequest | null; onRequestHandled(id: string): void;
  onJump(reference: PaperReference): void; onSaveNote(text: string): Promise<void>; onError(message: string): void;
}

export function ChatPanel({ paper, request, onRequestHandled, onJump, onSaveNote, onError }: ChatPanelProps) {
  const [providers, setProviders] = useState<AgentInfo[]>([]);
  const [providerId, setProviderId] = useState<AgentId>('codex');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [catalog, setCatalog] = useState<ChatCatalog>({ models: [] });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [state, setState] = useState<ChatState | null>(null);
  const [draft, setDraft] = useState<Draft>(() => drafts.get(paper.id) ?? emptyDraft());
  const [editing, setEditing] = useState<{ conversationId: string; messageId: string; previousDraft: Draft } | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [configProviderId, setConfigProviderId] = useState<AgentId>('codex');
  const [config, setConfig] = useState<AgentConfig>({});
  const [feedback, setFeedback] = useState('');
  const [deleted, setDeleted] = useState<ChatConversation | null>(null);
  const [renaming, setRenaming] = useState<ChatConversation | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [dragging, setDragging] = useState(false);
  const [imagePreview, setImagePreview] = useState<ChatAttachment | null>(null);
  const paperRef = useRef(paper.id); paperRef.current = paper.id;
  const draftOwner = useRef(paper.id);
  const currentRef = useRef<string | null>(null); currentRef.current = state?.conversation.id ?? null;
  const draftRef = useRef(draft); draftRef.current = draft;
  const processedRequests = useRef(new Set<string>());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const rememberedScrollTop = useRef(0);
  const operation = useRef(0);
  const resolvedModelPaper = useRef('');
  const configProvider = providers.find(item => item.id === configProviderId);
  const selectedProvider = providers.find(item => item.id === providerId);
  const selectedModel = catalog.models.find(item => item.providerId === providerId && item.model === model);
  const modelLabel = selectedProvider?.unavailableReason ? '选择模型' : model ? selectedModel?.label || model : '本机默认';
  const reasoningLevels = selectedModel?.reasoningLevels ?? [];
  const running = state?.running ?? false;

  const report = useCallback((reason: unknown) => { setError(messageOf(reason)); }, []);
  const refreshList = useCallback(async () => {
    const id = paper.id; const list = await chat.list(id);
    if (paperRef.current === id) setConversations(list);
  }, [paper.id]);
  const activate = useCallback((next: ChatState) => {
    currentRef.current = next.conversation.id;
    setState(next); setProviderId(next.conversation.providerId); setModel(next.conversation.model); setEffort(next.conversation.effort ?? '');
    saveSelection(next.conversation.paperId, next.conversation.id); follow.current = true;
  }, []);
  const refreshCatalog = useCallback(async (refresh = false) => {
    const id = paper.id; setCatalogLoading(true);
    try {
      const next = await chat.catalog(refresh);
      if (paperRef.current === id) setCatalog(next);
    } catch (reason) { if (paperRef.current === id) report(reason); }
    finally { if (paperRef.current === id) setCatalogLoading(false); }
  }, [paper.id, report]);

  // This effect runs before the paper-load effect: an old draft never lands in the new paper.
  useEffect(() => { if (draftOwner.current === paper.id) drafts.set(paper.id, draft); }, [paper.id, draft]);

  useEffect(() => {
    let alive = true; const revision = ++operation.current;
    draftOwner.current = paper.id;
    const savedDraft = drafts.get(paper.id) ?? emptyDraft();
    setReady(false); setBusy(false); setState(null); setError(''); setDraft(savedDraft);
    setImagePreview(null); setEditing(null); setDeleted(null); setRenaming(null);
    void refreshCatalog();
    void Promise.all([chat.providers(), chat.list(paper.id)]).then(async ([agents, list]) => {
      if (!alive || revision !== operation.current) return;
      setProviders(agents); setConversations(list);
      const saved = readSelection(paper.id);
      const entry = list.find(item => item.id === saved) ?? list[0];
      if (entry) {
        const loaded = await chat.get(entry.id);
        if (!alive || revision !== operation.current) return;
        activate(loaded);
      } else {
        const preference = readModelPreference();
        const provider = agents.find(item => item.id === preference?.providerId && item.available) ?? agents.find(item => item.id === 'codex' && item.available) ?? agents.find(item => item.available);
        setProviderId(provider?.id ?? 'codex');
        setModel(provider?.id === preference?.providerId ? preference?.model ?? '' : provider?.config.model ?? '');
        setEffort(provider?.id === preference?.providerId ? preference?.effort ?? '' : provider?.config.effort ?? '');
      }
      setReady(true);
    }).catch(reason => { if (alive) { report(reason); setReady(true); } });
    const unsubscribe = chat.onEvent(event => {
      if (!alive || event.state.conversation.paperId !== paper.id) return;
      if (event.deleted) {
        setConversations(previous => previous.filter(item => item.id !== event.conversationId));
        if (currentRef.current === event.conversationId) {
          currentRef.current = null; setState(null); setEditing(null); setDraft(emptyDraft());
          saveSelection(paper.id, '');
        }
        return;
      }
      if (currentRef.current === event.conversationId) setState(event.state);
      setConversations(previous => {
        const next = previous.filter(item => item.id !== event.conversationId);
        return [event.state.conversation, ...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      });
    });
    return () => { alive = false; unsubscribe(); };
  }, [paper.id, activate, report, refreshCatalog]);

  useEffect(() => {
    if (!ready || !catalog.models.length) return;
    const legacy = catalog.models.find(item => item.providerId === providerId && Object.values(item.reasoningVariants ?? {}).includes(model));
    if (legacy) {
      setModel(legacy.model); setEffort(Object.entries(legacy.reasoningVariants!).find(([, slug]) => slug === model)![0]);
      return;
    }
    if (resolvedModelPaper.current === paper.id) return;
    const preference = readModelPreference();
    const concrete = catalog.models.filter(item => item.model && item.providerId === providerId);
    const initial = concrete.find(item => preference?.providerId === providerId && item.model === preference.model)
      ?? concrete.find(item => item.isDefault) ?? concrete[0];
    if (!model && initial) {
      setModel(initial.model);
      setEffort(initial.reasoningLevels.includes(preference?.effort ?? '') ? preference!.effort : initial.defaultReasoningEffort ?? '');
    }
    if (model || initial) resolvedModelPaper.current = paper.id;
  }, [ready, catalog, providerId, model, paper.id]);
  useEffect(() => {
    if (!ready || !model || !selectedModel) return;
    try { localStorage.setItem(modelPreferenceKey, JSON.stringify({ providerId, model, effort })); } catch { /* The conversation also persists this choice. */ }
  }, [ready, providerId, model, effort, selectedModel]);
  useEffect(() => { setConfig(selectedProvider?.config ?? {}); }, [selectedProvider?.id, selectedProvider?.config]);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(180, Math.max(28, input.scrollHeight))}px`;
  }, [draft.text]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.clientHeight > 0 && follow.current) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
  }, [state?.messages, state?.conversation.id]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let wasVisible = el.clientHeight > 0;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      const visible = el.clientHeight > 0;
      const appeared = visible && !wasVisible;
      wasVisible = visible;
      if (!visible || (!follow.current && !appeared)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (el.clientHeight > 0) el.scrollTo({ top: follow.current ? el.scrollHeight : rememberedScrollTop.current, behavior: 'auto' });
      });
    });
    observer.observe(el);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(''), 2200); return () => clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    if (!deleted) return;
    const timer = setTimeout(() => setDeleted(null), 8000); return () => clearTimeout(timer);
  }, [deleted]);

  const newConversation = async (contextMode: 'paper' | 'general' = 'paper') => {
    if (!selectedProvider?.available) { setError(selectedProvider?.unavailableReason ?? '模型连接不可用，请在模型设置中检查本机程序。'); return; }
    const id = paper.id; setBusy(true); setError('');
    try {
      const next = await chat.create({ paperId: id, providerId, model, effort, contextMode });
      if (paperRef.current !== id) return;
      if (state) conversationDrafts.set(state.conversation.id, editing?.previousDraft ?? draftRef.current);
      setEditing(null); setDraft(emptyDraft());
      activate(next); await refreshList(); inputRef.current?.focus();
    } catch (reason) { if (paperRef.current === id) report(reason); }
    finally { if (paperRef.current === id) setBusy(false); }
  };

  const submit = useCallback(async (value: Draft, target?: ChatState | null) => {
    const active = target === undefined ? state : target;
    if (busy || active?.running) { setError('当前回答尚未结束，可以先停止，或新建一个对话。'); return; }
    if (!value.text.trim() && !value.attachments.length && !value.references.length && !value.messageReferences.length) return;
    if (!selectedProvider?.available) { setError(selectedProvider?.unavailableReason ?? '模型连接不可用，请在模型设置中检查本机程序。'); return; }
    if (value.attachments.length && (selectedModel?.images === false || !selectedProvider.images)) { setError('当前模型不支持图片，请切换支持图片的模型。'); return; }
    const id = paper.id; setBusy(true); setError(''); follow.current = true;
    try {
      let next = active;
      if (editing && target === undefined) {
        next = await chat.fork(editing.conversationId, editing.messageId);
      }
      if (!next) {
        next = await chat.create({ paperId: id, providerId, model, effort });
      }
      if (paperRef.current !== id) return;
      currentRef.current = next.conversation.id;
      setState(next); saveSelection(id, next.conversation.id);
      // Keep the draft until the main process has accepted the request.
      await chat.send({ conversationId: next.conversation.id, text: value.text.trim() || (value.attachments.length ? '请解读这张图片。' : '请解释引用的内容。'),
        references: value.references, messageReferences: value.messageReferences, attachments: value.attachments, scope: 'paper',
        providerId, model, effort });
      if (paperRef.current !== id) return;
      setEditing(null); setDraft(emptyDraft()); drafts.delete(id); conversationDrafts.delete(next.conversation.id);
      const latest = await chat.get(next.conversation.id);
      if (paperRef.current === id && currentRef.current === next.conversation.id) setState(latest);
      await refreshList();
    } catch (reason) { if (paperRef.current === id) report(reason); }
    finally { if (paperRef.current === id) setBusy(false); }
  }, [state, busy, selectedProvider, selectedModel, providerId, model, effort, paper.id, editing, refreshList, report]);

  useEffect(() => {
    if (!ready || !request || request.paperId !== paper.id || processedRequests.current.has(request.id)) return;
    processedRequests.current.add(request.id);
    const value: Draft = {
      ...draftRef.current,
      text: request.text ?? draftRef.current.text,
      references: request.reference ? [...draftRef.current.references.filter(item => item.id !== request.reference!.id), request.reference] : draftRef.current.references,
      attachments: request.attachment ? [...draftRef.current.attachments, request.attachment] : draftRef.current.attachments,
    };
    setDraft(value);
    onRequestHandled(request.id);
    if (request.autoSend && !running && !busy) void submit(value);
    else inputRef.current?.focus();
  }, [request, ready, paper.id, onRequestHandled, submit, running, busy]);

  const addFiles = async (files: File[]) => {
    const id = paper.id; setError('');
    try {
      if (draftRef.current.attachments.length + files.length > 4) throw new Error('每条消息最多添加 4 张图片。');
      const added = await Promise.all(files.map(file => {
        if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('支持 PNG、JPEG、WebP 和 GIF 图片。');
        if (file.size > 10 * 1024 * 1024) throw new Error(`「${file.name}」超过 10 MB，请缩小后添加。`);
        return new Promise<ChatAttachment>((resolve, reject) => {
          const reader = new FileReader(); reader.onerror = () => reject(new Error(`无法读取「${file.name}」`));
          reader.onload = () => resolve({ id: uid(), name: file.name || '粘贴的图片.png', mime: file.type, dataUrl: String(reader.result) });
          reader.readAsDataURL(file);
        });
      }));
      if (paperRef.current !== id) return;
      setDraft(previous => ({ ...previous, attachments: [...previous.attachments, ...added].slice(0, 4) })); inputRef.current?.focus();
    } catch (reason) { if (paperRef.current === id) report(reason); }
  };
  const paste = (event: ClipboardEvent) => {
    const files = [...event.clipboardData.items].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file);
    if (files.length) { event.preventDefault(); void addFiles(files); }
  };
  const drop = (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); setDragging(false); void addFiles([...event.dataTransfer.files]); };
  const chooseConversation = async (conversationId: string) => {
    if (state) conversationDrafts.set(state.conversation.id, editing?.previousDraft ?? draftRef.current);
    if (!conversationId) { ++operation.current; setEditing(null); setDraft(emptyDraft()); setState(null); currentRef.current = null; saveSelection(paper.id, ''); return; }
    const id = paper.id; const revision = ++operation.current; setBusy(true); setError('');
    try { const next = await chat.get(conversationId); if (paperRef.current === id && revision === operation.current) { setEditing(null); setDraft(conversationDrafts.get(conversationId) ?? emptyDraft()); activate(next); } }
    catch (reason) { if (paperRef.current === id) report(reason); }
    finally { if (paperRef.current === id) setBusy(false); }
  };
  const deleteConversation = async (item: ChatConversation) => {
    const paperId = paper.id, wasCurrent = currentRef.current === item.id;
    setBusy(true); setError('');
    try {
      if (wasCurrent) conversationDrafts.set(item.id, editing?.previousDraft ?? draftRef.current);
      await chat.delete(item.id);
      if (paperRef.current !== paperId) return;
      setDeleted(item);
      const list = await chat.list(paperId);
      if (paperRef.current !== paperId) return;
      setConversations(list);
      if (wasCurrent) {
        setEditing(null);
        if (list[0]) { const next = await chat.get(list[0].id); if (paperRef.current !== paperId) return;
          activate(next); setDraft(conversationDrafts.get(next.conversation.id) ?? emptyDraft());
        } else { currentRef.current = null; setState(null); setDraft(emptyDraft()); saveSelection(paperId, ''); }
      }
    } catch (reason) { if (paperRef.current === paperId) report(reason); }
    finally { if (paperRef.current === paperId) setBusy(false); }
  };
  const undoDelete = async () => {
    if (!deleted) return;
    const item = deleted, paperId = paper.id;
    setBusy(true); setError('');
    try {
      const next = await chat.restore(item.id);
      if (paperRef.current !== paperId) return;
      if (state) conversationDrafts.set(state.conversation.id, editing?.previousDraft ?? draftRef.current);
      activate(next); setEditing(null); setDraft(conversationDrafts.get(item.id) ?? emptyDraft()); setDeleted(null);
      await refreshList();
    } catch (reason) { if (paperRef.current === paperId) report(reason); }
    finally { if (paperRef.current === paperId) setBusy(false); }
  };
  const beginRename = (item: ChatConversation) => { setRenaming(item); setTitleDraft(item.title); setError(''); };
  const renameConversation = async () => {
    if (!renaming) return;
    const paperId = paper.id;
    setBusy(true); setError('');
    try {
      const next = await chat.rename(renaming.id, titleDraft);
      if (paperRef.current !== paperId) return;
      if (currentRef.current === next.conversation.id) setState(next);
      setRenaming(null); await refreshList();
    } catch (reason) { if (paperRef.current === paperId) report(reason); }
    finally { if (paperRef.current === paperId) setBusy(false); }
  };
  const quoteMessage = (messageId: string, quote: string) => {
    setDraft(previous => ({ ...previous, messageReferences: [...previous.messageReferences, { id: uid(), messageId, quote }] }));
    inputRef.current?.focus();
  };
  const editMessage = (message: ChatMessage) => {
    if (!state) return;
    setEditing({ conversationId: state.conversation.id, messageId: message.id, previousDraft: editing?.previousDraft ?? draftRef.current });
    setDraft({ text: message.text, references: message.references, messageReferences: message.messageReferences, attachments: message.attachments });
    inputRef.current?.focus();
  };
  const cancelEdit = () => {
    if (!editing) return;
    setDraft(editing.previousDraft); setEditing(null); inputRef.current?.focus();
  };
  const retryMessage = async (message: ChatMessage) => {
    if (!state) return;
    const index = state.messages.findIndex(item => item.id === message.id);
    const user = state.messages.slice(0, index).reverse().find(item => item.role === 'user');
    if (!user) return;
    const id = paper.id; setError('');
    try {
      const fork = await chat.fork(state.conversation.id, user.id);
      if (paperRef.current !== id) return;
      currentRef.current = fork.conversation.id; setState(fork); saveSelection(id, fork.conversation.id);
      const value = { text: user.text, references: user.references, messageReferences: user.messageReferences, attachments: user.attachments };
      setDraft(value); await submit(value, fork);
    } catch (reason) { if (paperRef.current === id) report(reason); }
  };
  const configure = async () => {
    const id = paper.id;
    setBusy(true); setError('');
    try {
      const next = await chat.configure(configProviderId, { executablePath: config.executablePath?.trim() || undefined,
        model: config.model?.trim() || undefined, effort: config.effort?.trim() || undefined });
      if (paperRef.current !== id) return;
      setProviders(next); setProviderId(configProviderId); setConfigOpen(false);
      setModel(config.model?.trim() ?? ''); setEffort(config.effort?.trim() ?? '');
      await refreshCatalog(true); setFeedback('模型设置已保存');
    } catch (reason) { if (paperRef.current === id) report(reason); }
    finally { if (paperRef.current === id) setBusy(false); }
  };
  const copy = async (text: string) => {
    try { await api.app.copyText(text); setFeedback('已复制'); }
    catch (reason) { report(reason); }
  };
  const messageText = (message: ChatMessage) => {
    if (message.role !== 'assistant' || !/```openui\b|~~~openui\b/i.test(message.text)) return message.text;
    return document.querySelector<HTMLElement>(`#chat-msg-${message.id} .chat-answer-body`)?.innerText || message.text;
  };
  const chooseModel = (value: ChatModel) => {
    setProviderId(value.providerId); setModel(value.model); setError('');
    setEffort(previous => value.reasoningLevels.includes(previous) ? previous : value.defaultReasoningEffort ?? '');
  };
  const menuModels = catalog.models.filter(item => !!item.model && !providers.find(provider => provider.id === item.providerId)?.unavailableReason);
  if (model && !selectedProvider?.unavailableReason && !menuModels.some(item => item.providerId === providerId && item.model === model)) {
    menuModels.unshift({ id: `${providerId}:${model || 'default'}`, providerId, model, label: modelLabel, reasoningLevels: [] });
  }
  useEffect(() => {
    if (ready && selectedProvider?.unavailableReason) setError(selectedProvider.unavailableReason);
  }, [ready, selectedProvider?.unavailableReason]);
  const catalogErrors = (catalog.errors ?? []).filter(item => !providers.find(provider => provider.id === item.providerId)?.unavailableReason);
  const settingsItems = [
    ...(state ? [
      { id: 'rename', label: '重命名', icon: <IconEdit />, disabled: busy, onSelect: () => beginRename(state.conversation) },
      { id: 'delete', label: '删除对话', icon: <IconTrash />, disabled: busy, onSelect: () => { void deleteConversation(state.conversation); } },
    ] : []),
    { id: 'general', label: '新建普通对话', icon: <IconPlus />, disabled: !ready || busy, onSelect: () => { void newConversation('general'); } },
    { id: 'refresh', label: catalogLoading ? '正在更新模型…' : '更新模型列表', icon: <IconRefresh />, disabled: catalogLoading, onSelect: () => { void refreshCatalog(true); } },
    { id: 'settings', label: '模型设置…', disabled: busy || running, onSelect: () => { setConfigProviderId(providerId); setConfig({ ...selectedProvider?.config, model, effort }); setConfigOpen(true); } },
  ];

  return <section className={`chat-panel${dragging ? ' is-dragging' : ''}`} aria-label="论文 AI 对话"
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={drop}>
    <header className="chat-header">
      <ChatHistory conversations={conversations} current={state?.conversation} disabled={!ready || busy}
        onSelect={id => { void chooseConversation(id); }} onDelete={item => { void deleteConversation(item); }} onRename={beginRename} />
      <button type="button" className="btn icon ghost" onClick={() => void newConversation()} disabled={!ready || busy} title="新建对话" aria-label="新建对话"><IconPlus /></button>
      <DesktopMenu menuClassName="chat-menu" ariaLabel="对话选项" className="btn icon ghost" align="end" width={208} items={settingsItems}><IconMore /></DesktopMenu>
    </header>

    <div className="chat-messages" ref={scrollRef} onScroll={event => {
      const el = event.currentTarget;
      if (el.clientHeight === 0) return;
      rememberedScrollTop.current = el.scrollTop;
      follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70;
    }}>
      {!ready ? <div className="chat-empty"><p>正在读取对话…</p></div> : !state?.messages.length ? <div className="chat-empty">
        <IconBook width={24} height={24} aria-hidden="true" />
        <h3>{state?.conversation.contextMode === 'general' ? '聊聊你的想法' : '读懂这篇论文'}</h3><p>{state?.conversation.contextMode === 'general' ? '提问、添加图片，或引用一段对话。' : '选中正文或添加图表，聊聊你想深入的地方。'}</p>
        {state?.conversation.contextMode !== 'general' && <button onClick={() => { setDraft(value => ({ ...value, text: '请概括这篇论文要解决的问题、主要方法和关键结果。' })); inputRef.current?.focus(); }}>梳理论文思路<ArrowUpRight /></button>}
      </div> : state.messages.map(message => <article className={`chat-message ${message.role}`} data-chat-message={message.id} id={`chat-msg-${message.id}`} key={message.id}>
        <div className="chat-message-content">
        {message.role !== 'user' && <div className="chat-message-label">{catalog.models.find(item => item.providerId === message.providerId && item.model === message.model)?.label || message.model || 'AI'}
          {message.status === 'interrupted' && <span className="chat-state-icon" title="已停止" aria-label="已停止"><StopIcon /></span>}
        </div>}
        {message.references.map(reference => <PaperCard key={reference.id} value={reference} onJump={onJump} />)}
        {message.messageReferences.map(reference => <button key={reference.id} className="chat-reference message-reference" onClick={() => document.getElementById(`chat-msg-${reference.messageId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}>
          <small>引用对话</small><span>{reference.quote}</span></button>)}
        {!!message.attachments.length && <div className="chat-images">{message.attachments.map(image => <button key={image.id} onClick={() => setImagePreview(image)} title="放大查看图片"><img src={image.dataUrl} alt={image.name} /></button>)}</div>}
        {message.role === 'user' ? <p className="chat-user-text" data-chat-selectable={message.id}>{message.text}</p> : <div className="chat-answer-body"><VisualAnswer text={message.text} messageId={message.id} streaming={message.status === 'streaming'} onFollowUp={text => { setDraft(value => ({ ...value, text: [value.text, text].filter(Boolean).join('\n\n') })); inputRef.current?.focus(); }} /></div>}
        {message.status === 'streaming' && !message.text && <span className="chat-waiting" role="status" aria-label="正在生成回答"><i /><i /><i /></span>}
        {message.error && !(message.status === 'interrupted' && message.error === '回答已停止') &&
          <p className="chat-message-error" role="alert">{message.error}</p>}
        </div>
        {message.status !== 'streaming' && <div className="chat-message-actions">
          <button title="复制" aria-label="复制" onClick={() => void copy(messageText(message))} disabled={!message.text}><CopyIcon /></button>
          {message.role === 'user' ? <button title="编辑" aria-label="编辑" onClick={() => editMessage(message)} disabled={busy || running}><EditIcon /></button> : <>
            <button title="重新生成" aria-label="重新生成" onClick={() => void retryMessage(message)} disabled={busy || running || !!editing}><IconRefresh /></button>
            <DesktopMenu menuClassName="chat-menu" ariaLabel="回答选项" placement="above" width={160} items={[
              { id: 'save-note', label: '存为笔记', disabled: !message.text, onSelect: () => { void onSaveNote(messageText(message)).then(() => setFeedback('已保存到笔记')).catch(reason => { report(reason); onError(messageOf(reason)); }); } },
            ]}><IconMore /></DesktopMenu>
          </>}

        </div>}
      </article>)}
    </div>

    <ChatSelectionAction containerRef={scrollRef} onQuote={quoteMessage} conversationId={state?.conversation.id} />
    {error && <div className="chat-error" role="alert"><span>{error}</span><button className="btn icon ghost" aria-label="关闭错误提示" onClick={() => setError('')}><IconClose /></button></div>}
    {deleted && <div className="chat-undo" role="status"><span>已删除对话</span><button disabled={busy} onClick={() => void undoDelete()}>撤销</button></div>}
    {feedback && <div className="chat-feedback" role="status">{feedback}</div>}
    <div className="chat-composer-wrap">
      <div className="chat-composer">
        {editing && <div className="chat-editing"><EditIcon /><span>编辑消息</span><button title="取消编辑" aria-label="取消编辑" onClick={cancelEdit}><IconClose /></button></div>}
        {(draft.references.length > 0 || draft.messageReferences.length > 0) && <div className="chat-draft-references">
          {draft.references.map(reference => <div className="chat-removable" key={reference.id}><PaperCard value={reference} onJump={onJump} /><button aria-label="移除论文引用" onClick={() => setDraft(value => ({ ...value, references: value.references.filter(item => item.id !== reference.id) }))}><IconClose width={12} height={12} /></button></div>)}
          {draft.messageReferences.map(reference => <div className="chat-removable" key={reference.id}><div className="chat-reference"><small>引用对话</small><span>{reference.quote}</span></div><button aria-label="移除对话引用" onClick={() => setDraft(value => ({ ...value, messageReferences: value.messageReferences.filter(item => item.id !== reference.id) }))}><IconClose width={12} height={12} /></button></div>)}
        </div>}
        {!!draft.attachments.length && <div className="chat-draft-images">{draft.attachments.map(image => <div key={image.id}><img src={image.dataUrl} alt={image.name} /><button aria-label={`移除${image.name}`} onClick={() => setDraft(value => ({ ...value, attachments: value.attachments.filter(item => item.id !== image.id) }))}><IconClose width={11} height={11} /></button></div>)}</div>}
        <textarea ref={inputRef} aria-label="向 AI 提问" value={draft.text} placeholder={state?.conversation.contextMode === 'general' ? '发送消息…' : '问问这篇论文…'} rows={1} onPaste={paste}
          onChange={event => setDraft(value => ({ ...value, text: event.target.value }))} onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!running && !busy) void submit(draftRef.current); }
            if (event.key === 'Escape') { event.stopPropagation(); cancelEdit(); }
          }} />
        <div className="chat-composer-tools">
          <input type="file" ref={fileRef} accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => { void addFiles([...event.target.files ?? []]); event.target.value = ''; }} />
          <button className="btn icon ghost" title="添加图片，也可以粘贴或拖入" aria-label="添加图片" onClick={() => fileRef.current?.click()}><IconPlus /></button>
          <span className="chat-tools-spacer" />
          {running ? <button className="chat-send stop" title="停止回答" aria-label="停止回答" onClick={() => void chat.stop(state!.conversation.id).catch(report)}><StopIcon /></button>
            : <button className="chat-send" title="发送 · Enter，换行 · Shift+Enter" aria-label="发送消息" disabled={!ready || busy || (!draft.text.trim() && !draft.attachments.length && !draft.references.length && !draft.messageReferences.length)} onClick={() => void submit(draftRef.current)}><ArrowUp /></button>}
        </div>
      </div>
      <div className="chat-model-bar">
        <DesktopMenu menuClassName="chat-menu" ariaLabel="选择模型" className="chat-model-select" placement="above" width={300} searchable searchPlaceholder="搜索模型…" disabled={!ready || busy || running} items={[
          ...menuModels.map(item => ({ id: item.id, label: item.label, selected: item.providerId === providerId && item.model === model,
            description: providers.find(provider => provider.id === item.providerId)?.label,
            disabled: providers.find(provider => provider.id === item.providerId)?.available === false, onSelect: () => chooseModel(item) })),
          { id: 'custom-model', label: '自定义模型…', onSelect: () => { setConfigProviderId(providerId); setConfig({ ...selectedProvider?.config, model, effort }); setConfigOpen(true); } },
        ]}><span>{modelLabel}</span><IconChevronDown width={11} height={11} /></DesktopMenu>
        <DesktopMenu menuClassName="chat-menu" ariaLabel="思考程度" className="chat-effort-select" placement="above" align="end" width={172} disabled={!ready || busy || running} items={[
          ...(providerId === 'agy' && selectedModel?.reasoningVariants ? [] : [{ id: 'default', label: 'Default', selected: !effort, onSelect: () => setEffort('') }]),
          ...reasoningLevels.map(level => ({ id: level, label: effortLabel(level), selected: (effort || (selectedModel?.reasoningVariants ? selectedModel.defaultReasoningEffort : '')) === level, onSelect: () => setEffort(level) })),
        ]}><ReasoningIcon /><span>{effortLabel(effort || (selectedModel?.reasoningVariants ? selectedModel.defaultReasoningEffort ?? '' : ''))}</span><IconChevronDown width={11} height={11} /></DesktopMenu>
      </div>
    </div>
    {dragging && <div className="chat-drop-overlay">松开以添加图片</div>}
    {configOpen && <Modal title="模型设置" className="chat-model-settings collection-dialog" busy={busy} onClose={() => setConfigOpen(false)} footer={<>
      <button className="btn ghost" disabled={busy} onClick={() => setConfigOpen(false)}>取消</button>
      <button className="btn primary" disabled={busy} onClick={() => void configure()}>保存</button>
    </>}>
      {configProvider?.unavailableReason && <p className="chat-connection-status">{configProvider.unavailableReason}</p>}
      <div className="field"><label htmlFor="chat-custom-model">自定义模型</label><input id="chat-custom-model" placeholder="使用本机默认模型" value={config.model ?? ''} onChange={event => setConfig(value => ({ ...value, model: event.target.value, effort: '' }))} /></div>
      <details className="chat-advanced"><summary>高级连接</summary>
        <div className="field"><label htmlFor="chat-connection">本机连接</label><select id="chat-connection" value={configProviderId} onChange={event => { const id = event.target.value as AgentId; setConfigProviderId(id); setConfig(providers.find(item => item.id === id)?.config ?? {}); }}>{providers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
        <button className="btn ghost" onClick={() => setConfig(value => ({ ...value, model: '', effort: '' }))}>使用本机默认模型</button><div className="field"><label htmlFor="chat-program">本机程序路径</label><input id="chat-program" placeholder={configProvider?.executablePath ?? '自动查找'} value={config.executablePath ?? ''} onChange={event => setConfig(value => ({ ...value, executablePath: event.target.value }))} /></div></details>
      {!!catalogErrors.length && <div className="chat-catalog-errors">{catalogErrors.map(item => <p key={item.providerId}>{providers.find(provider => provider.id === item.providerId)?.label}：{item.message}</p>)}<button className="btn ghost" disabled={catalogLoading} onClick={() => void refreshCatalog(true)}><IconRefresh />重新读取模型</button></div>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </Modal>}
    {renaming && <Modal title="重命名对话" className="collection-dialog" busy={busy} onClose={() => setRenaming(null)} footer={<>
      <button className="btn ghost" disabled={busy} onClick={() => setRenaming(null)}>取消</button>
      <button className="btn primary" disabled={busy || !titleDraft.trim()} onClick={() => void renameConversation()}>保存</button>
    </>}>
      <div className="field"><label htmlFor="chat-title">对话名称</label><input id="chat-title" value={titleDraft} maxLength={120} onChange={event => setTitleDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && !busy && titleDraft.trim()) void renameConversation(); }} /></div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </Modal>}
    {imagePreview && <Modal title={imagePreview.name} className="chat-image-preview" onClose={() => setImagePreview(null)}>
      <img src={imagePreview.dataUrl} alt={imagePreview.name} />
    </Modal>}
  </section>;
}

function ArrowUp() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-5 5 5-5 5 5" /></svg>; }
function ArrowUpRight() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg>; }
function StopIcon() { return <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.7" /></svg>; }
function ReasoningIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18h6m-5 3h4M8 15a7 7 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3Z" /></svg>; }

function PaperCard({ value, onJump }: { value: PaperReference; onJump(value: PaperReference): void }) {
  return <button className="chat-reference paper-reference" onClick={() => onJump(value)} title={`返回「${value.title}」原文`}>
    <small><strong className="chat-reference-title" title={value.title}>{value.title}</strong>
      <span className="chat-reference-page">第 {value.page} 页{value.translated ? ' · 译文' : ''}</span><span aria-hidden="true">↗</span></small><span>{value.quote}</span>
  </button>;
}

function CopyIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>; }
function EditIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15Z" /></svg>; }
