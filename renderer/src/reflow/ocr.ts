import type { PDFPageProxy } from 'pdfjs-dist';
import { api } from '@/lib/api';
import type { RawItem } from './analyze';

export async function recognizePage(page: PDFPageProxy): Promise<RawItem[]> {
  const size = page.getViewport({ scale: 1 });
  const scale = Math.min(3, Math.sqrt(12_000_000 / (size.width * size.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  try {
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
    const result = await api.ocr.recognize(canvas.toDataURL('image/png'));
    return result.lines.flatMap((line) => {
      // Vision's word boxes may touch. Keep recognized whitespace instead of guessing it from gaps.
      const complete = line.words.length && line.words.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim() === line.text.replace(/\s+/g, ' ').trim();
      const words = complete ? line.words : [line];
      return words.map((word, index) => {
        const [x0, y0, x1, y1] = word.bbox;
        return { str: (index ? ' ' : '') + word.text, x: x0 * size.width, y: line.bbox[3] * size.height,
          w: (x1 - x0) * size.width, h: (line.bbox[3] - line.bbox[1]) * size.height,
          top: y0 * size.height, bottom: y1 * size.height,
          bold: false, font: 'OCR', confidence: word.confidence };
      });
    });
  } finally {
    canvas.width = canvas.height = 0;
  }
}
