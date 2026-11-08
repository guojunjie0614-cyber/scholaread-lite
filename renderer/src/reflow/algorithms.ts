import type { RawItem } from './analyze';
import type { Drawing, Rect } from './regions';
import { parseCaption } from './captions';

export interface AlgorithmRegion extends Rect {
  label: string;
  /** Search/AI material is retained independently from the faithful displayed crop. */
  text: string;
}
interface TextLine extends Rect { text: string; }
const NUMBER = /^\s*(\d+)\s*[:.)：]?\s+/;
const CONTROL = /^\s*(?:\d+\s*[:.)：]?\s*)?(?:for|while|if|else|end|return|repeat|until)\b/i;
const ALGORITHM_HEADING = /^(?:Algorithm|算法)\s*\d+(?:[.:：]|\s)/i;
const SECTION_HEADING = /^(?:[IVXLCDM]+\.\s+|[A-Z]\.\s+|\d+(?:\.\d+)+\.?\s+)|^(?:results?|discussion|conclusions?|references|appendix|实验|结果|讨论|结论|参考文献|附录)$/i;
const IO = /^\s*(?:Inputs?|Outputs?|Require|Ensure)\b|^\s*(?:输入|输出)\s*[:：]/i;

function crossesContentBoundary(lines: TextLine[], body: number): boolean {
  return lines.some((line, index) => {
    if (!index) return false;
    if (ALGORITHM_HEADING.test(line.text) || SECTION_HEADING.test(line.text) || parseCaption(line.text)) return true;
    const gap = line.y0 - lines[index - 1].y1;
    const algorithmLine = NUMBER.test(line.text) || CONTROL.test(line.text) || IO.test(line.text) || /^\s*\/\//.test(line.text);
    return gap > body * 1.8 && !algorithmLine;
  });
}
const inside = (item: RawItem, box: Rect) => {
  const x = item.x + item.w / 2;
  const y = ((item.top ?? item.y - item.h * .82) + (item.bottom ?? item.y + item.h * .22)) / 2;
  return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
};

/** Recognize ruled algorithm panels before their line numbers can bias columns. */
export function identifyAlgorithms(
  items: RawItem[], drawings: Drawing[], body: number,
  toLines: (items: RawItem[], maxGap?: number) => TextLine[],
): AlgorithmRegion[] {
  const regions: AlgorithmRegion[] = [];
  const rules = drawings.filter(d => d.horizontal && d.x1 - d.x0 >= body * 10).sort((a, b) => a.y0 - b.y0);
  for (const top of rules) {
    // Both algorithm/algorithm2e conventions occur: title above the first rule,
    // or a title row enclosed between the top and the header separator.
    const headingBox = { ...top, y0: top.y0 - body * 2, y1: top.y1 + body * 2.5 };
    const heading = toLines(items.filter(it => inside(it, headingBox))).find(line => ALGORITHM_HEADING.test(line.text));
    if (!heading || regions.some(r => heading.x0 >= r.x0 && heading.x1 <= r.x1 && heading.y0 >= r.y0 && heading.y1 <= r.y1)) continue;
    const label = heading.text.match(/^(?:Algorithm|算法)\s*\d+/i)![0];
    const bottoms = rules.filter(rule => rule.y0 > heading.y1 + body * 3 &&
      Math.abs(rule.x0 - top.x0) < 3 && Math.abs(rule.x1 - top.x1) < 3);
    for (const bottom of bottoms) {
      const box = { x0: top.x0, y0: Math.min(top.y0, heading.y0), x1: top.x1, y1: bottom.y1 };
      const own = items.filter(it => inside(it, box));
      const lines = toLines(own);
      // Never use an unrelated later rule to swallow intervening prose/sections.
      if (crossesContentBoundary(lines, body)) break;
      if (!lines.length || bottom.y0 - lines[lines.length - 1].y1 > body * 2) continue;
      const text = lines.map(line => line.text).join('\n');
      const inputs = /\b(?:Inputs?|Require)\s*[:：]|输入\s*[:：]/i.test(text);
      const outputs = /\b(?:Outputs?|Ensure)\s*[:：]|输出\s*[:：]/i.test(text);
      const controls = lines.filter(line => CONTROL.test(line.text)).length;
      const numbers = lines.flatMap(line => { const match = NUMBER.exec(line.text); return match ? [Number(match[1])] : []; });
      const orderedSteps = numbers.length >= 3 && numbers[0] <= 2 && numbers.every((n, i) => !i || n > numbers[i - 1]);
      if (!(orderedSteps && (inputs || outputs || controls) || inputs && outputs && controls >= 2 || controls >= 3)) continue;
      regions.push({ ...box, label, text });
      break;
    }
  }
  // A heading plus pseudocode structure is sufficient evidence; horizontal
  // rules are a visual convention, not a requirement for an algorithm.
  const pageLines = toLines(items, body * 3);
  const left = Math.min(...pageLines.map(line => line.x0)), right = Math.max(...pageLines.map(line => line.x1));
  const middle = (left + right) / 2;
  for (const heading of pageLines.filter(line => ALGORITHM_HEADING.test(line.text))) {
    if (regions.some(region => heading.y0 >= region.y0 && heading.y1 <= region.y1 && heading.x0 >= region.x0 - 2 && heading.x1 <= region.x1 + 2)) continue;
    const otherColumn = pageLines.filter(line => line.x0 > middle && line.x1 > middle + body * 5).length >= 4;
    const x0 = Math.max(left, heading.x0 - body * 2);
    const x1 = heading.x1 < middle && otherColumn ? middle : right;
    const lines = toLines(items.filter(item => item.x + item.w / 2 >= x0 && item.x + item.w / 2 <= x1 &&
      (item.bottom ?? item.y + item.h * .22) >= heading.y0)).filter(line => line.y0 >= heading.y0 - body * .15);
    const members: TextLine[] = [];
    let steps = 0, codeLeft = Infinity;
    for (const line of lines) {
      const previous = members.at(-1);
      if (previous && (ALGORITHM_HEADING.test(line.text) || SECTION_HEADING.test(line.text) || parseCaption(line.text) ||
        line.y0 - previous.y1 > body * 1.8)) break;
      const structured = NUMBER.test(line.text) || CONTROL.test(line.text) || IO.test(line.text);
      if (NUMBER.test(line.text)) { steps++; codeLeft = Math.min(codeLeft, line.x0); }
      // A wrapped title/input or indented mathematical continuation belongs to
      // the panel. A following prose paragraph does not, even without a rule.
      if (steps >= 3 && !structured && !/^\s*(?:\/\/|#)/.test(line.text) &&
        (line.x0 < codeLeft + body * 1.5 || /[.!?]$/.test(line.text) && (line.text.match(/[A-Za-z]{3,}/g)?.length ?? 0) >= 6)) break;
      members.push(line);
    }
    const text = members.map(line => line.text).join('\n');
    const numbers = members.flatMap(line => { const match = NUMBER.exec(line.text); return match ? [Number(match[1])] : []; });
    const ordered = numbers.length >= 3 && numbers[0] <= 2 && numbers.every((n, index) => !index || n > numbers[index - 1]);
    const controls = members.filter(line => CONTROL.test(line.text)).length;
    const inputs = members.some(line => IO.test(line.text));
    if (!(ordered && (controls > 0 || inputs) || inputs && controls >= 3)) continue;
    const box = { x0: Math.min(...members.map(line => line.x0)), y0: Math.min(...members.map(line => line.y0)),
      x1: Math.max(...members.map(line => line.x1)), y1: Math.max(...members.map(line => line.y1)) };
    regions.push({ ...box, label: heading.text.match(/^(?:Algorithm|算法)\s*\d+/i)![0], text });
  }
  return regions;
}

/** Preserve numbered source listings enclosed by rules and labelled as figures. */
export function identifyCodeFigures(
  items: RawItem[], drawings: Drawing[], body: number,
  toLines: (items: RawItem[], maxGap?: number) => TextLine[],
): AlgorithmRegion[] {
  const result: AlgorithmRegion[] = [];
  const rules = drawings.filter(d => d.horizontal && d.x1 - d.x0 >= body * 10).sort((a, b) => a.y0 - b.y0);
  for (const top of rules) {
    if (result.some(r => top.y0 >= r.y0 && top.y0 <= r.y1 && top.x0 >= r.x0 && top.x1 <= r.x1)) continue;
    for (const bottom of rules.filter(r => r.y0 > top.y0 + body * 3 && Math.abs(r.x0 - top.x0) < 3 && Math.abs(r.x1 - top.x1) < 3)) {
      const box = { x0: top.x0, y0: top.y0, x1: top.x1, y1: bottom.y1 };
      const lines = toLines(items.filter(item => inside(item, box)));
      const numbers = lines.flatMap(line => { const m = line.x0 <= top.x0 + body * 2 ? NUMBER.exec(line.text) : null; return m ? [Number(m[1])] : []; });
      if (numbers.length < 4 || numbers[0] > 2 || !numbers.every((n, i) => !i || n > numbers[i - 1])) continue;
      if (!lines.some(line => /\b(?:import|def|return|for|while|class|function)\b/.test(line.text))) continue;
      const captionBox = { x0: top.x0, x1: top.x1, y0: bottom.y1, y1: bottom.y1 + body * 5 };
      const caption = toLines(items.filter(item => inside(item, captionBox))).find(line => parseCaption(line.text)?.kind === 'figure');
      if (!caption) continue;
      result.push({ ...box, label: parseCaption(caption.text)!.label, text: lines.map(line => line.text).join('\n') });
      break;
    }
  }
  return result;
}
