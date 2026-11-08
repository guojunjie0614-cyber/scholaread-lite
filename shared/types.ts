import type { ChatApi } from './chat-types.js';

export type BlockKind =
  'h1' | 'h2' | 'h3' | 'p' | 'li' | 'quote' | 'math' | 'algorithm' | 'figure' | 'table' | 'table-note' | 'caption' | 'ref';

export type LatexSource = 'pdf-structure' | 'pix2tex' | 'manual';

/** Text stays in source order; concatenated runs equal Block.text for selection offsets. */
export interface TextRun {
  text: string;
  script?: 'sub' | 'sup';
  italic?: boolean;
  bold?: boolean;
  /** A source math atom, positioned in base-font em without changing canonical text order. */
  mathPosition?: { group: string; x: number; y: number; width: number; size: number };
}

export interface Block {
  id: string;
  paperId: string;
  page: number;
  ord: number;
  kind: BlockKind;
  text: string;
  /** [x0, y0, x1, y1] in PDF points, 用于图表裁剪 */
  bbox?: [number, number, number, number];
  /** 图表块专用：裁剪区域（页内坐标） */
  crop?: [number, number, number, number];
  /** 行间公式编号，如 "(12)" */
  eqNo?: string;
  eqNoInCrop?: boolean;
  recognitionCrop?: [number, number, number, number];
  sourceFontSize?: number;
  parentBlockId?: string;
  figureLabel?: string;
  textRuns?: TextRun[];
  readingRole?: 'publication' | 'title' | 'authors' | 'affiliations' | 'biography';
  /** Native text has an unmapped glyph; display its original crop instead of guessing. */
  sourceTextFallback?: boolean;
  nativeLatex?: string;
  structureWarnings?: string[];
  latexSource?: LatexSource;
  latex?: string;
  latexVerified?: boolean;
  /** Retain single-equation reviews when complete source geometry joins several equations. */
  formulaReviews?: { eqNo: string; latex: string; latexVerified: boolean; latexSource?: LatexSource }[];
  source?: 'native' | 'ocr';
  confidence?: number;
  analysisVersion?: number;
}

export type FormulaSource = Pick<Block, 'page' | 'crop' | 'eqNo' | 'text'>;

export type ReadingStatus = 'unread' | 'reading' | 'read';

export interface Collection {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

export interface Paper {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxivId: string | null;
  venue: string | null;
  abstract: string | null;
  tags: string[];
  fileName: string;
  pageCount: number | null;
  addedAt: string;
  lastReadAt: string | null;
  readingStatus: ReadingStatus;
  collectionIds: string[];
}

export interface PaperMeta {
  title?: string;
  authors?: string[];
  year?: number | null;
  doi?: string | null;
  arxivId?: string | null;
  venue?: string | null;
  abstract?: string | null;
}

export interface Note {
  id: string;
  paperId: string;
  blockId: string | null;
  page: number | null;
  quote: string | null;
  body: string;
  color: 'yellow' | 'green' | 'blue' | 'pink' | 'purple';
  kind: 'note' | 'highlight';
  startOffset: number | null;
  endOffset: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Progress {
  page: number;
  scroll: number;
  mode: 'reflow' | 'faithful';
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  temperature?: number;
  api?: 'chat-completions' | 'responses';
  reasoningEffort?: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface ProviderModel {
  id: string;
  label: string;
  api: 'chat-completions' | 'responses';
  reasoningLevels?: string[];
}

export interface Settings {
  targetLang: string;
  theme: 'light' | 'dark' | 'auto';
  translate: {
    activeProvider: string;
    concurrency: number;
    providers: Record<string, ProviderConfig>;
  };
  reading: {
    /** Percentage of the fitted PDF page width; older settings default to 100. */
    pdfZoom?: number;
    fontSize: number;
    lineHeight: number;
    maxWidth: number;
    fontFamily: 'serif' | 'sans';
  };
  reflow: {
    keepFigures: boolean;
  };
}

export interface TranslationOrigin { provider: string; model: string }
export interface CachedTranslation extends TranslationOrigin { text: string }
export interface TranslationFailure { index: number; message: string; retryable: boolean; retryAfterMs?: number }

export interface TranslateResult {
  results: string[];
  provider: string;
  model: string;
  cached: boolean;
  origins?: (TranslationOrigin | null)[];
  failures?: TranslationFailure[];
}

export type TranslationPriority = 'interactive' | 'visible' | 'background';
export interface TranslateOptions { priority?: TranslationPriority; refresh?: boolean }
/** Only complete, validated segments are delivered through this event. */
export interface TranslationSegment { requestId: string; index: number; text: string; origin?: TranslationOrigin }

export interface ProviderInfo {
  id: string;
  label: string;
  needsKey: boolean;
  needsBaseUrl: boolean;
  defaultModel?: string;
  hint?: string;
}

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
}

export interface OcrResult {
  engine: 'apple-vision';
  width: number;
  height: number;
  lines: Array<OcrWord & { words: OcrWord[] }>;
}

export interface AppAppearance {
  nativeVibrancy: boolean;
  reducedTransparency: boolean;
  platform: string;
}

export type LibraryImportSource = 'zotero' | 'folder';
export interface LibraryImportLocation { path: string; label: string; source: LibraryImportSource }
export interface LibraryImportProgress {
  total: number;
  processed: number;
  imported: number;
  skipped: number;
  failed: number;
  current: string;
  phase?: 'discovering' | 'importing';
  sourceLabel?: string;
}
export interface LibraryImportResult extends LibraryImportProgress {
  cancelled: boolean;
  issues: string[];
  sources?: LibraryImportLocation[];
}

export interface PaperMetadataChange {
  id: string;
  patch: Partial<Pick<Paper, 'year' | 'venue'>>;
}

export interface LiteApi {
  chat: ChatApi;
  libraryImport: {
    discover(): Promise<LibraryImportLocation[]>;
    choose(): Promise<string | null>;
    auto(): Promise<LibraryImportResult>;
    start(source: LibraryImportSource, path: string): Promise<LibraryImportResult>;
    cancel(): Promise<void>;
    onProgress(listener: (progress: LibraryImportProgress) => void): () => void;
  };
  formula: {
    recognize(dataUrl: string): Promise<{ latex: string; engine: 'pix2tex' }>;
  };
  ocr: {
    recognize(dataUrl: string): Promise<OcrResult>;
  };
  papers: {
    list(): Promise<Paper[]>;
    onMetadataChange(listener: (change: PaperMetadataChange) => void): () => void;
    get(id: string): Promise<Paper | null>;
    importFile(collectionIds?: string[]): Promise<Paper | null>;
    importPath(filePath: string, collectionIds?: string[]): Promise<Paper>;
    opened(id: string): Promise<Paper>;
    addTags(ids: string[], tags: string[]): Promise<Paper[]>;
    setStatus(ids: string[], status: ReadingStatus): Promise<Paper[]>;
    update(id: string, patch: Partial<Paper>): Promise<Paper>;
    remove(id: string): Promise<void>;
  };
  collections: {
    list(): Promise<Collection[]>;
    create(name: string, parentId?: string | null): Promise<Collection>;
    update(id: string, patch: { name: string; parentId: string | null }): Promise<Collection>;
    remove(id: string): Promise<void>;
    addPapers(paperIds: string[], collectionIds: string[]): Promise<void>;
    removePapers(paperIds: string[], collectionId: string): Promise<void>;
    setForPaper(paperId: string, collectionIds: string[]): Promise<void>;
  };
  meta: {
    lookup(q: { doi?: string; arxivId?: string; title?: string }): Promise<PaperMeta | null>;
  };
  blocks: {
    list(paperId: string): Promise<Block[]>;
    save(paperId: string, blocks: Block[]): Promise<void>;
    setFormula(
      paperId: string,
      blockId: string,
      latex: string,
      verified: boolean,
      source: FormulaSource,
      origin?: LatexSource,
    ): Promise<Block>;
    clear(paperId: string): Promise<void>;
  };
  notes: {
    list(paperId: string): Promise<Note[]>;
    create(n: Partial<Note> & { paperId: string }): Promise<Note>;
    update(id: string, patch: Partial<Note>): Promise<Note>;
    remove(id: string): Promise<void>;
    exportMarkdown(paperId: string): Promise<string | null>;
  };
  progress: {
    get(paperId: string): Promise<Progress | null>;
    set(paperId: string, p: Progress): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>;
    set(patch: DeepPartial<Settings>): Promise<Settings>;
    providers(): Promise<ProviderInfo[]>;
    magpieModels(baseUrl: string): Promise<ProviderModel[]>;
  };
  translate: {
    cached(texts: string[], target: string): Promise<(CachedTranslation | null)[]>;
    batch(texts: string[], target?: string, requestId?: string, options?: TranslateOptions): Promise<TranslateResult>;
    cancel(requestId: string): Promise<void>;
    prioritize(requestId: string, priority: TranslationPriority): Promise<void>;
    onSegment(listener: (segment: TranslationSegment) => void): () => void;
  };
  app: {
    copyText(text: string): Promise<void>;
    openExternal(url: string): Promise<void>;
    revealPaper(paperId: string): Promise<void>;
    platform(): Promise<string>;
    appearance(): Promise<AppAppearance>;
    onAppearanceChange(listener: (value: AppAppearance) => void): () => void;
    getPathForFile(file: File): string;
  };
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
