import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Block, Note } from '@shared/types';
import { isReadingContent } from '@shared/reading-content';
import { IconBook, IconNote, IconTrash } from './icons';
import './notes.css';
import { SelectionGroup } from './SelectionGroup';
import { useContentTransition } from '@/lib/motion';

interface Props {
  notes: Note[];
  blocks: Block[];
  onJump: (blockId: string) => void;
  onUpdate: (id: string, patch: Partial<Note>) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
  open?: boolean;
  tab: 'notes' | 'outline' | 'ai';
  onTabChange(tab: 'notes' | 'outline' | 'ai'): void;
  chat: ReactNode;
}
export function NotesPanel({ notes, blocks, onJump, onUpdate, onRemove, open = true, tab, onTabChange, chat }: Props) {
  const setTab = onTabChange;
  const contentRef = useRef<HTMLDivElement>(null);
  useContentTransition(contentRef, tab);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The first h1 on page one is the document title, already shown in the reader header.
  const outline = useMemo(() => blocks.filter(b => isReadingContent(b) && /^h[123]$/.test(b.kind))
    .filter((block, index) => !(index === 0 && block.kind === 'h1' && block.page === 1)), [blocks]);
  const outlineLevel = Math.min(...outline.map(block => Number(block.kind[1])));
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('.reader-scroll');
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = root.getBoundingClientRect().top + root.clientHeight / 2 + 2;
      const rendered = outline.map(block => ({ block, element: document.getElementById(`blk-${block.id}`) }))
        .filter(item => item.element);
      if (rendered.length) {
        const current = rendered.filter(item => item.element!.getBoundingClientRect().top <= top).at(-1);
        setActiveHeading(current?.block.id ?? null);
      } else {
        const page = [...root.querySelectorAll<HTMLElement>('[data-page]')]
          .filter(element => element.getBoundingClientRect().top <= top).at(-1);
        setActiveHeading(outline.filter(block => block.page <= Number(page?.dataset.page)).at(-1)?.id ?? null);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    root.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });
    update();
    return () => { root.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); observer.disconnect(); cancelAnimationFrame(frame); };
  }, [outline]);
  const perform = async (operation: () => void | Promise<void>, done?: () => void) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await operation(); done?.(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const edit = (note: Note) => { setEditing(note.id); setDraft(note.body); setDeleting(null); setError(''); };
  return <aside className="panel reading-notes" id="notes-panel" aria-label="阅读辅助" data-open={open} aria-hidden={!open} inert={!open}>
    <SelectionGroup className="panel-tabs" role="tablist" aria-label="阅读辅助" onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const tabs = ['notes', 'outline', 'ai'] as const;
        const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3]; setTab(next);
        document.getElementById(`reader-${next}-tab`)?.focus();
      }
    }}>
      <button id="reader-notes-tab" role="tab" aria-selected={tab === 'notes'} aria-controls="reader-notes-content" tabIndex={tab === 'notes' ? 0 : -1}
        className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>笔记{notes.length > 0 && <span className="notes-count">{notes.length}</span>}</button>
      <button id="reader-outline-tab" role="tab" aria-selected={tab === 'outline'} aria-controls="reader-notes-content" tabIndex={tab === 'outline' ? 0 : -1}
        className={tab === 'outline' ? 'on' : ''} onClick={() => setTab('outline')}>大纲</button>
      <button id="reader-ai-tab" role="tab" aria-selected={tab === 'ai'} aria-controls="reader-ai-content" tabIndex={tab === 'ai' ? 0 : -1}
        className={tab === 'ai' ? 'on' : ''} onClick={() => setTab('ai')}>AI</button>
      <div className="spacer" />
    </SelectionGroup>
    <div ref={contentRef} hidden={tab === 'ai'} className="panel-body" id="reader-notes-content" role="tabpanel" aria-labelledby={`reader-${tab === 'notes' ? 'notes' : 'outline'}-tab`}>
      {error && <p className="notes-error" role="alert">{error}</p>}
      {tab === 'notes' ? notes.length === 0 ? <div className="notes-empty">
        <IconNote width={25} height={25} aria-hidden="true" /><h3>暂无笔记</h3><p>选中正文，添加高亮或笔记。</p>
      </div> : notes.map(note => <article className="note-item" key={note.id} data-note-id={note.id}>
        <div className="note-location"><span className={`dot ${note.color}`} aria-hidden="true" />
          <button disabled={!note.blockId} onClick={() => note.blockId && onJump(note.blockId)} title="跳转到原文">
            {note.page != null ? `第 ${note.page} 页` : '文献笔记'}
          </button><time dateTime={note.createdAt}>{note.createdAt.slice(5, 10).replace('-', '/')}</time>
        </div>
        {note.quote && <button className="note-quote" disabled={!note.blockId} onClick={() => note.blockId && onJump(note.blockId)} title="跳转到这段原文">{note.quote}</button>}
        {editing === note.id ? <div className="note-editor">
          <textarea autoFocus aria-label="编辑批注" value={draft} disabled={busy} placeholder="写下你的想法…" onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busy) setEditing(null); }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void perform(() => onUpdate(note.id, { body: draft }), () => setEditing(null)); }
            }} />
          <div className="note-editor-actions"><button className="btn ghost" disabled={busy} onClick={() => setEditing(null)}>取消</button>
            <button className="btn primary" disabled={busy} onClick={() => void perform(() => onUpdate(note.id, { body: draft }), () => setEditing(null))}>{busy ? '保存中…' : '保存'}</button>
          </div>
        </div> : <>
          {note.body && <p className="note-body">{note.body}</p>}
          {deleting === note.id ? <div className="note-delete-confirm" role="group" aria-label="删除笔记确认">
            <p>删除这条笔记和高亮？</p><div>
              <button className="btn ghost" disabled={busy} onClick={() => setDeleting(null)}>取消</button>
              <button className="btn danger" disabled={busy} onClick={() => void perform(() => onRemove(note.id), () => setDeleting(null))}>{busy ? '删除中…' : '确认删除'}</button>
            </div>
          </div> : <div className="note-actions">
            <button className="btn ghost" disabled={busy} onClick={() => edit(note)}><IconNote aria-hidden="true" />{note.body ? '编辑批注' : '添加批注'}</button>
            <button className="btn icon ghost" disabled={busy} aria-label="删除笔记" title="删除笔记" onClick={() => { setDeleting(note.id); setError(''); }}><IconTrash aria-hidden="true" /></button>
          </div>}
        </>}
      </article>) : outline.length === 0 ? <div className="notes-empty">
        <IconBook width={27} height={27} aria-hidden="true" /><h3>暂无大纲</h3><p>识别到的章节标题会显示在这里。</p>
      </div> : <nav className="document-outline" aria-label="文献章节">{outline.map(block => <button key={block.id}
        className={`outline-item ${block.kind}`} data-depth={Number(block.kind[1]) - outlineLevel}
        aria-current={activeHeading === block.id ? 'location' : undefined} onClick={() => { setActiveHeading(block.id); onJump(block.id); }} title={block.text}>
        <span>{block.text}</span><small>{block.page}</small>
      </button>)}</nav>}
    </div>
    <div className="reader-chat-host" id="reader-ai-content" role="tabpanel" aria-labelledby="reader-ai-tab" hidden={tab !== 'ai'}>{chat}</div>
  </aside>;
}
