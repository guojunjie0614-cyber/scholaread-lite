import { useEffect, useMemo, useRef, useState } from 'react';
import type { Collection, Paper, ReadingStatus } from '@shared/types';
import { displayVenue } from '@shared/venue';
import { IconBook, IconChevronDown, IconFolder, IconMore, IconPlus, IconSearch } from './icons';
import { Modal } from './Modal';
import DesktopMenu from './DesktopMenu';
import { OrganizeDialog } from './CollectionDialogs';
import {
  collectionLabel,
  collectionOptions,
  PAPER_DRAG_TYPE,
  scopePaper,
  statusLabels,
  type LibraryScope,
} from '@/lib/library';
import './library.css';
import { SelectionGroup } from './SelectionGroup';
import { useContentTransition } from '@/lib/motion';
interface Props {
  papers: Paper[];
  collections: Collection[];
  scope: LibraryScope;
  busy: boolean;
  searchRequest: number;
  onImport: (collectionIds?: string[]) => void;
  onSelect: (id: string) => void;
  onScope: (scope: LibraryScope) => void;
  onMenu: (paper: Paper, position: { x: number; y: number }) => void;
  onCreateCollection: (parentId?: string) => void;
  onAddCollections: (ids: string[], collections: string[]) => Promise<void>;
  onRemoveCollection: (ids: string[], collectionId: string) => Promise<void>;
  onAddTags: (ids: string[], tags: string[]) => Promise<void>;
  onSetStatus: (ids: string[], status: ReadingStatus) => Promise<void>;
}
export function LibraryHome({
  papers,
  collections,
  scope,
  busy,
  searchRequest,
  onImport,
  onSelect,
  onScope,
  onMenu,
  onCreateCollection,
  onAddCollections,
  onRemoveCollection,
  onAddTags,
  onSetStatus,
}: Props) {
  const [query, setQuery] = useState('');
  const [searchAll, setSearchAll] = useState(false);
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('added');
  const [view, setView] = useState<'list' | 'grid'>(() =>
    localStorage.getItem('library-view') === 'grid' ? 'grid' : 'list',
  );
  const contentRef = useRef<HTMLDivElement>(null);
  useContentTransition(contentRef, view);
  const [selected, setSelected] = useState(new Set<string>());
  const anchor = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingSearchFocus = useRef(false);
  const [organizing, setOrganizing] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const importDestination = scope !== 'all' && collections.some((c) => c.id === scope) ? scope : '';
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
    setSearchAll(false);
  }, [scope]);
  useEffect(() => {
    if (searchRequest) {
      pendingSearchFocus.current = true;
      setSelected(new Set());
    }
  }, [searchRequest]);
  useEffect(() => {
    if (pendingSearchFocus.current && searchRef.current) {
      searchRef.current.focus();
      pendingSearchFocus.current = false;
    }
  }, [searchRequest, selected]);
  useEffect(() => {
    setSelected((previous) => new Set([...previous].filter((id) => papers.some((p) => p.id === id))));
  }, [papers]);
  const title =
    scope === 'all' ? '全部文献' : scope === 'unfiled' ? '未分类' : collectionLabel(scope, collections);
  const filtered = useMemo(
    () =>
      papers
        .filter(
          (p) =>
            (searchAll || scopePaper(p, scope, collections)) &&
            (status === 'all' || p.readingStatus === status) &&
            [
              p.title,
              ...p.authors,
              p.year ?? '',
              p.venue ?? '',
              displayVenue(p.venue),
              p.doi ?? '',
              ...p.tags,
              ...p.collectionIds.map((id) => collectionLabel(id, collections)),
            ]
              .join(' ')
              .toLowerCase()
              .includes(query.trim().toLowerCase()),
        )
        .sort((a, b) =>
          sort === 'title'
            ? a.title.localeCompare(b.title, 'zh-CN')
            : sort === 'year'
              ? (b.year ?? 0) - (a.year ?? 0)
              : sort === 'recent'
                ? (b.lastReadAt ?? '').localeCompare(a.lastReadAt ?? '')
                : b.addedAt.localeCompare(a.addedAt),
        ),
    [papers, collections, scope, searchAll, status, query, sort],
  );
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [query, searchAll, status, sort]);
  const chosen = [...selected].filter((id) => filtered.some((p) => p.id === id));
  const allSelected = filtered.length > 0 && chosen.length === filtered.length;
  const select = (id: string, shift = false, toggle = false) => {
    setSelected((previous) => {
      const next = toggle ? new Set(previous) : new Set<string>();
      if (shift && anchor.current) {
        const a = filtered.findIndex((p) => p.id === anchor.current),
          b = filtered.findIndex((p) => p.id === id);
        if (a >= 0 && b >= 0)
          filtered.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((p) => next.add(p.id));
      } else if (toggle && next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!shift) anchor.current = id;
  };
  const run = async (task: () => Promise<void>) => {
    setWorking(true);
    setError('');
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };
  const changeView = (next: 'list' | 'grid') => {
    setView(next);
    localStorage.setItem('library-view', next);
  };
  const sortLabels: Record<string, string> = { added: '最近添加', recent: '最近阅读', title: '标题排序', year: '年份从新到旧' };
  const selectAll = <input
    type="checkbox"
    aria-label="选择当前结果中的全部文献"
    checked={allSelected}
    ref={element => { if (element) element.indeterminate = chosen.length > 0 && !allSelected; }}
    onChange={e => setSelected(new Set(e.target.checked ? filtered.map(p => p.id) : []))}
  />;
  return (
    <main className="main library-workspace">
      <div className="toolbar">
        <div className="doc-title library-heading">
          <h2>{searchAll && scope !== 'all' ? '全部文献' : title}</h2>
          <span className="library-total" aria-live="polite">· {filtered.length}</span>
        </div>
        <div className="library-import">
          <button className="btn library-import-button" onClick={() => onImport(importDestination ? [importDestination] : [])} disabled={busy}>
            <IconPlus />{busy ? '正在导入…' : '导入 PDF'}
          </button>
          <DesktopMenu ariaLabel="选择导入分类" className="library-import-options" align="end" disabled={busy}
            items={[{ id: 'unfiled', label: '未分类', onSelect: () => onImport([]) },
              ...collectionOptions(collections).map(c => ({ id: c.id, label: collectionLabel(c.id, collections), onSelect: () => onImport([c.id]) }))]}>
            <IconChevronDown />
          </DesktopMenu>
        </div>
      </div>
      {chosen.length ? (
        <div className="library-controls library-selection-bar" role="toolbar" aria-label="批量操作">
          <span className="library-selected-count" aria-live="polite">已选 {chosen.length} 篇</span>
          <button className="btn ghost" disabled={working} onClick={() => setOrganizing(true)}><IconFolder />加入分类</button>
          {scope !== 'all' && scope !== 'unfiled' && (
            <button className="btn ghost" disabled={working} onClick={() => void run(() => onRemoveCollection(chosen, scope))}>
              {collections.some(c => c.parentId === scope) ? '移出当前分类及子分类' : '移出当前分类'}
            </button>
          )}
          <button className="btn ghost" disabled={working} onClick={() => { setTagDraft(''); setTagging(true); }}>添加标签</button>
          <DesktopMenu ariaLabel="批量设置阅读状态" className="library-control" disabled={working}
            items={Object.entries(statusLabels).map(([id, label]) => ({ id, label, onSelect: () => void run(() => onSetStatus(chosen, id as ReadingStatus)) }))}>
            标记状态<IconChevronDown />
          </DesktopMenu>
          <button className="btn ghost library-cancel-selection" onClick={() => setSelected(new Set())}>取消选择</button>
        </div>
      ) : (
        <div className="library-controls">
          <div className="library-search">
            {scope !== 'all' ? (
              <DesktopMenu ariaLabel="搜索范围" className="library-search-scope" width={176}
                items={[{ id: 'current', label: '当前分类', selected: !searchAll, onSelect: () => setSearchAll(false) },
                  { id: 'all', label: '全部文献', selected: searchAll, onSelect: () => setSearchAll(true) }]}>
                <IconSearch /><IconChevronDown width={10} height={10} />
              </DesktopMenu>
            ) : <IconSearch />}
            <input ref={searchRef} aria-label="搜索文献" placeholder="搜索文献…" value={query} onChange={e => setQuery(e.target.value)} />
            {searchAll && scope !== 'all' && <span className="library-search-scope-label">全部文献</span>}
            {query && <button className="library-search-clear" aria-label="清除搜索" onClick={() => setQuery('')}>×</button>}
          </div>
          <DesktopMenu ariaLabel="阅读状态筛选" className={`library-control${status !== 'all' ? ' active' : ''}`} width={176}
            items={[{ id: 'all', label: '所有状态', selected: status === 'all', onSelect: () => setStatus('all') },
              ...Object.entries(statusLabels).map(([id, label]) => ({ id, label, selected: status === id, onSelect: () => setStatus(id) }))]}>
            {status === 'all' ? '筛选' : statusLabels[status as ReadingStatus]}<IconChevronDown />
          </DesktopMenu>
          <DesktopMenu ariaLabel="文献排序" className="library-control" width={186}
            items={Object.entries(sortLabels).map(([id, label]) => ({ id, label, selected: sort === id, onSelect: () => setSort(id) }))}>
            {sortLabels[sort]}<IconChevronDown />
          </DesktopMenu>
          <SelectionGroup className="segmented" role="group" aria-label="书库视图">
            <button aria-pressed={view === 'list'} className={view === 'list' ? 'on' : ''} onClick={() => changeView('list')}>列表</button>
            <button aria-pressed={view === 'grid'} className={view === 'grid' ? 'on' : ''} onClick={() => changeView('grid')}>卡片</button>
          </SelectionGroup>
        </div>
      )}
      {error && (
        <p className="library-error" role="alert">
          {error}
        </p>
      )}
      <div ref={contentRef} className="library-content-scroll">
        {!filtered.length ? (
          <div className="library-empty">
            <IconBook width={30} height={30} />
            <h2>{papers.length ? '没有匹配的文献' : '从第一篇论文开始'}</h2>
            <p>
              {papers.length
                ? '调整搜索或筛选，也可以导入文献到这里。'
                : '导入 PDF 后，可以按课题分类，集中阅读和整理笔记。'}
            </p>
            <button
              className="btn library-import-button"
              disabled={busy}
              onClick={() => onImport(importDestination ? [importDestination] : [])}
            >
              <IconPlus />
              导入 PDF
            </button>
            {!collections.length && (
              <button className="btn ghost" onClick={() => onCreateCollection()}>
                新建分类
              </button>
            )}
          </div>
        ) : (
          <>
            {view === 'grid' && <div className="library-grid-heading">{selectAll}<span>全选</span></div>}
            {view === 'list' && (
              <div className="library-table-heading">
                {selectAll}
                <span>标题 / 来源</span>
                <span>分类 / 标签</span>
                <span>年份</span>
                <span>状态</span>
                <span />
              </div>
            )}
            <div className={`library-items ${view}`} aria-label="文献列表">
              {filtered.map((paper) => (
                <article
                  key={paper.id}
                  className={`library-paper${selected.has(paper.id) ? ' selected' : ''}`}
                  data-paper-id={paper.id}
                  draggable
                  onDragStart={(e) => {
                    const ids = selected.has(paper.id) ? chosen : [paper.id];
                    e.dataTransfer.setData(PAPER_DRAG_TYPE, JSON.stringify(ids));
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('button,input,select,a')) return;
                    select(paper.id, e.shiftKey, e.metaKey || e.ctrlKey);
                  }}
                  onDoubleClick={(e) => {
                    if (!(e.target as HTMLElement).closest('button,input,select,a')) onSelect(paper.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onMenu(paper, { x: e.clientX, y: e.clientY });
                  }}
                >
                  <input
                    className="library-paper-check"
                    type="checkbox"
                    aria-label={`选择${paper.title}`}
                    checked={selected.has(paper.id)}
                    onChange={() => {}}
                    onClick={(e) => {
                      e.stopPropagation();
                      select(paper.id, e.shiftKey, true);
                    }}
                  />
                  <div className="library-paper-copy">
                    <button className="library-title" onClick={() => onSelect(paper.id)} title={paper.title}>
                      {paper.title}
                    </button>
                    {(paper.authors.length > 0 || paper.venue) && <div className="library-author">
                      {paper.venue && <span className="library-venue" title={paper.venue}>{displayVenue(paper.venue)}</span>}
                      {!!paper.venue && paper.authors.length > 0 && <span aria-hidden="true"> · </span>}
                      {paper.authors.length > 0 && <span title={paper.authors.join(', ')}>{paper.authors.slice(0, 2).join(', ')}</span>}
                    </div>}
                  </div>
                  <div className="library-paper-groups">
                    {paper.collectionIds.length ? (
                      paper.collectionIds.slice(0, 2).map((id) => (
                        <button
                          key={id}
                          className="library-group-chip"
                          title={collectionLabel(id, collections)}
                          onClick={() => onScope(id)}
                        >
                          {collections.find((c) => c.id === id)?.name}
                        </button>
                      ))
                    ) : (
                      <span className="library-unfiled">未分类</span>
                    )}
                    {paper.collectionIds.length > 2 && <span>+{paper.collectionIds.length - 2}</span>}
                    {paper.tags.length > 0 && (
                      <div className="library-tags" title={paper.tags.join(' · ')}>
                        {paper.tags.slice(0, 3).join(' · ')}
                      </div>
                    )}
                  </div>
                  <span className="library-year">{paper.year ?? (view === 'list' ? '—' : '')}</span>
                  <span className={`library-status ${paper.readingStatus}`}>
                    {statusLabels[paper.readingStatus]}
                  </span>
                  <div className="library-paper-actions">
                    <button
                      className="btn icon ghost"
                      aria-label={`${paper.title}的更多操作`}
                      aria-haspopup="menu"
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        onMenu(paper, { x: r.right, y: r.bottom });
                      }}
                    >
                      <IconMore />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </div>
      {organizing && (
        <OrganizeDialog
          title={`将 ${chosen.length} 篇文献加入分类`}
          collections={collections}
          onClose={() => setOrganizing(false)}
          onSave={(ids) => onAddCollections(chosen, ids)}
        />
      )}
      {tagging && (
        <Modal
          title={`为 ${chosen.length} 篇文献添加标签`}
          className="collection-dialog"
          onClose={() => setTagging(false)}
          busy={working}
          footer={
            <>
              <button className="btn ghost" disabled={working} onClick={() => setTagging(false)}>
                取消
              </button>
              <button
                className="btn primary"
                disabled={working || !tagDraft.trim()}
                onClick={() =>
                  void run(async () => {
                    await onAddTags(
                      chosen,
                      tagDraft
                        .split(/[,，;；\n]/)
                        .map((t) => t.trim())
                        .filter(Boolean),
                    );
                    setTagging(false);
                  })
                }
              >
                添加标签
              </button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="batch-tags">标签</label>
            <input
              id="batch-tags"
              autoFocus
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              placeholder="用逗号分隔"
            />
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}

    </main>
  );
}
