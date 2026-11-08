import { useLayoutEffect, useRef, type HTMLAttributes, type Ref } from 'react';

/** Keep native button, tab and radio semantics; only the selection surface moves. */
export function SelectionGroup({ as: Tag = 'div', className = '', children, ...props }: HTMLAttributes<HTMLElement> & { as?: 'div' | 'nav' }) {
  const ref = useRef<HTMLElement>(null);
  const measure = () => {
    const root = ref.current;
    const selected = root?.querySelector<HTMLElement>('button[aria-pressed="true"], button[aria-selected="true"], button[aria-current="page"], input:checked + span');
    if (!root || !selected || !selected.offsetWidth) return;
    let x = 0, y = 0;
    // Offset coordinates stay stable while the enclosing dialog scales into view.
    for (let item: HTMLElement | null = selected; item && item !== root; item = item.offsetParent as HTMLElement | null) {
      x += item.offsetLeft; y += item.offsetTop;
    }
    root.style.setProperty('--selection-x', `${x}px`);
    root.style.setProperty('--selection-y', `${y}px`);
    root.style.setProperty('--selection-width', `${selected.offsetWidth}px`);
    root.style.setProperty('--selection-height', `${selected.offsetHeight}px`);
    root.dataset.selectionMeasured = 'true';
  };
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const root = ref.current!;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const child of root.children) observer.observe(child);
    const frame = requestAnimationFrame(() => { root.dataset.selectionReady = 'true'; });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); delete root.dataset.selectionReady; };
  }, []);
  return <Tag {...props} ref={ref as Ref<HTMLDivElement>} className={`motion-selection ${className}`}>{children}</Tag>;
}
