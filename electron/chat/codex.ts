import { jsonProcess, terminateChild, abortError } from './process.js';
import type { RunAgent } from './provider-types.js';

export const runCodex: RunAgent = async input => {
  if (input.signal.aborted) throw abortError();
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 1;
  let threadId = '';
  let turnId = '';
  let finished = false;
  const emitted = new Map<string, string>();
  let lastItem = '';
  const emit = (id: string, text: string) => {
    if (!text || input.signal.aborted) return;
    if (lastItem && lastItem !== id) input.onText('\n\n');
    lastItem = id;
    input.onText(text);
    emitted.set(id, (emitted.get(id) ?? '') + text);
  };
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  let interruptRequested = false;
  let resolveTurn!: () => void;
  let rejectTurn!: (error: Error) => void;
  const complete = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  // Attach rejection handling before initialization, since a subprocess may fail immediately.
  void complete.catch(() => {});
  const proc = jsonProcess(input.executable, [
    'app-server', '--stdio',
    '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false',
    '-c', 'features.hooks=false', '-c', 'features.plugins=false',
    '-c', 'mcp_servers={}', '-c', 'web_search="disabled"',
  ], input.cwd, message => {
    if (message.id !== undefined && !message.method) {
      const request = pending.get(Number(message.id));
      if (request) {
        clearTimeout(request.timer); pending.delete(Number(message.id));
        if (message.error) request.reject(new Error(message.error.message || 'Codex 协议请求失败'));
        else request.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      // Reading mode never grants a tool permission or an external side effect.
      const method = String(message.method);
      if (method === 'item/permissions/requestApproval') proc.send({ id: message.id, result: { permissions: {}, scope: 'turn' } });
      else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') proc.send({ id: message.id, result: { decision: 'decline' } });
      else proc.send({ id: message.id, error: { code: -32601, message: '论文解读模式未开放此工具' } });
      return;
    }
    const p = message.params ?? {};
    if (p.threadId && threadId && p.threadId !== threadId) return;
    if (message.method === 'item/agentMessage/delta') {
      if (typeof p.delta === 'string') emit(p.itemId ?? 'anonymous', p.delta);
    } else if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
      if (typeof p.item.text === 'string') {
        const id = p.item.id ?? 'anonymous', previous = emitted.get(id) ?? '';
        if (p.item.text.startsWith(previous)) emit(id, p.item.text.slice(previous.length));
        else rejectTurn(new Error('Codex 完成消息与已接收的流式内容不一致'));
      }
    } else if (message.method === 'turn/started') turnId = p.turn?.id ?? turnId;
    else if (message.method === 'turn/completed') {
      finished = true;
      if (input.signal.aborted || p.turn?.status === 'interrupted') rejectTurn(abortError());
      else if (p.turn?.status === 'failed') rejectTurn(new Error(p.turn?.error?.message || 'Codex 回答失败'));
      else resolveTurn();
    } else if (message.method === 'error' && !p.willRetry) {
      rejectTurn(new Error(p.error?.message || p.message || 'Codex 运行失败'));
    }
  });
  const closed = (error: Error) => {
    if (!finished) rejectTurn(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  void proc.done.then(() => closed(new Error('Codex 进程未返回回答完成状态')), closed);
  const rpc = (method: string, params: unknown): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} 响应超时`)); }, 30000);
      pending.set(id, { resolve, reject, timer });
      proc.send({ id, method, params });
    });
  };
  const abort = () => {
    if (interruptRequested) return;
    interruptRequested = true;
    if (threadId && turnId) {
      // Give the native session a bounded opportunity to persist its interrupted turn.
      void rpc('turn/interrupt', { threadId, turnId }).catch(() => {
        terminateChild(proc.child); rejectTurn(abortError());
      });
      abortTimer = setTimeout(() => { terminateChild(proc.child); rejectTurn(abortError()); }, 1500);
    } else {
      terminateChild(proc.child); rejectTurn(abortError());
    }
  };
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    await rpc('initialize', { clientInfo: { name: 'scholarlite', title: 'ScholarLite', version: '0.1.0' }, capabilities: {} });
    proc.send({ method: 'initialized', params: {} });
    if (input.signal.aborted) throw abortError();
    const config = { cwd: input.cwd, approvalPolicy: 'never', sandbox: 'read-only', ...(input.config.model ? { model: input.config.model } : {}) };
    const response = input.sessionId
      ? await rpc('thread/resume', { ...config, threadId: input.sessionId })
      : await rpc('thread/start', config);
    threadId = response.thread.id;
    input.onSession(threadId);
    if (input.signal.aborted) throw abortError();
    const responseTurn = await rpc('turn/start', {
      threadId, cwd: input.cwd, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
      ...(input.config.model ? { model: input.config.model } : {}),
      ...(input.config.effort ? { effort: input.config.effort } : {}),
      input: [{ type: 'text', text: input.prompt }, ...input.images.map(image => ({ type: 'localImage', path: image.path }))],
    });
    turnId = responseTurn.turn.id;
    if (input.signal.aborted) { abort(); await complete; }
    await complete;
  } finally {
    finished = true;
    if (abortTimer) clearTimeout(abortTimer);
    input.signal.removeEventListener('abort', abort);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Codex 连接已关闭')); }
    pending.clear();
    proc.close();
    await proc.done.catch(() => {});
  }
};
