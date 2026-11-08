import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import type { Block, Note, Paper, PaperMetadataChange, ProviderInfo, Settings, Collection, AppAppearance } from '@shared/types';
import { api } from '@/lib/api';
import { loadPdf, releasePdfResources, type PDFDocumentProxy } from '@/lib/pdf';
import { recognizePage } from '@/reflow/ocr';
import { analyzeDocument, REFLOW_ENGINE_VERSION } from '@/reflow/analyze';
import { Library } from '@/components/Library';
import { Reader } from '@/components/Reader';
import { NotesPanel } from '@/components/NotesPanel';
import { SettingsDialog, type SettingsSection } from '@/components/SettingsDialog';
import { LibraryHome } from '@/components/LibraryHome';
import { PaperManagement, type PaperTarget } from '@/components/PaperManagement';
import { PanelToggle } from '@/components/PanelToggle';
import { CollectionEditor } from '@/components/CollectionDialogs';
import { scopePaper, collectionDescendants, type LibraryScope } from '@/lib/library';
import type { ChatRequest, PaperReference } from '@shared/chat-types';
import { isReadingContent } from '@shared/reading-content';
import { ChatPanel } from '@/chat/ChatPanel';
import { ReaderAIContext } from '@/components/ReaderAIContext';
import '@/components/reader-ai.css';

type Mode = 'reflow' | 'faithful';

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [papers, setPapers] = useState<Paper[]>([]);
  const initialMetadata = useRef(new Map<string, PaperMetadataChange['patch']>());
  const libraryLoaded = useRef(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [scope, setScope] = useState<LibraryScope>('all');
  const [searchRequest, setSearchRequest] = useState(0);
  const [collectionTarget, setCollectionTarget] = useState<{
    collection?: Collection;
    parentId?: string | null;
  } | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [analysisRevision, setAnalysisRevision] = useState(0);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [analyzing, setAnalyzing] = useState<{ done: number; total: number } | null>(null);
  const [mode, setMode] = useState<Mode>('reflow');
  const [originalPage, setOriginalPage] = useState<{ paperId: string; page: number } | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelTab, setPanelTab] = useState<'notes' | 'outline' | 'ai'>('notes');
  const [chatRequest, setChatRequest] = useState<ChatRequest | null>(null);
  const [chatWidth, setChatWidth] = useState(() => Number(localStorage.getItem('slite-chat-width')) || 420);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [paperTarget, setPaperTarget] = useState<PaperTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const resize = () => {
      setViewportWidth(window.innerWidth);
      if (panelTab === 'ai' && window.innerWidth < 1150) setSidebarOpen(false);
    };
    resize(); window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [panelTab]);

  const docRef = useRef<PDFDocumentProxy | null>(null);
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const settingsRef = useRef<Settings | null>(null);
  const importRef = useRef<() => Promise<void>>(async () => {});
  const importing = useRef(false);
  const choosePaper = useCallback((id: string | null) => {
    setOriginalPage(null);
    currentIdRef.current = id;
    setCurrentId(id);
  }, []);
  const openOriginalPage = useCallback((page: number) => {
    const paperId = currentIdRef.current;
    if (!paperId) return;
    setOriginalPage({ paperId, page });
    setMode('faithful');
  }, []);
  useEffect(() => {
    if (mode !== 'faithful' || !originalPage || originalPage.paperId !== currentId || !doc) return;
    const target = document.querySelector(`.reader-scroll [data-page="${originalPage.page}"]`);
    if (target) { target.scrollIntoView({ block: 'start' }); setOriginalPage(null); }
  }, [originalPage, mode, currentId, doc]);
  const openMenu = (paper: Paper, position: { x: number; y: number }) =>
    setPaperTarget({ paper, ...position });
  const chooseScope = (next: LibraryScope) => {
    setScope(next);
    choosePaper(null);
  };
  const searchLibrary = () => {
    choosePaper(null);
    setScope('all');
    setSearchRequest((value) => value + 1);
  };
  const toastTimer = useRef<number | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => api.papers.onMetadataChange(({ id, patch }) => {
    if (!libraryLoaded.current) initialMetadata.current.set(id, { ...initialMetadata.current.get(id), ...patch });
    setPapers(previous => previous.map(paper => paper.id === id ? { ...paper, ...patch } : paper));
  }), []);

  // 启动：设置 + 服务商 + 书库
  useEffect(() => {
    void (async () => {
      try {
        const [s, p, list, groups] = await Promise.all([
          api.settings.get(),
          api.settings.providers(),
          api.papers.list(),
          api.collections.list(),
        ]);
        setSettings(s);
        setProviders(p);
        setPapers(list.map(paper => ({ ...paper, ...initialMetadata.current.get(paper.id) })));
        initialMetadata.current.clear();
        libraryLoaded.current = true;
        setCollections(groups);
        // The library is the stable landing page; opening a document restores its own progress.
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [notify]);

  useEffect(() => {
    let alive = true;
    const apply = (value: AppAppearance) => {
      if (!alive) return;
      document.documentElement.dataset.nativeVibrancy = String(value.nativeVibrancy);
      document.documentElement.dataset.reduceTransparency = String(value.reducedTransparency);
      document.documentElement.dataset.platform = value.platform;
    };
    void api.app
      .appearance()
      .then(apply)
      .catch((error) => notify(String(error.message ?? error)));
    const unsubscribe = api.app.onAppearanceChange(apply);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [notify]);

  // 主题
  useEffect(() => {
    if (!settings) return;
    const apply = () => {
      const resolved =
        settings.theme === 'auto'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : settings.theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    if (settings.theme === 'auto') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [settings]);

  // 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setSettingsSection('appearance');
        setSettingsOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && ['k', 'f'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        choosePaper(null);
        setScope('all');
        setSearchRequest((value) => value + 1);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void importRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key !== 'Escape' ||
        e.defaultPrevented ||
        document.querySelector('[role="dialog"], [role="menu"]')
      )
        return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (settingsOpen) {
        setSettingsOpen(false);
        return;
      }
      const sel = window.getSelection();
      if (sel && sel.toString().trim()) {
        sel.removeAllRanges();
        return;
      }
      if (currentId) choosePaper(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentId, settingsOpen, choosePaper]);

  const refreshPapers = useCallback(async () => {
    const [list, groups] = await Promise.all([api.papers.list(), api.collections.list()]);
    setPapers(list);
    setCollections(groups);
    return list;
  }, []);

  const handleImport = useCallback(
    async (collectionIds?: string[]) => {
      if (importing.current) return;
      importing.current = true;
      setBusy(true);
      try {
        const paper = await api.papers.importFile(
          collectionIds ?? (scope === 'all' || scope === 'unfiled' ? [] : [scope]),
        );
        if (paper) {
          await refreshPapers();
          choosePaper(paper.id);
          notify('已导入');
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
      } finally {
        importing.current = false;
        setBusy(false);
      }
    },
    [notify, refreshPapers, choosePaper, scope],
  );
  importRef.current = handleImport;

  // 打开文献：加载 PDF + 重排块（无缓存则现场解析）
  useEffect(() => {
    let cancelled = false;

    if (!currentId) {
      const previous = docRef.current;
      docRef.current = null;
      if (previous) { releasePdfResources(previous); void previous.destroy().catch(() => {}); }
      setAnalyzing(null);
      setDoc(null);
      setBlocks([]);
      setNotes([]);
      return;
    }

    void (async () => {
      try {
        if (docRef.current) {
          const old = docRef.current;
          docRef.current = null;
          setDoc(null);
          releasePdfResources(old);
          void old.destroy().catch(() => {});
        }

        setBlocks([]);
        const [storedBlocks, storedNotes] = await Promise.all([
          api.blocks.list(currentId),
          api.notes.list(currentId),
        ]);
        if (cancelled || currentIdRef.current !== currentId) return;
        setNotes(storedNotes);
        setBlocks(storedBlocks);
        // Recording a visit must not delay cached text or PDF initialization.
        void api.papers.opened(currentId).then(opened => {
          if (!cancelled && currentIdRef.current === currentId) {
            setPapers(previous => previous.map(paper => paper.id === currentId
              ? { ...paper, lastReadAt: opened.lastReadAt, readingStatus: paper.readingStatus === 'unread' ? opened.readingStatus : paper.readingStatus }
              : paper));
          }
        }).catch(error => {
          if (!cancelled && currentIdRef.current === currentId) notify(`阅读记录保存失败：${error instanceof Error ? error.message : String(error)}`);
        });

        const pdf = await loadPdf(currentId);
        if (cancelled || currentIdRef.current !== currentId) {
          releasePdfResources(pdf);
          void pdf.destroy().catch(() => {});
          return;
        }
        docRef.current = pdf;
        setDoc(pdf);
        if (storedBlocks.length && storedBlocks.every((b) => b.analysisVersion === REFLOW_ENGINE_VERSION)) {
          return;
        }

        setAnalyzing({ done: 0, total: pdf.numPages });
        try {
          const parsed = await analyzeDocument(pdf, currentId, {
            ocrPage: recognizePage,
            keepFigures: settingsRef.current?.reflow.keepFigures ?? true,
            onProgress: (done, total) =>
              !cancelled && currentIdRef.current === currentId && setAnalyzing({ done, total }),
          });
          if (cancelled || currentIdRef.current !== currentId) return;
          const list = parsed.map((b) => ({ ...b, analysisVersion: REFLOW_ENGINE_VERSION }));
          await api.blocks.save(currentId, list);
          if (cancelled || currentIdRef.current !== currentId) return;
          const [savedBlocks, refreshedNotes] = await Promise.all([
            api.blocks.list(currentId),
            api.notes.list(currentId),
          ]);
          if (cancelled || currentIdRef.current !== currentId) return;
          setNotes(refreshedNotes);
          setBlocks(savedBlocks);
          setAnalysisRevision((v) => v + 1);
          await api.papers.update(currentId, { pageCount: pdf.numPages });
          setPapers((prev) => prev.map((p) => (p.id === currentId ? { ...p, pageCount: pdf.numPages } : p)));
        } finally {
          if (!cancelled && currentIdRef.current === currentId) setAnalyzing(null);
        }
      } catch (err) {
        if (!cancelled && currentIdRef.current === currentId) setAnalyzing(null);
        if (!cancelled && currentIdRef.current === currentId)
          notify(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentId, notify]);

  // 完整解析成功后原子替换，失败时保留上一版与笔记。
  const reanalyze = useCallback(async () => {
    const pdf = docRef.current;
    if (!pdf || !currentId) return;
    setAnalyzing({ done: 0, total: pdf.numPages });
    try {
      const parsed = await analyzeDocument(pdf, currentId, {
        ocrPage: recognizePage,
        keepFigures: settingsRef.current?.reflow.keepFigures ?? true,
        onProgress: (done, total) => currentIdRef.current === currentId && setAnalyzing({ done, total }),
      });
      if (currentIdRef.current !== currentId) return;
      const list = parsed.map((b) => ({ ...b, analysisVersion: REFLOW_ENGINE_VERSION }));
      await api.blocks.save(currentId, list);
      const [savedBlocks, refreshedNotes] = await Promise.all([
        api.blocks.list(currentId),
        api.notes.list(currentId),
      ]);
      if (currentIdRef.current !== currentId) return;
      setNotes(refreshedNotes);
      setBlocks(savedBlocks);
      setAnalysisRevision((v) => v + 1);
      notify(`已重新解析 ${list.length} 个段落`);
    } catch (err) {
      if (currentIdRef.current === currentId) notify(err instanceof Error ? err.message : String(err));
    } finally {
      if (currentIdRef.current === currentId) setAnalyzing(null);
    }
  }, [currentId, notify]);

  const onDrop = useCallback(
    async (e: ReactDragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (!file || importing.current) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      let filePath = '';
      try {
        filePath = api.app.getPathForFile(file);
      } catch {
        filePath = '';
      }
      if (!filePath) return notify('无法获取文件路径，请用「导入 PDF」按钮');
      importing.current = true;
      setBusy(true);
      try {
        const paper = await api.papers.importPath(
          filePath,
          scope === 'all' || scope === 'unfiled' ? [] : [scope],
        );
        await refreshPapers();
        choosePaper(paper.id);
        notify('已导入');
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
      } finally {
        importing.current = false;
        setBusy(false);
      }
    },
    [notify, refreshPapers, choosePaper, scope],
  );

  const savePaper = async (id: string, patch: Partial<Paper>) => {
    const saved = await api.papers.update(id, patch);
    setPapers((previous) => previous.map((paper) => (paper.id === id ? saved : paper)));
    notify('文献信息已更新');
  };

  const removePaper = async (paper: Paper) => {
    const wasCurrent = currentIdRef.current === paper.id;
    try {
      if (wasCurrent) {
        // Invalidate in-flight parsing before deleting the record it would save into.
        choosePaper(null);
        setBlocks([]);
        setNotes([]);
        setAnalyzing(null);
        setDoc(null);
        const previous = docRef.current;
        docRef.current = null;
        if (previous) { releasePdfResources(previous); await previous.destroy(); }
      }
      await api.papers.remove(paper.id);
      setPapers((previous) => previous.filter((entry) => entry.id !== paper.id));
      notify('文献已删除');
    } catch (error) {
      if (wasCurrent) choosePaper(paper.id);
      throw error;
    }
  };

  const current = papers.find((p) => p.id === currentId) ?? null;
  const openChat = useCallback((request: ChatRequest) => {
    if (request.paperId !== currentIdRef.current) return;
    setChatRequest(request); setPanelTab('ai'); setPanelOpen(true);
    if (window.innerWidth < 1150) setSidebarOpen(false);
  }, []);
  const handleChatRequest = useCallback((id: string) => setChatRequest(value => value?.id === id ? null : value), []);
  const jumpToReference = (reference: PaperReference) => {
    const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();
    const text = normalized(reference.originalText || reference.quote);
    const candidates = blocks.filter(block => block.page === reference.page && text
      && (normalized(block.text).includes(text) || text.includes(normalized(block.text)) && normalized(block.text).length > 20));
    const regions = reference.crop ? blocks.filter(block => block.page === reference.page && block.crop?.every((value, index) => Math.abs(value - reference.crop![index]) < 1)) : [];
    const exact = regions.length === 1 ? regions[0] : candidates.length === 1 ? candidates[0] : null;
    if (mode === 'reflow' && exact && !isReadingContent(exact)) { openOriginalPage(reference.page); return; }
    const element = mode === 'reflow' && exact ? document.getElementById(`blk-${exact.id}`) : null;
    (element ?? document.querySelector(`.reader-scroll [data-page="${reference.page}"]`))?.scrollIntoView({ block: 'center' });
  };
  const settingsRevision = useRef(0);

  const saveSettings = useCallback(
    async (patch: Settings) => {
      const revision = ++settingsRevision.current;
      const next = await api.settings.set(patch);
      if (revision === settingsRevision.current) setSettings(next);
      notify('设置已保存');
    },
    [notify],
  );

  const changeReading = useCallback(async (reading: Partial<Settings['reading']>) => {
    const revision = ++settingsRevision.current;
    try {
      const next = await api.settings.set({ reading });
      if (revision === settingsRevision.current) setSettings(next);
    } catch (error) {
      notify(`阅读大小保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [notify]);

  return (
    <ReaderAIContext.Provider value={current ? { paper: current, blocks, onRequest: openChat, onError: notify } : null}>
    <div
      className={`app${panelOpen && current ? '' : ' panel-collapsed'}${sidebarOpen ? '' : ' rail-collapsed'}${current ? '' : ' library-view'}${panelTab === 'ai' ? ' ai-panel-active' : ''}`}
      style={panelTab === 'ai' ? { '--panel': `${Math.min(chatWidth, Math.max(340, viewportWidth - 420))}px` } as React.CSSProperties : undefined}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <Library
        open={sidebarOpen}
        papers={papers}
        collections={collections}
        scope={scope}
        onScope={chooseScope}
        onSearch={searchLibrary}
        onMenu={openMenu}
        currentId={currentId}
        busy={busy}
        onSelect={choosePaper}
        onImport={() => void handleImport()}
        onOpenSettings={() => { setSettingsSection('appearance'); setSettingsOpen(true); }}
        onCreateCollection={(parentId) => setCollectionTarget({ parentId })}
        onEditCollection={(collection) => setCollectionTarget({ collection })}
        onDropPapers={async (ids, group) => {
          await api.collections.addPapers(ids, [group]);
          await refreshPapers();
          notify('已加入分类');
        }}
        onError={notify}
      />

      {current ? (
        <Reader
          key={`${current.id}:${analysisRevision}`}
          paper={current}
          doc={doc}
          blocks={blocks}
          notes={notes}
          settings={settings!}
          analyzing={analyzing}
          mode={mode}
          onModeChange={setMode}
          onOpenOriginalPage={openOriginalPage}
          onReadingChange={changeReading}
          onBack={() => choosePaper(null)}
          onOpenTranslationSettings={() => { setSettingsSection('translation'); setSettingsOpen(true); }}
          onExportNotes={async () => {
            try {
              const file = await api.notes.exportMarkdown(current.id);
              if (file) notify(`已导出：${file}`);
            } catch (err) {
              notify(err instanceof Error ? err.message : String(err));
            }
          }}
          onReanalyze={reanalyze}
          onBlockUpdated={(block) =>
            setBlocks((prev) =>
              prev.map((b) =>
                b.id === block.id &&
                b.page === block.page &&
                b.text === block.text &&
                JSON.stringify(b.crop) === JSON.stringify(block.crop)
                  ? block
                  : b,
              ),
            )
          }
          onNoteCreated={(n) => {
            if (currentIdRef.current === n.paperId) setNotes((prev) => [...prev, n]);
          }}
          onToast={notify}
        />
      ) : (
        <LibraryHome
          papers={papers}
          collections={collections}
          scope={scope}
          busy={busy}
          searchRequest={searchRequest}
          onImport={(ids) => void handleImport(ids)}
          onSelect={choosePaper}
          onMenu={openMenu}
          onScope={chooseScope}
          onCreateCollection={(parentId) => setCollectionTarget({ parentId })}
          onAddCollections={async (ids, groups) => {
            await api.collections.addPapers(ids, groups);
            await refreshPapers();
            notify('已加入分类');
          }}
          onRemoveCollection={async (ids, group) => {
            await api.collections.removePapers(ids, group);
            await refreshPapers();
            notify('已移出当前分类，文献仍在书库中');
          }}
          onAddTags={async (ids, tags) => {
            await api.papers.addTags(ids, tags);
            await refreshPapers();
            notify('标签已添加');
          }}
          onSetStatus={async (ids, status) => {
            await api.papers.setStatus(ids, status);
            await refreshPapers();
            notify('阅读状态已更新');
          }}
        />
      )}

      {current && (
        <NotesPanel
          key={current.id}
          open={panelOpen}
          tab={panelTab}
          onTabChange={tab => { setPanelTab(tab); if (tab === 'ai' && window.innerWidth < 1150) setSidebarOpen(false); }}
          chat={<ChatPanel paper={current} request={chatRequest?.paperId === current.id ? chatRequest : null}
            onRequestHandled={handleChatRequest} onJump={jumpToReference} onError={notify}
            onSaveNote={async text => {
              const note = await api.notes.create({ paperId: current.id, body: text, kind: 'note', color: 'blue' });
              if (currentIdRef.current === current.id) setNotes(previous => [...previous, note]);
              notify('已保存到笔记');
            }} />}
          notes={notes}
          blocks={blocks}
          onJump={(blockId) => {
            const block = blocks.find((item) => item.id === blockId);
            if (block && mode === 'reflow' && !isReadingContent(block)) { openOriginalPage(block.page); return; }
            if (mode === 'faithful') {
              if (block)
                document
                  .querySelector(`.reader-scroll [data-page="${block.page}"]`)
                  ?.scrollIntoView({ block: 'start' });
            } else {
              document.getElementById(`blk-${blockId}`)?.scrollIntoView({ block: 'center' });
            }
          }}
          onUpdate={async (id, patch) => {
            const next = await api.notes.update(id, patch);
            setNotes((prev) => prev.map((n) => (n.id === id ? next : n)));
          }}
          onRemove={async (id) => {
            await api.notes.remove(id);
            setNotes((prev) => prev.filter((n) => n.id !== id));
          }}
        />
      )}
      {current && panelOpen && panelTab === 'ai' && <div className="chat-panel-resize" role="separator" aria-label="调整 AI 面板宽度" aria-orientation="vertical" tabIndex={0}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault();
          setChatWidth(value => { const next = Math.max(340, Math.min(640, value + (event.key === 'ArrowLeft' ? 20 : -20))); localStorage.setItem('slite-chat-width', String(next)); return next; });
        }}
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.dragging = 'true'; }}
        onPointerMove={event => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const next = Math.max(340, Math.min(640, window.innerWidth - event.clientX)); setChatWidth(next);
        }}
        onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); delete event.currentTarget.dataset.dragging; localStorage.setItem('slite-chat-width', String(chatWidth)); }} />}

      {paperTarget && (
        <PaperManagement
          key={paperTarget.paper.id}
          target={paperTarget}
          onClose={() => setPaperTarget(null)}
          onOpen={choosePaper}
          onSave={savePaper}
          onDelete={removePaper}
          onToast={notify}
          collections={collections}
          removeCollectionLabel={
            collections.some((c) => c.parentId === scope) ? '移出当前分类及子分类' : '移出当前分类'
          }
          onSetCollections={async (id, groups) => {
            await api.collections.setForPaper(id, groups);
            await refreshPapers();
            notify('分类已更新');
          }}
          onRemoveFromCollection={
            scope !== 'all' && scope !== 'unfiled' && scopePaper(paperTarget.paper, scope, collections)
              ? async () => {
                  await api.collections.removePapers([paperTarget.paper.id], scope);
                  await refreshPapers();
                  notify('已移出当前分类');
                }
              : undefined
          }
        />
      )}

      {settingsOpen && settings && (
        <SettingsDialog
          initialSection={settingsSection}
          settings={settings}
          providers={providers}
          onSave={saveSettings}
          onLibraryImported={async () => { await refreshPapers(); }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {collectionTarget && (
        <CollectionEditor
          target={collectionTarget}
          collections={collections}
          onClose={() => setCollectionTarget(null)}
          onSave={async (name, parentId) => {
            if (collectionTarget.collection)
              await api.collections.update(collectionTarget.collection.id, { name, parentId });
            else await api.collections.create(name, parentId);
            await refreshPapers();
            notify('分类已保存');
          }}
          onDelete={
            collectionTarget.collection
              ? async () => {
                  const id = collectionTarget.collection!.id;
                  await api.collections.remove(id);
                  await refreshPapers();
                  if (collectionDescendants(id, collections).has(scope))
                    setScope('all');
                  notify('分类已删除，文献和笔记已保留');
                }
              : undefined
          }
        />
      )}
      {/* Electron subtracts no-drag controls after all titlebar drag regions. */}
      <PanelToggle
        className="sidebar-toggle"
        side="left"
        open={sidebarOpen}
        label={sidebarOpen ? '收起文献导航' : '展开文献导航'}
        controls="library-navigation"
        onToggle={() => setSidebarOpen((value) => !value)}
      />
      {current && (
        <PanelToggle
          className="notes-toggle"
          side="right"
          open={panelOpen}
          label={panelOpen ? '收起阅读辅助面板' : '展开阅读辅助面板'}
          controls="notes-panel"
          onToggle={() => setPanelOpen((value) => !value)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
    </ReaderAIContext.Provider>
  );
}
