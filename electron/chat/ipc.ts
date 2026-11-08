import { app, BrowserWindow, clipboard, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chatService } from './service.js';
import type { AgentConfig, AgentId, ChatSendInput } from '../../shared/chat-types.js';

function trusted(sender: WebContents): boolean {
  if (sender.isDestroyed() || !BrowserWindow.fromWebContents(sender)) return false;
  try {
    const url = new URL(sender.getURL());
    if (process.env.VITE_DEV_SERVER_URL) return url.origin === new URL(process.env.VITE_DEV_SERVER_URL).origin;
    // The macOS bundle links Resources/app to the checkout; Chromium resolves that link.
    return url.protocol === 'file:' && fs.realpathSync(fileURLToPath(url)) === fs.realpathSync(path.join(app.getAppPath(), 'dist/index.html'));
  } catch { return false; }
}

export function registerChatIpc() {
  const subscribers = new Set<WebContents>();
  const service = chatService(event => {
    for (const sender of subscribers) {
      if (trusted(sender)) sender.send('chat:event', event);
      else subscribers.delete(sender);
    }
  });
  const handle = (channel: string, operation: (...args: any[]) => unknown) => ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!trusted(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('此窗口无权访问 AI 对话');
    if (!subscribers.has(event.sender)) {
      subscribers.add(event.sender);
      event.sender.once('destroyed', () => subscribers.delete(event.sender));
    }
    return operation(...args);
  });
  handle('chat:providers', () => service.providers());
  handle('chat:catalog', (refresh?: boolean) => service.catalog(refresh));
  handle('chat:configure', (id: AgentId, config: AgentConfig) => service.configure(id, config));
  handle('chat:list', (paperId: string) => service.list(paperId));
  handle('chat:create', input => service.create(input));
  handle('chat:get', (id: string) => service.get(id));
  handle('chat:delete', (id: string) => service.delete(id));
  handle('chat:restore', (id: string) => service.restore(id));
  handle('chat:rename', (id: string, title: string) => service.rename(id, title));
  handle('chat:fork', (id: string, beforeMessageId: string) => service.fork(id, beforeMessageId));
  handle('chat:send', (input: ChatSendInput) => service.send(input));
  handle('chat:stop', (id: string) => service.stop(id));
  handle('chat:copyText', (text: unknown) => {
    if (typeof text !== 'string' || text.length > 1000000) throw new Error('复制内容无效或过长');
    clipboard.writeText(text);
  });
}
