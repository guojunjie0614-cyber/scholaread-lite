import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from './icons';
import './desktop-menu.css';
import { useExitTransition } from '@/lib/motion';

/** One desktop dialog contract: focus stays inside, Escape closes only this layer. */
export function Modal({ title, onClose, children, footer, className = '', busy = false }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode;
  className?: string; busy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const attachOverlay = useExitTransition(overlayRef, 'dialog');
  const titleId = useId();
  const state = useRef({ onClose, busy });
  state.current = { onClose, busy };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const app = document.getElementById('root');
    const wasInert = app?.inert;
    if (app) app.inert = true;
    const focusable = () => [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])]
      .filter(el => el.getClientRects().length > 0);
    (ref.current?.querySelector<HTMLElement>('[autofocus], input:not([type=checkbox]), textarea') ?? focusable()[0] ?? ref.current)?.focus();
    const key = (event: KeyboardEvent) => {
      // A nested menu owns Escape and Tab before the enclosing dialog.
      if (ref.current?.closest('.overlay')?.querySelector('.desktop-menu')) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!state.current.busy) state.current.onClose();
      }
      if (event.key === 'Tab') {
        const items = focusable();
        if (!items.length) { event.preventDefault(); ref.current?.focus(); return; }
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      if (app) app.inert = wasInert ?? false;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<div ref={attachOverlay} className="overlay" onPointerDown={e => {
    if (e.target === e.currentTarget && !busy) onClose();
  }}>
    <div ref={ref} className={`dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="modal-header"><h2 id={titleId}>{title}</h2>
        <button type="button" className="btn icon ghost" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}><IconClose /></button>
      </header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-footer">{footer}</footer>}
    </div>
  </div>, document.body);
}
