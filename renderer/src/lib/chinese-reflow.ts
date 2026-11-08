import type { Block, CachedTranslation, TranslateResult, TranslationPriority, TranslationOrigin, TranslationFailure } from '@shared/types';
import { protectTranslationMath, translationSource, translatedRuns, type TranslationRun } from '@shared/translation-scripts';
import { isTranslatableContent, isUntranslatedSourceContent } from '@shared/reading-content';

export type TranslatedBlocks = Record<string, { source: string; text: string; runs: TranslationRun[]; origin?: TranslationOrigin; restored?: boolean }>;
export interface TranslationBlockState {
  status: 'queued' | 'running' | 'succeeded' | 'retryable' | 'failed' | 'cancelled';
  attempts: number;
  retryAt?: number;
  refresh?: boolean;
  error?: string;
}
export type TranslationScope = 'reading' | 'all';
export type TranslationPageStatus = 'queued' | 'translating' | 'mixed' | 'ready' | 'error' | 'untranslated';
export interface TranslationPageState { status: TranslationPageStatus; error?: string }
export interface ReflowBatchOptions {
  priority: TranslationPriority;
  blocks: Block[];
  signal: AbortSignal;
  onSegment: (index: number, text: string, origin?: TranslationOrigin) => void;
}

export function translatableBlocks(blocks: Block[]): Block[] {
  return blocks.filter(isTranslatableContent);
}

/** A bad cache entry must not discard independent, valid paragraphs. */
export function restoreCachedReflow(blocks: Block[], hits: (CachedTranslation | null)[], existing: TranslatedBlocks) {
  const translations = { ...existing };
  const rejectedIds: string[] = [];
  blocks.forEach((block, index) => {
    const hit = hits[index];
    if (!hit || hit.provider === 'echo' || translations[block.id]) return;
    try {
      const source = translationSource(block);
      const runs = translatedRuns(source, hit.text);
      if (!runs.some(run => run.text.trim())) throw new Error('空译文');
      translations[block.id] = { source, text: runs.map(run => run.text).join(''), runs,
        origin: { provider: hit.provider, model: hit.model }, restored: true };
    } catch { rejectedIds.push(block.id); }
  });
  return { translations, rejectedIds };
}

/** Count usable translations on this page; unresolved body-source blocks remain in the denominator. */
export function translationPageProgress(blocks: Block[], page: number, translated: TranslatedBlocks, states: Record<string, TranslationBlockState>) {
  const list = translatableBlocks(blocks).filter(block => block.page === page);
  const untranslated = blocks.filter(block => block.page === page && isUntranslatedSourceContent(block)).length;
  const complete = list.filter(block => translated[block.id]?.source === translationSource(block) && translated[block.id].text.trim());
  const restored = complete.filter(block => translated[block.id].restored).length;
  const failed = list.filter(block => !complete.includes(block) && states[block.id]?.status === 'failed').length;
  return { total: list.length + untranslated, done: complete.length, restored, completed: complete.length - restored, failed, untranslated };
}

/** A one-block retry cannot mark the rest of its page ready. */
export function translationPageFeedback(blocks: Block[], page: number, translated: TranslatedBlocks, states: Record<string, TranslationBlockState>): TranslationPageState {
  const list = translatableBlocks(blocks).filter(block => block.page === page);
  const progress = translationPageProgress(blocks, page, translated, states);
  const error = list.map(block => states[block.id]).find(state => state?.status === 'failed')?.error;
  const refreshing = list.some(block => states[block.id]?.refresh && states[block.id].status !== 'succeeded');
  const busy = list.some(block => states[block.id]?.status === 'running');
  const status = progress.done === progress.total && !refreshing ? 'ready'
    : progress.done ? 'mixed' : error ? 'error' : busy ? 'translating' : !list.length && progress.untranslated ? 'untranslated' : 'queued';
  return { status, ...(error ? { error } : {}) };
}

/** Publish validated segments immediately. Omitted scope preserves whole-document callers. */
export async function prepareChineseReflow(
  blocks: Block[],
  existing: TranslatedBlocks,
  translate: (texts: string[], target: string, batch?: ReflowBatchOptions) => Promise<TranslateResult>,
  options: {
    cancelled: () => boolean;
    signal?: AbortSignal;
    concurrency?: number;
    target?: string;
    states?: Record<string, TranslationBlockState>;
    onBlockState?: (id: string, state: TranslationBlockState) => void;
    scope?: TranslationScope;
    getCurrentPage?: () => number;
    getVisibleBlockIds?: () => string[];
    subscribeViewport?: (listener: () => void) => () => void;
    onProgress: (done: number, total: number) => void;
    onBatch: (result: TranslatedBlocks, changedIds?: string[]) => void;
    onPageState?: (page: number, state: TranslationPageState) => void;
    onPageReady?: (page: number, result: TranslatedBlocks) => void;
  },
): Promise<TranslatedBlocks | null> {
  const selected = translatableBlocks(blocks);
  const result: TranslatedBlocks = {};
  const stopped = () => Boolean(options.signal?.aborted || options.cancelled());
  for (const block of selected) {
    const value = existing[block.id];
    if (value?.source === translationSource(block) && value.text.trim()) result[block.id] = value;
  }
  const byPage = new Map<number, Block[]>();
  for (const block of blocks.filter(block => isTranslatableContent(block) || isUntranslatedSourceContent(block))) {
    const list = byPage.get(block.page) ?? [];
    list.push(block); byPage.set(block.page, list);
  }
  const active = new Map<Block[], AbortController>();
  let foregroundReserve: Block[] | null = null;
  const inFlight = new Set<string>();
  const wireLengths = new Map<string, number>();
  const states = options.states ?? {};
  const failed = new Map<string, string>();
  const updateState = (block: Block, state: TranslationBlockState) => {
    states[block.id] = state;
    options.onBlockState?.(block.id, state);
  };
  for (const block of selected) {
    if (result[block.id]) updateState(block, { status: 'succeeded', attempts: states[block.id]?.attempts ?? 0 });
    else if (states[block.id]?.status === 'failed') failed.set(block.id, states[block.id].error ?? '段落翻译失败');
  }
  const publishedReady = new Set<number>();
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  const backgroundLimit = concurrency > 1 ? concurrency - 1 : 1;
  const currentPage = () => options.getCurrentPage?.() ?? selected[0]?.page ?? 1;
  const inWindow = (block: Block) => options.scope !== 'reading' || Math.abs(block.page - currentPage()) <= 1;
  const visibleIds = () => new Set(options.getVisibleBlockIds?.() ?? selected.filter(block => block.page === currentPage()).map(block => block.id));
  const priorityOf = (batch: Block[], visible: Set<string>): TranslationPriority => batch.some(block => visible.has(block.id)) ? 'visible' : 'background';
  const total = selected.length + blocks.filter(isUntranslatedSourceContent).length;
  const progress = () => options.onProgress(Object.keys(result).length, total);
  const pageState = (page: number) => {
    if (stopped()) return;
    const list = byPage.get(page)!;
    const state = translationPageFeedback(list, page, result, states);
    const { status } = state;
    options.onPageState?.(page, state);
    if (status === 'ready' && !publishedReady.has(page)) {
      publishedReady.add(page);
      options.onPageReady?.(page, { ...result });
    }
  };
  progress();
  for (const page of byPage.keys()) pageState(page);

  return new Promise<TranslatedBlocks | null>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(retryTimer);
      unsubscribe();
      options.signal?.removeEventListener('abort', onAbort);
      if (stopped()) {
        for (const controller of active.values()) controller.abort();
        resolve(null); return;
      }
      const errors = [...new Set(failed.values())];
      if (errors.length) reject(new Error(errors.join('；')));
      else resolve(result);
    };
    const onAbort = () => finish();
    const accept = (block: Block, text: string, origin?: TranslationOrigin) => {
      if (stopped() || settled || result[block.id]) return;
      if (!text?.trim()) throw new Error('翻译服务返回了缺失的段落，请重试。');
      const source = translationSource(block);
      const runs = translatedRuns(source, text);
      result[block.id] = { source, text: runs.map(run => run.text).join(''), runs, origin };
      updateState(block, { status: 'succeeded', attempts: states[block.id]?.attempts ?? 0 });
      failed.delete(block.id);
      options.onBatch({ ...result }, [block.id]);
      progress();
      pageState(block.page);
    };
    const fail = (block: Block, failure: Omit<TranslationFailure, 'index'>) => {
      if (result[block.id]) return;
      const attempts = states[block.id]?.attempts ?? 1;
      const error = `第 ${block.page} 页段落翻译失败：${failure.message}`;
      if (failure.retryable && attempts < 3) {
        updateState(block, { status: 'retryable', attempts, error,
          retryAt: Date.now() + Math.max(failure.retryAfterMs ?? 0, 1000 * 2 ** (attempts - 1)) });
      } else {
        failed.set(block.id, error);
        updateState(block, { status: 'failed', attempts, error });
      }
    };
    const run = async (batch: Block[], priority: TranslationPriority) => {
      const batchController = new AbortController();
      if (active.size >= concurrency) foregroundReserve = batch;
      active.set(batch, batchController);
      batch.forEach(block => {
        inFlight.add(block.id);
        updateState(block, { status: 'running', attempts: (states[block.id]?.attempts ?? 0) + 1 });
      });
      pageState(batch[0].page);
      try {
        const response = await translate(batch.map(translationSource), options.target ?? 'zh-CN', {
          priority,
          blocks: batch,
          signal: batchController.signal,
          onSegment(index, text, origin) {
            const block = batch[index];
            if (!block || stopped() || settled || batchController.signal.aborted) return;
            // The final response carries failure metadata; a malformed streamed segment
            // remains pending until the backend has finished its format recovery.
            try { accept(block, text, origin); } catch { /* handled below */ }
          },
        });
        if (stopped() || settled || batchController.signal.aborted) return;
        if (response.results.length !== batch.length) throw new Error('翻译服务返回了缺失的段落，请重试。');
        batch.forEach((block, index) => {
          const failure = response.failures?.find(item => item.index === index);
          if (failure) { fail(block, failure); return; }
          try { accept(block, response.results[index], response.origins?.[index] ?? undefined); }
          catch (error) { fail(block, { message: error instanceof Error ? error.message : String(error), retryable: true }); }
        });
      } catch (error) {
        if (stopped() || settled || batchController.signal.aborted) return;
        // A failed request cannot erase segments that were already validated and displayed.
        for (const block of batch) if (!result[block.id]) {
          const message = error instanceof Error ? error.message : String(error);
          fail(block, { message, retryable: /timeout|network|fetch|ECONN|超时|连接|断开|429|\b5\d\d\b|temporar|暂时/i.test(message) });
        }
      } finally {
        active.delete(batch);
        if (foregroundReserve === batch) foregroundReserve = null;
        batch.forEach(block => {
          inFlight.delete(block.id);
          if (batchController.signal.aborted && !result[block.id]) {
            updateState(block, { status: 'cancelled', attempts: Math.max(0, (states[block.id]?.attempts ?? 1) - 1) });
          }
        });
        if (!settled) { pageState(batch[0].page); pump(); }
      }
    };
    const pump = () => {
      if (settled) return;
      if (stopped()) { finish(); return; }
      clearTimeout(retryTimer);
      const visible = visibleIds();
      const viewportOrder = new Map([...visible].map((id, index) => [id, index]));
      const page = currentPage();
      const readingBody = (block: Block) => ['p', 'h2', 'h3'].includes(block.kind);
      const readingEnd = Math.max(-1, ...selected.filter(block => block.page === page && (visible.has(block.id) || result[block.id])).map(block => block.ord));
      const rank = (block: Block) => visible.has(block.id) && readingBody(block) ? 0
        : block.page === page && readingBody(block) && block.ord <= readingEnd ? 1
        : block.page === page && readingBody(block) ? 2
        : visible.has(block.id) ? 3 : block.page === page ? 4 : 5;
      for (const block of selected) {
        if (!result[block.id] && !failed.has(block.id) && inWindow(block) && !wireLengths.has(block.id)) {
          try { wireLengths.set(block.id, protectTranslationMath(translationSource(block), 0).text.length); }
          catch (error) {
            fail(block, { message: error instanceof Error ? error.message : String(error), retryable: false });
            pageState(block.page);
            continue;
          }
        }
        if (!result[block.id] && !failed.has(block.id) && inWindow(block) && (!states[block.id] || states[block.id].status === 'cancelled')) {
          updateState(block, { status: 'queued', attempts: states[block.id]?.attempts ?? 0 });
        }
      }
      const candidates = () => selected.filter(block => !result[block.id] && !failed.has(block.id) && !inFlight.has(block.id) && inWindow(block) && (states[block.id]?.retryAt ?? 0) <= Date.now())
        .sort((a, b) => rank(a) - rank(b)
          || (visible.has(a.id) && visible.has(b.id) ? viewportOrder.get(a.id)! - viewportOrder.get(b.id)! : 0)
          || Math.abs(a.page - currentPage()) - Math.abs(b.page - currentPage())
          || (a.page < currentPage() ? 1 : 0) - (b.page < currentPage() ? 1 : 0)
          || a.page - b.page || a.ord - b.ord);
      while (true) {
        const waiting = candidates();
        const first = waiting[0];
        if (!first) break;
        const priority = visible.has(first.id) ? 'visible' : 'background';
        const activeVisible = [...active.keys()].some(batch => priorityOf(batch, visible) === 'visible');
        if (active.size >= concurrency + 1) {
          // Keep exactly one foreground reserve. Rapid navigation replaces only
          // that obsolete reserve, leaving the ordinary in-flight requests intact.
          if (priority === 'visible' && !activeVisible && foregroundReserve) active.get(foregroundReserve)?.abort();
          break;
        }
        const activeBackground = [...active.keys()].filter(batch => priorityOf(batch, visible) === 'background').length;
        if (priority === 'background' && (active.size >= concurrency || activeBackground >= backgroundLimit)) break;
        const maxChars = priority === 'visible' ? 1000 : 4000;
        const maxSegments = priority === 'visible' ? 3 : Number.POSITIVE_INFINITY;
        const batch: Block[] = [];
        let chars = 0;
        for (const block of waiting) {
          if (block.page !== first.page || visible.has(block.id) !== visible.has(first.id)) continue;
          const length = wireLengths.get(block.id)!;
          if (batch.length && (batch.length >= maxSegments || chars + length > maxChars)) break;
          batch.push(block); chars += length;
        }
        void run(batch, priority);
      }
      const retryTimes = selected.filter(block => !result[block.id] && inWindow(block) && states[block.id]?.status === 'retryable')
        .map(block => states[block.id].retryAt!).filter(time => time > Date.now());
      if (retryTimes.length) retryTimer = setTimeout(pump, Math.max(1, Math.min(...retryTimes) - Date.now()));
      else if (!active.size) finish();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    unsubscribe = options.subscribeViewport?.(pump) ?? unsubscribe;
    pump();
  });
}
