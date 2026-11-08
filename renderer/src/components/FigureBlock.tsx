import type { PDFDocumentProxy } from '@/lib/pdf';
import { useRegionImage } from './useRegionImage';
import { useState } from 'react';
import { ImagePreview } from './ImagePreview';
import { RegionAIButton } from './ReaderAIContext';

interface Props {
  doc: PDFDocumentProxy | null;
  paperId: string;
  page: number;
  crop: [number, number, number, number];
  caption?: string;
  kind?: 'figure' | 'table' | 'algorithm';
  sourceFontSize?: number;
}

export function FigureBlock({ doc, page, crop, caption, kind = 'figure', sourceFontSize }: Props) {
  const [preview, setPreview] = useState(false);
  const { ref, src, error } = useRegionImage(doc, page, crop);
  const label = kind === 'algorithm' ? '算法' : kind === 'table' ? '表格' : '插图';
  return (
    <div className={`figure ${kind === 'table' ? 'table-image' : kind === 'algorithm' ? 'algorithm-image' : ''}`} ref={ref}>
      {src ? (
          <img src={src} alt={caption || `第 ${page} 页${label}`} style={{ width: `${(crop[2] - crop[0]) / (kind === 'algorithm' ? sourceFontSize || 10 : 9)}em` }}
            role="button" tabIndex={0} aria-label={`预览${label}`} title="双击放大查看"
            onDoubleClick={event => { event.stopPropagation(); setPreview(true); }}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); setPreview(true); } }} />
      ) : (
        <div className="figure-fallback" style={{ minHeight: Math.max(60, Math.min(440, crop[3] - crop[1])) }}>
          {error ? `${label}加载失败：${error}。可切到原页查看。` : `正在加载${label}…`}
        </div>
      )}
      {doc && src && <RegionAIButton doc={doc} page={page} crop={crop} caption={caption} />}
      {preview && doc && src && <ImagePreview doc={doc} page={page} crop={crop} src={src} title={`第 ${page} 页 · ${label}`} onClose={() => setPreview(false)} />}
    </div>
  );
}
