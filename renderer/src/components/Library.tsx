import { useEffect, useMemo, useState } from 'react';
import type { Collection, Paper } from '@shared/types';
import { displayVenue } from '@shared/venue';
import {
  IconBook,
  IconChevronDown,
  IconFolder,
  IconLibrary,
  IconMore,
  IconPlus,
  IconSearch,
  IconSettings,
} from './icons';
import { PAPER_DRAG_TYPE, stableRecentPapers, scopePaper, type LibraryScope } from '@/lib/library';
import './library.css';
import appIcon from '../../../assets/app-mark.png';
interface Props {
  papers: Paper[];
  collections: Collection[];
  scope: LibraryScope;
  currentId: string | null;
  onSelect: (id: string) => void;
  onScope: (scope: LibraryScope) => void;
  onSearch: () => void;
  onImport: () => void;
  onOpenSettings: () => void;
  onMenu: (paper: Paper, position: { x: number; y: number }) => void;
  onCreateCollection: (parentId?: string) => void;
  onEditCollection: (collection: Collection) => void;
  onDropPapers: (ids: string[], collectionId: string) => Promise<void>;
  onError: (message: string) => void;
  busy: boolean;
  open?: boolean;
}
export function Library({
  papers,
  collections,
  scope,
  currentId,
  onSelect,
  onScope,
  onSearch,
  onImport,
  onOpenSettings,
  onMenu,
  onCreateCollection,
  onEditCollection,
  onDropPapers,
  onError,
  busy,
  open = true,
}: Props) {
  const [foldersOpen, setFoldersOpen] = useState(true);
  const [recentOpen, setRecentOpen] = useState(true);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [recentOrder, setRecentOrder] = useState<string[]>([]);
  const recent = useMemo(() => stableRecentPapers(papers, recentOrder), [papers, recentOrder]);
  useEffect(() => {
    const ids = recent.map((paper) => paper.id);
    if (ids.length !== recentOrder.length || ids.some((id, index) => id !== recentOrder[index])) {
      setRecentOrder(ids);
    }
  }, [recent, recentOrder]);
  const folder = (c: Collection) => {
    const children = collections.filter((item) => item.parentId === c.id);
    return (
      <div key={c.id} className={c.parentId ? 'collection-branch nested' : 'collection-branch'}>
        <div
          className={`collection-row${!currentId && scope === c.id ? ' selected' : ''}${dragOver === c.id ? ' drop-target' : ''}`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(PAPER_DRAG_TYPE)) {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'copy';
              setDragOver(c.id);
            }
          }}
          onDragLeave={() => setDragOver(null)}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes(PAPER_DRAG_TYPE)) return;
            e.preventDefault();
            e.stopPropagation();
            setDragOver(null);
            try {
              const ids = JSON.parse(e.dataTransfer.getData(PAPER_DRAG_TYPE));
              void onDropPapers(ids, c.id).catch((error) => onError(String(error.message ?? error)));
            } catch {
              onError('无法读取拖动的文献');
            }
          }}
        >
          {children.length > 0 ? (
            <button
              className="collection-disclosure"
              aria-label={`${collapsed.has(c.id) ? '展开' : '收起'}${c.name}`}
              aria-expanded={!collapsed.has(c.id)}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(c.id)) next.delete(c.id);
                  else next.add(c.id);
                  return next;
                })
              }
            >
              <IconChevronDown style={{ transform: collapsed.has(c.id) ? 'rotate(-90deg)' : undefined }} />
            </button>
          ) : (
            <span className="collection-disclosure" />
          )}
          <button className="collection-open" onClick={() => onScope(c.id)} title={c.name}>
            <IconFolder />
            <span>{c.name}</span>
            <small>{papers.filter((p) => scopePaper(p, c.id, collections)).length}</small>
          </button>
          <button
            className="collection-more"
            title="编辑分类"
            aria-label={`编辑分类${c.name}`}
            onClick={() => onEditCollection(c)}
          >
            <IconMore />
          </button>
        </div>
        {children.length > 0 && <div className="motion-disclosure" data-open={!collapsed.has(c.id)} aria-hidden={collapsed.has(c.id)} inert={collapsed.has(c.id)}>
          <div>{children.map(folder)}</div>
        </div>}
      </div>
    );
  };
  return (
    <aside
      id="library-navigation"
      className="rail"
      data-open={open}
      aria-label="文献导航"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="rail-window-space" aria-hidden="true" />
      <nav className="rail-primary-actions" aria-label="书库操作">
        <button className="rail-primary-action" onClick={onImport} disabled={busy}>
          <IconPlus />
          <span>{busy ? '正在导入…' : '导入 PDF'}</span>
          <kbd>⌘ O</kbd>
        </button>
        <button className="rail-primary-action" onClick={onSearch}>
          <IconSearch />
          <span>搜索文献</span>
          <kbd>⌘ K</kbd>
        </button>
        <button
          className={`rail-primary-action${!currentId && scope === 'all' ? ' selected' : ''}`}
          onClick={() => onScope('all')}
          aria-current={!currentId && scope === 'all' ? 'page' : undefined}
        >
          <IconLibrary />
          <span>全部文献</span>
          <span className="rail-count">{papers.length}</span>
        </button>
        <button
          className={`rail-primary-action${!currentId && scope === 'unfiled' ? ' selected' : ''}`}
          onClick={() => onScope('unfiled')}
        >
          <IconFolder />
          <span>未分类</span>
          <span className="rail-count">{papers.filter((p) => !p.collectionIds.length).length}</span>
        </button>
      </nav>
      <div className="library-nav-scroll">
        <div className="library-section-heading">
          <button onClick={() => setFoldersOpen(!foldersOpen)} aria-expanded={foldersOpen}>
            <IconChevronDown style={{ transform: foldersOpen ? undefined : 'rotate(-90deg)' }} />
            我的分类
          </button>
          <button aria-label="新建分类" title="新建分类" onClick={() => onCreateCollection()}>
            <IconPlus />
          </button>
        </div>
        <div className="motion-disclosure" data-open={foldersOpen} aria-hidden={!foldersOpen} inert={!foldersOpen}>
          <div className="collection-tree">
            {collections.filter((c) => !c.parentId).map(folder)}
            {!collections.length && (
              <button className="create-first-collection" onClick={() => onCreateCollection()}>
                新建你的第一个分类
              </button>
            )}
          </div>
        </div>
        <div className="library-section-heading">
          <button onClick={() => setRecentOpen(!recentOpen)} aria-expanded={recentOpen}>
            <IconChevronDown style={{ transform: recentOpen ? undefined : 'rotate(-90deg)' }} />
            最近阅读
          </button>
          <span>{recent.length} / 10</span>
        </div>
        <div className="motion-disclosure" data-open={recentOpen} aria-hidden={!recentOpen} inert={!recentOpen}>
          <div className="recent-papers">
            {recent.length ? (
              recent.map((paper) => (
                <div
                  key={paper.id}
                  className={`paper-row${paper.id === currentId ? ' active' : ''}`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onMenu(paper, { x: e.clientX, y: e.clientY });
                  }}
                >
                  <button className="paper-open" title={paper.title} aria-current={paper.id === currentId ? 'page' : undefined} onClick={() => onSelect(paper.id)}>
                    <IconBook />
                    <span className="paper-row-copy">
                      <span className="paper-title">{paper.title}</span>
                      <span className="paper-meta">
                        {paper.venue && <><span className="paper-meta-venue" title={paper.venue}>{displayVenue(paper.venue)}</span><span aria-hidden="true">·</span></>}
                        <span>{[paper.year, paper.pageCount ? `${paper.pageCount} 页` : 'PDF'].filter(Boolean).join(' · ')}</span>
                      </span>
                    </span>
                  </button>
                  <button
                    className="paper-more"
                    aria-label={`${paper.title}的更多操作`}
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      onMenu(paper, { x: r.right, y: r.bottom });
                    }}
                  >
                    <IconMore />
                  </button>
                </div>
              ))
            ) : (
              <p className="library-nav-empty">打开文献后会显示在这里。</p>
            )}
          </div>
        </div>
      </div>
      <footer className="rail-footer">
        <button className="rail-workspace" onClick={() => onScope('all')}>
          <img className="rail-logo" src={appIcon} alt="" width={24} height={24} draggable={false} />
          <span>ScholarLite</span>
        </button>
        <button className="btn icon ghost" title="设置（⌘ ,）" aria-label="设置" onClick={onOpenSettings}>
          <IconSettings />
        </button>
      </footer>
    </aside>
  );
}
