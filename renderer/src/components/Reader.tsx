import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TextLayer } from 'pdfjs-dist';
import type { Block, Note, Paper, Progress, Settings, TranslationPriority } from '@shared/types';
import { api } from '@/lib/api';
import type { PDFDocumentProxy } from '@/lib/pdf';
import { renderPageToCanvas } from '@/lib/pdf';
import { FigureBlock } from './FigureBlock';
import { MathBlock } from './MathBlock';
import { SourceTextBlock } from './SourceTextBlock';
import { InlineText } from './InlineText';
import { prepareChineseReflow, restoreCachedReflow, translationPageProgress, translationPageFeedback, translatableBlocks, type TranslatedBlocks, type TranslationPageState, type TranslationBlockState } from '@/lib/chinese-reflow';
import { translationSource } from '@shared/translation-scripts';
import { isReadingContent, isTranslatableContent, isUntranslatedSourceContent } from '@shared/reading-content';
import { TranslationText } from './TranslationText';
import { Modal } from './Modal';
import DesktopMenu from './DesktopMenu';
import './reader-controls.css';
import './translation-feedback.css';
import { SelectionGroup } from './SelectionGroup';
import { useContentTransition } from '@/lib/motion';
import { ReaderAIContext, RegionAIButton } from './ReaderAIContext';
import { ReaderAIMenu } from './ReaderAIMenu';
import {
  IconBack,
  IconExport,
  IconHighlight,
  IconNote,
  IconRefresh,
  IconMore,
  IconChevronDown,
  IconTranslate,
} from './icons';

type Mode = 'reflow' | 'faithful';

interface Props {
  paper: Paper;
  doc: PDFDocumentProxy | null;
  blocks: Block[];
  notes: Note[];
  settings: Settings;
  analyzing: { done: number; total: number } | null;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onOpenOriginalPage: (page: number) => void;
  onReadingChange: (reading: Partial<Settings['reading']>) => void;
  onBack: () => void;
  onOpenTranslationSettings: () => void;
  onExportNotes: () => void;
  onReanalyze: () => void;
  onBlockUpdated: (block: Block) => void;
  onNoteCreated: (n: Note) => void;
  onToast: (msg: string) => void;
}

interface Selection {
  text: string;
  blockId: string | null;
  blockIds: string[];
  start: number | null;
  end: number | null;
  page: number;
  x: number;
  y: number;
  translated: boolean;
}

const HL_COLORS: Note['color'][] = ['yellow', 'green', 'blue', 'pink', 'purple'];
const EMPTY_NOTES: Note[] = [];

// DOM page order is stable. Binary search reads O(log pages) layout boxes per scroll.
function firstBelow(elements: HTMLElement[], line: number): number {
  let low = 0, high = elements.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (elements[middle].getBoundingClientRect().bottom <= line) low = middle + 1;
    else high = middle;
  }
  return low;
}
function viewportBlocks(root: HTMLElement): HTMLElement[] {
  const viewport = root.getBoundingClientRect();
  const pages = [...root.querySelectorAll<HTMLElement>('[data-page]')];
  const result: HTMLElement[] = [];
  for (let index = firstBelow(pages, viewport.top); index < pages.length; index++) {
    if (pages[index].getBoundingClientRect().top >= viewport.bottom) break;
    for (const block of pages[index].querySelectorAll<HTMLElement>('[data-block-id]')) {
      const bounds = block.getBoundingClientRect();
      if (bounds.bottom > viewport.top && bounds.top < viewport.bottom) result.push(block);
    }
  }
  return result;
}
function restoredPageStates(blocks: Block[], translated: TranslatedBlocks, states: Record<string, TranslationBlockState> = {}): Record<number, TranslationPageState> {
  return Object.fromEntries([...new Set(blocks.filter(block => isTranslatableContent(block) || isUntranslatedSourceContent(block)).map(block => block.page))]
    .map(page => [page, translationPageFeedback(blocks, page, translated, states)]));
}


/** The reading line stays inside a long page regardless of its viewport intersection ratio. */
export function readingPageAtLine(pages: Array<{ page: number; top: number; bottom: number }>, line: number): number | null {
  return pages.find(page => page.bottom > line)?.page ?? pages.at(-1)?.page ?? null;
}

function splitByHighlights(
  text: string,
  ranges: Array<{ start: number; end: number; color: Note['color']; id: string }>,
) {
  const valid = ranges
    .filter((r) => r.start < r.end && r.start < text.length)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const out: Array<{ text: string; hl?: { color: Note['color']; id: string } }> = [];
  let cursor = 0;
  for (const r of valid) {
    const start = Math.max(cursor, r.start);
    const end = Math.min(text.length, r.end);
    if (start >= end) continue;
    if (start > cursor) out.push({ text: text.slice(cursor, start) });
    out.push({ text: text.slice(start, end), hl: { color: r.color, id: r.id } });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  return out;
}

export function Reader({
  paper,
  doc,
  blocks,
  notes,
  settings,
  analyzing,
  mode,
  onModeChange,
  onOpenOriginalPage,
  onReadingChange,
  onBack,
  onOpenTranslationSettings,
  onExportNotes,
  onReanalyze,
  onNoteCreated,
  onBlockUpdated,
  onToast,
}: Props) {
  const ai = useContext(ReaderAIContext);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  const navigationRevision = useRef(0);
  const pdfZoom = settings.reading.pdfZoom ?? 100;
  const sizeAnchor = useRef<{ element: HTMLElement; fraction: number; line: number; revision: number; mode: Mode } | null>(null);
  const changeReadingSize = (value: number) => {
    const root = scrollRef.current;
    if (root) {
      const line = Math.min(72, root.clientHeight * 0.15);
      const top = root.getBoundingClientRect().top;
      const elements = root.querySelectorAll<HTMLElement>(mode === 'reflow' ? '[data-block-id]' : '[data-page]');
      const element = [...elements].find(node => node.getBoundingClientRect().bottom > top + line);
      if (element) {
        const bounds = element.getBoundingClientRect();
        sizeAnchor.current = { element, fraction: (top + line - bounds.top) / Math.max(1, bounds.height), line, revision: navigationRevision.current, mode };
      }
    }
    onReadingChange(mode === 'reflow' ? { fontSize: value } : { pdfZoom: value });
  };
  useLayoutEffect(() => {
    const anchor = sizeAnchor.current;
    const root = scrollRef.current;
    if (root && anchor?.element.isConnected && anchor.revision === navigationRevision.current && anchor.mode === mode) {
      const bounds = anchor.element.getBoundingClientRect();
      root.scrollTop += bounds.top + bounds.height * anchor.fraction - root.getBoundingClientRect().top - anchor.line;
    }
    sizeAnchor.current = null;
  }, [settings.reading.fontSize, pdfZoom, mode]);
  const restoredPaper = useRef<string | null>(null);
  const [restoration, setRestoration] = useState<{ paperId: string; progress: Progress | null; revision: number } | null>(null);
  const toastRef = useRef(onToast);
  toastRef.current = onToast;
  const visiblePage = () => {
    const root = scrollRef.current;
    if (!root) return currentPageRef.current;
    const rect = root.getBoundingClientRect();
    const line = rect.top + Math.min(72, rect.height * 0.15);
    const sections = [...root.querySelectorAll<HTMLElement>('[data-page]')];
    const section = sections[Math.min(firstBelow(sections, line), sections.length - 1)];
    return section ? Number(section.dataset.page) : currentPageRef.current;
  };
  const trackVisiblePage = () => {
    const page = visiblePage();
    currentPageRef.current = page;
    setCurrentPage(page);
    for (const listener of viewportListeners.current) listener();
  };
  const viewportListeners = useRef(new Set<() => void>());
  const visibleBlockIds = () => {
    const root = scrollRef.current;
    if (!root) return [];
    return viewportBlocks(root).map(element => element.dataset.blockId!);
  };
  const [translations, setTranslations] = useState<TranslatedBlocks>({});
  const [chinese, setChinese] = useState(false);
  useContentTransition(scrollRef, `${mode}:${chinese}`, 0);
  const chineseRef = useRef(chinese);
  chineseRef.current = chinese;
  const [translationProgress, setTranslationProgress] = useState<{ done: number; total: number } | null>(null);
  const [translationError, setTranslationError] = useState('');
  const translationRun = useRef(0);
  const translationPending = useRef(false);
  const translationCache = useRef<TranslatedBlocks>({});
  const [pageTranslations, setPageTranslations] = useState<Record<number, TranslationPageState>>({});
  const translationController = useRef<AbortController | null>(null);
  const translationRequests = useRef(new Map<string, { blocks: Block[]; priority: TranslationPriority; cancelled: boolean; unsubscribe: () => void }>());
  const blockStates = useRef<Record<string, TranslationBlockState>>({});
  const [translationStates, setTranslationStates] = useState<Record<string, TranslationBlockState>>({});
  const restoringTranslations = useRef(false);
  const [translationRevision, setTranslationRevision] = useState(0);
  const translationDisplayTiming = useRef<{ run: number; context: string; provider: string; startedAt: number; blockId: string | null } | null>(null);
  const selectionRequest = useRef<string | null>(null);
  const blockIsChinese = (block: Block) => chinese && isTranslatableContent(block) && translations[block.id]?.source === translationSource(block);
  const refreshRequestPriorities = () => {
    const visible = new Set(visibleBlockIds());
    for (const [requestId, request] of translationRequests.current) {
      if (request.cancelled) continue;
      const priority: TranslationPriority = request.blocks.some(block => visible.has(block.id)) ? 'visible' : 'background';
      if (priority === request.priority) continue;
      request.priority = priority;
      void api.translate.prioritize(requestId, priority).catch(error => toastRef.current(`调整翻译优先级失败：${error instanceof Error ? error.message : String(error)}`));
    }
  };
  const abortTranslationRequests = () => {
    translationDisplayTiming.current = null;
    translationController.current?.abort();
    translationController.current = null;
    for (const [requestId, request] of translationRequests.current) {
      request.unsubscribe();
      if (!request.cancelled) {
        request.cancelled = true;
        void api.translate.cancel(requestId).catch(error => onToast(`取消翻译失败：${error instanceof Error ? error.message : String(error)}`));
      }
    }
    translationRequests.current.clear();
  };
  const languageAnchor = useRef<{ id: string; offset: number } | null>(null);
  const providerId = settings.translate.activeProvider;
  const providerKey = JSON.stringify([providerId, settings.translate.providers[providerId]]);
  const contentKey = useMemo(() => JSON.stringify(blocks.map(block => [block.id, block.page, block.ord, block.kind, translationSource(block)])), [blocks]);
  const translationIdentity = `${paper.id}:${settings.targetLang}`;
  const translationIdentityRef = useRef(translationIdentity);
  const requestConfig = `${settings.translate.concurrency}:${providerKey}`;
  const requestConfigRef = useRef(requestConfig);
  // Request generations reject stale responses; successful content has its own identity.
  const translationContext = `${paper.id}:${settings.targetLang}:${settings.translate.concurrency}:${providerKey}:${contentKey}`;
  const contextRef = useRef(translationContext);
  contextRef.current = translationContext;
  const [sel, setSel] = useState<Selection | null>(null);
  const [aiMenu, setAIMenu] = useState<{ selection: Selection; x: number; y: number } | null>(null);
  const selectionRef = useRef<Selection | null>(sel);
  selectionRef.current = sel;
  const [composer, setComposer] = useState<{
    blockId: string | null;
    quote: string;
    start: number | null;
    end: number | null;
    page: number;
    x: number;
    y: number;
  } | null>(null);
  const [selTranslation, setSelTranslation] = useState<string | null>(null);

  const rememberLanguagePosition = () => {
    const root = scrollRef.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top;
    const visible = viewportBlocks(root)
      .find(element => element.getBoundingClientRect().bottom > top + 8);
    languageAnchor.current = visible ? { id: visible.id, offset: visible.getBoundingClientRect().top - top } : null;
  };

  useLayoutEffect(() => {
    const anchor = languageAnchor.current;
    const root = scrollRef.current;
    const target = anchor && document.getElementById(anchor.id);
    if (root && target && anchor) root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset;
    languageAnchor.current = null;
  }, [chinese, translations, pageTranslations]);

  useLayoutEffect(() => {
    const timing = translationDisplayTiming.current;
    if (!chinese || !timing?.blockId || timing.context !== translationContext || !translations[timing.blockId]) return;
    if (document.getElementById(`blk-${timing.blockId}`)?.dataset.language !== 'chinese') return;
    console.info('[translation] first current-run segment displayed', {
      run: timing.run, scope: 'reading', provider: timing.provider,
      firstReadableSegmentMs: Math.round((performance.now() - timing.startedAt) * 10) / 10,
    });
    translationDisplayTiming.current = null;
  }, [chinese, translations, translationContext, mode]);

  useEffect(() => {
    translationRun.current += 1;
    abortTranslationRequests();
    translationPending.current = false;
    const changedDocument = translationIdentityRef.current !== translationIdentity;
    const changedService = requestConfigRef.current !== requestConfig;
    translationIdentityRef.current = translationIdentity;
    requestConfigRef.current = requestConfig;
    const retained: TranslatedBlocks = {};
    const retainedStates: Record<string, TranslationBlockState> = {};
    if (!changedDocument) for (const block of translatableBlocks(blocks)) {
      const value = translationCache.current[block.id];
      if (value?.source === translationSource(block) && value.origin?.provider !== 'echo') {
        retained[block.id] = value;
        retainedStates[block.id] = { status: 'succeeded', attempts: 0 };
      } else if (!changedService && blockStates.current[block.id]?.status === 'failed') {
        retainedStates[block.id] = blockStates.current[block.id];
      }
    }
    translationCache.current = retained;
    blockStates.current = retainedStates;
    setTranslationStates({ ...retainedStates });
    setTranslations(retained);
    setPageTranslations(restoredPageStates(blocks, retained, retainedStates));
    setTranslationProgress(null);
    setTranslationError('');
    if (changedDocument) setChinese(false);
    setSel(null); setSelTranslation(null);
    const context = translationContext;
    const missing = translatableBlocks(blocks).filter(block => !retained[block.id]);
    restoringTranslations.current = true;
    // Disk restoration is independent of API credentials and never issues a model request.
    void api.translate.cached(missing.map(translationSource), settings.targetLang).then(hits => {
      if (contextRef.current !== context) return;
      const { translations: merged, rejectedIds } = restoreCachedReflow(missing, hits, translationCache.current);
      for (const block of missing) {
        if (merged[block.id]) blockStates.current[block.id] = { status: 'succeeded', attempts: 0 };
        else if (rejectedIds.includes(block.id)) blockStates.current[block.id] = { status: 'queued', attempts: 0, error: '已有译文格式失效，将重新翻译。' };
      }
      translationCache.current = merged;
      setTranslations(merged);
      setPageTranslations(restoredPageStates(blocks, merged, blockStates.current));
      setTranslationStates({ ...blockStates.current });
    }).catch(error => {
      if (contextRef.current === context) setTranslationError(`读取已有译文失败：${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (contextRef.current !== context) return;
      restoringTranslations.current = false;
      setTranslationRevision(value => value + 1);
    });
    return () => {
      translationRun.current += 1;
      abortTranslationRequests();
      if (selectionRequest.current) {
        void api.translate.cancel(selectionRequest.current).catch(error => onToast(`取消翻译失败：${error instanceof Error ? error.message : String(error)}`));
        selectionRequest.current = null;
      }
    };
  }, [translationContext]);


  const pageCount = doc?.numPages ?? paper.pageCount ?? 1;
  const notesByBlock = useMemo(() => {
    const map = new Map<string, Note[]>();
    for (const n of notes) {
      if (!n.blockId) continue;
      const arr = map.get(n.blockId) ?? [];
      arr.push(n);
      map.set(n.blockId, arr);
    }
    return map;
  }, [notes]);

  const captionsByFigure = useMemo(() => {
    const map = new Map<string, string>();
    for (const block of blocks) {
      if (block.kind === 'caption' && block.parentBlockId) map.set(block.parentBlockId, block.text);
    }
    return map;
  }, [blocks]);

  const translatablePages = useMemo(() => new Set(translatableBlocks(blocks).map(block => block.page)), [blocks]);
  const untranslatedSourceBlocks = useMemo(() => blocks.filter(isUntranslatedSourceContent), [blocks]);
  const untranslatedSourcePages = useMemo(() => {
    const counts = new Map<number, number>();
    for (const block of untranslatedSourceBlocks) counts.set(block.page, (counts.get(block.page) ?? 0) + 1);
    return counts;
  }, [untranslatedSourceBlocks]);

  const pages = useMemo(() => {
    const map = new Map<number, Block[]>();
    for (const b of blocks) {
      if (!isReadingContent(b)) continue;
      const arr = map.get(b.page) ?? [];
      arr.push(b);
      map.set(b.page, arr);
    }
    return [...map.entries()].filter(([, list]) => list.some(block => block.readingRole !== 'publication'))
      .sort((a, b) => a[0] - b[0]);
  }, [blocks]);

  // Read saved progress once per document. A late response must not undo a user's navigation.
  useEffect(() => {
    let alive = true;
    const revision = navigationRevision.current;
    restoredPaper.current = null;
    setRestoration(null);
    api.progress.get(paper.id).then(progress => {
      if (alive) setRestoration({ paperId: paper.id, progress, revision });
    }).catch(error => {
      if (!alive) return;
      toastRef.current(`读取进度失败：${error instanceof Error ? error.message : String(error)}`);
      setRestoration({ paperId: paper.id, progress: null, revision });
    });
    return () => { alive = false; };
  }, [paper.id]);

  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root || restoration?.paperId !== paper.id || restoredPaper.current === paper.id) return;
    if (!root.querySelector('[data-page]')) return;
    if (restoration.revision === navigationRevision.current && restoration.progress?.page) {
      const page = Math.min(pageCount, Math.max(1, restoration.progress.page));
      const visiblePages = [...root.querySelectorAll<HTMLElement>('[data-page]')];
      const target = root.querySelector<HTMLElement>(`[data-page="${page}"]`) ??
        (!analyzing && mode === 'reflow' ? visiblePages.filter(element => Number(element.dataset.page) <= page).at(-1) ?? visiblePages[0] : undefined);
      if (!target) return;
      root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top;
    }
    restoredPaper.current = paper.id;
    trackVisiblePage();
  }, [restoration, pages, mode, paper.id, pageCount, analyzing]);

  // Track the reading line without scanning every paragraph during fast scrolling.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; trackVisiblePage(); });
    };
    root.addEventListener('scroll', schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    root.querySelectorAll<HTMLElement>('[data-page]').forEach(section => resize.observe(section));
    schedule();
    return () => {
      root.removeEventListener('scroll', schedule);
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [paper.id, pages, mode]);

  useEffect(() => {
    let alive = true;
    if (restoredPaper.current !== paper.id) return;
    const t = setTimeout(() => {
      void api.progress.set(paper.id, {
        page: currentPage,
        scroll: scrollRef.current?.scrollTop ?? 0,
        mode,
      }).catch(error => { if (alive) onToast(`保存进度失败：${error instanceof Error ? error.message : String(error)}`); });
    }, 800);
    return () => { alive = false; clearTimeout(t); };
  }, [currentPage, mode, paper.id, onToast, restoration]);

  const goToPage = (page: number) => {
    const next = Math.min(pageCount, Math.max(1, page));
    navigationRevision.current += 1;
    const root = scrollRef.current;
    const target = root?.querySelector<HTMLElement>(`[data-page="${next}"]`);
    if (!target && mode === 'reflow' && !analyzing) { onOpenOriginalPage(next); return; }
    if (root && target) root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top;
    currentPageRef.current = next;
    setCurrentPage(next);
  };

  const clearSelection = useCallback(() => {
    if (selectionRequest.current) {
      void api.translate.cancel(selectionRequest.current).catch(error => onToast(`取消翻译失败：${error instanceof Error ? error.message : String(error)}`));
      selectionRequest.current = null;
    }
    setSel(null);
    setSelTranslation(null);
  }, [onToast]);

  const captureSelection = useCallback((): Selection | null => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const raw = selection.toString();
    const text = raw.trim();
    if (text.length < 2) return null;

    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    const el = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)) ?? null;
    if (el?.closest('.equation-block, .figure, input, textarea, button')) return null;
    const blockEl = el?.closest<HTMLElement>('[data-block-id]') ?? null;
    const endEl = range.endContainer.nodeType === Node.TEXT_NODE ? range.endContainer.parentElement : range.endContainer as HTMLElement;
    if (!el || !endEl || !scrollRef.current?.contains(el) || !scrollRef.current.contains(endEl)) return null;
    const sameBlock = blockEl && endEl?.closest('[data-block-id]') === blockEl;
    const rect = range.getBoundingClientRect();
    const selectedBlocks = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-block-id]') ?? [])]
      .filter(element => range.intersectsNode(element));

    let start: number | null = null;
    let end: number | null = null;
    const translated = selectedBlocks.some(element => element.dataset.language === 'chinese');
    if (sameBlock && !translated) {
      const pre = range.cloneRange();
      pre.selectNodeContents(blockEl);
      pre.setEnd(range.startContainer, range.startOffset);
      start = pre.toString().length + raw.length - raw.trimStart().length;
      end = start + text.length;
    }

    const pageEl = el?.closest<HTMLElement>('[data-page]');
    return {
      text,
      translated,
      blockId: blockEl?.dataset.blockId ?? null,
      blockIds: selectedBlocks.map(element => element.dataset.blockId!),
      start,
      end,
      page: Number(pageEl?.dataset.page ?? currentPage),
      x: Math.min(Math.max(rect.left + rect.width / 2, 210), window.innerWidth - 210),
      y: Math.max(rect.top - 6, 70),
    };
  }, [currentPage]);
  const onMouseUp = useCallback(() => {
    const selection = captureSelection(); clearSelection(); setSel(selection);
  }, [captureSelection, clearSelection]);
  const askAI = (selection: Selection, autoSend: boolean) => {
    ai?.onRequest({ id: crypto.randomUUID(), paperId: paper.id,
      reference: { id: crypto.randomUUID(), paperId: paper.id, title: paper.title,
        page: selection.page, blockIds: selection.blockIds, quote: selection.text, translated: selection.translated,
        originalText: selection.translated ? blocks.filter(block => selection.blockIds.includes(block.id)).map(block => block.text).join('\n') : selection.text },
      text: autoSend ? '请结合论文上下文，详细解读引用的这段文字，解释关键术语、推理过程和含义。' : undefined, autoSend,
    });
    setAIMenu(null); clearSelection(); window.getSelection()?.removeAllRanges();
  };

  const startTranslation = async (automatic = false, retryId?: string, refresh = false) => {
    if (translationPending.current) return;
    if (restoringTranslations.current) { setChinese(true); return; }
    if (!automatic) navigationRevision.current += 1;
    if (!automatic) { clearSelection(); window.getSelection()?.removeAllRanges(); }
    if (providerId === 'echo') {
      setChinese(true);
      setTranslationError('当前使用 Echo 调试回显，不会生成中文。请在设置 → 翻译服务中选择实际翻译服务。');
      return;
    }
    if (!translatableBlocks(blocks).length) {
      if (untranslatedSourceBlocks.length) setChinese(true);
      else onToast('没有可翻译的正文');
      return;
    }
    const retryRefresh = Boolean(retryId && blockStates.current[retryId]?.refresh);
    const runBlocks = retryId ? blocks.filter(block => block.id === retryId)
      : refresh ? blocks.filter(block => block.page === visiblePage()) : blocks;
    const refreshIds = new Set(Object.entries(blockStates.current).filter(([, state]) => state.refresh).map(([id]) => id));
    if (refresh || retryRefresh) runBlocks.forEach(block => refreshIds.add(block.id));
    const existing = Object.fromEntries(Object.entries(translationCache.current).filter(([id]) => !refreshIds.has(id)));
    if (!automatic) {
      for (const [id, state] of Object.entries(blockStates.current)) {
        if (state.status === 'failed' && (!retryId || retryId === id)) blockStates.current[id] = { status: 'queued', attempts: 0, refresh: state.refresh };
      }
      if (refresh) for (const block of runBlocks) blockStates.current[block.id] = { status: 'queued', attempts: 0, refresh: true };
      setTranslationStates({ ...blockStates.current });
    }
    const run = ++translationRun.current;
    const context = translationContext;
    const controller = new AbortController();
    translationController.current = controller;
    translationDisplayTiming.current = { run, context, provider: providerId, startedAt: performance.now(), blockId: null };
    const cancelled = () => controller.signal.aborted || translationRun.current !== run || contextRef.current !== context;
    translationPending.current = true;
    if (!automatic) setTranslationError('');
    rememberLanguagePosition();
    setChinese(true);
    try {
      const result = await prepareChineseReflow(runBlocks, existing, async (texts, target, batch) => {
        const requestId = crypto.randomUUID();
        const requestBlocks = batch?.blocks ?? [];
        const unsubscribe = api.translate.onSegment(segment => {
          if (segment.requestId === requestId && !cancelled() && !batch?.signal.aborted) batch?.onSegment(segment.index, segment.text, segment.origin);
        });
        const cancelBatch = () => {
          const request = translationRequests.current.get(requestId);
          if (request?.cancelled) return;
          unsubscribe();
          if (request) request.cancelled = true;
          void api.translate.cancel(requestId).catch(error => {
            if (!cancelled()) toastRef.current(`取消翻译失败：${error instanceof Error ? error.message : String(error)}`);
          });
        };
        batch?.signal.addEventListener('abort', cancelBatch, { once: true });
        translationRequests.current.set(requestId, { blocks: requestBlocks, priority: batch?.priority ?? 'background', cancelled: false, unsubscribe });
        try { return await api.translate.batch(texts, target, requestId, { priority: batch?.priority ?? 'background', refresh: requestBlocks.some(block => refreshIds.has(block.id)) }); }
        finally {
          batch?.signal.removeEventListener('abort', cancelBatch);
          unsubscribe(); translationRequests.current.delete(requestId);
        }
      }, {
        cancelled,
        signal: controller.signal,
        concurrency: settings.translate.concurrency,
        target: settings.targetLang,
        states: blockStates.current,
        onBlockState: (id, state) => {
          if (cancelled()) return;
          const next = { ...state, refresh: refreshIds.has(id) && state.status !== 'succeeded' };
          blockStates.current[id] = next;
          setTranslationStates(previous => ({ ...previous, [id]: next }));
        },
        scope: 'reading',
        getCurrentPage: visiblePage,
        getVisibleBlockIds: visibleBlockIds,
        subscribeViewport: listener => {
          const update = () => { if (!cancelled()) { refreshRequestPriorities(); listener(); } };
          viewportListeners.current.add(update);
          return () => viewportListeners.current.delete(update);
        },
        onProgress: (done, total) => { if (!cancelled()) setTranslationProgress({ done, total }); },
        onBatch: (partial, changedIds = []) => {
          if (cancelled()) return;
          const timing = translationDisplayTiming.current;
          if (timing?.run === run && !timing.blockId && changedIds.length) timing.blockId = changedIds[0];
          if (chineseRef.current) {
            rememberLanguagePosition();
            const selection = selectionRef.current;
            if (selection && changedIds.some(id => selection.blockIds.includes(id))) {
              clearSelection(); window.getSelection()?.removeAllRanges();
            }
          }
          const merged = { ...translationCache.current, ...partial };
          translationCache.current = merged;
          setTranslations(merged);
        },
        onPageState: page => {
          if (cancelled()) return;
          setPageTranslations(previous => ({ ...previous, [page]: translationPageFeedback(blocks, page, translationCache.current, blockStates.current) }));
        },
      });
      if (!result || cancelled()) return;
      const merged = { ...translationCache.current, ...result };
      translationCache.current = merged;
      setTranslations(merged);
    } catch (error) {
      if (!cancelled()) {
        const failed = Object.values(blockStates.current).some(state => state.status === 'failed');
        if (!failed) setTranslationError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!cancelled()) {
        translationPending.current = false;
        translationController.current = null;
        setTranslationProgress(null);
      }
    }
  };

  const currentTranslation = translationPageProgress(blocks, currentPage, translations, translationStates);
  const failedTranslationBlocks = translatableBlocks(blocks).filter(block => translationStates[block.id]?.status === 'failed');
  const revealFailedTranslation = () => {
    const block = failedTranslationBlocks.find(block => block.page >= currentPage) ?? failedTranslationBlocks[0];
    if (!block) return;
    goToPage(block.page);
    document.getElementById(`blk-${block.id}`)?.scrollIntoView({ block: 'center' });
  };
  const revealUntranslatedSource = () => {
    const block = untranslatedSourceBlocks.find(block => block.page === currentPage);
    if (block) document.getElementById(`blk-${block.id}`)?.scrollIntoView({ block: 'center' });
  };

  // A completed reading window stays idle; navigating to new pages adds only their local window.
  useEffect(() => {
    if (!chinese || mode !== 'reflow' || translationPending.current || restoringTranslations.current || analyzing || providerId === 'echo') return;
    const page = visiblePage();
    const missing = translatableBlocks(blocks).some(block => (!translationCache.current[block.id] || blockStates.current[block.id]?.refresh) && blockStates.current[block.id]?.status !== 'failed'
      && Math.abs(block.page - page) <= 1);
    if (missing) void startTranslation(true);
  }, [currentPage, chinese, mode, translationContext, blocks, analyzing, translationProgress, translationRevision]);

  const toggleChinese = () => {
    clearSelection(); window.getSelection()?.removeAllRanges();
    rememberLanguagePosition();
    if (chinese) { setChinese(false); return; }
    if (translationPending.current) {
      setChinese(true);
      return;
    }
    void startTranslation();
  };

  const translateSelection = useCallback(async () => {
    if (!sel) return;
    const requestId = crypto.randomUUID();
    const context = translationContext;
    if (selectionRequest.current) {
      void api.translate.cancel(selectionRequest.current).catch(error => onToast(`取消翻译失败：${error instanceof Error ? error.message : String(error)}`));
    }
    selectionRequest.current = requestId;
    try {
      const res = await api.translate.batch([sel.text], undefined, requestId, { priority: 'interactive' });
      if (res.failures?.length) throw new Error(res.failures[0].message);
      if (selectionRequest.current === requestId && contextRef.current === context) setSelTranslation(res.results[0] ?? '');
    } catch (err) {
      if (selectionRequest.current === requestId && contextRef.current === context) onToast(err instanceof Error ? err.message : String(err));
    } finally {
      if (selectionRequest.current === requestId) selectionRequest.current = null;
    }
  }, [sel, onToast, translationContext]);

  const openComposer = useCallback(
    (opts: { blockId: string | null; quote: string; start?: number | null; end?: number | null; page: number; x: number; y: number }) => {
      setComposer({
        blockId: opts.blockId,
        quote: opts.quote,
        start: opts.start ?? null,
        end: opts.end ?? null,
        page: opts.page,
        x: Math.min(Math.max(opts.x, 190), window.innerWidth - 190),
        y: Math.min(Math.max(opts.y, 150), window.innerHeight - 260),
      });
      clearSelection();
    },
    [clearSelection],
  );

  const saveNote = useCallback(
    async (body: string, color: Note['color']) => {
      if (!composer) return;
      const note = await api.notes.create({
        paperId: paper.id,
        blockId: composer.blockId,
        quote: composer.quote || null,
        body,
        color,
        kind: composer.start != null && composer.end != null ? 'highlight' : 'note',
        startOffset: composer.start,
        endOffset: composer.end,
        page: composer.page,
      });
      onNoteCreated(note);
      setComposer(null);
      onToast('已保存');
    },
    [composer, paper.id, onNoteCreated, onToast],
  );


  const renderedPages = pages.map(([page, list]) => (
    <section key={page} data-page={page} data-language={chinese && pageTranslations[page]?.status === 'ready' ? 'chinese' : chinese && list.some(block => blockIsChinese(block)) ? 'mixed' : 'original'} lang={chinese && pageTranslations[page]?.status === 'ready' ? settings.targetLang : undefined} className="page-section">
      {(page > 1 || chinese) && <div className="page-chip">{page > 1 && <span>第 {page} 页</span>}{chinese && <span className={`page-translation-state${pageTranslations[page]?.error ? ' failed' : ''}`}>
        {untranslatedSourcePages.has(page) ? `${untranslatedSourcePages.get(page)} 块未译 · 原稿保留` : !translatablePages.has(page) ? list.some(block => block.kind === 'ref') ? '参考文献 · 原文' : '原稿' : pageTranslations[page]?.error ? '部分段落失败 · 可重试' : pageTranslations[page]?.status === 'ready' ? '译文' : pageTranslations[page]?.status === 'mixed' ? '原文与译文逐段显示' : pageTranslations[page]?.status === 'translating' ? '翻译中 · 原文保留' : translationProgress && Math.abs(page - currentPage) <= 1 ? '等待翻译 · 原文保留' : '原文 · 阅读时翻译'}
      </span>}</div>}
      {list.map((block) => (
        <div
          key={block.id}
          id={`blk-${block.id}`}
          data-block-id={block.id}
          data-language={blockIsChinese(block) ? 'chinese' : 'original'}
          data-translation-status={chinese && isUntranslatedSourceContent(block) ? 'untranslated' : chinese && isTranslatableContent(block) ? translationStates[block.id]?.status ?? 'idle' : undefined}
          aria-busy={chinese && translationStates[block.id]?.status === 'running' || undefined}
          lang={blockIsChinese(block) ? settings.targetLang : undefined}
          data-translation-provider={blockIsChinese(block) ? translations[block.id]?.origin?.provider : undefined}
          data-translation-model={blockIsChinese(block) ? translations[block.id]?.origin?.model : undefined}
          role={/^h[123]$/.test(block.kind) ? 'heading' : block.kind === 'table-note' ? 'note' : undefined}
          aria-level={/^h[123]$/.test(block.kind) ? Number(block.kind[1]) : undefined}
          data-parent-block-id={block.parentBlockId}
          data-figure-label={block.figureLabel}
          aria-describedby={block.kind === 'table' || block.kind === 'figure' ? list.filter((note) => note.parentBlockId === block.id).map((note) => `blk-${note.id}`).join(' ') || undefined : undefined}
          className={`blk ${block.kind}${block.readingRole ? ` reading-${block.readingRole}` : ''}`}
        >
          <div className="gutter">
            <button
              title="为这段添加笔记"
              onClick={(e) => {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                openComposer({
                  blockId: block.id,
                  quote: block.sourceTextFallback ? '原稿段落' : (blockIsChinese(block) ? translations[block.id]?.text ?? block.text : block.text).slice(0, 600),
                  page: block.page,
                  x: rect.right + 170,
                  y: rect.top + 40,
                });
              }}
            >
              <IconNote width={13} height={13} />
            </button>
            {!blockIsChinese(block) && block.kind !== 'algorithm' && !block.sourceTextFallback && <button
              title="整段高亮"
              onClick={async () => {
                const note = await api.notes.create({
                  paperId: paper.id,
                  blockId: block.id,
                  quote: (blockIsChinese(block) ? translations[block.id]?.text ?? block.text : block.text).slice(0, 600),
                  body: '',
                  color: 'yellow',
                  kind: 'highlight',
                  startOffset: 0,
                  endOffset: block.text.length,
                  page: block.page,
                });
                onNoteCreated(note);
              }}
            >
              <IconHighlight width={13} height={13} />
            </button>}
          </div>
          <ReaderBlockBody block={block} doc={doc} paperId={paper.id} caption={captionsByFigure.get(block.id)}
            translated={blockIsChinese(block) ? translations[block.id] : undefined} notes={notesByBlock.get(block.id) ?? EMPTY_NOTES} onBlockUpdated={onBlockUpdated} />
          {chinese && isUntranslatedSourceContent(block) && <div className="block-translation-feedback" role="status">此段未译：PDF 字符无法可靠识别，已保留原稿。</div>}
          {chinese && (!blockIsChinese(block) || translationStates[block.id]?.refresh) && ['queued', 'running'].includes(translationStates[block.id]?.status) && <div className="block-translation-feedback block-translation-pending">
            <span>{translationStates[block.id].status === 'running' ? translationStates[block.id].refresh ? '正在重译' : '正在翻译' : '等待翻译'} · {translationStates[block.id].refresh ? '保留原译文' : '原文保留'}</span>
          </div>}
          {chinese && (!blockIsChinese(block) || translationStates[block.id]?.refresh) && translationStates[block.id]?.status === 'failed' && <div className="block-translation-feedback" role="status">
            <span>{translationStates[block.id].refresh ? '重译未完成，已保留原译文。' : ''}{translationStates[block.id].error}</span>
            <button className="btn ghost" disabled={translationProgress !== null} onClick={() => void startTranslation(false, block.id)}>重试本段</button>
          </div>}
          {chinese && (!blockIsChinese(block) || translationStates[block.id]?.refresh) && translationStates[block.id]?.status === 'retryable' && <div className="block-translation-feedback" role="status" title={translationStates[block.id].error}>稍后自动重试 · 已尝试 {translationStates[block.id].attempts}/3 次</div>}

        </div>
      ))}
    </section>
  ));

  return (
    <main className="main reader-main">
      <div className="toolbar">
        <button className="btn back" title="返回文献库（Esc）" onClick={onBack}>
          <IconBack />
        </button>
        <div className="doc-title">
          <h2 title={paper.title}>{paper.title}</h2>
          <p>
            {[paper.authors.slice(0, 3).join(', '), paper.year, paper.venue]
              .filter(Boolean)
              .join(' · ') || `${pageCount} 页 · PDF 文献`}
            {paper.doi ? ` · DOI ${paper.doi}` : ''}
          </p>
        </div>

        <button className="btn icon ghost" title="导出笔记为 Markdown" aria-label="导出笔记" onClick={onExportNotes}><IconExport /></button>
      </div>
      <div className="reader-controls" aria-label="阅读工具">
        <SelectionGroup className="segmented" role="group" aria-label="阅读模式">
          <button aria-pressed={mode === 'reflow'} className={mode === 'reflow' ? 'on' : ''} onClick={() => onModeChange('reflow')}>重排</button>
          <button aria-pressed={mode === 'faithful'} className={mode === 'faithful' ? 'on' : ''} onClick={() => onModeChange('faithful')}>原页</button>
        </SelectionGroup>
        <button className={`btn ghost language-toggle${chinese ? ' on' : ''}`} onClick={toggleChinese}
          disabled={mode !== 'reflow' || analyzing !== null || !blocks.length} aria-pressed={chinese}
          title={chinese ? '查看原文' : '查看译文'}
          aria-label={chinese ? '查看原文' : '查看译文'}>
          <IconTranslate />
          <span key={String(chinese)}>{chinese ? '查看原文' : '查看译文'}</span>
        </button>
        <div className="spacer" />
        <DesktopMenu className="btn ghost reading-size" ariaLabel={mode === 'reflow' ? `阅读字号，当前 ${settings.reading.fontSize} 像素` : `页面缩放，当前 ${pdfZoom}%`} align="end" width={168}
          items={mode === 'reflow'
            ? Array.from({ length: 11 }, (_, index) => index + 14).map(value => ({
              id: String(value), label: `${value} px${value === 17 ? ' · 默认' : ''}`,
              selected: settings.reading.fontSize === value, onSelect: () => changeReadingSize(value),
            }))
            : [50, 75, 100, 125, 150, 175, 200].map(value => ({
              id: String(value), label: value === 100 ? '100% · 适合宽度' : `${value}%`,
              selected: pdfZoom === value, onSelect: () => changeReadingSize(value),
            }))}>
          <span className="reading-size-symbol" aria-hidden="true">Aa</span>
          <span>{mode === 'reflow' ? settings.reading.fontSize : `${pdfZoom}%`}</span>
          <IconChevronDown />
        </DesktopMenu>
        <PageNavigation currentPage={currentPage} pageCount={pageCount} availablePages={mode === 'reflow' && pages.length ? pages.map(([page]) => page) : undefined} onJump={goToPage} />
        <DesktopMenu className="btn icon ghost reader-more" ariaLabel="更多阅读操作" align="end" width={196} items={[
          { id: 'retranslate', label: '用当前模型重译本页', icon: <IconTranslate />, disabled: mode !== 'reflow' || translationProgress !== null || restoringTranslations.current || analyzing !== null || providerId === 'echo', onSelect: () => { void startTranslation(false, undefined, true); } },
          { id: 'reanalyze', label: '重新解析版面', icon: <IconRefresh />, disabled: !doc || analyzing !== null, onSelect: onReanalyze },
        ]}><IconMore /></DesktopMenu>
      </div>

      {translationError && <div className="translation-error" role="alert"><span>{translationError}</span>
        <button className="btn ghost" onClick={onOpenTranslationSettings}>设置翻译服务</button>
        {providerId !== 'echo' && <button className="btn ghost" disabled={translationProgress !== null} onClick={() => void startTranslation()}>重试</button>}
        <button className="btn ghost" onClick={() => setTranslationError('')}>关闭</button>
      </div>}
      {chinese && mode === 'reflow' && (currentTranslation.total > 0 || failedTranslationBlocks.length > 0) && <div className="translation-progress" role="status">
        <span>{currentTranslation.total > 0 ? `本页已译 ${currentTranslation.done}/${currentTranslation.total} 个文本块` : '本页保留原稿'}</span>
        {currentTranslation.restored > 0 && <span>缓存恢复 {currentTranslation.restored}</span>}
        {currentTranslation.completed > 0 && <span>本次完成 {currentTranslation.completed}</span>}
        {currentTranslation.failed > 0 ? <span>{currentTranslation.failed} 块失败 · 原文保留</span>
          : translationProgress && currentTranslation.done < currentTranslation.total - currentTranslation.untranslated && <span>翻译中 · 逐块显示</span>}
        {currentTranslation.untranslated > 0 && <><span>{currentTranslation.untranslated} 块未译 · 字符无法识别，原稿保留</span>
          <button className="translation-locate-failure" onClick={revealUntranslatedSource}>定位未译块</button></>}
        {failedTranslationBlocks.length > 0 && <button className="translation-locate-failure" onClick={revealFailedTranslation}>定位失败块{failedTranslationBlocks.length > 1 ? `（${failedTranslationBlocks.length}）` : ''}</button>}
      </div>}

      <div
        className="reader-scroll"
        ref={scrollRef}
        onMouseUp={event => { if (event.button === 0) onMouseUp(); }}
        onKeyUp={event => { if (event.shiftKey || event.key === 'Shift') onMouseUp(); }}
        onContextMenu={event => {
          const selection = captureSelection();
          if (!selection || !ai) return;
          event.preventDefault(); setSel(null);
          setAIMenu({ selection, x: event.clientX, y: event.clientY });
        }}
        onWheelCapture={() => { navigationRevision.current += 1; }}
        onTouchStartCapture={() => { navigationRevision.current += 1; }}
        onPointerDownCapture={() => { navigationRevision.current += 1; }}
        onKeyDownCapture={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) navigationRevision.current += 1; }}
        onScroll={() => sel && clearSelection()}
      >
        {analyzing && (
          <div className="banner" style={{ margin: '18px 40px 0', maxWidth: 760 }}>
            正在整理版面 · {analyzing.done} / {analyzing.total} 页
          </div>
        )}

        {mode === 'reflow' ? (
          <article
            className={`article${settings.reading.fontFamily === 'sans' ? ' sans' : ''}`}
            data-language={chinese ? 'mixed' : 'original'}
            style={
              {
                '--reading-size': `${settings.reading.fontSize}px`,
                '--reading-lh': String(settings.reading.lineHeight),
                '--reading-width': `${settings.reading.maxWidth}px`,
              } as React.CSSProperties
            }
          >
            {blocks.length === 0 && !analyzing ? (
              <p style={{ color: 'var(--text-3)' }}>没有可显示的正文，试试切到「原页」模式。</p>
            ) : (
              renderedPages
            )}
          </article>
        ) : (
          <FaithfulView key={paper.id} doc={doc} pageCount={pageCount} zoom={pdfZoom} />
        )}
      </div>

      {sel && (
        <div className="selbar" style={{ left: sel.x, top: sel.y }}>
          {ai && <button onMouseDown={event => event.preventDefault()} onClick={() => askAI(sel, false)}>问 AI</button>}
          {!sel.translated && <button onClick={translateSelection}>
            <IconTranslate width={12} height={12} /> 翻译
          </button>}
          <div className="sep" />
          <button
            onClick={() =>
              openComposer({
                blockId: sel.blockId,
                quote: sel.text,
                start: sel.start,
                end: sel.end,
                page: sel.page,
                x: sel.x,
                y: sel.y - 40,
              })
            }
          >
            笔记
          </button>
          {!sel.translated && mode === 'reflow' && <button
            onClick={async () => {
              if (!sel.blockId || sel.start == null || sel.end == null) {
                return onToast('请选择同一段落内的文字再高亮');
              }
              const note = await api.notes.create({
                paperId: paper.id,
                blockId: sel.blockId,
                quote: sel.text,
                body: '',
                color: 'yellow',
                kind: 'highlight',
                startOffset: sel.start,
                endOffset: sel.end,
                page: sel.page,
              });
              onNoteCreated(note);
              clearSelection();
            }}
          >
            高亮
          </button>}
          {selTranslation && (
            <>
              <div className="sep" />
              <span
                style={{
                  padding: '5px 8px',
                  fontSize: 12,
                  maxWidth: 320,
                  whiteSpace: 'normal',
                  lineHeight: 1.5,
                }}
              >
                {selTranslation}
              </span>
            </>
          )}
        </div>
      )}
      {aiMenu && <ReaderAIMenu x={aiMenu.x} y={aiMenu.y} onClose={() => setAIMenu(null)} onExplain={() => askAI(aiMenu.selection, true)} onQuote={() => askAI(aiMenu.selection, false)} />}

      {composer && (
        <NoteComposer
          quote={composer.quote}
          x={composer.x}
          y={composer.y}
          onCancel={() => setComposer(null)}
          onSave={saveNote}
        />
      )}
    </main>
  );
}

const ReaderBlockBody = memo(function ReaderBlockBody({ block, doc, paperId, caption, translated, notes, onBlockUpdated }: {
  block: Block; doc: PDFDocumentProxy | null; paperId: string; caption?: string;
  translated?: TranslatedBlocks[string]; notes: Note[]; onBlockUpdated: (block: Block) => void;
}) {
    if (block.kind === 'math' && block.crop) {
      return (
        <MathBlock
          key={`${block.id}:${block.crop.join(',')}`}
          doc={doc}
          block={block as Block & { crop: [number, number, number, number] }}
          onUpdated={onBlockUpdated}
        />
      );
    }

    if (block.sourceTextFallback && block.crop) {
      return <SourceTextBlock doc={doc} block={block as Block & { crop: [number, number, number, number] }} />;
    }

    if ((block.kind === 'figure' || block.kind === 'table' || block.kind === 'algorithm') && block.crop) {
      return (
        <FigureBlock
          doc={doc}
          paperId={paperId}
          page={block.page}
          crop={block.crop}
          caption={caption || (block.kind === 'algorithm' ? block.text.split('\n')[0] : block.text) || (block.figureLabel ? `Figure ${block.figureLabel}` : undefined)}
          kind={block.kind}
          sourceFontSize={block.sourceFontSize}
        />
      );
    }

    if (translated && !['math', 'figure', 'table', 'algorithm'].includes(block.kind)) {
      return <TranslationText runs={translated?.runs ?? []} />;
    }

    const hl = notes
      .filter((n) => n.startOffset != null && n.endOffset != null)
      .map((n) => ({ start: n.startOffset!, end: n.endOffset!, color: n.color, id: n.id }));

    const renderText = (text: string, offset: number) => splitByHighlights(text, hl.map((range) => ({
      ...range, start: range.start - offset, end: range.end - offset,
    }))).map((seg, index) => seg.hl ? (
      <mark key={index} className={`hl ${seg.hl.color}`} data-note-id={seg.hl.id}>{seg.text}</mark>
    ) : <span key={index}>{seg.text}</span>);

    if (block.textRuns?.length) {
      return <InlineText runs={block.textRuns} renderText={renderText} />;
    }
    return hl.length ? renderText(block.text, 0) : block.text;
  });

function PageNavigation({ currentPage, pageCount, availablePages, onJump }: { currentPage: number; pageCount: number; availablePages?: number[]; onJump: (page: number) => void }) {
  const choices = availablePages ?? Array.from({ length: pageCount }, (_, index) => index + 1);
  const previous = choices.filter(page => page < currentPage).at(-1);
  const next = choices.find(page => page > currentPage);
  const [draft, setDraft] = useState(String(currentPage));
  useEffect(() => setDraft(String(currentPage)), [currentPage]);
  const commit = () => {
    const value = Number(draft);
    if (Number.isInteger(value) && value >= 1 && value <= pageCount) onJump(value);
    else setDraft(String(currentPage));
  };
  return <div className="page-navigation" aria-label="页码导航">
    <button className="btn icon ghost" title="上一页" aria-label="上一页" disabled={previous === undefined} onClick={() => previous !== undefined && onJump(previous)}><IconBack width={13} /></button>
    <div className="reader-page-field">
      <input aria-label="跳转页码" inputMode="numeric" value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(String(currentPage)); }
        }} />
      <span>/ {pageCount}</span>
      <DesktopMenu ariaLabel="选择页码" className="reader-page-menu" width={152} align="end" items={choices.map(page => ({
        id: String(page), label: `第 ${page} 页`, selected: currentPage === page, onSelect: () => onJump(page),
      }))}><IconChevronDown width={13} height={13} /></DesktopMenu>
    </div>
    <button className="btn icon ghost" title="下一页" aria-label="下一页" disabled={next === undefined} onClick={() => next !== undefined && onJump(next)}><IconBack width={13} style={{ transform: 'rotate(180deg)' }} /></button>
  </div>;
}

function NoteComposer({
  quote,
  onCancel,
  onSave,
}: {
  quote: string;
  x: number;
  y: number;
  onCancel: () => void;
  onSave: (body: string, color: Note['color']) => Promise<void>;
}) {
  const [body, setBody] = useState('');
  const [color, setColor] = useState<Note['color']>('yellow');
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState('');
  const save = async () => {
    setSaving(true); setError('');
    try { await onSave(body, color); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <Modal title="添加笔记" className="note-composer" onClose={onCancel} busy={saving} footer={<>
      <div className="composer-colors" role="group" aria-label="高亮颜色">
        {HL_COLORS.map((c) => <button key={c} className={`swatch${color === c ? ' on' : ''}`}
          style={{ background: `var(--hl-${c})` }} disabled={saving} onClick={() => setColor(c)}
          aria-label={{yellow:'黄色',green:'绿色',blue:'蓝色',pink:'粉色',purple:'紫色'}[c]} aria-pressed={color === c} />)}
      </div>
      <button className="btn ghost" disabled={saving} onClick={onCancel}>取消</button>
      <button className="btn primary" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
    </>}>
      {quote && <div className="quote">{quote}</div>}
      <textarea
        ref={ref}
        value={body}
        aria-label="笔记内容"
        disabled={saving}
        placeholder="写点什么…（⌘+Enter 保存）"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (!saving) {
              void save();
            }
          }
          if (e.key === 'Escape' && !saving) onCancel();
        }}
      />
      {error && <p role="alert" className="form-error">{error}</p>}

    </Modal>
  );
}

function FaithfulView({ doc, pageCount, zoom }: { doc: PDFDocumentProxy | null; pageCount: number; zoom: number }) {
  return (
    <div className="faithful" style={{ '--pdf-scale': zoom / 100 } as React.CSSProperties}>
      {Array.from({ length: pageCount }, (_, i) => (
        <FaithfulPage key={i} doc={doc} pageNumber={i + 1} zoom={zoom} />
      ))}
    </div>
  );
}

const FaithfulPage = memo(function FaithfulPage({ doc, pageNumber, zoom }: { doc: PDFDocumentProxy | null; pageNumber: number; zoom: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [textWidth, setTextWidth] = useState(0);
  const [textError, setTextError] = useState('');
  const [pageSize, setPageSize] = useState<[number, number] | null>(null);
  const visibleRef = useRef(false);
  const renderedVersion = useRef<{ doc: PDFDocumentProxy; zoom: number } | null>(null);
  const [nearby, setNearby] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setTextWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const container = textRef.current;
    if (!nearby || !doc || !container || !textWidth) return;
    let active = true;
    let layer: TextLayer | undefined;
    setTextError('');
    void (async () => {
      const page = await doc.getPage(pageNumber);
      const original = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      if (!active) return;
      setPageSize([original.width, original.height]);
      const scale = textWidth / original.width;
      container.replaceChildren();
      container.style.setProperty('--scale-factor', String(scale));
      layer = new TextLayer({ container, textContentSource: content, viewport: page.getViewport({ scale }) });
      await layer.render();
    })().catch(reason => { if (active) setTextError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; layer?.cancel(); };
  }, [nearby, doc, pageNumber, textWidth, retry]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = el.closest('.reader-scroll');
    const nearbyObserver = new IntersectionObserver(entries => {
      for (const entry of entries) setNearby(entry.isIntersecting);
    }, { root, rootMargin: '800px 0px' });
    const visibleObserver = new IntersectionObserver(entries => {
      for (const entry of entries) visibleRef.current = entry.isIntersecting;
    }, { root });
    nearbyObserver.observe(el);
    visibleObserver.observe(el);
    return () => { nearbyObserver.disconnect(); visibleObserver.disconnect(); };
  }, []);

  useEffect(() => {
    if (!nearby || !doc || !canvasRef.current) { setLoading(false); return; }
    if (renderedVersion.current?.doc === doc && renderedVersion.current.zoom === zoom) return;
    const controller = new AbortController();
    setError(''); setLoading(true);
    const buffer = document.createElement('canvas');
    // Only a successful offscreen render replaces the previous zoom's bitmap.
    renderPageToCanvas(doc, pageNumber, 1.5 * Math.max(1, zoom / 100), buffer, {
      signal: controller.signal,
      priority: () => visibleRef.current ? 100 : 10,
    }).then(() => {
      const canvas = canvasRef.current;
      if (controller.signal.aborted || !canvas) return;
      canvas.width = buffer.width;
      canvas.height = buffer.height;
      canvas.getContext('2d')!.drawImage(buffer, 0, 0);
      renderedVersion.current = { doc, zoom };
      setLoading(false);
    }).catch(reason => {
      if (controller.signal.aborted) return;
      setLoading(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => controller.abort();
  }, [nearby, doc, pageNumber, zoom, retry]);

  return <div className="page" ref={ref} data-page={pageNumber} aria-label={`第 ${pageNumber} 页原稿`} aria-busy={loading}>
    <canvas ref={canvasRef} width={800} height={1100} />
    <div ref={textRef} className="textLayer" />
    {doc && pageSize && <RegionAIButton doc={doc} page={pageNumber} crop={[0, 0, ...pageSize]} caption={`第 ${pageNumber} 页原稿`} />}
    {loading && <div className="page-render-status" role="status">正在加载原页…</div>}
    {textError && <div className="page-text-error" role="status">文字层加载失败，可切换重排模式或发送本页图片。</div>}
    {error && <div className="page-render-error" role="alert">原页加载失败：{error}
      <button className="btn ghost" onClick={() => setRetry(value => value + 1)}>重新加载</button>
    </div>}
  </div>;
});
