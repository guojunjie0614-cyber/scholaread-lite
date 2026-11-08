import type { Block } from '@shared/types';
import { isReferenceHeading } from '@shared/reading-content';

const INSTITUTION = /\b(?:university|institute|institut|department|school|college|academy|laborator(?:y|ies)|compan(?:y|ies)|corporation|corp\.?|ltd\.?|inc\.?|gmbh)\b/i;
const NAME = /^[A-Z][\p{L}.'’\-]+(?:\s+[A-Z][\p{L}.'’\-]+)+/u;
const DEGREE = /\b(?:degrees?|diploma|habilitation|Ph\.?\s?D\.?|Dr\.?[-\s]?Ing\.?|[BM]\.?\s?(?:S|Sc|Eng)\.?)\b/i;
const PERSONAL_DETAIL = /\b(?:research|degree|professor|university|institute|award|recipient|fellow|member|published|authored|editor|serves?|served|scientist|engineer|habilitation|privatdozent|patents?)\b/i;

function sliceTextBlock(block: Block, start: number, end: number): Block {
  let offset = 0;
  const textRuns = block.textRuns?.flatMap(run => {
    const from = Math.max(0, start - offset), to = Math.min(run.text.length, end - offset);
    offset += run.text.length;
    return to > from ? [{ ...run, text: run.text.slice(from, to) }] : [];
  });
  return { ...block, text: block.text.slice(start, end), textRuns };
}

/** Funding and author addresses sometimes share a PDF paragraph. Keep funding readable. */
function splitAuthorFootnotes(blocks: Block[]): void {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.page !== 1 || block.kind !== 'p' || block.readingRole) continue;
    const match = /(?:^|[.!?)]\s+)([A-Z][\p{L}.'’\-]+(?:\s+[A-Z][\p{L}.'’\-]+)+[^.!?]{0,240}\b(?:is|are) with\b)/u.exec(block.text);
    if (!match) continue;
    let start = match.index + match[0].length - match[1].length;
    if (!start || !INSTITUTION.test(block.text.slice(start))) continue;
    const corresponding = /\(Corresponding authors?:[^)]*\)\s*$/i.exec(block.text.slice(0, start));
    if (corresponding) start = corresponding.index;
    const prefixEnd = block.text.slice(0, start).trimEnd().length;
    if (!prefixEnd) continue;
    const prefix = sliceTextBlock(block, 0, prefixEnd);
    const author = { ...sliceTextBlock(block, start, block.text.length), id: `${block.id}:authors`, readingRole: 'affiliations' as const };
    blocks.splice(i, 1, prefix, author);
    i++;
  }
}

/** Shared identity evidence for the text and portrait passes; geometry alone cannot establish an author. */
export interface BiographySubject { name: string; surname: string; }
export function identifyBiographySubject(text: string): BiographySubject | undefined {
  const match = /^([A-Z][\p{L}.'’\-]+(?:\s+[A-Z][\p{L}.'’\-]+){1,7})\s*(?:\([^)]*\)\s*)?(received|earned|obtained|is)\b/u.exec(text);
  if (!match) return;
  const education = match[2] !== 'is' && DEGREE.test(text);
  const appointment = match[2] === 'is' &&
    /^(?:currently )?(?:an? |the )?(?:Professor|Associate Professor|Assistant Professor|Research Scientist|Researcher)\b/.test(text.slice(match[0].length).trimStart()) && INSTITUTION.test(text);
  if (!education && !appointment) return;
  const name = match[1];
  return { name, surname: name.split(/\s+/).at(-1)! };
}

function namesOnly(text: string): boolean {
  const names = text.replace(/\([^)]*\)|\b(?:Senior |Fellow,? |Member,? )?IEEE\b|\b(?:Senior Member|Member|Fellow)\b/g, '')
    .replace(/[,，&✉*†‡\d]|\band\b/g, ' ').trim();
  return /^[A-Z][\p{L}.'’\-]+(?:\s+[A-Z][\p{L}.'’\-]+)+$/u.test(names) && !/[!?。！？]/.test(text);
}

function sameSubject(text: string, subject: BiographySubject): boolean {
  const titled = /^(?:(?:Mr|Mrs|Ms|Dr|Prof)\.|Professor)\s+([\p{L}.'’\-]+)\b/u.exec(text);
  return !!titled && titled[1].replace(/\.$/, '') === subject.surname.replace(/\.$/, '');
}

/** Classify, never remove, source paragraphs. A biography cannot consume a later technical section. */
export function classifyReadingRoles(blocks: Block[], totalPages: number): void {
  splitAuthorFootnotes(blocks);
  // The title, authors and addresses may be split across independent PDF columns.
  // Classify this bounded opening after the document has been ordered.
  let opening = false, openingAuthors = false;
  for (const block of blocks) {
    if (block.page !== 1) break;
    if (block.readingRole === 'title' || !opening && block.kind === 'h1' && block.bbox && block.bbox[1] < 200) {
      block.readingRole = 'title'; opening = true; continue;
    }
    if (!opening || block.readingRole === 'publication') continue;
    if (block.kind !== 'p' || /^(?:abstract|introduction|摘要|引言)\b/i.test(block.text)) break;
    if (!openingAuthors && (block.text.match(/[A-Z][\p{L}.'’\-]+\s+[A-Z][\p{L}.'’\-]+/gu) ?? []).length >= 2 &&
      /[,，]/.test(block.text) && !/[.!?。！？]$/.test(block.text)) {
      block.readingRole = 'authors';
      openingAuthors = true;
    } else if (openingAuthors && INSTITUTION.test(block.text)) block.readingRole = 'affiliations';
    else if (openingAuthors && namesOnly(block.text)) block.readingRole = 'authors';
    else break;
  }
  // Column ordering can place one author-name fragment after the abstract/body.
  // Recover the physical opening band, rather than trusting that reading-order adjacency.
  const title = blocks.find(block => block.page === 1 && block.readingRole === 'title' && block.bbox);
  const abstract = blocks.find(block => block.page === 1 && block.bbox && /^(?:abstract|摘要)\b/i.test(block.text));
  if (title?.bbox && abstract?.bbox) for (const block of blocks) {
    if (block.page === 1 && block.kind === 'p' && !block.readingRole && block.bbox &&
      block.bbox[1] >= title.bbox[3] && block.bbox[3] < abstract.bbox[1] && namesOnly(block.text)) block.readingRole = 'authors';
  }
  let previousBiography: Block | undefined;
  let subject: BiographySubject | undefined;
  for (const block of blocks) {
    if (block.page === 1 && block.kind === 'p' && /^\d+\s*(?:the\s+)?(?:[\p{L}.'’\-]+\s+){0,5}(?:university|institute|department|school|college|academy|laborator(?:y|ies))\b/iu.test(block.text) && /,/.test(block.text)) {
      block.readingRole = 'affiliations';
    }
    if (block.page === 1 && block.kind === 'p' && NAME.test(block.text) &&
      /^.{2,300}?\b(?:is|are) with\b/.test(block.text) && INSTITUTION.test(block.text)) {
      block.readingRole = 'affiliations';
    }
    if (block.page === 1 && /^(?:(?:[A-Z]\.\s*)+[A-Z][\p{L}.'’\-]+\.?\s*)?\(Corresponding authors?:[^)]+\)\s*$/u.test(block.text)) {
      block.readingRole = 'authors';
    }
    if (block.readingRole === 'publication' || block.kind === 'figure' && block.readingRole === 'biography') continue;
    if (block.page < Math.max(2, Math.ceil(totalPages * .7)) || block.kind !== 'p' || isReferenceHeading(block)) {
      previousBiography = undefined; subject = undefined;
      continue;
    }
    const personalContinuation = previousBiography && block.page <= previousBiography.page + 1 &&
      (subject && sameSubject(block.text, subject) ||
        /^(?:(?:He|She|His|Her|They|Their)\b|(?:From|Since)\s+\d{4}\b)/.test(block.text) && PERSONAL_DETAIL.test(block.text));
    const degreeContinuation = previousBiography && block.page <= previousBiography.page + 1 &&
      /\b(?:Ph\.?\s?D\.?|[BM]\.?\s?(?:S|Sc|Eng)\.?)$/i.test(previousBiography.text) &&
      /^degrees?\s+(?:in|from|with)\b/i.test(block.text);
    const pageContinuation = previousBiography && block.page === previousBiography.page + 1 &&
      !/[.!?。！？]$/.test(previousBiography.text) && PERSONAL_DETAIL.test(block.text) &&
      !/^(?:We|Our|This|The proposed|In this|Fig\.|Table|Algorithm)\b/i.test(block.text);
    const nextSubject = identifyBiographySubject(block.text);
    if (nextSubject || personalContinuation || degreeContinuation || pageContinuation) {
      block.readingRole = 'biography';
      previousBiography = block;
      subject = nextSubject ?? subject;
    } else { previousBiography = undefined; subject = undefined; }
  }
  blocks.forEach((block, ord) => { block.ord = ord; });
}
