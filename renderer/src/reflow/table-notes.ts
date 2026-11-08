import type { RawItem } from './analyze';
import { parseCaption } from './captions';
import { unionRects, type PageRegion, type Rect } from './regions';
import type { TextRun } from '@shared/types';
import { linesTextRuns } from './inline-text';

interface NoteLine extends Rect {
  items: RawItem[];
  text: string;
  y: number;
  size: number;
  bold: boolean;
}

export interface TableNote extends Rect {
  table: PageRegion;
  items: RawItem[];
  text: string;
  textRuns: TextRun[];
  sourceFontSize: number;
}

const MARKER = /^(?:[*∗†‡§¶]|notes?\s*[:.]|注\s*[:：])/i;
const HEADING = /^(?:[IVXLC]{1,6}\.|[A-Z]\.|\d+(?:\.\d+)+)\s+\S/;

/**
 * A note belongs to the table above it, not to the page's normal column stream.
 * Size, horizontal containment and a continuous vertical gap are all required.
 * Unmarked notes need the stronger evidence of alignment and an almost touching table rule.
 */
export function extractTableNotes(
  tables: PageRegion[],
  items: RawItem[],
  bodySize: number,
  toLines: (items: RawItem[]) => NoteLine[],
): TableNote[] {
  const result: TableNote[] = [];
  const assigned = new Set<RawItem>();
  for (const table of [...tables].sort((a, b) => a.y0 - b.y0)) {
    const below = items.filter(item => !assigned.has(item) &&
      item.x >= table.x0 - 3 && item.x + item.w <= table.x1 + 3 &&
      item.y > table.y1 && item.y < table.y1 + bodySize * 12);
    const lines = toLines(below);
    let current: NoteLine[] = [];
    let previous: NoteLine | undefined;

    const flush = () => {
      if (!current.length) return;
      const textRuns = linesTextRuns(current, true);
      const noteItems = current.flatMap(line => line.items);
      result.push({
        ...unionRects(current),
        table,
        items: noteItems,
        text: textRuns.map(run => run.text).join(''),
        textRuns,
        sourceFontSize: current[0].size,
      });
      noteItems.forEach(item => assigned.add(item));
      current = [];
    };

    for (const line of lines) {
      if (line.size >= bodySize * .94 || HEADING.test(line.text) || parseCaption(line.text)) break;
      if (line.bold && line.text.length < 90) break;
      const marked = MARKER.test(line.text);
      if (!previous) {
        const gap = line.y0 - table.y1;
        if (gap < -1 || gap > bodySize) break;
        const aligned = Math.abs(line.x0 - table.x0) <= bodySize * .8;
        const unmarkedEvidence = aligned && gap <= bodySize * .65 && line.size <= bodySize * .88;
        if (!marked && !unmarkedEvidence) break;
      } else {
        if (line.y - previous.y > Math.max(previous.size * 1.75, bodySize * 1.1)) break;
        if (Math.abs(line.size - previous.size) > 1) break;
      }
      if (marked && current.length) flush();
      current.push(line);
      previous = line;
    }
    flush();
  }
  return result;
}
