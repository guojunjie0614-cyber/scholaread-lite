import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Block, BlockKind, TextRun } from '@shared/types';
import { extractPageRegions, multiplyMatrices, transformRect, unionRects, type Rect, type PageRegion, type Drawing } from './regions';
import { extractMathRegions } from './math';
import { MATH_EXTENSION_FONT } from './math-fonts';
import { extractTableNotes } from './table-notes';
import { parseCaption } from './captions';
import { matchFigurePlates, groupFigurePlateRows } from './figure-plates';
import { identifyAlgorithms, identifyCodeFigures } from './algorithms';
import { identifyAuthorPortraits } from './portraits';
import { lineTextRuns, linesTextRuns, joinTextRuns } from './inline-text';
import { identifyFrontMatter, identifyPublicationHeaders, identifyRepeatedPublicationHeaders } from './front-matter';
import { classifyReadingRoles } from './reading-roles';
import { classifyReferences, endsReferenceSection, isBibliographicLine, isBibliographicEntryStart } from './references';
import { isReferenceHeading } from '@shared/reading-content';
import { composeDottedEquals, hasUnmappedGlyphs, recoverEncodedGlyphs } from './glyph-recovery';
export const REFLOW_ENGINE_VERSION = 28;

/** Running headers and floating figures must not interrupt an unfinished sentence. */
export function orderFloatingContent<T extends Pick<Block, 'kind' | 'text' | 'readingRole'>>(blocks: T[]): T[] {
  const headers = blocks.filter(block => block.readingRole === 'publication');
  const result = blocks.filter(block => block.readingRole !== 'publication');
  for (let i = 0; i < result.length; i++) {
    const before = result[i];
    if (before.kind !== 'p' || !/[\p{L}\p{N},;:]$/u.test(before.text.trim())) continue;
    let next = i + 1;
    while (next < result.length && (result[next].kind === 'figure' || result[next].kind === 'caption')) next++;
    if (next === i + 1 || next >= result.length || result[next].kind !== 'p' ||
      !/^\p{Ll}/u.test(result[next].text.trim())) continue;
    const [continuation] = result.splice(next, 1);
    result.splice(i + 1, 0, continuation);
    i++;
  }
  return [...headers, ...result];
}
export interface RawItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bold: boolean;
  italic?: boolean;
  font: string;
  top?: number;
  bottom?: number;
  confidence?: number;
}

interface Line extends Rect {
  items: RawItem[];
  text: string;
  y: number;
  size: number;
  bold: boolean;
  readingRole?: Block['readingRole'];
}

interface Paragraph extends Rect {
  text: string;
  size: number;
  bold: boolean;
  lines: number;
  kind: BlockKind;
  textRuns: TextRun[];
  readingRole?: Block['readingRole'];
}

interface Placed {
  block: Block;
  box: Rect;
  column: number;
  footnote?: boolean;
}
type Column = {
  x0: number;
  x1: number;
};
export interface AnalyzeOptions {
  keepFigures: boolean;
  /** Document context is required before suppressing author portraits. */
  documentPageCount?: number;
  ocrPage?: (page: PDFPageProxy) => Promise<RawItem[]>;
  onProgress?: (done: number, total: number) => void;
}

const HEADING = /^(?:[IVXLC]{1,6}\.\s+|[A-Z]\.\s+|\d+(?:\.\d+)+\.?\s+)\S/;
const SECTION = /^(?:abstract|introduction|related work|background|methods?|methodology|results?|discussion|conclusions?|references|acknowledg(?:e)?ments?|appendix|摘要|引言|相关工作|方法|实验|结果|讨论|结论|参考文献|致谢)$/i;
const LIST = /^(?:[•‣▪◦■]|[-–—]\s|\d{1,2}[.)]\s|[a-z][.)]\s)/;
const PUBLICATION_NOTICE = /©\s*\d{4}|\bcopyright\b|\bauthorized licensed use\b|\brestrictions apply\b|\b97[89](?:[- ]?\d){10,}|^arxiv:|^preprint\s+doi\b/i;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const bounds = (it: RawItem): Rect => ({ x0: it.x, y0: it.top ?? it.y - it.h * .82, x1: it.x + it.w, y1: it.bottom ?? it.y + it.h * .22 });
const centerInside = (it: RawItem, r: Rect) => { const b = bounds(it), x = (b.x0 + b.x1) / 2, y = (b.y0 + b.y1) / 2; return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1; };
const xOverlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
function bodySize(items: RawItem[]): number {
  const hist = new Map<number, number>();
  for (const it of items) {
    if (!it.str.trim())
      continue;
    const size = Math.round(it.h * 2) / 2;
    hist.set(size, (hist.get(size) ?? 0) + it.str.length);
  }
  return [...hist].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
}

function joinItems(items: RawItem[]): string {
  let text = '', end = -Infinity;
  for (const it of [...items].sort((a, b) => a.x - b.x)) {
    if (text && it.x - end > Math.max(.5, it.h * .13) && !(/\s$/.test(text) || /^\s/.test(it.str)))
      text += ' ';
    text += it.str;
    end = Math.max(end, it.x + it.w);
  }
  return norm(text);
}
/** Preserve source order within visual baselines; whitespace items contribute actual spaces. */
function toLines(items: RawItem[], maxGap = Infinity, gutter: number | null = null): Line[] {
  const rows: Array<{
    y: number;
    items: RawItem[];
  }> = [];
  const decoration = (it: RawItem) => /^[ˆ̂˙̸¯]$/.test(it.str.trim());
  const extensionOperator = (it: RawItem) => MATH_EXTENSION_FONT.test(it.font) && /^[∫∑∏]$/.test(it.str.trim());
  // Establish main baselines before assigning smaller superscripts/subscripts.
  // CMEX operators use a top-origin font transform, not a text baseline.
  // Establish their surrounding text first, but still assign them before limits.
  const priority = (it: RawItem) => decoration(it) || !it.str.trim() && MATH_EXTENSION_FONT.test(it.font) ? 0 : extensionOperator(it) ? it.h * .84 : it.h;
  const ordered = [...items].sort((a, b) => priority(a) - priority(b)).reverse();
  for (const it of ordered) {
    const candidates = rows.filter(row => {
      const size = Math.max(...row.items.map(x => x.h));
      const offset = it.y - row.y;
      if (extensionOperator(it)) return Math.abs(row.y - (it.y + it.h * .8)) < it.h * .65 &&
        row.items.some(host => !extensionOperator(host) && host.h >= it.h * .85 &&
          it.x <= host.x + host.w + it.h * 1.5 && it.x + it.w >= host.x - it.h * 1.5);
      if (Math.abs(offset) <= Math.max(1, size * .14)) return true;
      if (it.h >= size * .88 && !decoration(it)) return Math.abs(offset) <= Math.max(2, size * .30);
      // Descenders move much less than superscripts. A symmetric nearest-row
      // window assigns a high exponent to the preceding tightly spaced line.
      if (offset < -size * (it.h < size * .56 ? 1.25 : .75) || offset > size * (it.h < size * .56 ? .85 : .65)) return false;
      if (/^[′″‴]+$/.test(it.str.trim()) && offset > size * .1) return false;
      return row.items.some(host => (host.h >= size * .88 && Math.abs(host.y - row.y) <= size * .25 && offset >= -size * .75 && offset <= size * .65 ||
          it.h < host.h * .8 && Math.abs(it.y - host.y) <= host.h * .65) &&
        (offset <= size * .38 || /[\p{L}\p{N})\]}]$/u.test(host.str.trim())) &&
        it.x <= host.x + host.w + size * .85 && it.x + it.w >= host.x - size * .5);
    });
    candidates.sort((a, b) => {
      const distance = (row: typeof a) => Math.min(...row.items.map(host =>
        Math.max(0, it.x - (host.x + host.w), host.x - (it.x + it.w)) + Math.abs(host.y - it.y) * .3));
      return distance(a) - distance(b);
    });
    if (candidates[0])
      candidates[0].items.push(it);
    else
      rows.push({ y: it.y, items: [it] });
  }
  // A subscript may arrive right-to-left: its last glyph can start a small
  // row before the glyph beside the host is visited. Reattach the whole row
  // once its horizontal extent makes that host unambiguous.
  for (const row of [...rows]) {
    const rowSize = Math.max(...row.items.map(it => it.h));
    const candidates = rows.filter(host => host !== row).flatMap(host => host.items.filter(h => h.h > rowSize / .88)
      .map(h => ({ host, size: h.h, offset: row.y - h.y,
        distance: Math.min(...row.items.map(it => Math.max(0, it.x - (h.x + h.w), h.x - (it.x + it.w)))) })))
      .filter(x => x.offset >= -x.size * (rowSize < x.size * .56 ? .95 : .75) && x.offset <= x.size * .65 && x.distance <= x.size * .5 &&
        (!row.items.every(it => /^[′″‴]+$/.test(it.str.trim())) || x.offset <= x.size * .1))
      .sort((a, b) => a.distance - b.distance || Math.abs(a.offset) - Math.abs(b.offset));
    if (candidates[0]) {
      candidates[0].host.items.push(...row.items);
      rows.splice(rows.indexOf(row), 1);
    }
  }
  const lines: Line[] = [];
  for (const row of rows) {
    const sorted = row.items.sort((a, b) => a.x - b.x);
    // Sharing a baseline never joins independent columns. Only an actual ink item
    // or ordinary word spacing bridging the gutter is evidence of a full-width row.
    const rowInk = sorted.filter(it => it.str.trim());
    const rowSize = rowInk.length ? Math.max(...rowInk.map(x => x.h)) : 10;
    const bridgesGutter = gutter !== null && (
      rowInk.some(it => it.x < gutter - 2 && it.x + it.w > gutter + 2) ||
      rowInk.some((it, idx) => idx > 0 && rowInk[idx - 1].x + rowInk[idx - 1].w >= gutter - rowSize * .45 &&
        it.x <= gutter + rowSize * .45 && it.x - (rowInk[idx - 1].x + rowInk[idx - 1].w) <= Math.max(5, rowSize * .65))
    );
    const splitColumns = gutter !== null && !bridgesGutter;
    let group: RawItem[] = [];
    let end = -Infinity;
    const flush = () => {
      if (!group.some(x => x.str.trim()))
        return;
      const box = unionRects(group.map(bounds));
      const ink = group.filter(x => x.str.trim());
      lines.push({
        ...box,
        items: group,
        text: joinItems(group),
        y: row.y,
        size: Math.max(...ink.map(x => x.h)),
        bold: ink.filter(x => x.bold).reduce((s, x) => s + x.str.length, 0) > ink.reduce((s, x) => s + x.str.length, 0) * .65
      });
    };
    for (const it of sorted) {
      const crossesColumn = gutter !== null && splitColumns && group.length > 0 &&
        group[0].x + group[0].w / 2 < gutter && it.x + it.w / 2 >= gutter;
      if (group.length && (it.x - end > maxGap || crossesColumn)) {
        flush();
        group = [];
      }
      group.push(it);
      end = it.x + it.w;
    }
    flush();
  }
  return lines.sort((a, b) => a.y - b.y || a.x0 - b.x0);
}
/** Require a persistent inter-column gap wider than ordinary word spacing. */
export function detectGutter(items: RawItem[], pageWidth: number): number | null {
  if (items.filter(x => x.str.trim()).length < 12)
    return null;
  const body = bodySize(items);
  // Gutter evidence comes from horizontal bands, not semantic text baselines.
  // Adjacent columns may use different fonts/line spacing (body vs references);
  // their ink still bounds a persistent whitespace corridor.
  const rows: Array<{ y: number; items: RawItem[] }> = [];
  for (const item of [...items].sort((a, b) => b.h - a.h)) {
    const row = rows.filter(row => Math.abs(row.y - item.y) <= Math.max(2, item.h * .55, ...row.items.map(x => x.h * .65)))
      .sort((a, b) => Math.abs(a.y - item.y) - Math.abs(b.y - item.y))[0];
    if (row) row.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }
  for (const row of rows) row.items.sort((a, b) => a.x - b.x);
  let best: {
    x: number;
    score: number;
  } | null = null;
  for (let x = pageWidth * .30; x <= pageWidth * .70; x += 1) {
    let support = 0, cross = 0;
    for (const row of rows) {
      const ink = row.items.filter(it => it.str.trim());
      const left = ink.filter(it => it.x + it.w <= x), right = ink.filter(it => it.x >= x);
      if (ink.some(it => it.x < x && it.x + it.w > x)) {
        cross++;
        continue;
      }
      if (!left.length || !right.length)
        continue;
      const l = Math.max(...left.map(it => it.x + it.w)), r = Math.min(...right.map(it => it.x));
      const gaps = ink.slice(1).map((it, i) => it.x - (ink[i].x + ink[i].w)).filter(g => g > 1).sort((a, b) => a - b);
      const ordinaryGap = gaps.length >= 4 ? gaps[Math.floor(gaps.length / 2)] : 0;
      if (r - l >= Math.max(8, body * .8) && r - l > ordinaryGap * 1.6 && x - l >= 2 && r - x >= 2)
        support++;
    }
    if (support < 4 || support < rows.length * .16)
      continue;
    const score = support - cross * .3 - Math.abs(x - pageWidth / 2) * .04;
    if (score > 0 && (!best || score > best.score))
      best = { x, score };
  }
  return best?.x ?? null;
}

function columnsFor(items: RawItem[], width: number, gutter: number | null): Column[] {
  if (gutter === null)
    return [{ x0: Math.min(...items.map(x => x.x)), x1: Math.max(...items.map(x => x.x + x.w)) }];
  return [[0, gutter], [gutter, width]].map(([lo, hi]) => {
    const own = items.filter(it => it.x >= lo - 1 && it.x + it.w <= hi + 1 && it.str.trim());
    return {
      x0: own.length ? Math.min(...own.map(x => x.x)) : lo,
      x1: own.length ? Math.max(...own.map(x => x.x + x.w)) : hi
    };
  });
}

function lineKind(line: Line, body: number, page: number): BlockKind {
  const text = line.text;
  if (!isBibliographicLine(text) && HEADING.test(text) && text.length < 130 && (!/^\d/.test(text) || line.bold || line.size > body * 1.1))
    return /^\d+\.\d+\.\d+/.test(text) ? 'h3' : /^[A-H]\./.test(text) ? 'h3' : 'h2';
  if (SECTION.test(text))
    return 'h2';
  if (page === 1 && line.size >= body * 1.5 && text.length < 240)
    return 'h1';
  if (line.bold && line.size >= body * 1.08 && text.length < 120)
    return 'h3';
  if (LIST.test(text))
    return 'li';
  if (isBibliographicEntryStart(text))
    return 'ref';
  return 'p';
}

function joinLines(left: string, right: string): string {
  if (/\u00ad$/.test(left))
    return left.slice(0, -1) + right;
  if (/[a-z]-$/i.test(left) && /^[a-z]/i.test(right)) {
    const head = left.match(/([A-Za-z]+)-$/)?.[1] ?? '';
    // Conservative dehyphenation: retain real compounds such as high-dynamic and candidate-record.
    if (/^(?:re|co|de|pre|pro|un|in|im|en|ex|dis|mis|sub|inter|trans|how|there|com|con|sig|para|archi|imple|opti|compu|evalua|detec|correla)$/i.test(head) || /^(?:tion|sion|tions|sions|ing|ment|ments|ness|ity|ities|ance|ence|able|ible|ization|isation|ture|tures|tation|tations|rithm|rithms|puter|puters)\b/i.test(right))
      return left.slice(0, -1) + right;
    return left + right;
  }
  if (/[\u3400-\u9fff]$/.test(left) && /^[\u3400-\u9fff]/.test(right))
    return left + right;
  return `${left} ${right}`;
}

function paragraphs(lines: Line[], body: number, page: number, referenceState = { active: false }): Paragraph[] {
  const out: Paragraph[] = [];
  let prev: Line | null = null;
  let inReferences = referenceState.active;
  const right = Math.max(...lines.map(l => l.x1));
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], next = lines[index + 1], afterNext = lines[index + 2];
    let kind = line.readingRole === 'title' ? 'h1' as const : line.readingRole ? 'p' as const : lineKind(line, body, page);
    const last = out[out.length - 1];
    // A decimal value at the start of a wrapped line is not a section number.
    const wrappedDecimal = /^\d+\.\d+\s/.test(line.text) && last?.kind === 'p' && prev &&
      !/[.!?;:。！？]$/.test(prev.text) && last.x1 - last.x0 > body * 12 && prev.x1 >= last.x1 - body * 2.5 &&
      Math.abs(line.x0 - prev.x0) < body * .5 && line.y - prev.y > 0 && line.y - prev.y < body * 1.75;
    if (/^h[23]$/.test(kind) && wrappedDecimal) kind = 'p';
    const headingGap = next && (next.y - line.y > body * 1.4 ||
      next.x0 > line.x0 + body && afterNext && afterNext.y - next.y > body * 1.4);
    if (!wrappedDecimal && !line.readingRole && kind === 'p' && /^\d+(?:\.\d+)*\s+[A-Z]/.test(line.text) &&
      line.text.length < 120 && !/[.!?。！？]$/.test(line.text) && headingGap &&
      (!prev || line.y - prev.y > body * 1.4)) kind = 'h2';
    if (kind === 'p' && last?.kind === 'h2' && prev && /^\d+(?:\.\d+)*\s/.test(last.text) &&
      line.x0 > last.x0 + body && line.y - prev.y < body * 1.35 && next && next.y - line.y > body * 1.4 &&
      !/[.!?。！？]$/.test(line.text)) kind = 'h2';
    const referenceHeading = isReferenceHeading({ kind, text: line.text });
    if (referenceHeading) inReferences = true;
    else if (endsReferenceSection(line.text)) inReferences = false;
    else if (inReferences && !line.readingRole && (/^\[\d+\]/.test(line.text) || isBibliographicLine(line.text) || /^h[23]$/.test(kind))) kind = 'ref';
    // Heading-less bibliographies can continue with organization-led entries.
    // Require a preceding real entry or the next consecutive entry's strong
    // author/publishing evidence; an isolated “[36] to achieve ...” stays prose.
    const marker = /^\[(\d+)\]/.exec(line.text);
    if (!inReferences && !line.readingRole && kind === 'p' && marker) {
      const following = lines.slice(index + 1, index + 9).find(candidate => /^\[\d+\]/.test(candidate.text));
      const nextNumber = following?.text.match(/^\[(\d+)\]/)?.[1];
      if (last?.kind === 'ref' || following && Number(nextNumber) === Number(marker[1]) + 1 && isBibliographicEntryStart(following.text)) kind = 'ref';
    }
    const startsItem = kind === 'li' || kind === 'ref' && /^\[\d+\]/.test(line.text);
    const continuesItem = last && prev && kind === 'p' &&
      (last.kind === 'li' || last.kind === 'ref') &&
      (line.x0 >= last.x0 + (last.kind === 'ref' ? -.5 : body * .3) ||
        last.kind === 'li' && /^[•‣▪◦■]/.test(last.text) && line.x0 >= last.x0 - body * 1.2 && !/[.!?;:]$/.test(prev.text)) &&
      line.y - prev.y < body * 1.75;
    if (continuesItem) kind = last.kind;
    const indented = prev && line.x0 - prev.x0 > body * .8 &&
      (/[.!?;:。！？]$/.test(prev.text) || line.y - prev.y > body * 1.4);
    const shortEnd = prev && prev.x1 < right - body * 2.5 && /[.!?。！？]$/.test(prev.text);
    const newParagraph = !last || !prev || kind !== last.kind || line.readingRole !== last.readingRole || startsItem ||
      hasUnmappedGlyphs(line.text) || hasUnmappedGlyphs(prev.text) ||
      line.y - prev.y > Math.max(body * 1.75, prev.size * 1.8) ||
      Math.abs(line.size - prev.size) > 1.4 || (kind === 'p' && !line.readingRole && (indented || shortEnd));
    if (newParagraph)
      out.push({ ...line, text: line.text, textRuns: lineTextRuns(line), size: line.size, bold: line.bold, lines: 1, kind });
    else {
      last.text = norm(joinLines(last.text, line.text));
      last.textRuns = joinTextRuns(last.textRuns, lineTextRuns(line), last.text);
      Object.assign(last, unionRects([last, line]));
      last.lines++;
    }
    prev = line;
  }
  referenceState.active = inReferences;
  return out;
}

function identifyTables(lines: Line[], drawings: Drawing[], cols: Column[], height: number): PageRegion[] {
  const tables: PageRegion[] = [];
  const captions = lines.filter(l => parseCaption(l.text)?.kind === 'table');
  for (const caption of captions) {
    const cx = (caption.x0 + caption.x1) / 2;
    const col = cols.find(c => cx >= c.x0 && cx <= c.x1) ?? { x0: cols[0].x0, x1: cols[cols.length - 1].x1 };
    const rules = drawings.filter(r => r.horizontal && r.y0 > caption.y && r.x0 < cx && r.x1 > cx && r.x1 - r.x0 > 80).sort((a, b) => a.y0 - b.y0);
    const top = rules[0];
    if (!top || top.y0 - caption.y > 65)
      continue;
    const nextCaption = captions.find(c => c.y > caption.y && c.x0 < col.x1 && c.x1 > col.x0);
    const aligned = rules.filter(r => Math.abs(r.x0 - top.x0) < 5 && Math.abs(r.x1 - top.x1) < 5 && r.y1 < (nextCaption?.y0 ?? height * .96));
    if (aligned.length < 2)
      continue;
    const box = unionRects(aligned);
    if (box.y1 - box.y0 < 16)
      continue;
    tables.push({ ...box, kind: 'table', parts: aligned.length, rules: { h: aligned.length, v: 0 } });
  }
  return tables;
}

function fitFigures(regions: PageRegion[], items: RawItem[], lines: Line[], body: number, width: number, height: number, tables: PageRegion[], cols: Column[] = []): PageRegion[] {
  const figures: PageRegion[] = [];
  for (const region of regions) {
    if (tables.some(t => xOverlap(t, region) > Math.min(t.x1 - t.x0, region.x1 - region.x0) * .6 && region.y0 >= t.y0 - 4 && region.y1 <= t.y1 + 4))
      continue;
    const caption = lines.filter(l => parseCaption(l.text) && parseCaption(l.text)?.kind !== 'table' && l.size <= body * 1.02 && l.y0 >= region.y1 - 3 && l.y0 - region.y1 < 55 && xOverlap(l, region) > 0).sort((a, b) => a.y0 - b.y0)[0];
    const lower = caption ? caption.y0 - 3 : region.y1 + 5;
    const labelMargin = caption ? body * 4.5 : 14;
    const col = cols.find(col => region.x0 >= col.x0 - 2 && region.x1 <= col.x1 + 2);
    const labelLeft = Math.max(col?.x0 ?? 0, region.x0 - labelMargin);
    const labelRight = Math.min(col?.x1 ?? width, region.x1 + labelMargin);
    const labels = items.filter(it => it.h <= body * 1.05 && it.x >= labelLeft - 1 && it.x + it.w <= labelRight + 1 && (bounds(it).y0 >= region.y0 - 10) && (bounds(it).y1 <= lower));
    const box = unionRects([region, ...labels.map(bounds)]);
    figures.push({
      ...region,
      ...box,
      x0: Math.max(0, box.x0 - 3),
      y0: Math.max(0, box.y0 - 3),
      x1: Math.min(width, box.x1 + 3),
      y1: Math.min(height, box.y1 + 3)
    });
  }
  return figures;
}

interface CompositeFigure { box: Rect; caption: Line[]; label: string; }
/** Join separate image/vector fragments only when a single full-width caption owns them. */
function identifyCompositeFigures(items: RawItem[], regions: PageRegion[], body: number, width: number, height: number, gutter: number | null): CompositeFigure[] {
  const lines = toLines(items, Math.max(12, body * 1.2), gutter);
  const results: CompositeFigure[] = [];
  let previousCaptionBottom = 0;
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i], label = parseCaption(first.text);
    if (!label || label.kind !== 'figure' || first.x1 - first.x0 < width * .65) continue;
    const caption = [first];
    while (i + 1 < lines.length) {
      const next = lines[i + 1], prev = caption[caption.length - 1];
      if (next.y - prev.y > body * 1.5 || Math.abs(next.size - first.size) > 1 ||
        next.x0 < first.x0 - body || next.x0 > first.x0 + body * 2 || parseCaption(next.text)) break;
      caption.push(next); i++;
    }
    const candidates = regions.filter(r => r.kind === 'figure' && r.y1 <= first.y0 + 3 &&
      r.y0 >= Math.max(previousCaptionBottom, first.y0 - height * .65) &&
      r.x0 >= first.x0 - body && r.x1 <= first.x1 + body);
    const left = candidates.some(r => (r.x0 + r.x1) / 2 < width / 2);
    const right = candidates.some(r => (r.x0 + r.x1) / 2 >= width / 2);
    if (left && right && candidates.length >= 2) {
      const top = Math.min(...candidates.map(r => r.y0));
      const prose = lines.some(line => line.y0 >= top && line.y1 < first.y0 && line.size >= body * .95 &&
        line.text.length > 100 && line.x1 - line.x0 > width * .3);
      if (!prose) results.push({ box: { x0: first.x0, y0: Math.max(0, top - body), x1: first.x1, y1: first.y0 - 2 }, caption, label: label.label });
    }
    previousCaptionBottom = caption[caption.length - 1].y1;
  }
  return results;
}

export async function analyzePage(page: PDFPageProxy, pageNumber: number, paperId: string, options: AnalyzeOptions): Promise<Block[]> {
  const viewport = page.getViewport({ scale: 1 }), W = viewport.width, H = viewport.height;
  const geom = await extractPageRegions(page), content = await page.getTextContent();
  let raw: RawItem[] = [];
  for (const item of content.items as any[]) {
    if (typeof item.str !== 'string' || !item.str)
      continue;
    const tx = multiplyMatrices(viewport.transform, item.transform), size = Math.hypot(tx[2], tx[3]) || item.height || 10;
    const style = content.styles[item.fontName];
    const font = geom.fontNames.get(item.fontName) ?? style?.fontFamily ?? '';
    const extension = MATH_EXTENSION_FONT.test(font) && !!item.str.trim() && !/^[ˆ̂˙¯]+$/.test(item.str.trim());
    const ascent = extension ? 0 : (style?.ascent || .82), descent = extension ? -1.8 : (style?.descent || -.22);
    const length = (item.width || size * item.str.length * .5) / Math.max(.001, Math.hypot(tx[0], tx[1]));
    const box = transformRect(tx, 0, descent, length, ascent);
    // Publisher stamps can run vertically along the outer page edge. Feeding their
    // baseline into horizontal line grouping would splice the entire stamp into prose.
    const vertical = Math.abs(tx[1]) > Math.abs(tx[0]) * 4;
    if (vertical && ((box.x0 + box.x1) / 2 < W * .08 || (box.x0 + box.x1) / 2 > W * .92) &&
      (PUBLICATION_NOTICE.test(item.str) || /^\d{8,}[\d():,;\s]*$/.test(item.str.trim())))
      continue;
    raw.push({
      str: recoverEncodedGlyphs(item.str, page.commonObjs.has(item.fontName) ? page.commonObjs.get(item.fontName) : undefined),
      x: box.x0,
      y: tx[5],
      w: box.x1 - box.x0,
      h: size,
      top: box.y0,
      bottom: box.y1,
      bold: /bold|black|semibold|demi|medi/i.test(font),
      italic: /italic|oblique|(?:^|[+\-])(?:CMMI|CMTI|CMSL)\d*/i.test(font),
      font
    });
  }
  raw = composeDottedEquals(raw);
  const nativeText = raw.map(x => x.str).join('');
  const bad = (nativeText.match(/[\uFFFD\u0000-\u0008]/g) ?? []).length;
  const needsOCR = nativeText.trim().length < 8 || (nativeText.length > 0 && bad / nativeText.length > .03);
  let usedOCR = false;
  if (needsOCR && options.ocrPage) {
    raw = await options.ocrPage(page);
    usedOCR = true;
  }
  if (!raw.some(x => x.str.trim()))
    return geom.drawings.length ? [{
        id: `${paperId}:${pageNumber}:page`,
        paperId,
        page: pageNumber,
        ord: 0,
        kind: 'figure',
        text: '',
        crop: [0, 0, W, H],
        source: 'native'
      }] : [];
  const body = bodySize(raw);
  // Footnote numbers and URLs can share vertical positions with the other
  // column's prose. Pair them by line and size before constructing text rows.
  const footnoteUrls = raw.filter(it => it.h < body * .7 && /^(?:https?:\/\/|www\.)/i.test(it.str.trim()));
  const urlFootnotes: RawItem[] = [];
  const footnoteMarkers = new Set(raw.filter(it => /^\d{1,2}$/.test(it.str.trim()) && it.h < body * .7 &&
    footnoteUrls.some(url => Math.abs(url.y - it.y) < body * .35 && url.x >= it.x + it.w && url.x - it.x - it.w < body * 2)));
  // Keep marker and URL together as one source item for search and provenance.
  for (const marker of footnoteMarkers) {
    const url = footnoteUrls.find(item => Math.abs(item.y - marker.y) < body * .35 && item.x >= marker.x + marker.w && item.x - marker.x - marker.w < body * 2)!;
    urlFootnotes.push({ ...url, x: marker.x, w: url.w + url.x - marker.x, str: `${marker.str} ${url.str}` });
  }
  const pairedUrls = new Set(footnoteUrls.filter(url => [...footnoteMarkers].some(marker =>
    Math.abs(url.y - marker.y) < body * .35 && url.x >= marker.x + marker.w && url.x - marker.x - marker.w < body * 2)));
  raw = raw.filter(it => !footnoteMarkers.has(it) && !pairedUrls.has(it));
  // Classify whole margin lines before column splitting. The publication name and
  // copyright/ISBN often share a footer baseline but occupy opposite columns.
  const marginItems = new Set(toLines(raw)
    .filter(line => (/^[-–—]?\d{1,4}[-–—]?$/.test(line.text) &&
      (line.y < H * .065 || line.y > H * .95)) ||
      (line.y0 > H * .95 && !/^\[\d+\]/.test(line.text) &&
        (PUBLICATION_NOTICE.test(line.text) || /^(?:\d+\s*[•·]\s*)?(?:digest|proceedings) of\b/i.test(line.text))))
    .flatMap(line => line.items));
  let items = raw.filter(it => !marginItems.has(it));
  // Rejoin a drop cap only when its adjacent first line is actually found.
  const consumed = new Set<RawItem>();
  items = items.map(it => ({ ...it }));
  for (const cap of items.filter(it => /^[A-Z]$/.test(it.str) && it.h > body * 1.5)) {
    const box = bounds(cap);
    const target = items.filter(it => it !== cap && /^[A-Za-z]/.test(it.str) && it.h <= body * 1.2 &&
      it.x >= cap.x + cap.w - 3 && it.x - cap.x - cap.w < body &&
      it.y >= box.y0 && it.y <= box.y1 + body * .2).sort((a, b) => a.y - b.y)[0];
    if (target) {
      const gap = target.x - cap.x - cap.w;
      target.str = cap.str + (gap > body * .3 ? ' ' : '') + target.str;
      target.w = target.x + target.w - cap.x;
      target.x = cap.x;
      consumed.add(cap);
      // Some PDFs emit an empty item in the drop cap's large font. Its baseline
      // spans several text rows but contributes no visible whitespace.
      for (const blank of items) if (!blank.str.trim() && blank.h > body * 1.5 && Math.abs(blank.y - cap.y) < 1)
        consumed.add(blank);
    }
  }
  items = items.filter(it => !consumed.has(it));
  const algorithms = identifyAlgorithms(items, geom.drawings, body, toLines);
  const codeFigures = options.keepFigures ? identifyCodeFigures(items, geom.drawings, body, toLines) : [];
  // Code listings still provide strong evidence for a column boundary even
  // though their glyphs are removed from ordinary text immediately afterward.
  // Algorithm glyphs and line numbers never participate in ordinary columns or paragraphs.
  items = items.filter(it => ![...algorithms, ...codeFigures].some(region => centerInside(it, region)));
  const preGutter = detectGutter(items.filter(it => !algorithms.some(region => centerInside(it, region))), W);
  const composites = options.keepFigures ? identifyCompositeFigures(items, geom.regions, body, W, H, preGutter) : [];
  const compositeCaptionItems = new Set(composites.flatMap(figure => figure.caption.flatMap(line => line.items)));
  const gutter = detectGutter(items.filter(it => !algorithms.some(region => centerInside(it, region)) &&
    !compositeCaptionItems.has(it) && !composites.some(figure => centerInside(it, figure.box))), W);
  items = items.filter(it => !compositeCaptionItems.has(it) && !composites.some(figure => centerInside(it, figure.box)));
  const portraits = usedOCR ? [] : identifyAuthorPortraits(items, geom.drawings, W, H, body,
    pageNumber, options.documentPageCount, toLines);
  const coveredBy = (region: Rect, masks: Rect[]) => masks.some(mask => {
    const area = xOverlap(region, mask) * Math.max(0, Math.min(region.y1, mask.y1) - Math.max(region.y0, mask.y0));
    return area > 0 && area >= (region.x1 - region.x0) * (region.y1 - region.y0) * .8;
  });
  const visibleRegions = geom.regions.filter(region => !coveredBy(region, [...algorithms, ...codeFigures, ...portraits, ...composites.map(x => x.box)]));
  const visibleDrawings = geom.drawings.filter(drawing => !coveredBy(drawing, [...algorithms, ...codeFigures, ...portraits, ...composites.map(x => x.box)]));
  const cols = columnsFor(items, W, gutter);
  const allLines = toLines(items, Math.max(12, body * 1.2), gutter);
  const tables = usedOCR ? [] : identifyTables(allLines, visibleDrawings, cols, H);
  const plates = usedOCR || !options.keepFigures ? [] :
    matchFigurePlates(visibleDrawings, visibleRegions, allLines, W, H, line => lineKind(line, body, pageNumber) === 'p');
  const plateItems = new Set(plates.flatMap(plate => plate.caption.items));
  const normalRegions = visibleRegions.filter(region => {
    const coveredArea = plates.reduce((sum, plate) => sum + xOverlap(region, plate.image) *
      Math.max(0, Math.min(region.y1, plate.image.y1) - Math.max(region.y0, plate.image.y0)), 0);
    return coveredArea < (region.x1 - region.x0) * (region.y1 - region.y0) * .8;
  });
  const figures = usedOCR ? [] : fitFigures(normalRegions, items, allLines, body, W, H, tables, cols);
  const regions = [...tables, ...figures];
  const tableNotes = options.keepFigures ? extractTableNotes(tables, items, body, toLines) : [];
  const tableNoteItems = new Set(tableNotes.flatMap(note => note.items));
  const spanningProse = gutter === null ? [] : allLines.filter(l => l.items.some(it => it.x < gutter - 2 && it.x + it.w > gutter + 2 && /[A-Za-z]{3,}.*[A-Za-z]{3,}/.test(it.str)));
  const wideItems = new Set(spanningProse.flatMap(l => l.items));
  const equations = extractMathRegions(items.filter(it => !wideItems.has(it) && !tableNoteItems.has(it) && !plateItems.has(it)),
    body, W, cols, [...regions, ...plates.map(plate => plate.image)], visibleDrawings);
  const placed: Placed[] = [];
  let serial = 0;
  const columnFor = (box: Rect) => gutter === null ? 0 : (box.x0 < gutter - 2 && box.x1 > gutter + 2 ? -1 : (box.x0 + box.x1) / 2 < gutter ? 0 : 1);
  const add = (kind: BlockKind, text: string, box: Rect, extra: Partial<Block> = {}) => {
    const block: Block = {
      id: `${paperId}:${pageNumber}:${serial++}`,
      paperId,
      page: pageNumber,
      ord: 0,
      kind,
      text,
      source: usedOCR ? 'ocr' : 'native',
      bbox: [box.x0, box.y0, box.x1, box.y1],
      ...extra
    };
    if (!['math', 'figure', 'table', 'algorithm'].includes(kind) && hasUnmappedGlyphs(text)) {
      block.sourceTextFallback = true;
      block.crop = [Math.max(0, box.x0 - 1), Math.max(0, box.y0), Math.min(W, box.x1 + 1), Math.min(H, box.y1)];
    }
    placed.push({ block, box, column: columnFor(box) });
    return block;
  };
  for (const algorithm of algorithms) {
    add('algorithm', algorithm.text, algorithm, { sourceFontSize: body,
      crop: [Math.max(0, algorithm.x0 - 2), Math.max(0, algorithm.y0 - 2), Math.min(W, algorithm.x1 + 2), Math.min(H, algorithm.y1 + 2)],
    });
  }
  for (const portrait of portraits) {
    add('figure', '', portrait, { readingRole: 'biography',
      crop: [Math.max(0, portrait.x0 - 2), Math.max(0, portrait.y0 - 2), Math.min(W, portrait.x1 + 2), Math.min(H, portrait.y1 + 2)] });
  }
  for (const code of codeFigures) {
    add('figure', code.text, code, { figureLabel: code.label,
      crop: [Math.max(0, code.x0 - 2), Math.max(0, code.y0 - 2), Math.min(W, code.x1 + 2), Math.min(H, code.y1 + 2)] });
  }
  for (const note of urlFootnotes) {
    add('p', note.str, bounds(note), { sourceFontSize: note.h });
    placed[placed.length - 1].footnote = true;
  }
  for (const composite of composites) {
    const figure = add('figure', '', composite.box, { figureLabel: composite.label,
      crop: [composite.box.x0, composite.box.y0, composite.box.x1, composite.box.y1] });
    const box = unionRects(composite.caption);
    add('caption', composite.caption.map(line => line.text).join(' '), box,
      { figureLabel: composite.label, parentBlockId: figure.id, sourceFontSize: composite.caption[0].size,
        textRuns: linesTextRuns(composite.caption) });
  }
  const tableBlocks = new Map<PageRegion, Block>();
  for (const region of regions) {
    if (!options.keepFigures) continue;
    const block = add(region.kind, '', region, {
      crop: [Math.max(0, region.x0 - 2), Math.max(0, region.y0 - 2), Math.min(W, region.x1 + 2), Math.min(H, region.y1 + 2)],
    });
    if (region.kind === 'table') tableBlocks.set(region, block);
  }
  for (const note of tableNotes) {
    const siblings = tableNotes.filter(candidate => candidate.table === note.table);
    const index = siblings.indexOf(note);
    const previousBottom = index > 0 ? siblings[index - 1].y1 + .1 : note.table.y1 + .5;
    const nextTop = index + 1 < siblings.length ? siblings[index + 1].y0 - .1 : H;
    add('table-note', note.text, note, {
      parentBlockId: tableBlocks.get(note.table)!.id,
      sourceFontSize: note.sourceFontSize,
      textRuns: note.textRuns,
      crop: [Math.max(0, note.x0 - 1.5), Math.max(previousBottom, note.y0 - 1.5), Math.min(W, note.x1 + 1.5), Math.min(nextTop, note.y1 + 1.5)],
    });
    // A short continuation of a full-width table note must not fall into the left column.
    placed[placed.length - 1].column = columnFor(note.table);
  }
  for (const eq of equations)
    add('math', eq.text, eq, {
      crop: [eq.x0, eq.y0, eq.x1, Math.min(H, eq.y1)],
      eqNo: eq.eqNo ?? undefined,
      eqNoInCrop: !!eq.eqNo,
      sourceFontSize: body,
      recognitionCrop: eq.recognitionCrop,
      nativeLatex: eq.nativeLatex,
      structureWarnings: eq.structureWarnings,
    });
  const equationItems = new Set(equations.flatMap(eq => eq.items));
  const excluded = options.keepFigures ? [...regions, ...plates.map(plate => plate.image)] : [];
  let remaining = items.filter(it => !equationItems.has(it) && !tableNoteItems.has(it) && !plateItems.has(it) && !excluded.some(r => centerInside(it, r)));
  // Recover full-width title/author rows before dividing into columns.
  const fullRows = toLines(remaining, Math.max(12, body * 1.2), gutter);
  const spans = gutter === null ? [] : fullRows.filter(l => l.items.some(it => it.str.trim() && it.x < gutter - 2 && it.x + it.w > gutter + 2));
  for (const line of [...spans])
    if (parseCaption(line.text)) {
      let prev = line;
      for (const next of fullRows.filter(l => l.y > line.y).sort((a, b) => a.y - b.y)) {
        if (next.y - prev.y <= line.size * .2 || next.y - prev.y > line.size * 1.75 ||
          next.x0 < line.x0 - line.size || next.x0 > line.x0 + line.size * 1.5 ||
          next.x1 > line.x1 + line.size * 1.5 || Math.abs(next.size - line.size) > 1 ||
          parseCaption(next.text) || lineKind(next, body, pageNumber) !== 'p')
          break;
        if (!spans.includes(next))
          spans.push(next);
        prev = next;
      }
    }
  const spanItems = new Set(spans.flatMap(l => l.items));
  remaining = remaining.filter(it => !spanItems.has(it));
  const streams = gutter === null ? [{ column: 0, items: remaining }] : [
    { column: 0, items: remaining.filter(it => it.x + it.w / 2 < gutter) },
    { column: 1, items: remaining.filter(it => it.x + it.w / 2 >= gutter) },
    { column: -1, items: [...spanItems] },
  ];
  const referenceState = { active: false };
  for (const stream of streams) {
    const lines = toLines(stream.items);
    identifyPublicationHeaders(lines, H, pageNumber);
    if (pageNumber === 1) identifyFrontMatter(lines, body, H);
    const ordinary: Line[] = [];
    const flush = () => {
      for (const p of paragraphs(ordinary, body, pageNumber, referenceState)) {
        add(p.kind, p.text, p, { sourceFontSize: p.size, textRuns: p.textRuns, readingRole: p.readingRole });
        const current = placed[placed.length - 1];
        current.column = stream.column;
        current.footnote = p.kind === 'p' && p.size < body * .9 && p.y0 > H * .72 &&
          /supported|corresponding author|authors? (?:are|is)|\b(?:is|are) with\b|university|institute|e-mail|基金|作者|通讯|\bcolor versions? of\b|\bdigital object identifier\b/i.test(p.text);
      }
      ordinary.length = 0;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const label = parseCaption(line.text);
      const relatedVisual = label && [...figures, ...tables, ...codeFigures].some(region =>
        (label.kind === 'table' ? tables.includes(region as PageRegion) : !tables.includes(region as PageRegion)) &&
        xOverlap(line, region) > Math.min(line.x1 - line.x0, region.x1 - region.x0) * .35 &&
        (line.y0 >= region.y1 - 3 && line.y0 - region.y1 < body * 5 ||
          label.kind === 'table' && region.y0 >= line.y1 && region.y0 - line.y1 < body * 5));
      const proseReference = label && /^(?:shows?|illustrates?|depicts?|presents?|compares?|demonstrates?|is|are|was|were|provides?|gives?|summarizes?|describes?|can|has|have)\b/i.test(label.text);
      const caption = label && !proseReference && (!label.text || label.hasDelimiter || relatedVisual);
      if (!caption) {
        ordinary.push(line);
        continue;
      }
      flush();
      const parts = [line];
      while (i + 1 < lines.length) {
        const next = lines[i + 1], last = parts[parts.length - 1];
        if (parseCaption(next.text) || lineKind(next, body, pageNumber) !== 'p' || next.y - last.y > line.size * 1.75 || Math.abs(next.size - line.size) > 1 || next.x0 > line.x1 || next.x1 < line.x0)
          break;
        parts.push(next);
        i++;
      }
      const box = unionRects(parts);
      add('caption', parts.map(p => p.text).join(' '), box, { sourceFontSize: line.size, textRuns: linesTextRuns(parts) });
      placed[placed.length - 1].column = stream.column;
    }
    flush();
  }
  // Bind vector figures before sorting, just like bitmap plates. Otherwise a
  // caption near the top of the right column can interrupt left-column prose.
  const captionsByFigure = new Map<Placed, Placed>();
  for (const entry of placed) {
    if (entry.block.kind !== 'caption') continue;
    if (entry.block.parentBlockId) {
      const parent = placed.find(candidate => candidate.block.id === entry.block.parentBlockId);
      if (parent) captionsByFigure.set(parent, entry);
      continue;
    }
    const label = parseCaption(entry.block.text);
    if (label?.kind !== 'figure') continue;
    const figure = placed.filter(candidate => candidate.block.kind === 'figure' &&
      !captionsByFigure.has(candidate) && candidate.column === entry.column &&
      candidate.box.y1 <= entry.box.y0 + 3 && entry.box.y0 - candidate.box.y1 < 55 &&
      xOverlap(candidate.box, entry.box) >= Math.min(candidate.box.x1 - candidate.box.x0,
        entry.box.x1 - entry.box.x0) * .6)
      .sort((a, b) => b.box.y1 - a.box.y1)[0];
    if (!figure) continue;
    figure.block.figureLabel = label.label;
    entry.block.figureLabel = label.label;
    entry.block.parentBlockId = figure.block.id;
    captionsByFigure.set(figure, entry);
  }
  const linkedCaptions = new Set(captionsByFigure.values());
  const reading = placed.filter(entry => !linkedCaptions.has(entry)).map(entry => {
    const caption = captionsByFigure.get(entry);
    const entries = caption ? [entry, caption] : [entry];
    return { entries, box: unionRects(entries.map(part => part.box)),
      column: entry.column, footnote: entry.footnote };
  });
  // Aligned plate cells share one reading unit; single-column plates stay in-column.
  for (const row of groupFigurePlateRows(plates)) {
    const entries: Placed[] = [];
    for (const plate of row) {
      const figure = add('figure', '', plate.image, {
        crop: plate.crop,
        figureLabel: plate.figureLabel,
      });
      entries.push(placed[placed.length - 1]);
      add('caption', plate.caption.text, plate.caption, {
        parentBlockId: figure.id,
        figureLabel: plate.figureLabel,
        sourceFontSize: plate.caption.size,
        textRuns: plate.caption.textRuns,
      });
      entries.push(placed[placed.length - 1]);
    }
    const box = unionRects(entries.map(entry => entry.box));
    reading.push({ entries, box, column: columnFor(box), footnote: false });
  }
  const footnotes = reading.filter(unit => unit.footnote);
  const main = reading.filter(unit => !unit.footnote);
  const sorted: typeof reading = [];
  if (gutter === null)
    sorted.push(...main.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0));
  else {
    // A full-width block separates reading bands. Each band reads left column then right column.
    const span = main.filter(p => p.column === -1).sort((a, b) => a.box.y0 - b.box.y0);
    let rest = main.filter(p => p.column !== -1);
    const flush = (limit: number) => {
      const band = rest.filter(p => p.box.y0 < limit);
      rest = rest.filter(p => p.box.y0 >= limit);
      sorted.push(...band.sort((a, b) => a.column - b.column || a.box.y0 - b.box.y0));
    };
    for (const p of span) {
      // A full-width visual occupies its whole vertical band. Content below it
      // is ordered after the figure even if its baseline overlaps a tall panel.
      flush(p.entries[0].block.kind === 'figure' ? p.box.y1 : p.box.y0);
      sorted.push(p);
    }
    flush(Infinity);
  }
  sorted.push(...footnotes.sort((a, b) => a.box.y0 - b.box.y0));
  const ordered = sorted.flatMap(unit => unit.entries);

  return orderFloatingContent(ordered.map(entry => entry.block)).map((block, ord) => ({ ...block, ord }));
}

export async function analyzeDocument(pdf: PDFDocumentProxy, paperId: string, options: AnalyzeOptions): Promise<Block[]> {
  const blocks: Block[] = [];
  const pageHeights = new Map<number, number>();
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    pageHeights.set(p, page.getViewport({ scale: 1 }).height);
    try {
      blocks.push(...await analyzePage(page, p, paperId, { ...options, documentPageCount: pdf.numPages }));
    }
    catch (error) {
      throw new Error(`第 ${p} 页解析失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    finally {
      page.cleanup();
    }
    options.onProgress?.(p, pdf.numPages);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  identifyRepeatedPublicationHeaders(blocks, pageHeights);
  const result = blocks.map((block, ord) => ({ ...block, ord }));
  classifyReadingRoles(result, pdf.numPages);
  classifyReferences(result);
  return result;
}
