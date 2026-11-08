import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

import './desktop-menu.css';
import { useExitTransition } from '@/lib/motion';

export interface DesktopMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  description?: string | undefined;
  selected?: boolean | undefined;
  disabled?: boolean | undefined;
  onSelect: () => void;
}

export interface DesktopMenuProps {
  children: ReactNode;
  ariaLabel: string;
  className?: string | undefined;
  disabled?: boolean | undefined;
  items: DesktopMenuItem[];
  placement?: 'above' | 'below' | undefined;
  align?: 'start' | 'end' | undefined;
  width?: number | undefined;
  menuClassName?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
}

/** Small desktop menus share one anchored surface and keyboard contract. */
export default function DesktopMenu({ children, ariaLabel, className, menuClassName, disabled, items, placement = 'below', align = 'start', width = 232, searchable = false, searchPlaceholder = '搜索…' }: DesktopMenuProps) {
  const [open, setOpen] = useState(false);
  const [keyboardMode, setKeyboardMode] = useState(false);
  const [geometry, setGeometry] = useState<{ style: CSSProperties; side: 'above' | 'below' } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const attachMenu = useExitTransition(menuRef, 'menu');
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const initialFocus = useRef<'selected' | 'first' | 'last'>('selected');
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const visibleItems = searchable ? items.filter(item => `${item.label} ${item.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())) : items;
  const id = useId();

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const show = (keyboard: boolean, focus: typeof initialFocus.current = 'selected') => {
    initialFocus.current = focus;
    setKeyboardMode(keyboard);
    setGeometry(null);
    setQuery('');
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const margin = 8;
      const gap = 6;
      const menuWidth = Math.min(width, window.innerWidth - margin * 2);
      const above = Math.max(0, anchor.top - margin - gap);
      const below = Math.max(0, window.innerHeight - anchor.bottom - margin - gap);
      const naturalHeight = menu.scrollHeight + 2;
      const preferredSpace = placement === 'above' ? above : below;
      const otherSpace = placement === 'above' ? below : above;
      const side = preferredSpace < Math.min(naturalHeight, 160) && otherSpace > preferredSpace
        ? placement === 'above' ? 'below' : 'above'
        : placement;
      const available = side === 'above' ? above : below;
      const left = align === 'end' ? anchor.right - menuWidth : anchor.left;
      setGeometry({ side, style: {
        width: menuWidth,
        left: Math.max(margin, Math.min(left, window.innerWidth - menuWidth - margin)),
        ...(side === 'above' ? { bottom: window.innerHeight - anchor.top + gap } : { top: anchor.bottom + gap }),
        maxHeight: Math.min(360, available),
      } });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const observer = new ResizeObserver(place);
    if (triggerRef.current) observer.observe(triggerRef.current);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      observer.disconnect();
    };
  }, [open, placement, align, width, items.length, query]);

  // Focus only after the first positioned frame; hidden elements cannot receive it.
  const positioned = geometry !== null;
  useLayoutEffect(() => {
    if (!open || !positioned) return;
    if (searchable) { searchRef.current?.focus(); return; }
    const enabled = optionRefs.current.filter((option): option is HTMLButtonElement => !!option && !option.disabled);
    const selectedIndex = items.findIndex(item => item.selected && !item.disabled);
    const target = initialFocus.current === 'last' ? enabled.at(-1)
      : initialFocus.current === 'first' ? enabled[0]
      : optionRefs.current[selectedIndex] ?? enabled[0];
    (target ?? menuRef.current)?.focus();
  }, [open, positioned]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close(true);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    setKeyboardMode(true);
    if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.target === searchRef.current && ['Home', 'End'].includes(event.key)) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = optionRefs.current.slice(0, visibleItems.length).filter((option): option is HTMLButtonElement => !!option && !option.disabled);
    if (!options.length) return;
    const focused = options.findIndex(option => option === document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : focused < 0 ? event.key === 'ArrowUp' ? options.length - 1 : 0
      : (focused + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  };

  return <>
    <button ref={triggerRef} type="button" className={`desktop-menu-trigger${className ? ` ${className}` : ''}`} aria-label={ariaLabel} title={ariaLabel} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled || !items.length} onClick={event => open ? close(false) : show(event.detail === 0)} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        show(true, event.key === 'ArrowUp' ? 'last' : 'first');
      }
    }}>{children}</button>
    {open && createPortal(<div ref={attachMenu} id={id} role="menu" aria-label={ariaLabel} tabIndex={-1} className={`desktop-menu${menuClassName ? ` ${menuClassName}` : ''}`} data-side={geometry?.side ?? placement} data-positioned={positioned} data-keyboard={keyboardMode} style={geometry?.style ?? { width, visibility: 'hidden' }} onKeyDown={navigate} onPointerMove={() => setKeyboardMode(false)}>
      {searchable && <div className="desktop-menu-search"><input ref={searchRef} aria-label={searchPlaceholder} placeholder={searchPlaceholder} value={query} onChange={event => setQuery(event.target.value)} /></div>}
      {visibleItems.map((item, index) => <button key={item.id} ref={element => { optionRefs.current[index] = element; }} type="button" role={item.selected === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item.selected} tabIndex={-1} disabled={item.disabled} className="desktop-menu-item" onClick={() => { close(true); item.onSelect(); }}>
        {item.icon && <span className="desktop-menu-icon" aria-hidden="true">{item.icon}</span>}
        <span className="desktop-menu-copy"><span className="desktop-menu-label">{item.label}</span>{item.description && <span className="desktop-menu-description">{item.description}</span>}</span>
        {item.selected && <svg className="desktop-menu-check" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>}
      </button>)}
      {searchable && !visibleItems.length && <div className="desktop-menu-empty">没有匹配项</div>}
    </div>, triggerRef.current?.closest('.overlay') ?? document.body)}
  </>;
}
