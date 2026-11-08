import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

/** Animate explicit view changes without replacing content, focus or scroll state. */
export function useContentTransition(ref: RefObject<HTMLElement | null>, view: string, distance = 4) {
  const previous = useRef(view);
  useLayoutEffect(() => {
    if (previous.current === view) return;
    previous.current = view;
    const element = ref.current;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    if (!element || media.matches) return;
    const animation = element.animate([
      { opacity: .72, ...(distance ? { transform: `translateY(${distance}px)` } : {}) },
      { opacity: 1, ...(distance ? { transform: 'translateY(0)' } : {}) },
    ], { duration: 180, easing: 'cubic-bezier(.16, 1, .3, 1)' });
    const reduce = () => { if (media.matches) animation.cancel(); };
    media.addEventListener('change', reduce);
    return () => { animation.cancel(); media.removeEventListener('change', reduce); };
  }, [ref, view, distance]);
}

/** Leave only an inert visual copy so dismissal, actions and focus never wait for motion. */
export function useExitTransition(ref: RefObject<HTMLElement | null>, kind: 'dialog' | 'menu') {
  return useCallback((element: HTMLElement | null) => {
    const source = ref.current;
    ref.current = element;
    // React detaches the ref before removing the DOM, so computed styles and scroll are intact.
    if (!element && source) {
      const media = matchMedia('(prefers-reduced-motion: reduce)');
      if (media.matches) return;
      const owner = kind === 'menu' ? source.closest('.overlay') : null;
      const snapshot = source.cloneNode(true) as HTMLElement;
      const originals = [source, ...source.querySelectorAll<HTMLElement>('*')];
      const copies = [snapshot, ...snapshot.querySelectorAll<HTMLElement>('*')];
      const scrollPositions = originals.flatMap((item, index) => item.scrollTop || item.scrollLeft
        ? [{ element: copies[index]!, top: item.scrollTop, left: item.scrollLeft }] : []);
      const style = getComputedStyle(source);
      const opacity = style.opacity || '1';
      const transform = style.transform || 'none';
      const dialog = source.querySelector<HTMLElement>('.dialog');
      const dialogTransform = dialog ? getComputedStyle(dialog).transform || 'none' : 'none';
      snapshot.classList.add('motion-exit-snapshot');
      snapshot.inert = true;
      snapshot.setAttribute('aria-hidden', 'true');
      for (const item of copies) {
        item.removeAttribute('id');
        item.removeAttribute('autofocus');
        item.removeAttribute('role');
        item.removeAttribute('aria-modal');
        item.removeAttribute('name');
      }
      // Wait until React removes the source; StrictMode's effect replay stays connected.
      queueMicrotask(() => {
        if (source.isConnected || media.matches || (owner && !owner.isConnected)) return;
        document.body.append(snapshot);
        for (const position of scrollPositions) {
          position.element.scrollTop = position.top;
          position.element.scrollLeft = position.left;
        }
        const timing = { duration: 140, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' as const };
        const animations = kind === 'menu'
          ? [snapshot.animate([
              { opacity, transform },
              { opacity: 0, transform: `translateY(${source.dataset.side === 'above' ? 2 : -2}px) scale(.98)` },
            ], timing)]
          : [snapshot.animate([{ opacity }, { opacity: 0 }], timing)];
        const visualDialog = snapshot.querySelector<HTMLElement>('.dialog');
        if (kind === 'dialog' && visualDialog) {
          animations.push(visualDialog.animate([
            { transform: dialogTransform },
            { transform: 'translateY(4px) scale(.985)' },
          ], timing));
        }
        const remove = () => {
          snapshot.remove();
          media.removeEventListener('change', reduce);
        };
        const reduce = () => {
          if (media.matches) { animations.forEach(animation => animation.cancel()); remove(); }
        };
        media.addEventListener('change', reduce);
        void Promise.all(animations.map(animation => animation.finished)).then(remove, remove);
      });
    }
  }, [ref, kind]);
}
