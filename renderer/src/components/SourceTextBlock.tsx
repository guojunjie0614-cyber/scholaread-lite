import { useState } from 'react';
import type { Block } from '@shared/types';
import type { PDFDocumentProxy } from '@/lib/pdf';
import { useRegionImage } from './useRegionImage';
import { ImagePreview } from './ImagePreview';

/** An undecodable text line remains body-sized source text, not a shrunken figure. */
export function SourceTextBlock({ doc, block }: { doc: PDFDocumentProxy | null; block: Block & { crop: [number, number, number, number] } }) {
  const [preview, setPreview] = useState(false);
  const { ref, src, error } = useRegionImage(doc, block.page, block.crop, true);
  return <div className="source-text" ref={ref}>
    {src ? <img src={src} alt={block.text} draggable={false} role="button" tabIndex={0}
      aria-label="查看原稿文字" title="双击放大查看原稿文字"
      style={{ width: `${(block.crop[2] - block.crop[0]) / (block.sourceFontSize || 10)}em` }}
      onDoubleClick={event => { event.stopPropagation(); setPreview(true); }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); setPreview(true); } }} />
      : <span className="source-text-status">{error ? `原稿文字加载失败：${error}，请查看原页。` : '正在加载原稿文字…'}</span>}
    {preview && doc && src && <ImagePreview doc={doc} page={block.page} crop={block.crop} src={src}
      title={`第 ${block.page} 页 · 原稿文字`} onClose={() => setPreview(false)} />}
  </div>;
}
