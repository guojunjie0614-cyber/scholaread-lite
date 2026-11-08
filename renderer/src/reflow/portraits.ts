import type { RawItem } from './analyze';
import type { Drawing, Rect } from './regions';
import { parseCaption } from './captions';
import { identifyBiographySubject } from './reading-roles';

interface TextLine extends Rect { text: string; }

/** Hide only small raster portraits anchored to a named author biography in the document tail. */
export function identifyAuthorPortraits(
  items: RawItem[], drawings: Drawing[], width: number, height: number, body: number,
  page: number, totalPages: number | undefined,
  toLines: (items: RawItem[], maxGap?: number) => TextLine[],
): Rect[] {
  if (!totalPages || page < Math.max(2, Math.ceil(totalPages * .7))) return [];
  const lines = toLines(items, Math.max(12, body * 1.2));
  return drawings.filter(image => {
    const w = image.x1 - image.x0, h = image.y1 - image.y0;
    if (image.kind !== 'image' || w < 30 || w > width * .2 || h < 40 || h > height * .22 || w / h < .5 || w / h > 1.2) return false;
    if (lines.some(line => parseCaption(line.text) && line.y0 >= image.y1 - body && line.y0 < image.y1 + body * 5 && line.x0 < image.x1 && line.x1 > image.x0)) return false;
    const adjacent = lines.filter(line => line.x0 >= image.x1 && line.x0 <= image.x1 + body * 2.5 &&
      line.y0 >= image.y0 - body && line.y0 < image.y0 + body * 7 && line.x1 <= image.x1 + width * .35);
    if (!adjacent.length || Math.abs(adjacent[0].y0 - image.y0) > body * 1.5) return false;
    const text = adjacent.map(line => line.text).join(' ');
    // The same named subject establishes the biography in both passes. In
    // particular Dr.-Ing. is education evidence, not a different portrait rule.
    return !!identifyBiographySubject(text);
  });
}
