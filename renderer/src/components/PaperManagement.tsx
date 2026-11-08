import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Collection, Paper, ReadingStatus } from '@shared/types';
import { api } from '@/lib/api';
import { OrganizeDialog } from './CollectionDialogs';
import { collectionLabel, statusLabels } from '@/lib/library';
import { Modal } from './Modal';
import DesktopMenu from './DesktopMenu';
import { IconBook, IconEdit, IconExport, IconFolder, IconTrash, IconNote, IconChevronDown } from './icons';

export interface PaperTarget {
  paper: Paper;
  x: number;
  y: number;
}
interface Props {
  target: PaperTarget;
  onClose: () => void;
  onOpen: (id: string) => void;
  onSave: (id: string, patch: Partial<Paper>) => Promise<void>;
  onDelete: (paper: Paper) => Promise<void>;
  onToast: (message: string) => void;
  collections: Collection[];
  onSetCollections: (paperId: string, ids: string[]) => Promise<void>;
  onRemoveFromCollection?: () => Promise<void>;
  removeCollectionLabel?: string;
}

export function PaperManagement({
  target,
  onClose,
  onOpen,
  onSave,
  onDelete,
  onToast,
  collections,
  onSetCollections,
  onRemoveFromCollection,
  removeCollectionLabel = '移出当前分类',
}: Props) {
  const { paper } = target;
  const [action, setAction] = useState<'edit' | 'delete' | 'organize' | 'details' | null>(null);
  const [title, setTitle] = useState(paper.title);
  const [authors, setAuthors] = useState(paper.authors.join('; '));
  const [year, setYear] = useState(paper.year?.toString() ?? '');
  const [venue, setVenue] = useState(paper.venue ?? '');
  const [doi, setDoi] = useState(paper.doi ?? '');
  const [tags, setTags] = useState(paper.tags.join(', '));
  const [readingStatus, setReadingStatus] = useState(paper.readingStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [position, setPosition] = useState({ x: target.x, y: target.y });
  const menu = useRef<HTMLDivElement>(null);
  const originalFocus = useRef(document.activeElement as HTMLElement | null);
  const busyRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (action || !menu.current) return;
    const rect = menu.current.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(target.y, window.innerHeight - rect.height - 8)),
    });
    menu.current.querySelector<HTMLButtonElement>('button')?.focus();
  }, [action, target.x, target.y]);
  useEffect(
    () => () => {
      if (originalFocus.current?.isConnected) originalFocus.current.focus();
    },
    [],
  );
  useEffect(() => {
    if (action) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) closeRef.current();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('keydown', onKey, true);
    const onResize = () => closeRef.current();
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  }, [action]);

  const execute = async (task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await task();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const save = async () => {
    if (!title.trim()) {
      setError('请填写文献标题。');
      return;
    }
    if (year && (!/^\d{4}$/.test(year) || Number(year) < 1000)) {
      setError('年份应为四位数字，或留空。');
      return;
    }
    await execute(() =>
      onSave(paper.id, {
        readingStatus,
        title: title.trim(),
        authors: authors
          .split(/[;；\n]/)
          .map((value) => value.trim())
          .filter(Boolean),
        year: year ? Number(year) : null,
        venue: venue.trim() || null,
        doi: doi.trim() || null,
        tags: [
          ...new Set(
            tags
              .split(/[,，;；\n]/)
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        ],
      }),
    );
  };

  if (action === 'organize')
    return (
      <OrganizeDialog
        title="文献分类"
        collections={collections}
        initial={paper.collectionIds}
        allowEmpty
        onClose={onClose}
        onSave={(ids) => onSetCollections(paper.id, ids)}
      />
    );

  if (action === 'details') return (
    <Modal key="details" title="文献详情" className="paper-dialog" onClose={onClose} footer={<>
      <button className="btn ghost" onClick={() => setAction('edit')}>编辑</button>
      <button className="btn primary" onClick={() => { onOpen(paper.id); onClose(); }}>打开文献</button>
    </>}>
      <h3 className="paper-detail-title">{paper.title}</h3>
      <dl className="paper-details">
        <dt>作者</dt><dd>{paper.authors.join(', ') || '—'}</dd>
        <dt>年份 / 来源</dt><dd>{[paper.year, paper.venue].filter(Boolean).join(' · ') || '—'}</dd>
        <dt>分类</dt><dd>{paper.collectionIds.map((id) => collectionLabel(id, collections)).join('；') || '未分类'}</dd>
        <dt>标签</dt><dd>{paper.tags.join(' · ') || '—'}</dd>
        <dt>DOI</dt><dd>{paper.doi || '—'}</dd>
        <dt>摘要</dt><dd>{paper.abstract || '暂无摘要'}</dd>
      </dl>
    </Modal>
  );

  if (action)
    return (
      <Modal
        key={action}
        title={action === 'edit' ? '编辑文献信息' : '删除文献？'}
        className="paper-dialog"
        busy={busy}
        onClose={onClose}
        footer={
          <>
            <button className="btn ghost" disabled={busy} onClick={onClose}>
              取消
            </button>
            <button
              type={action === 'edit' ? 'submit' : 'button'}
              form={action === 'edit' ? 'paper-edit-form' : undefined}
              className={`btn ${action === 'delete' ? 'danger' : 'primary'}`}
              disabled={busy || (action === 'edit' && !title.trim())}
              onClick={action === 'delete' ? () => void execute(() => onDelete(paper)) : undefined}
            >
              {busy ? '正在处理…' : action === 'edit' ? '保存' : '删除文献'}
            </button>
          </>
        }
      >
        {action === 'edit' ? (
          <form
            id="paper-edit-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="field">
              <label htmlFor="paper-title">标题</label>
              <textarea
                id="paper-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                rows={3}
                maxLength={1000}
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="paper-authors">作者</label>
              <input
                id="paper-authors"
                type="text"
                value={authors}
                onChange={(event) => setAuthors(event.target.value)}
                placeholder="多位作者用分号分隔"
              />
            </div>
            <div className="row2">
              <div className="field">
                <label htmlFor="paper-year">年份</label>
                <input
                  id="paper-year"
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  value={year}
                  onChange={(event) => setYear(event.target.value)}
                  placeholder="如 2025"
                />
              </div>
              <div className="field">
                <label htmlFor="paper-venue">期刊 / 会议</label>
                <input
                  id="paper-venue"
                  type="text"
                  value={venue}
                  onChange={(event) => setVenue(event.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="paper-doi">DOI</label>
              <input
                id="paper-doi"
                type="text"
                value={doi}
                onChange={(event) => setDoi(event.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label htmlFor="paper-tags">标签</label>
              <input
                id="paper-tags"
                type="text"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="如 存内计算, 待读"
              />
            </div>
            <div className="field">
              <label>阅读状态</label>
              <DesktopMenu ariaLabel="阅读状态" className="field-menu" disabled={busy}
                items={Object.entries(statusLabels).map(([value, label]) => ({
                  id: value, label, selected: readingStatus === value,
                  onSelect: () => setReadingStatus(value as ReadingStatus),
                }))}>
                <span>{statusLabels[readingStatus]}</span><IconChevronDown />
              </DesktopMenu>
            </div>
          </form>
        ) : (
          <div className="delete-paper-copy">
            <p className="delete-paper-title">{paper.title}</p>
            <p>将永久删除这篇文献在书库中的 PDF 副本、笔记、高亮和阅读记录。最初导入的原文件不会删除。</p>
            <p>此操作无法撤销。需要保留笔记时，请先取消并导出。</p>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </Modal>
    );

  return (
    <div
      className="menu-backdrop"
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="paper-menu"
        role="menu"
        aria-label="文献操作"
        ref={menu}
        style={{ left: position.x, top: position.y }}
      >
        <div className="menu-heading" title={paper.title}>
          {paper.title}
        </div>
        <button
          role="menuitem"
          className="menu-item"
          onClick={() => {
            onOpen(paper.id);
            onClose();
          }}
        >
          <IconBook />
          <span>打开文献</span>
        </button>
        <button role="menuitem" className="menu-item" onClick={() => setAction('details')}>
          <IconNote />
          <span>查看详情</span>
        </button>
        <button role="menuitem" className="menu-item" onClick={() => setAction('edit')}>
          <IconEdit />
          <span>编辑文献信息…</span>
        </button>
        <button role="menuitem" className="menu-item" onClick={() => setAction('organize')}>
          <IconFolder />
          <span>管理分类…</span>
        </button>
        {onRemoveFromCollection && (
          <button
            role="menuitem"
            className="menu-item"
            disabled={busy}
            onClick={() => void execute(onRemoveFromCollection)}
          >
            <IconFolder />
            <span>{removeCollectionLabel}</span>
          </button>
        )}
        <button
          role="menuitem"
          className="menu-item"
          disabled={busy}
          onClick={() => void execute(() => api.app.revealPaper(paper.id))}
        >
          <IconFolder />
          <span>在 Finder 中显示</span>
        </button>
        <button
          role="menuitem"
          className="menu-item"
          disabled={busy}
          onClick={() =>
            void execute(async () => {
              const file = await api.notes.exportMarkdown(paper.id);
              if (file) onToast('笔记已导出');
            })
          }
        >
          <IconExport />
          <span>导出笔记…</span>
        </button>
        <div className="menu-separator" role="separator" />
        <button role="menuitem" className="menu-item danger" onClick={() => setAction('delete')}>
          <IconTrash />
          <span>删除文献…</span>
        </button>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
