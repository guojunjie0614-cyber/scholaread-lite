import type { IpcMain, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { refreshTranslationQueue, translateBatch, readCachedTranslations, TranslationBatchFailure } from './translate.js';
import type { TranslateOptions, TranslationPriority, TranslationSegment } from '../shared/types.js';

/** Each renderer owns its requests; closing or reloading it releases upstream work. */
export function registerTranslationIpc(ipc: Pick<IpcMain, 'handle'>) {
  type Request = { controller: AbortController; priority: TranslationPriority };
  const owners = new Map<WebContents, Map<string, Request>>();
  const requestsFor = (sender: WebContents) => {
    let requests = owners.get(sender);
    if (!requests) {
      requests = new Map();
      owners.set(sender, requests);
      const abortAll = () => {
        for (const request of requests!.values()) request.controller.abort();
        requests!.clear();
      };
      sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) abortAll();
      });
      sender.on('render-process-gone', abortAll);
      sender.once('destroyed', () => { abortAll(); owners.delete(sender); });
    }
    return requests;
  };
  const validId = (id: unknown): id is string =>
    typeof id === 'string' && id.length > 0 && id.length <= 160;
  const validPriority = (value: unknown): value is TranslationPriority =>
    value === 'interactive' || value === 'visible' || value === 'background';

  ipc.handle('translate:cached', (_event, texts: string[], target: string) => {
    if (!Array.isArray(texts) || texts.some(text => typeof text !== 'string') || typeof target !== 'string') throw new Error('翻译缓存查询参数无效');
    return readCachedTranslations(texts, target);
  });

  ipc.handle('translate:batch', async (event, texts: string[], target?: string, requestId?: string, options?: TranslateOptions) => {
    if (!Array.isArray(texts)) throw new Error('texts 必须是数组');
    if (requestId !== undefined && !validId(requestId)) throw new Error('翻译请求 ID 无效');
    if (options !== undefined && (!options || typeof options !== 'object'
      || (options.priority !== undefined && !validPriority(options.priority))
      || (options.refresh !== undefined && typeof options.refresh !== 'boolean'))) throw new Error('翻译请求优先级无效');
    const id = requestId ?? randomUUID();
    const requests = requestsFor(event.sender);
    if (requests.has(id)) throw new Error('翻译请求 ID 已在使用');
    const controller = new AbortController();
    const request: Request = { controller, priority: options?.priority ?? 'visible' };
    requests.set(id, request);
    try {
      return await translateBatch(texts.map(text => typeof text === 'string' ? text : ''), target, controller.signal, {
        getPriority: () => request.priority,
        refresh: options?.refresh,
        onSegment: (index, text, origin) => {
          if (!requestId || controller.signal.aborted || requests.get(id) !== request || event.sender.isDestroyed()) return;
          const segment: TranslationSegment = { requestId: id, index, text, origin };
          event.sender.send('translate:segment', segment);
        },
      });
    } catch (error) {
      // Electron discards custom Error fields. Send paragraph failures explicitly.
      if (error instanceof TranslationBatchFailure) return error.result;
      throw error;
    } finally {
      if (requests.get(id) === request) requests.delete(id);
    }
  });
  ipc.handle('translate:cancel', (event, requestId: string) => {
    if (!validId(requestId)) throw new Error('翻译请求 ID 无效');
    owners.get(event.sender)?.get(requestId)?.controller.abort();
  });
  ipc.handle('translate:prioritize', (event, requestId: string, priority: TranslationPriority) => {
    if (!validId(requestId)) throw new Error('翻译请求 ID 无效');
    if (!validPriority(priority)) throw new Error('翻译请求优先级无效');
    const request = owners.get(event.sender)?.get(requestId);
    if (request) { request.priority = priority; refreshTranslationQueue(); }
  });
}
