import { useEffect, useRef, useState } from 'react';
import { cropPageRegionBlob, type PDFDocumentProxy } from '@/lib/pdf';

export function useRegionImage(
  doc: PDFDocumentProxy | null,
  page: number,
  crop: [number, number, number, number],
  transparent = false,
  enabled = true,
) {
  const ref = useRef<HTMLDivElement>(null);
  const priority = useRef(0);
  const [nearby, setNearby] = useState(false);
  const [result, setResult] = useState<{ doc: PDFDocumentProxy; key: string; src?: string; error?: string }>();
  const currentUrl = useRef<string | undefined>(undefined);
  const loaded = useRef(false);
  const key = `${page}:${crop.join(',')}:${transparent}`;

  useEffect(() => {
    if (!ref.current || !enabled) return;
    const near = new IntersectionObserver(entries => {
      setNearby(entries.some(entry => entry.isIntersecting));
    }, { rootMargin: '600px 0px' });
    const visible = new IntersectionObserver(entries => {
      priority.current = entries.some(entry => entry.isIntersecting) ? 10 : 0;
    });
    near.observe(ref.current);
    visible.observe(ref.current);
    return () => { near.disconnect(); visible.disconnect(); };
  }, [enabled]);

  // Loaded images remain stable while scrolling; only pending work is cancelled offscreen.
  useEffect(() => {
    loaded.current = false;
    setResult(undefined);
    return () => {
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
      currentUrl.current = undefined;
      loaded.current = false;
    };
  }, [doc, key, enabled]);

  useEffect(() => {
    if (!nearby || !enabled || !doc || loaded.current) return;
    const controller = new AbortController();
    cropPageRegionBlob(doc, page, crop, 3, {
      transparent, signal: controller.signal, priority: () => priority.current,
    }).then(blob => {
      if (controller.signal.aborted) return;
      const src = URL.createObjectURL(blob);
      currentUrl.current = src;
      loaded.current = true;
      setResult({ doc, key, src });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ doc, key, error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [doc, nearby, key, enabled]);
  const current = enabled && result?.doc === doc && result.key === key ? result : undefined;
  return { ref, src: current?.src, error: current?.error };
}
