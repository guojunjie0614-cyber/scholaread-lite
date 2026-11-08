import { unionRects } from './regions';
import { restoreFormula, type FormulaRule } from './formula-structure';
import { MATH_FONT, MATH_SYMBOL, MATH_EXTENSION_FONT } from './math-fonts';
export interface MathItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  font: string;
  top?: number;
  bottom?: number;
}

export interface EqRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text: string;
  eqNo: string | null;
  ratio: number;
  items: MathItem[];
  recognitionCrop?: [number, number, number, number];
  nativeLatex?: string;
  structureWarnings?: string[];
}

// Theses and books number by chapter: (4.1), (2-1).
const NUMBER = /^\(\s*\d{1,3}(?:[.\-–]\d{1,3})?[a-z]?\s*\)$/i;
interface Row {
  items: MathItem[];
  y: number;
  x0: number;
  x1: number;
  ratio: number;
  prose: boolean;
  text: string;
}

function rowsOf(items: MathItem[], body: number): Row[] {
  const rows: Row[] = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let row = rows[rows.length - 1];
    if (!row || Math.abs(row.y - item.y) > Math.max(.9, body * .14)) {
      row = { items: [], y: item.y, x0: item.x, x1: item.x + item.w, ratio: 0, prose: false, text: '' };
      rows.push(row);
    }
    row.items.push(item);
    row.x0 = Math.min(row.x0, item.x);
    row.x1 = Math.max(row.x1, item.x + item.w);
  }
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    row.text = row.items.map(x => x.str).join(' ').replace(/\s+/g, ' ').trim();
    const ink = row.items.filter(x => x.str.trim() && !NUMBER.test(x.str.trim()));
    const math = ink.filter(x => MATH_FONT.test(x.font) || MATH_SYMBOL.test(x.str));
    row.ratio = math.reduce((s, x) => s + x.w, 0) / Math.max(1, ink.reduce((s, x) => s + x.w, 0));
    // Vocabulary in a small script is not prose: “sum-weight” and “comb”
    // are ordinary Roman fonts inside perfectly valid formulae.
    const plain = ink.filter(x => !MATH_FONT.test(x.font) && x.h >= body * .85).map(x => x.str).join(' ');
    const words = plain.match(/[A-Za-z]{2,}/g) ?? [];
    // Chinese prose has no Latin words; a run of Han characters is equally decisive.
    const han = (plain.match(/[\u3400-\u9fff]/g) ?? []).length;
    row.prose = (words.length >= 2 && row.ratio < .55) ||
      (/^(where|with|for|and|thus|here|using|let)\b/i.test(plain.trim()) && row.ratio < .6) || words.length >= 4 || han >= 6;
  }
  assignScriptProse(rows, body);
  return rows;
}

function assignScriptProse(rows: Row[], body: number) {
  // Attach scripts/accents to the nearest real text baseline before deciding
  // region boundaries. A script's own English spelling never votes here.
  const baselines = rows.filter(row => row.items.some(it => it.str.trim() && it.h >= body * .85 &&
    !MATH_EXTENSION_FONT.test(it.font) && !/^[ˆ̂˙¯˜′]+$/.test(it.str.trim())));
  for (const row of rows) {
    if (baselines.includes(row)) continue;
    const host = baselines.filter(other => row.y - other.y >= -body * .9 && row.y - other.y <= body * .65 &&
      row.x0 < other.x1 + body * .5 && row.x1 > other.x0 - body * .5)
      .sort((a, b) => Math.abs(a.y - row.y) - Math.abs(b.y - row.y))[0];
    row.prose = !!host?.prose;
  }
}

interface Candidate { items: MathItem[]; anchors: MathItem[]; column: number }
const itemBounds = (it: MathItem) => {
  const extension = MATH_EXTENSION_FONT.test(it.font) && !/^[ˆ̂˙¯̸]+$/.test(it.str.trim());
  return { x0: it.x, x1: it.x + it.w,
    y0: it.top ?? (extension ? it.y : it.y - it.h * .85),
    y1: it.bottom ?? it.y + it.h * (extension ? 1.8 : .3) };
};

/** Resolve complete formula groups and unique glyph ownership before making crops. */
export function extractMathRegions(items: MathItem[], body: number, pageWidth: number, columns: Array<{
  x0: number; x1: number;
}>, obstacles: Array<{ x0: number; y0: number; x1: number; y1: number }> = [], drawings: FormulaRule[] = []): EqRegion[] {
  const cols = columns.length ? columns : [{ x0: 0, x1: pageWidth }];
  const eligible = items.filter(it => {
    const b = itemBounds(it), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    return !obstacles.some(r => cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1);
  });
  // Column bounds can overlap at a wide equation. Choose one owner, rather
  // than creating per-column copies of the very same source item.
  const owner = new Map<MathItem, number>();
  for (const it of eligible) {
    const overlap = cols.map(col => Math.max(0, Math.min(it.x + it.w, col.x1) - Math.max(it.x, col.x0)));
    let column = overlap.indexOf(Math.max(...overlap));
    if (!overlap[column]) column = cols.map(col => Math.abs((col.x0 + col.x1) / 2 - it.x - it.w / 2))
      .reduce((best, distance, index, distances) => distance < distances[best] ? index : best, 0);
    owner.set(it, column);
  }
  const candidates: Candidate[] = [];
  const proseRows: Row[] = [];
  for (const [column, col] of cols.entries()) {
    const own = eligible.filter(it => owner.get(it) === column);
    const rows = rowsOf(own, body);
    // A display number normally ends at the column edge. When the gutter is not detected
    // (e.g. the other column is one tall figure) accept a number that ends its own
    // relation row after a wide blank run instead.
    const spacedRowEnd = (it: MathItem) => rows.some(row => {
      const ink = row.items.filter(other => other.str.trim());
      const index = ink.indexOf(it);
      return index > 0 && index === ink.length - 1 && /[=∈<>≤≥≈]/.test(row.text) &&
        it.x - Math.max(...ink.slice(0, index).map(other => other.x + other.w)) >= body * 4;
    });
    // Figure labels can widen the measured column; justified prose marks the real right margin.
    const proseRights = rows.filter(row => row.prose && row.x1 - row.x0 > (col.x1 - col.x0) * .5).map(row => row.x1).sort((a, b) => a - b);
    const textRight = proseRights.length >= 3 ? proseRights[Math.floor(proseRights.length / 2)] : col.x1;
    const anchors = own.filter(it => NUMBER.test(it.str.trim()) && it.h > body * .75 &&
      (Math.abs(it.x + it.w - col.x1) < Math.max(9, body) || Math.abs(it.x + it.w - textRight) < Math.max(9, body) || spacedRowEnd(it)));
    for (const row of rows) {
      if (row.items.some(it => anchors.includes(it)) && /[=∈<>≤≥≈]/.test(row.text)) row.prose = false;
    }
    // Roman words in fraction numerators (e.g. “Exec. Time”) need structural,
    // not vocabulary, evidence. A nearby numbered fraction provides it.
    for (const anchor of anchors) {
      for (const rule of drawings.filter(rule => rule.y1 - rule.y0 < 1.6 && rule.x1 - rule.x0 > body &&
        rule.x0 >= col.x0 && rule.x1 <= col.x1 && Math.abs((rule.y0 + rule.y1) / 2 - anchor.y) < body * 2)) {
        for (const row of rows.filter(row => row.x0 >= rule.x0 - 1 && row.x1 <= rule.x1 + 1 &&
          Math.abs(row.y - rule.y0) < body * 1.1)) row.prose = false;
      }
    }
    assignScriptProse(rows, body);
    proseRows.push(...rows.filter(row => row.prose));
    const groups: Row[][] = [];
    // A lone "(4.2)" beside an equation pasted as a picture numbers that picture; joining it
    // to the formula above would duplicate part of the picture in a second crop.
    const pictureNumber = (row: Row) => {
      const ink = row.items.filter(it => it.str.trim());
      return ink.length > 0 && ink.every(it => NUMBER.test(it.str.trim())) &&
        obstacles.some(r => r.y0 <= row.y && r.y1 >= row.y && r.x1 <= ink[0].x + 1);
    };
    for (const row of rows) {
      if (row.prose || !row.items.some(it => it.str.trim()) || pictureNumber(row)) continue;
      const previous = groups.at(-1)?.at(-1);
      const previousIndex = previous ? rows.indexOf(previous) : -2;
      const weakNumber = (r: Row) => /^\d{1,4}$/.test(r.text) && r.ratio < .2;
      const gapLimit = previous && (weakNumber(row) || weakNumber(previous)) ? body * .9 : body * 2.1;
      if (previous && rows.indexOf(row) === previousIndex + 1 && row.y - previous.y <= gapLimit)
        groups.at(-1)!.push(row);
      else groups.push([row]);
    }
    for (const group of groups) {
      const selected = group.flatMap(row => row.items);
      const numbers = anchors.filter(anchor => selected.includes(anchor));
      const first = rows.indexOf(group[0]), last = rows.indexOf(group.at(-1)!);
      const isolated = !(rows[first - 1]?.prose && group[0].y - rows[first - 1].y < body * 1.1) &&
        !(rows[last + 1]?.prose && rows[last + 1].y - group.at(-1)!.y < body * 1.1);
      const display = group.some(row => row.ratio >= .65 && MATH_SYMBOL.test(row.text) &&
        row.x0 - col.x0 >= body * .9 && col.x1 - row.x1 >= body * .9);
      if (!numbers.length && !(display && isolated)) continue;
      if (!selected.some(it => MATH_SYMBOL.test(it.str)) && selected.filter(it => MATH_FONT.test(it.font)).length < 2) continue;
      candidates.push({ items: selected, anchors: numbers, column });
    }
  }
  // A wide display can cross the gutter (including its equation number).
  // Merge only touching, vertically overlapping math candidates; ordinary
  // left/right column equations retain independent reading order.
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if (a.column === b.column) continue;
      const ab = unionRects(a.items.filter(it => it.str.trim()).map(itemBounds)), bb = unionRects(b.items.filter(it => it.str.trim()).map(itemBounds));
      const vertical = Math.min(ab.y1, bb.y1) - Math.max(ab.y0, bb.y0);
      const horizontalGap = Math.max(0, ab.x0 - bb.x1, bb.x0 - ab.x1);
      if (vertical <= body * .25 || horizontalGap > body * .4) continue;
      a.items.push(...b.items);
      a.anchors.push(...b.anchors);
      a.column = -1;
      candidates.splice(j--, 1);
    }
  }
  return candidates.map(candidate => {
    const selected = candidate.items;
    const box = unionRects(selected.filter(it => it.str.trim()).map(itemBounds)), pad = body * .55;
    // Prose constrains only whitespace padding, never the member envelope.
    // Conflicting font estimates therefore cannot invert or clip a crop.
    const prose = proseRows.filter(row => row.x0 < box.x1 && row.x1 > box.x0);
    const first = Math.min(...selected.map(it => it.y)), last = Math.max(...selected.map(it => it.y));
    const before = prose.filter(row => row.y < first).flatMap(row => row.items).filter(it => it.str.trim()).map(it => itemBounds(it).y1);
    const after = prose.filter(row => row.y > last).flatMap(row => row.items).filter(it => it.str.trim()).map(it => itemBounds(it).y0);
    const cropTop = Math.max(0, box.y0 - pad, Math.min(box.y0, before.length ? Math.max(...before) + 1.2 : 0));
    const cropBottom = Math.max(box.y1, Math.min(box.y1 + pad, after.length ? Math.min(...after) - 1.2 : Infinity));
    const cropLeft = Math.max(0, box.x0 - pad), cropRight = Math.min(pageWidth, box.x1 + pad);
    const bodyItems = selected.filter(it => !candidate.anchors.includes(it) && it.str.trim());
    const bodyLeft = Math.min(...bodyItems.map(it => it.x)), bodyRight = Math.max(...bodyItems.map(it => it.x + it.w));
    const anchor = candidate.anchors.length === 1 ? candidate.anchors[0] : null;
    const recognitionCrop: EqRegion['recognitionCrop'] = anchor && bodyRight < anchor.x - 2
      ? [Math.max(0, bodyLeft - pad), cropTop, Math.min(anchor.x - 1, bodyRight + pad), cropBottom] : undefined;
    const structure = candidate.anchors.length > 1 ? { latex: undefined, warnings: ['Multiple numbered equations share this faithful source region; recognize them together.'] }
      : restoreFormula(bodyItems, drawings.filter(r => r.x0 >= box.x0 - 1 && r.x1 <= box.x1 + 1 && r.y0 >= cropTop && r.y1 <= cropBottom), body);
    const math = selected.filter(it => MATH_FONT.test(it.font) || MATH_SYMBOL.test(it.str));
    return { x0: cropLeft, y0: cropTop, x1: cropRight, y1: cropBottom, recognitionCrop,
      nativeLatex: structure.latex, structureWarnings: structure.warnings.length ? structure.warnings : undefined,
      items: selected, text: rowsOf(selected, body).map(row => row.text).join(' '),
      eqNo: candidate.anchors.map(it => it.str.trim()).join(', ') || null,
      ratio: math.reduce((sum, it) => sum + it.w, 0) / Math.max(1, selected.reduce((sum, it) => sum + it.w, 0)) };
  }).filter(region => Number.isFinite(region.x0 + region.y0 + region.x1 + region.y1) &&
    region.x1 > region.x0 && region.y1 > region.y0)
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}
