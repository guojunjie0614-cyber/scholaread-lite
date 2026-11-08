import { createContext, useContext, useState } from 'react';
import type { Block, Paper } from '@shared/types';
import type { ChatRequest } from '@shared/chat-types';
import { cropPageRegionBlob, type PDFDocumentProxy } from '@/lib/pdf';

export const ReaderAIContext = createContext<{
  paper: Paper;
  blocks: Block[];
  onRequest(request: ChatRequest): void;
  onError(message: string): void;
} | null>(null);

export function RegionAIButton({ doc, page, crop, caption = '', onSent }: {
  doc: PDFDocumentProxy; page: number; crop: [number, number, number, number];
  caption?: string; onSent?: () => void;
}) {
  const context = useContext(ReaderAIContext);
  const [busy, setBusy] = useState(false);
  if (!context) return null;
  return <button className="btn ghost region-ai-button" disabled={busy} onClick={async event => {
    event.stopPropagation();
    setBusy(true);
    try {
      const matches = context.blocks.filter(block => block.page === page && block.crop?.every((value, index) => Math.abs(value - crop[index]) < 1));
      const sourceIds = new Set(matches.flatMap(block => [block.id, ...(block.parentBlockId ? [block.parentBlockId] : [])]));
      const captions = context.blocks.filter(block => block.page === page && block.kind === 'caption' && block.parentBlockId && sourceIds.has(block.parentBlockId));
      const sources = matches.length ? [...matches, ...captions] : context.blocks.filter(block => block.page === page);
      const sourceText = captions.map(block => block.text).join('\n') || caption || matches.map(block => block.text).filter(Boolean).join('\n') || '论文图表或公式';
      const blob = await cropPageRegionBlob(doc, page, crop, 2, { priority: 100 });
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('无法读取论文图片'));
        reader.readAsDataURL(blob);
      });
      context.onRequest({
        id: crypto.randomUUID(), paperId: context.paper.id,
        reference: { id: crypto.randomUUID(), paperId: context.paper.id, title: context.paper.title, page,
          blockIds: sources.map(block => block.id), quote: sourceText, originalText: sourceText, crop: [...crop] },
        attachment: { id: crypto.randomUUID(), name: `第${page}页.png`, mime: 'image/png', dataUrl },
        text: '请结合论文上下文，解读这张图片中的内容。', autoSend: false,
      });
      onSent?.();
    } catch (error) { context.onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }}>{busy ? '准备图片…' : '问 AI'}</button>;
}
