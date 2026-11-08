import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AgentId, AgentConfig, AgentInfo, ChatApi, ChatCatalog, ChatConversation, ChatState, ChatSendInput, ChatEvent } from '../shared/chat-types.js';
import type {
  Block,
  Note,
  Paper,
  PaperMetadataChange,
  Progress,
  Settings,
  DeepPartial,
  OcrResult,
  FormulaSource,
  LatexSource,
  Collection,
  ReadingStatus,
  AppAppearance,
  ProviderInfo,
  ProviderModel,
  TranslateResult,
  CachedTranslation,
  TranslateOptions,
  TranslationPriority,
  TranslationSegment,
  LibraryImportSource,
  LibraryImportLocation,
  LibraryImportResult,
  LibraryImportProgress,
} from '../shared/types.js';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api = {
  chat: {
    providers: () => invoke<AgentInfo[]>('chat:providers'),
    catalog: (refresh?: boolean) => invoke<ChatCatalog>('chat:catalog', refresh),
    configure: (id: AgentId, config: AgentConfig) => invoke<AgentInfo[]>('chat:configure', id, config),
    list: (paperId: string) => invoke<ChatConversation[]>('chat:list', paperId),
    create: (input: Parameters<ChatApi['create']>[0]) => invoke<ChatState>('chat:create', input),
    get: (id: string) => invoke<ChatState>('chat:get', id),
    delete: (id: string) => invoke<void>('chat:delete', id),
    restore: (id: string) => invoke<ChatState>('chat:restore', id),
    rename: (id: string, title: string) => invoke<ChatState>('chat:rename', id, title),
    fork: (conversationId: string, beforeMessageId: string) => invoke<ChatState>('chat:fork', conversationId, beforeMessageId),
    send: (input: ChatSendInput) => invoke<void>('chat:send', input),
    stop: (conversationId: string) => invoke<void>('chat:stop', conversationId),
    onEvent: (listener: (value: ChatEvent) => void) => {
      const handle = (_event: Electron.IpcRendererEvent, value: ChatEvent) => listener(value);
      ipcRenderer.on('chat:event', handle);
      return () => ipcRenderer.removeListener('chat:event', handle);
    },
  },
  libraryImport: {
    discover: () => invoke<LibraryImportLocation[]>('libraryImport:discover'),
    choose: () => invoke<string | null>('libraryImport:choose'),
    auto: () => invoke<LibraryImportResult>('libraryImport:auto'),
    start: (source: LibraryImportSource, path: string) => invoke<LibraryImportResult>('libraryImport:start', source, path),
    cancel: () => invoke<void>('libraryImport:cancel'),
    onProgress: (listener: (value: LibraryImportProgress) => void) => {
      const handle = (_event: Electron.IpcRendererEvent, value: LibraryImportProgress) => listener(value);
      ipcRenderer.on('libraryImport:progress', handle);
      return () => ipcRenderer.removeListener('libraryImport:progress', handle);
    },
  },
  formula: {
    recognize: (dataUrl: string) =>
      invoke<{ latex: string; engine: 'pix2tex' }>('formula:recognize', dataUrl),
  },
  ocr: {
    recognize: (dataUrl: string) => invoke<OcrResult>('ocr:recognize', dataUrl),
  },
  papers: {
    list: () => invoke<Paper[]>('papers:list'),
    onMetadataChange: (listener: (change: PaperMetadataChange) => void) => {
      const handle = (_event: Electron.IpcRendererEvent, change: PaperMetadataChange) => listener(change);
      ipcRenderer.on('papers:metadata-changed', handle);
      return () => ipcRenderer.removeListener('papers:metadata-changed', handle);
    },
    get: (id: string) => invoke<Paper | null>('papers:get', id),
    importFile: (collectionIds?: string[]) => invoke<Paper | null>('papers:import', collectionIds),
    importPath: (filePath: string, collectionIds?: string[]) =>
      invoke<Paper>('papers:importPath', filePath, collectionIds),
    opened: (id: string) => invoke<Paper>('papers:opened', id),
    addTags: (ids: string[], tags: string[]) => invoke<Paper[]>('papers:addTags', ids, tags),
    setStatus: (ids: string[], status: ReadingStatus) => invoke<Paper[]>('papers:setStatus', ids, status),
    update: (id: string, patch: Partial<Paper>) => invoke<Paper>('papers:update', id, patch),
    remove: (id: string) => invoke<void>('papers:remove', id),
  },
  collections: {
    list: () => invoke<Collection[]>('collections:list'),
    create: (name: string, parentId?: string | null) =>
      invoke<Collection>('collections:create', name, parentId),
    update: (id: string, patch: { name: string; parentId: string | null }) =>
      invoke<Collection>('collections:update', id, patch),
    remove: (id: string) => invoke<void>('collections:remove', id),
    addPapers: (paperIds: string[], collectionIds: string[]) =>
      invoke<void>('collections:addPapers', paperIds, collectionIds),
    removePapers: (paperIds: string[], collectionId: string) =>
      invoke<void>('collections:removePapers', paperIds, collectionId),
    setForPaper: (paperId: string, collectionIds: string[]) =>
      invoke<void>('collections:setForPaper', paperId, collectionIds),
  },
  meta: {
    lookup: (q: { doi?: string; arxivId?: string; title?: string }) => invoke('meta:lookup', q),
  },
  blocks: {
    list: (paperId: string) => invoke<Block[]>('blocks:list', paperId),
    save: (paperId: string, list: Block[]) => invoke<void>('blocks:save', paperId, list),
    setFormula: (
      paperId: string,
      blockId: string,
      latex: string,
      verified: boolean,
      source: FormulaSource,
      origin?: LatexSource,
    ) => invoke<Block>('blocks:setFormula', paperId, blockId, latex, verified, source, origin),
    clear: (paperId: string) => invoke<void>('blocks:clear', paperId),
  },
  notes: {
    list: (paperId: string) => invoke<Note[]>('notes:list', paperId),
    create: (n: Partial<Note> & { paperId: string }) => invoke<Note>('notes:create', n),
    update: (id: string, patch: Partial<Note>) => invoke<Note>('notes:update', id, patch),
    remove: (id: string) => invoke<void>('notes:remove', id),
    exportMarkdown: (paperId: string, targetPath?: string) =>
      invoke<string | null>('notes:exportMarkdown', paperId, targetPath),
  },
  progress: {
    get: (paperId: string) => invoke<Progress | null>('progress:get', paperId),
    set: (paperId: string, p: Progress) => invoke<void>('progress:set', paperId, p),
  },
  settings: {
    get: () => invoke<Settings>('settings:get'),
    set: (patch: DeepPartial<Settings>) => invoke<Settings>('settings:set', patch),
    providers: () => invoke<ProviderInfo[]>('settings:providers'),
    magpieModels: (baseUrl: string) => invoke<ProviderModel[]>('settings:magpieModels', baseUrl),
  },
  translate: {
    cached: (texts: string[], target: string) => invoke<(CachedTranslation | null)[]>('translate:cached', texts, target),
    batch: (texts: string[], target?: string, requestId?: string, options?: TranslateOptions) =>
      invoke<TranslateResult>('translate:batch', texts, target, requestId, options),
    cancel: (requestId: string) => invoke<void>('translate:cancel', requestId),
    prioritize: (requestId: string, priority: TranslationPriority) => invoke<void>('translate:prioritize', requestId, priority),
    onSegment: (listener: (segment: TranslationSegment) => void) => {
      const handle = (_event: Electron.IpcRendererEvent, segment: TranslationSegment) => listener(segment);
      ipcRenderer.on('translate:segment', handle);
      return () => { ipcRenderer.removeListener('translate:segment', handle); };
    },
  },
  app: {
    copyText: (text: string) => invoke<void>('chat:copyText', text),
    openExternal: (url: string) => invoke<void>('app:openExternal', url),
    revealPaper: (paperId: string) => invoke<void>('app:reveal', paperId),
    platform: () => invoke<string>('app:platform'),
    appearance: () => invoke<AppAppearance>('app:appearance'),
    onAppearanceChange: (listener: (value: AppAppearance) => void) => {
      const handle = (_event: Electron.IpcRendererEvent, value: AppAppearance) => listener(value);
      ipcRenderer.on('app:appearance-changed', handle);
      return () => ipcRenderer.removeListener('app:appearance-changed', handle);
    },
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
};

contextBridge.exposeInMainWorld('lite', api);

export type LiteBridge = typeof api;
