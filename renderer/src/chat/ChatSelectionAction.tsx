import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/** Only the selected message body becomes a reference, never its controls or neighbouring messages. */
export function ChatSelectionAction({ containerRef, conversationId, onQuote }: {
  containerRef: RefObject<HTMLDivElement | null>; conversationId: string | undefined;
  onQuote(messageId: string, quote: string): void;
}) {
  const [selection, setSelection] = useState<{ messageId: string; quote: string; x: number; y: number } | null>(null);
  useEffect(() => {
    setSelection(null);
    const update = () => {
      const selected = window.getSelection();
      const owner = (node: Node | null) => (node?.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element | null)?.closest<HTMLElement>('[data-chat-selectable]');
      if (!selected || selected.isCollapsed || !selected.rangeCount) { setSelection(null); return; }
      const start = owner(selected.anchorNode); const end = owner(selected.focusNode);
      const quote = selected.toString().trim();
      if (!start || start !== end || !containerRef.current?.contains(start) || !quote) { setSelection(null); return; }
      const rects = selected.getRangeAt(0).getClientRects();
      const rect = rects[0]; const bounds = containerRef.current.getBoundingClientRect();
      if (!rect || rect.bottom < bounds.top || rect.top > bounds.bottom) { setSelection(null); return; }
      setSelection({ messageId: start.dataset.chatSelectable!, quote,
        x: Math.max(8, Math.min(rect.left, window.innerWidth - 132)),
        y: Math.max(bounds.top + 4, Math.min(rect.top - 38, bounds.bottom - 36)) });
    };
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelection(null); };
    document.addEventListener('selectionchange', update);
    document.addEventListener('keydown', dismiss);
    window.addEventListener('resize', update);
    const container = containerRef.current;
    container?.addEventListener('scroll', update);
    return () => {
      document.removeEventListener('selectionchange', update); document.removeEventListener('keydown', dismiss);
      window.removeEventListener('resize', update); container?.removeEventListener('scroll', update);
    };
  }, [containerRef, conversationId]);
  if (!selection) return null;
  return createPortal(<button className="chat-selection-action" style={{ left: selection.x, top: selection.y }}
    onPointerDown={event => event.preventDefault()} onClick={() => {
      onQuote(selection.messageId, selection.quote); window.getSelection()?.removeAllRanges(); setSelection(null);
    }}>添加到对话</button>, document.body);
}
