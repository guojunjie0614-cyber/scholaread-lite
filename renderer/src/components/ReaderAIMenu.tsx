import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export function ReaderAIMenu({ x, y, onClose, onExplain, onQuote }: {
  x: number; y: number; onClose(): void; onExplain(): void; onQuote(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close.current(); };
    const dismiss = () => close.current();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); };
  }, []);
  return createPortal(<div ref={root} role="menu" aria-label="论文 AI 操作" className="reader-ai-menu" style={{ left: Math.max(8, Math.min(x, window.innerWidth - 208)), top: Math.max(8, Math.min(y, window.innerHeight - 96)) }}
    onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); const buttons = [...root.current!.querySelectorAll('button')];
        buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + 1) % buttons.length]?.focus();
      }
    }}>
    <button role="menuitem" onClick={onExplain}>发送给 AI 解读</button>
    <button role="menuitem" onClick={onQuote}>引用到 AI</button>
  </div>, document.body);
}
