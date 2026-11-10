import type { Block } from '@shared/types';

interface FrontLine {
  text: string; y: number; size: number; bold: boolean;
  x0: number; x1: number;
  readingRole?: Block['readingRole'];
}

const ISSCC_HEADER = /^ISSCC\s+20\d{2}\s*(?:\/\s*SESSION\s+\d+\b.*|\/\s*(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2}\s*\/\s*\d{1,2}:\d{2}\s*(?:AM|PM)|PAPER CONTINUATIONS AND REFERENCES)$/i;
const PUBLICATION = /^(?:\d{1,4}\s+)?(?:IEEE TRANSACTIONS|IEEE JOURNAL|PROCEEDINGS OF)\b.*(?:\bVOL\.|\b20\d{2}\b)/i;
const JOURNAL_LABEL = /^IEEE (?:[A-Z][A-Z-]*\s+){1,12}JOURNAL(?:\s+\d{1,4})?$/i;
const ACCEPTANCE_NOTICE = /^This article has been accepted for publication\b|^This is the author['’]s version\b|^Citation information:\s*DOI\b/i;
const RIGHTS_NOTICE = /^(?:but\s+)?republication\s*\/\s*redistribution requires\b|^(?:©|copyright\b|all rights reserved\b)|^For more information,? see https?:\/\/(?:www\.)?creativecommons\.org\/licenses\//i;
const RUNNING_TITLE = /^(?:\d{1,4}\s+)?[\p{Lu}][\p{L}.'’\- ]{1,55}\s+et al\.\s*:\s*(.{20,})(?:\s+\d{1,4})?$/u;
const BODY_START = /^(?:(?:[IVX]+|\d+)\.?\s+)?(?:(?:abstract|introduction|background|keywords|index terms)\b|摘要|引言)/i;
const AFFILIATION = /\b(?:university|institute|department|laborator(?:y|ies)|school of|academy|college|research center|compan(?:y|ies)|corporation|corp\.?|ltd\.?|inc\.?|gmbh)\b|大学|研究所|学院/i;

function horizontalNoticeOverlap(a: { x0: number; x1: number }, b: { x0: number; x1: number }): boolean {
  const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  return overlap > Math.min(a.x1 - a.x0, b.x1 - b.x0) * .6;
}

/** Publication furniture is a whole margin region, including centered wrapped lines. */
export function identifyPublicationHeaders(lines: FrontLine[], height: number, page = 1): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const topNotice = line.y < height * .055 && ACCEPTANCE_NOTICE.test(line.text);
    const bottomNotice = line.y > height * .93 && RIGHTS_NOTICE.test(line.text);
    if (topNotice || bottomNotice || line.y < height * .09 &&
      (ISSCC_HEADER.test(line.text) || PUBLICATION.test(line.text) || JOURNAL_LABEL.test(line.text) ||
        /^NATURE COMMUNICATIONS\s*\|/i.test(line.text) || /^ARTICLE$/.test(line.text) ||
        page > 1 && isRunningTitle(line.text))) line.readingRole = 'publication';
    if (!topNotice && !bottomNotice) continue;
    // Successive banner lines are often independently centered. Their left
    // edges need not align; the common band, font and horizontal region do.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j], previous = lines[j - 1];
      if ((topNotice ? next.y >= height * .055 : next.y <= height * .93) ||
        next.y - previous.y > line.size * 1.8 || Math.abs(next.size - line.size) > .8 ||
        !horizontalNoticeOverlap(line, next)) break;
      next.readingRole = 'publication';
    }
  }
}

function isRunningTitle(text: string): boolean {
  const title = RUNNING_TITLE.exec(text)?.[1];
  if (!title) return false;
  const letters = title.replace(/[^\p{L}]/gu, '');
  return letters.length > 16 && letters.replace(/[^\p{Lu}]/gu, '').length / letters.length > .8;
}

/** Classify repeated margin furniture without deleting source blocks or body footnotes. */
export function identifyRepeatedPublicationHeaders(blocks: Block[], pageHeights: ReadonlyMap<number, number>): void {
  const repeated = new Map<string, Set<number>>();
  const candidates: Block[] = [];
  for (const block of blocks) {
    const height = pageHeights.get(block.page);
    if (!height || !block.bbox || block.kind !== 'p' || block.readingRole) continue;
    const top = block.bbox[1] < height * .09;
    if (top && (ACCEPTANCE_NOTICE.test(block.text) || block.page > 1 && isRunningTitle(block.text)) ||
      block.bbox[1] > height * .93 && RIGHTS_NOTICE.test(block.text)) {
      block.readingRole = 'publication';
      continue;
    }
    // Repetition is supporting evidence only in the physical margin, never in
    // the ordinary footer/footnote band or in a recurring body sentence.
    if (block.text.length > 160 || block.bbox[3] - block.bbox[1] > 22 ||
      !(block.bbox[3] < height * .065 || block.bbox[1] > height * .95) ||
      !/^[\p{Lu}\d\s.,:;()/'’|—–-]+$/u.test(block.text)) continue;
    const key = block.text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
    const pages = repeated.get(key) ?? new Set<number>();
    pages.add(block.page); repeated.set(key, pages);
    candidates.push(block);
  }
  // A stream boundary may split a centered publisher banner into multiple
  // blocks. Resolve its complete physical region before reading projection.
  for (const seed of blocks) {
    const height = pageHeights.get(seed.page);
    if (!height || !seed.bbox || seed.readingRole !== 'publication' ||
      !(ACCEPTANCE_NOTICE.test(seed.text) || RIGHTS_NOTICE.test(seed.text))) continue;
    const top = seed.bbox[1] < height * .055;
    let edge = seed.bbox[3];
    const nearby = blocks.filter(block => block.page === seed.page && block.bbox && !block.readingRole && block.kind === 'p')
      .sort((a, b) => a.bbox![1] - b.bbox![1]);
    for (const block of nearby) {
      const box = block.bbox!;
      if (box[1] < seed.bbox[1] || (top ? box[3] >= height * .055 : box[1] <= height * .93) ||
        box[1] - edge > (seed.sourceFontSize ?? 6) * 1.8 || box[3] - box[1] > 18 ||
        !horizontalNoticeOverlap({ x0: seed.bbox[0], x1: seed.bbox[2] }, { x0: box[0], x1: box[2] })) continue;
      block.readingRole = 'publication';
      edge = Math.max(edge, box[3]);
    }
  }
  for (const block of candidates) {
    const key = block.text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
    if (repeated.get(key)!.size >= Math.max(2, Math.ceil(pageHeights.size * .4))) block.readingRole = 'publication';
  }
  identifyRepeatedMarginLines(blocks, pageHeights);
}

/**
 * Theses and Chinese journals put running heads ("XX大学硕士学位论文", "第 2 章 …") and
 * page numbers ("- 11 -") well inside the physical margin band above, and the uppercase
 * filter there never admits CJK. Evidence here is narrower than mere repetition (which
 * must not hide a recurring Latin body line or footnote): a bare page-number pattern, or
 * a short CJK line without sentence-final punctuation, in the same slot on ≥3 pages.
 */
function identifyRepeatedMarginLines(blocks: Block[], pageHeights: ReadonlyMap<number, number>): void {
  const groups = new Map<string, Block[]>();
  for (const block of blocks) {
    const height = pageHeights.get(block.page);
    if (!height || !block.bbox || block.readingRole || !['p', 'li', 'h2', 'h3'].includes(block.kind)) continue;
    const [, y0, , y1] = block.bbox;
    const text = block.text.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 60 || y1 - y0 > (block.sourceFontSize ?? 10) * 2.2) continue;
    if (!(y1 < height * .13 || y0 > height * .87)) continue;
    const pageNumber = /^[-–—\s]*(?:page\s*)?\d{1,4}(?:\s*(?:\/|of)\s*\d{1,4})?[-–—\s]*$|^第\s*\d{1,4}\s*页$/i.test(text);
    const cjkHead = /[\u3400-\u9fff]/.test(text) && !/[。．！？；.!?;，,]$/.test(text);
    if (!pageNumber && !cjkHead) continue;
    const band = y1 < height * .13 ? 'top' : 'bottom';
    const key = `${band}|${pageNumber ? '#page' : text.replace(/\d+/g, '#')}`;
    const list = groups.get(key) ?? [];
    list.push(block); groups.set(key, list);
  }
  for (const list of groups.values()) {
    const pages = new Set(list.map(block => block.page));
    if (pages.size < 3) continue;
    // Same physical slot: the median top edge, within a small tolerance.
    const tops = list.map(block => block.bbox![1]).sort((a, b) => a - b);
    const median = tops[Math.floor(tops.length / 2)];
    const aligned = list.filter(block => Math.abs(block.bbox![1] - median) <= 4);
    if (new Set(aligned.map(block => block.page)).size < 3) continue;
    for (const block of aligned) block.readingRole = 'publication';
  }
}

/** Bounded to the first page's opening typography; ordinary body prose never becomes metadata. */
export function identifyFrontMatter(lines: FrontLine[], body: number, height: number): void {
  const start = lines.findIndex(line => !line.readingRole && line.text.trim());
  if (start < 0) return;
  const first = lines[start];
  if (first.y > height * .23 || first.text.length < 24 || BODY_START.test(first.text) ||
    !(first.size >= body * 1.5 || (first.bold && first.size >= body * 1.18))) return;
  let end = start;
  first.readingRole = 'title';
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i], previous = lines[i - 1];
    if (line.y - previous.y > first.size * 1.9 || Math.abs(line.size - first.size) > .8 ||
      line.bold !== first.bold || line.x1 < first.x0 || line.x0 > first.x1 ||
      line.y > height * .35 || BODY_START.test(line.text)) break;
    line.readingRole = 'title';
    end = i;
  }
  let affiliation = false;
  for (let i = end + 1; i < lines.length; i++) {
    const line = lines[i], previous = lines[i - 1];
    if (/^preprint\s*[,;—-]\s*(?:compiled|published|revised)\b/i.test(line.text)) {
      line.readingRole = 'publication';
      continue;
    }
    if (line.y > height * .45 || line.y - previous.y > Math.max(previous.size, line.size) * 3 ||
      line.x1 < first.x0 || line.x0 > first.x1 || BODY_START.test(line.text) || line.bold) break;
    const institution = AFFILIATION.test(line.text.replace(/^[\d, *†‡]+/, ''));
    const names = !affiliation && line.size >= body && line.size < first.size &&
      /[,，]/.test(line.text) && !/[.!?。！？]$/.test(line.text) &&
      !/\b(?:we|our|this|these|paper|propose|however|because)\b/i.test(line.text);
    const continuation = affiliation && line.y - previous.y <= line.size * 1.65 &&
      !/[.!?。！？]$/.test(line.text);
    if (!institution && !names && !continuation) break;
    affiliation ||= institution;
    line.readingRole = affiliation ? 'affiliations' : 'authors';
  }
}
