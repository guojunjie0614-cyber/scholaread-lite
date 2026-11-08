import { jsonProcess, terminateChild, abortError } from './process.js';
import type { RunAgent } from './provider-types.js';

export const runClaude: RunAgent = async input => {
  if (input.signal.aborted) throw abortError();
  const emitted = new Map<string, string>();
  let currentId = 'anonymous', lastId = '';
  const emit = (id: string, text: string) => {
    if (!text || input.signal.aborted) return;
    if (lastId && lastId !== id) input.onText('\n\n');
    input.onText(text); lastId = id;
    emitted.set(id, (emitted.get(id) ?? '') + text);
  };
  let resultSeen = false;
  let resultError: Error | undefined;
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    // Safe mode preserves native auth/model configuration; restricted mode discards user settings.
    '--verbose', '--include-partial-messages', '--safe-mode',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--permission-prompts', 'none', '--disable-slash-commands',
  ];
  if (input.sessionId) args.push('--resume', input.sessionId);
  if (input.config.model) args.push('--model', input.config.model);
  if (input.config.effort) args.push('--effort', input.config.effort);
  const proc = jsonProcess(input.executable, args, input.cwd, message => {
    if (typeof message.session_id === 'string') input.onSession(message.session_id);
    if (message.type === 'stream_event') {
      const event = message.event;
      if (event?.type === 'message_start') currentId = event.message?.id ?? 'anonymous';
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && !input.signal.aborted) {
        emit(currentId, event.delta.text);
      }
    } else if (message.type === 'assistant' && !input.signal.aborted) {
      const text = (message.message?.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
      const id = message.message?.id ?? currentId, previous = emitted.get(id) ?? '';
      if (text.startsWith(previous)) emit(id, text.slice(previous.length));
    } else if (message.type === 'result') {
      resultSeen = true;
      if (message.is_error || message.subtype && message.subtype !== 'success') {
        resultError = new Error(message.errors?.join('\n') || message.result || 'Claude Code 回答失败');
      } else if (!emitted.size && typeof message.result === 'string' && !input.signal.aborted) emit(currentId, message.result);
      proc.child.stdin.end();
    } else if (message.type === 'control_request') {
      proc.send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: '论文解读模式未开放工具权限' } });
    }
  });
  const abort = () => terminateChild(proc.child);
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    proc.send({ type: 'user', session_id: input.sessionId ?? '', parent_tool_use_id: null,
      message: { role: 'user', content: [
        { type: 'text', text: input.prompt },
        ...input.images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } })),
      ] },
    });
    // EOF is the documented print-mode input completion signal. The turn can still stream output.
    proc.child.stdin.end();
    try { await proc.done; } catch (error) { if (resultError) throw resultError; throw error; }
    if (input.signal.aborted) throw abortError();
    if (resultError) throw resultError;
    if (!resultSeen) throw new Error('Claude Code 未返回完成状态，请检查本机登录和 CLI 版本');
  } finally {
    input.signal.removeEventListener('abort', abort);
    proc.close();
  }
};
