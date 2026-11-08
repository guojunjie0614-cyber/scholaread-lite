import { useEffect, useRef, useState } from 'react';
import { cropPageRegionBlob, type PDFDocumentProxy } from '@/lib/pdf';
import { Modal } from './Modal';
import './image-preview.css';
import { RegionAIButton } from './ReaderAIContext';

type View = { scale: number; x: number; y: number; fit: boolean };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Zoom changes the viewport immediately; a bounded PDF render supplies the detail. */
export function ImagePreview({ doc, page, crop, src, title, onClose }: {
  doc: PDFDocumentProxy; page: number; crop: [number, number, number, number];
  src: string; title: string; onClose: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0, fit: true });
  const [detail, setDetail] = useState<{ url: string; scale: number }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const width = crop[2] - crop[0], height = crop[3] - crop[1];
  const fitScale = size.width && size.height ? Math.min((size.width - 40) / width, (size.height - 40) / height) : 1;
  const minScale = Math.min(.25, fitScale);
  const maxScale = Math.max(8, fitScale);
  const scale = view.fit ? fitScale : view.scale;
  const current = useRef({ ...view, scale });
  current.current = { ...view, scale };

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const zoom = (factor: number, x = 0, y = 0) => {
    const previous = current.current;
    const next = clamp(previous.scale * factor, minScale, maxScale);
    const ratio = next / previous.scale;
    setView({ scale: next, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio, fit: false });
  };
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      const rect = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      zoomRef.current(Math.exp(-clamp(delta, -240, 240) * .0025), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  // Never allocate an unbounded canvas, even when zooming into a full-page figure.
  const renderScale = Math.min(Math.ceil(scale * Math.min(window.devicePixelRatio || 1, 2) * 2) / 2,
    4096 / Math.max(width, height), Math.sqrt(12_000_000 / (width * height)));
  useEffect(() => {
    if (!size.width || (detail && detail.scale >= renderScale)) { setLoading(false); setError(''); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    const timer = window.setTimeout(() => {
      cropPageRegionBlob(doc, page, crop, renderScale, { signal: controller.signal, priority: 100 }).then(blob => {
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        setDetail({ url, scale: renderScale });
        setLoading(false);
      }).catch(reason => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false);
      });
    }, 160);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [doc, page, crop.join(','), renderScale, retry, size.width]);
  // The dialog's 140 ms exit snapshot still needs its image while fading out.
  useEffect(() => () => { if (detail) window.setTimeout(() => URL.revokeObjectURL(detail.url), 200); }, [detail]);

  const fit = () => setView({ scale: fitScale, x: 0, y: 0, fit: true });
  return <Modal title={title} onClose={onClose} className="image-preview">
    <div className="image-preview-controls" role="toolbar" aria-label="图片缩放">
      <button className="btn ghost" aria-label="缩小图片" disabled={scale <= minScale} onClick={() => zoom(1 / 1.25)}>−</button>
      <span className="image-preview-scale">{Math.round(scale * 100)}%</span>
      <button className="btn ghost" aria-label="放大图片" disabled={scale >= maxScale} onClick={() => zoom(1.25)}>＋</button>
      <button className="btn ghost" onClick={fit}>适应窗口</button>
      <button className="btn ghost" onClick={() => setView({ scale: 1, x: 0, y: 0, fit: false })}>100%</button>
      <RegionAIButton doc={doc} page={page} crop={crop} caption={title} onSent={onClose} />
      <span className="image-preview-hint">滚轮缩放 · 拖动查看</span>
    </div>
    <div ref={viewport} className="image-preview-viewport" tabIndex={0} role="region" aria-label="图片预览，使用加减键缩放，方向键平移，0 适应窗口"
      onKeyDown={event => {
        if (event.key === '+' || event.key === '=') zoom(1.25);
        else if (event.key === '-') zoom(1 / 1.25);
        else if (event.key === '0') fit();
        else if (event.key.startsWith('Arrow')) setView(v => ({ ...v, scale, fit: false, x: v.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0), y: v.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0) }));
        else return;
        event.preventDefault(); event.stopPropagation();
      }}
      onDoubleClick={fit}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.dataset.dragging = 'true';
      }}
      onPointerMove={event => {
        const previous = drag.current;
        if (!previous || previous.id !== event.pointerId) return;
        const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        setView(v => ({ ...v, scale, fit: false, x: v.x + dx, y: v.y + dy }));
      }}
      onPointerUp={event => { drag.current = null; event.currentTarget.dataset.dragging = 'false'; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onLostPointerCapture={event => { drag.current = null; event.currentTarget.dataset.dragging = 'false'; }}>
      <img src={detail?.url || src} alt={title} draggable={false} style={{ width: width * scale, height: height * scale, transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))` }} />
    </div>
    <div className="image-preview-status" role="status">
      {error ? <><span>高清图片加载失败：{error}</span><button className="btn ghost" onClick={() => setRetry(n => n + 1)}>重试</button></> : loading ? '正在加载高清细节…' : 'Esc 关闭预览'}
    </div>
  </Modal>;
}
