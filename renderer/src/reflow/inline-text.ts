import type { TextRun } from '@shared/types';
import type { RawItem } from './analyze';
import { MATH_EXTENSION_FONT } from './math-fonts';

export interface InlineLine { items: RawItem[]; y: number; size: number }

function append(runs: TextRun[], text: string, style: Omit<TextRun, 'text'> = {}) {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && last.script === style.script && last.italic === style.italic && last.bold === style.bold &&
    !last.mathPosition && !style.mathPosition)
    last.text += text;
  else runs.push({ text, ...style });
}

const extensionOperator = (item: RawItem) => MATH_EXTENSION_FONT.test(item.font) && /^[∫∑∏]$/.test(item.str.trim());

const ACCENT = /^[\u0300-\u036f\u20ddˆ˙¯˜]+$/;

/**
 * PDF.js emits synthetic " " items across font switches (e.g., Small Caps `I` + `NTRODUCTION`,
 * `-G` + `RAINED`, or subscripts `I` + `i`, `act` + `,`) even when the true page-point gap
 * between the adjacent ink items is <= 0.55pt. Share the exact threshold and filter between
 * `joinItems` and `lineTextRuns` so `block.textRuns` always matches `block.text`.
 */
export function spaceThreshold(prevInk: RawItem | null, nextInk: RawItem): number {
  if (prevInk && Math.abs(nextInk.y - prevInk.y) <= 1.5) {
    if ((/(?:^|[\s(\-/])[A-Z]$/.test(prevInk.str) && /^[A-Z]/.test(nextInk.str) &&
        nextInk.h >= prevInk.h * .68 && nextInk.h <= prevInk.h * .88) ||
        (/[A-Z]$/.test(prevInk.str) && /^-[A-Z]/.test(nextInk.str)))
      return Math.max(1.2, prevInk.h * .20);
    if (/^[.,;:!?)]/.test(nextInk.str.trim()))
      return Math.max(1.2, Math.max(prevInk.h, nextInk.h) * .20);
  }
  return Math.max(.5, nextInk.h * .13);
}

export function filterSubSpaceItems(sorted: RawItem[]): RawItem[] {
  return sorted.filter((it, idx) => {
    if (/\S/.test(it.str)) return true;
    let prev: RawItem | null = null;
    for (let k = idx - 1; k >= 0; k--) {
      if (/\S/.test(sorted[k].str)) { prev = sorted[k]; break; }
    }
    let next: RawItem | null = null;
    for (let k = idx + 1; k < sorted.length; k++) {
      if (/\S/.test(sorted[k].str)) { next = sorted[k]; break; }
    }
    if (!prev || !next) return false;
    return next.x - (prev.x + prev.w) > spaceThreshold(prev, next);
  });
}

/** Keep canonical source text, with independent geometry for overlapping scripts. */
export function lineTextRuns(line: InlineLine, tableMarker = false): TextRun[] {
  const runs: TextRun[] = [];
  const ordered = filterSubSpaceItems([...line.items].sort((a, b) => a.x - b.x));
  const scripts = new Map<RawItem, 'sub' | 'sup'>();
  for (const item of ordered) {
    const marker = tableMarker && item === ordered.find(it => it.str.trim()) && /^(?:[*∗†‡§¶]|notes?\s*[:.]|注\s*[:：])/i.test(item.str.trim());
    if (!marker && item.str.trim() && !ACCENT.test(item.str.trim()) && item.h < line.size * .88 && item.h >= line.size * .3) {
      if (item.y - line.y > line.size * .08) scripts.set(item, 'sub');
      else if (line.y - item.y > line.size * .10) scripts.set(item, 'sup');
    }
  }
  const roots = ordered.filter(item => item.str.trim() && !scripts.has(item) && !ACCENT.test(item.str.trim()) &&
    (extensionOperator(item) || Math.abs(item.y - line.y) < line.size * .3));
  const hosts = new Map<RawItem, RawItem>();
  for (const item of ordered.filter(it => scripts.has(it) || ACCENT.test(it.str.trim()))) {
    const accent = ACCENT.test(item.str.trim());
    const candidates = roots.filter(root => accent
      ? (item.str === '̸' ? /[=<>]$/.test(root.str.trim()) : /[\p{L}\p{N}]$/u.test(root.str.trim())) &&
        item.x + item.w >= root.x - line.size * .3 && item.x <= root.x + root.w + line.size * .3 && item.y <= root.y + line.size * .12
      : root.x < item.x && root.x + root.w <= item.x + line.size * .6 && item.x - root.x - root.w < line.size * 3.2);
    const host = candidates.sort((a, b) => accent
      ? Math.abs(item.x - (a.x + a.w / 2)) - Math.abs(item.x - (b.x + b.w / 2))
      : b.x + b.w - a.x - a.w)[0];
    if (host) hosts.set(item, host);
    else {
      const previous = ordered.filter(it => hosts.has(it) && it.x <= item.x &&
        item.x - it.x - it.w < line.size * .85 && Math.abs(it.y - item.y) < line.size * .5)
        .sort((a, b) => b.x + b.w - a.x - a.w)[0];
      if (previous) hosts.set(item, hosts.get(previous)!);
    }
  }
  // Simple one-script runs already render faithfully with sub/sup. Introduce a
  // spatial group only where two baselines overlap or a nested/accented script
  // cannot be expressed by that linear representation.
  const groups = new Map<RawItem, { id: string; x: number; suffix: string; prefix: string; width: number }>();
  for (const root of roots) {
    const children = ordered.filter(it => hosts.get(it) === root);
    if (!children.length) continue;
    const overlap = children.some((a, index) => children.slice(index + 1).some(b =>
      Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) + .1 && Math.abs(a.y - b.y) > line.size * .12));
    const nested = children.some(it => it.h < line.size * .56);
    if (!overlap && !nested && !children.some(it => ACCENT.test(it.str.trim()))) continue;
    const suffix = root.str.match(/(?:[A-Za-zα-ωΑ-Ω]|\d+|[^\s])$/u)?.[0] ?? root.str;
    const prefix = root.str.slice(0, root.str.length - suffix.length);
    const width = prefix ? Math.min(root.w, [...suffix].length * root.h * .5) : root.w;
    groups.set(root, { id: `${line.y.toFixed(3)}:${root.x.toFixed(3)}`, x: root.x + root.w - width, suffix, prefix, width });
  }
  let end = -Infinity;
  let prevInk: RawItem | null = null;
  for (const item of ordered) {
    const previous = runs.at(-1)?.text ?? '';
    if (runs.length && /\S/.test(item.str) && item.x - end > spaceThreshold(prevInk, item) &&
      !/\s$/.test(previous) && !/^\s/.test(item.str)) append(runs, ' ');
    const style: Omit<TextRun, 'text'> = {};
    if (scripts.has(item)) style.script = scripts.get(item);
    if (item.italic) style.italic = true;
    if (item.bold) style.bold = true;
    const root = hosts.get(item) ?? item, group = groups.get(root);
    const geometry = (x: number, width: number): NonNullable<TextRun['mathPosition']> => ({
      group: group!.id, x: (x - group!.x) / line.size, y: extensionOperator(item) ? 0 : (item.y - line.y) / line.size,
      width: width / line.size, size: item.h / line.size,
    });
    const parts = group && item === root ? [{ text: group.prefix, spatial: false }, { text: group.suffix, spatial: true }]
      : [{ text: item.str, spatial: !!group }];
    for (const chunk of parts) {
      let normalized = '';
      for (const part of chunk.text.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          const previous = normalized || runs.at(-1)?.text || '';
          if (previous && !/\s$/.test(previous)) normalized += ' ';
        } else normalized += part;
      }
      if (chunk.spatial) append(runs, normalized, { ...style,
        mathPosition: geometry(item === root ? group!.x : item.x, item === root ? group!.width : item.w) });
      else {
        for (const part of normalized.split(/(\s+)/)) {
          if (part) append(runs, part, /^\s+$/.test(part) ? {} : style);
        }
      }
    }
    end = Math.max(end, item.x + item.w);
    if (/\S/.test(item.str)) prevInk = item;
  }
  while (runs.length && /\s$/.test(runs.at(-1)!.text)) {
    const last = runs.at(-1)!;
    last.text = last.text.trimEnd();
    if (!last.text) runs.pop();
  }
  // PDF whitespace can sit between overlapping superscript glyphs in the
  // canonical sequence. Keep that source space in the same spatial wrapper,
  // without giving it an extra visual advance or breaking the shared host.
  for (const group of groups.values()) {
    const indices = runs.flatMap((run, index) => run.mathPosition?.group === group.id ? [index] : []);
    if (!indices.length) continue;
    for (let index = indices[0]; index <= indices.at(-1)!; index++) {
      const run = runs[index];
      if (!run.mathPosition && /^\s+$/.test(run.text)) run.mathPosition = {
        group: group.id, x: 0, y: 0, width: 0, size: 1,
      };
    }
  }
  return runs;
}

/** Join after the caller has chosen paragraph whitespace/dehyphenation semantics. */
export function joinTextRuns(left: TextRun[], right: TextRun[], joinedText: string): TextRun[] {
  const rightText = right.map(run => run.text).join('');
  const prefix = joinedText.slice(0, joinedText.length - rightText.length);
  const result: TextRun[] = [];
  let offset = 0;
  for (const { text, ...style } of left) {
    const kept = text.slice(0, Math.max(0, prefix.length - offset));
    append(result, kept, style);
    offset += text.length;
  }
  if (prefix.length > offset) append(result, prefix.slice(offset));
  for (const { text, ...style } of right) append(result, text, style);
  return result;
}

export function linesTextRuns(lines: InlineLine[], tableMarker = false): TextRun[] {
  return lines.reduce<TextRun[]>((runs, line) => {
    const next = lineTextRuns(line, tableMarker);
    return runs.length ? joinTextRuns(runs, next, `${runs.map(run => run.text).join('')} ${next.map(run => run.text).join('')}`) : next;
  }, []);
}
