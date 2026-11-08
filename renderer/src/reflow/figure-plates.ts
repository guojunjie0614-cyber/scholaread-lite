import { parseCaption, isProseCaptionReference, isWrappedProseMention } from './captions';
import { unionRects, type Drawing, type PageRegion, type Rect } from './regions';
import type { RawItem } from './analyze';
import type { TextRun } from '@shared/types';
import { linesTextRuns } from './inline-text';

interface CaptionLine extends Rect {
  text: string;
  items: RawItem[];
  y: number;
  size: number;
  textRuns?: TextRun[];
}

export interface FigurePlate {
  image: Drawing;
  crop: [number, number, number, number];
  caption: CaptionLine;
  figureLabel: string;
}

const area = (rect: Rect) => (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
const overlapWidth = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
const overlapArea = (a: Rect, b: Rect) => overlapWidth(a, b) *
  Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/**
 * A complete raster figure is already an independent object. Do not union adjacent
 * image panels across a page grid. The caption below provides the semantic identity.
 * An image embedded in a larger vector figure remains on the normal geometry path.
 */
export function matchFigurePlates<T extends CaptionLine>(
  drawings: Drawing[],
  regions: PageRegion[],
  lines: T[],
  width: number,
  height: number,
  isProse: (line: T) => boolean,
): FigurePlate[] {
  const seeds = drawings.filter(drawing => drawing.kind === 'image' &&
    drawing.x1 - drawing.x0 >= 40 && drawing.y1 - drawing.y0 >= 30 && area(drawing) >= 1800);
  const images = seeds.filter(seed => !regions.some(region =>
    overlapArea(region, seed) > area(seed) * .9 && area(region) > area(seed) * 1.3 &&
    !seeds.some(other => other !== seed && overlapArea(region, other) > area(other) * .9)));
  // A region containing several large seeds may itself be an over-merged plate row.
  // Captions below decide whether those seeds are separate figures or one composite.
  const used = new Set<Drawing>();
  const claimedLines = new Set<CaptionLine>();
  const plates: FigurePlate[] = [];
  for (const line of lines) {
    const label = parseCaption(line.text);
    if (claimedLines.has(line) || label?.kind !== 'figure' || isProseCaptionReference(label)) continue;
    // An explicit delimiter or an isolated label distinguishes captions from prose
    // such as “Figure 2 illustrates ...”, even when the page's dominant font is small.
    if (!label.hasDelimiter && label.text) continue;
    const prevInCol = lines
      .filter(candidate => candidate.y < line.y && overlapWidth(candidate, line) > Math.min(candidate.x1 - candidate.x0, line.x1 - line.x0) * .5)
      .sort((a, b) => b.y - a.y)[0];
    if (isWrappedProseMention(prevInCol, line)) continue;
    const candidates = images.filter(image => !used.has(image)).map(image => ({
      image,
      gap: line.y0 - image.y1,
      overlap: overlapWidth(line, image) / Math.min(line.x1 - line.x0, image.x1 - image.x0),
    })).filter(candidate => candidate.gap >= -1 && candidate.gap <= Math.max(24, line.size * 3) &&
      candidate.overlap >= .6);
    candidates.sort((a, b) => a.gap - b.gap || b.overlap - a.overlap);
    const best = candidates[0];
    if (!best) continue;
    // A caption spanning multiple equally plausible images describes a composite
    // vector/raster figure; leave it to the normal region path rather than splitting it.
    if (candidates[1] && Math.abs(candidates[1].gap - best.gap) < line.size &&
        Math.abs(candidates[1].overlap - best.overlap) < .1) continue;

    const parts = [line];
    // Captions may be wider than the image. Follow their own text column rather
    // than clipping continuation lines to the bitmap's narrower bounds.
    const captionLeft = Math.min(line.x0, best.image.x0) - line.size * 1.5;
    const captionRight = Math.max(line.x1, best.image.x1) + line.size * 1.5;
    const rightEdge = Math.max(line.x1, best.image.x1);
    let previous = line;
    for (const next of lines.filter(candidate => candidate.y > line.y).sort((a, b) => a.y - b.y)) {
      if (next.x1 < line.x0 || next.x0 > line.x1) continue;
      const prevEndedSentence = /[.!?。！？]$/.test(previous.text.trim());
      const shortEnd = prevEndedSentence && previous.x1 < rightEdge - line.size * 3;
      const indentedNewPara = prevEndedSentence && next.x0 - line.x0 > line.size * .8;
      if (next.y - previous.y > line.size * 1.8 || Math.abs(next.size - line.size) > 1 ||
          next.x0 < captionLeft || next.x1 > captionRight || shortEnd || indentedNewPara ||
          parseCaption(next.text) || !isProse(next)) break;
      parts.push(next);
      previous = next;
    }
    const caption = {
      ...line,
      ...unionRects(parts),
      items: parts.flatMap(part => part.items),
      text: parts.map(part => part.text).join(' '),
      textRuns: linesTextRuns(parts),
    };
    parts.forEach(part => claimedLines.add(part));
    used.add(best.image);
    const pad = 1.5;
    // The PDF's clip is part of the original figure. Preserve the complete visible
    // bitmap, with padding stopped before the caption's glyph band.
    plates.push({
      image: best.image,
      crop: [
        Math.max(0, best.image.x0 - pad),
        Math.max(0, best.image.y0 - pad),
        Math.min(width, best.image.x1 + pad),
        Math.min(height, Math.max(best.image.y1, Math.min(line.y0 - 1, best.image.y1 + pad))),
      ],
      caption,
      figureLabel: label.label,
    });
  }
  return plates;
}

/** Keep aligned plate cells together; each row enters the page reading order as one unit. */
export function groupFigurePlateRows(plates: FigurePlate[]): FigurePlate[][] {
  const rows: FigurePlate[][] = [];
  for (const plate of [...plates].sort((a, b) => a.caption.y - b.caption.y || a.image.x0 - b.image.x0)) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last[0].caption.y - plate.caption.y) <= plate.caption.size * 1.5) last.push(plate);
    else rows.push([plate]);
  }
  return rows.flatMap(row => {
    row.sort((a, b) => a.image.x0 - b.image.x0);
    // Aligned but nonconsecutive captions indicate independent column figures,
    // not cells of the same row-major plate.
    const labels = row.map(plate => plate.figureLabel.match(/^(.*?)(\d+)$/));
    if (row.length > 1 && labels.every(Boolean) && labels.some((label, i) => i > 0 &&
      (label![1] !== labels[i - 1]![1] || Number(label![2]) !== Number(labels[i - 1]![2]) + 1)))
      return row.map(plate => [plate]);
    return [row];
  });
}
