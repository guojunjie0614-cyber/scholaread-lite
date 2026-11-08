import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatConversation } from '@shared/chat-types';
import { IconChevronDown, IconPlus, IconTrash, IconEdit } from '@/components/icons';

/** History rows have independent actions, unlike a single-action selection menu. */
export function ChatHistory({ conversations, current, disabled, onSelect, onDelete, onRename }: {
  conversations: ChatConversation[]; current?: ChatConversation; disabled: boolean;
  onSelect(id: string): void; onDelete(item: ChatConversation): void; onRename(item: ChatConversation): void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 340, maxHeight: 380 });
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const width = Math.min(380, window.innerWidth - 16);
      const top = anchor.bottom + 6;
      setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)), top, width,
        maxHeight: Math.min(420, window.innerHeight - top - 8) });
    };
    place();
    (popup.current?.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? popup.current?.querySelector('button'))?.focus();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <>
    <button ref={trigger} type="button" className="desktop-menu-trigger chat-history" title="对话历史" aria-label="对话历史"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}>
      <span>{current?.contextMode === 'general' ? '普通对话 · ' : ''}{current?.title || '新对话'}</span><IconChevronDown />
    </button>
    {open && createPortal(<div ref={popup} id={id} role="dialog" aria-label="对话历史" className="desktop-menu chat-menu chat-history-popover"
      style={position} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const rows = [...popup.current!.querySelectorAll<HTMLButtonElement>('.chat-history-open')];
        const row = (event.target as HTMLElement).closest('.chat-history-row');
        const index = rows.findIndex(button => button === document.activeElement || row?.contains(button));
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        rows[next]?.focus();
      }}>
      <button className="chat-history-open chat-history-new" onClick={() => { close(true); onSelect(''); }}><IconPlus /><span>新对话</span></button>
      {conversations.map(item => <div className="chat-history-row" key={item.id} data-selected={item.id === current?.id}>
        <button className="chat-history-open" aria-current={item.id === current?.id ? 'true' : undefined} onClick={() => { close(true); onSelect(item.id); }} title={item.title}>
          <span className="chat-history-title">{item.title || '新对话'}</span>
          <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}{item.contextMode === 'general' ? ' · 普通对话' : ''}</time>
        </button>
        <div className="chat-history-actions">
          <button title="重命名" aria-label={`重命名「${item.title}」`} onClick={() => { close(true); onRename(item); }}><IconEdit /></button>
          <button title="删除对话" aria-label={`删除「${item.title}」`} onClick={() => { close(true); onDelete(item); }}><IconTrash /></button>
        </div>
      </div>)}
    </div>, document.body)}
  </>;
}
