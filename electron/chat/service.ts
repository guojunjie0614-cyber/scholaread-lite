import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, papers, blocks } from '../db.js';
import { paths } from '../paths.js';
import { createChatStore } from './store.js';
import { createProviderSettings, isAgentId } from './providers.js';
import { createModelCatalog, normalizeAgySelection } from './catalog.js';
import { createAttachments } from './attachments.js';
import { buildChatPrompt, buildGeneralPrompt, validateReferences } from './context.js';
import { runCodex } from './codex.js';
import { runClaude } from './claude.js';
import { runAgy } from './agy.js';
import type { RunAgent } from './provider-types.js';
import type { AgentId, ChatApi, ChatEvent, ChatMessage, ChatSendInput, ChatState } from '../../shared/chat-types.js';
import { containsChatQuote } from '../../shared/chat-text.js';

const runners: Record<AgentId, RunAgent> = { codex: runCodex, claude: runClaude, agy: runAgy };
let singleton: ReturnType<typeof createChatService> | undefined;

function validateSelection(input: { providerId?: unknown; model?: unknown; effort?: unknown }) {
  if (input.providerId !== undefined && !isAgentId(input.providerId)) throw new Error('模型连接无效');
  for (const key of ['model', 'effort'] as const) {
    const value = input[key];
    if (value !== undefined && (typeof value !== 'string' || value.length > 500 || /[\x00\r\n]/.test(value))) throw new Error('模型或思考程度无效');
  }
}

export function createChatService(root: string, emit: (event: ChatEvent) => void, runAgents = runners) {
  fs.mkdirSync(root, { recursive: true });
  const store = createChatStore(db), providers = createProviderSettings(root), attachments = createAttachments(root);
  const catalog = createModelCatalog(root, providers.list);
  const running = new Map<string, { controller: AbortController; paperId: string; message: ChatMessage; timer?: ReturnType<typeof setTimeout> }>();
  const preparing = new Map<string, AbortController>();
  store.recover();
  const assertPaper = (id: unknown) => {
    if (typeof id !== 'string') throw new Error('文献 ID 无效');
    const paper = papers.get(id);
    if (!paper) throw new Error('文献不存在');
    return paper;
  };
  const get = (id: string): ChatState => {
    if (typeof id !== 'string') throw new Error('对话 ID 无效');
    const conversation = store.get(id);
    assertPaper(conversation.paperId);
    const messages = store.messages(id), active = running.get(id);
    if (active) {
      const index = messages.findIndex(message => message.id === active.message.id);
      if (index >= 0) messages[index] = active.message;
    }
    return { conversation, messages, running: running.has(id) };
  };
  const publish = (id: string) => { try { emit({ conversationId: id, state: get(id) }); } catch (error) { console.error('[chat] publish', error instanceof Error ? error.message : String(error)); } };
  const create: ChatApi['create'] = async input => {
    assertPaper(input?.paperId);
    validateSelection(input);
    if (!isAgentId(input.providerId)) throw new Error('模型连接无效');
    if (input.contextMode !== undefined && input.contextMode !== 'paper' && input.contextMode !== 'general') throw new Error('对话上下文模式无效');
    const provider = providers.get(input.providerId);
    const selectedModel = input.model?.trim() ?? provider.config.model ?? '';
    const selectedEffort = input.effort?.trim() ?? provider.config.effort ?? '';
    const selection = input.providerId === 'agy' ? normalizeAgySelection((await catalog()).models, selectedModel, selectedEffort)
      : { model: selectedModel, effort: selectedEffort };
    const conversation = store.create(input.paperId, input.providerId, selection.model, '新对话', selection.effort, input.contextMode ?? 'paper');
    return get(conversation.id);
  };
  const sendMessage = async (value: ChatSendInput, preparation: AbortSignal) => {
    if (!value || typeof value.conversationId !== 'string' || typeof value.text !== 'string' || value.text.length > 60000) throw new Error('对话消息无效或过长');
    const conversation = store.get(value.conversationId), paper = assertPaper(conversation.paperId);
    validateSelection(value);
    if (running.has(conversation.id)) throw new Error('本对话仍在回答中，请先停止或等待完成');
    if (running.size >= 3) throw new Error('已有 3 个对话运行，请先等待一个完成');
    const providerId = value.providerId ?? conversation.providerId;
    const provider = providers.get(providerId);
    if (!provider.available || !provider.executablePath) throw new Error(provider.unavailableReason ?? `未找到 ${provider.label}，请在 AI 连接设置中指定可执行文件`);
    const sameProvider = providerId === conversation.providerId;
    const requestedModel = value.model?.trim() ?? (sameProvider ? conversation.model : provider.config.model ?? '');
    const requestedEffort = value.effort?.trim() ?? (sameProvider ? conversation.effort ?? provider.config.effort ?? '' : provider.config.effort ?? '');
    // Validate newly requested capability choices; existing configured callers keep their original contract.
    const options = providerId === 'agy' || value.model !== undefined || value.effort !== undefined ? (await catalog()).models : [];
    const selection = providerId === 'agy' ? normalizeAgySelection(options, requestedModel, requestedEffort)
      : { model: requestedModel, effort: requestedEffort, option: options.find(option => option.providerId === providerId && option.model === requestedModel) };
    const { model, effort, option } = selection;
    // Native resumes can retain turn overrides; a fresh session reliably restores local defaults.
    const resetSession = !sameProvider || value.model !== undefined && !model && Boolean(conversation.model)
      || value.effort !== undefined && !effort && Boolean(conversation.effort);
    if (preparation.aborted) throw new Error('已取消发送');
    if (running.size >= 3) throw new Error('已有 3 个对话运行，请先等待一个完成');
    if (value.effort?.trim() && option?.source === 'runtime') {
      // Configured/default entries have no capability evidence. Preserve their
      // requested override for the CLI instead of treating discovery failure as refusal.
      if (!option.reasoningLevels.includes(effort)) throw new Error('当前模型未提供该思考程度，请刷新模型列表或选择默认');
    }
    if (option?.reasoningVariants && !option.reasoningVariants[effort]) throw new Error('当前模型未提供该思考程度，请刷新模型列表后重新选择');
    if (value.scope !== undefined && value.scope !== 'selection' && value.scope !== 'paper') throw new Error('论文上下文范围无效');
    const references = validateReferences(value.references, paper);
    if (value.attachments !== undefined && (!Array.isArray(value.attachments) || value.attachments.length > 4)) throw new Error('一次最多发送 4 张图片');
    if (value.attachments?.length && !provider.images) throw new Error(`${provider.label} 当前命令行接口不支持图片，请切换到 Codex 或 Claude Code`);
    const history = store.messages(conversation.id);
    if (option?.images === false && (value.attachments?.length || history.some(message => message.attachments.length)))
      throw new Error('当前模型不支持图片，请选择支持图片的模型');
    if (value.messageReferences !== undefined && (!Array.isArray(value.messageReferences) || value.messageReferences.length > 8)) throw new Error('对话引用无效');
    const messageReferences = (value.messageReferences ?? []).map(reference => {
      const source = reference && history.find(message => message.id === reference.messageId || message.originIds?.includes(reference.messageId));
      if (!source || typeof reference.quote !== 'string' || reference.quote.length > 20000 || !containsChatQuote(source.text, reference.quote)) throw new Error('引用的对话片段不存在');
      return { id: randomUUID(), messageId: source.id, quote: reference.quote };
    });
    if (!value.text.trim() && !references.length && !value.attachments?.length) throw new Error('请输入问题或添加引用、图片');
    const sessionId = resetSession ? undefined : store.session(conversation.id);
    const input = { ...value, references, messageReferences, text: value.text.trim() || '请解释所附材料。' };
    // Validate the complete prompt before persisting messages or starting a model turn.
    const prompt = conversation.contextMode === 'general' ? buildGeneralPrompt(input, sessionId ? [] : history)
      : buildChatPrompt(paper, blocks.list(paper.id), input, sessionId ? [] : history);
    if ((!sessionId ? history.flatMap(message => message.attachments).length : 0) + (value.attachments?.length ?? 0) > 16)
      throw new Error('分支包含的图片过多，请新建对话后重新选择所需图片');
    const savedAttachments = attachments.saveMany(value.attachments ?? [], value.attachments?.length ? store.attachmentsForPaper(paper.id) : []);
    const images = [...(!sessionId ? history.flatMap(message => message.attachments) : []), ...savedAttachments].map(attachment => attachments.read(attachment));
    if (images.length > 16) throw new Error('分支包含的图片过多，请新建对话后重新选择所需图片');
    const date = new Date().toISOString();
    const user: ChatMessage = { id: randomUUID(), conversationId: conversation.id, role: 'user', text: input.text,
      references, messageReferences, attachments: savedAttachments, status: 'complete', createdAt: date };
    const assistant: ChatMessage = { id: randomUUID(), conversationId: conversation.id, role: 'assistant', text: '',
      references: [], messageReferences: [], attachments: [], status: 'streaming', createdAt: date, providerId, model, effort };
    store.selectModel(conversation.id, providerId, model, effort, resetSession);
    store.saveMessage(user); store.saveMessage(assistant);
    if (!history.length && conversation.title === '新对话') store.title(conversation.id, input.text.slice(0, 42));
    const controller = new AbortController(), active = { controller, paperId: paper.id, message: assistant, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    running.set(conversation.id, active);
    const cwd = path.join(root, 'sessions', conversation.id);
    fs.mkdirSync(cwd, { recursive: true });
    publish(conversation.id);
    const flush = () => {
      active.timer = undefined;
      if (running.get(conversation.id) !== active || !store.exists(conversation.id)) { controller.abort(); return; }
      store.saveMessage(assistant); publish(conversation.id);
    };
    void (async () => {
      const timeout = setTimeout(() => controller.abort(new Error('Agent 响应超过 15 分钟，请稍后重试')), 15 * 60 * 1000);
      timeout.unref();
      try {
        const runtimeModel = providerId === 'agy' ? option?.reasoningVariants?.[effort] ?? model : model;
        await runAgents[providerId]({ executable: provider.executablePath!, config: { ...provider.config, model: runtimeModel || undefined, effort: providerId === 'agy' ? undefined : effort || undefined },
          cwd, sessionId, prompt, images, history: sessionId ? [] : history, contextMode: conversation.contextMode, signal: controller.signal,
          onSession(id) { if (!controller.signal.aborted && running.get(conversation.id) === active) store.setSession(conversation.id, id); },
          onText(text) {
            if (controller.signal.aborted || typeof text !== 'string') return;
            assistant.text += text;
            if (!active.timer) active.timer = setTimeout(flush, 160);
          },
        });
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!assistant.text.trim()) throw new Error('Agent 返回了空回答，请检查模型与本机登录');
        assistant.status = 'complete';
      } catch (error) {
        assistant.status = controller.signal.aborted ? 'interrupted' : 'failed';
        assistant.error = controller.signal.aborted
          ? controller.signal.reason instanceof Error && controller.signal.reason.name !== 'AbortError' ? controller.signal.reason.message : '回答已停止'
          : error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timeout);
        if (active.timer) clearTimeout(active.timer);
        const ownsRun = running.get(conversation.id) === active;
        if (ownsRun) running.delete(conversation.id);
        if (ownsRun && store.exists(conversation.id)) { store.saveMessage(assistant); publish(conversation.id); }
      }
    })();
  };
  const send = async (value: ChatSendInput) => {
    if (!value || typeof value.conversationId !== 'string') throw new Error('对话消息无效');
    if (preparing.has(value.conversationId)) throw new Error('本对话正在准备消息，请稍后再试');
    const preparation = new AbortController();
    preparing.set(value.conversationId, preparation);
    try { await sendMessage(value, preparation.signal); } finally { if (preparing.get(value.conversationId) === preparation) preparing.delete(value.conversationId); }
  };
  return {
    providers: async () => providers.list(),
    catalog,
    configure: async (...args: Parameters<typeof providers.configure>) => providers.configure(...args),
    list: async (paperId: string) => { assertPaper(paperId); return store.list(paperId); },
    create, get: async (id: string) => get(id), send,
    delete: async (id: string) => {
      get(id);
      preparing.get(id)?.abort();
      preparing.delete(id);
      const active = running.get(id);
      if (active) {
        active.controller.abort();
        if (active.timer) clearTimeout(active.timer);
        running.delete(id);
        store.saveMessage({ ...active.message, status: 'interrupted', error: '回答已停止' });
        // Undo can be immediate while the native runner is still stopping. Replay into a fresh session.
        store.setSession(id, null);
      }
      const state = get(id);
      store.delete(id);
      emit({ conversationId: id, state, deleted: true });
    },
    restore: async (id: string) => {
      store.restore(id);
      const state = get(id); publish(id); return state;
    },
    rename: async (id: string, title: string) => {
      get(id);
      if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 || /[\x00\r\n]/.test(title)) throw new Error('对话名称应为 1–120 个字符，且不能包含换行');
      store.title(id, title.trim());
      const state = get(id); publish(id); return state;
    },
    fork: async (id: string, beforeMessageId: string) => {
      if (running.has(id)) throw new Error('请先停止回答再创建分支');
      get(id);
      return get(store.fork(id, beforeMessageId).id);
    },
    stop: async (id: string) => { get(id); preparing.get(id)?.abort(); running.get(id)?.controller.abort(); },
    stopAll: (paperId?: string) => {
      for (const [id, preparation] of preparing) if (!paperId || store.exists(id) && store.get(id).paperId === paperId) preparation.abort();
      for (const run of running.values()) if (!paperId || run.paperId === paperId) run.controller.abort();
    },
  };
}

export function chatService(emit?: (event: ChatEvent) => void) {
  if (!singleton) singleton = createChatService(path.join(paths.root(), 'chat'), emit ?? (() => {}));
  return singleton;
}
export function stopChatAgents(paperId?: string) { singleton?.stopAll(paperId); }
