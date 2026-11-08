import type { Block } from '@shared/types';
import { isReferenceHeading } from '@shared/reading-content';

/** Bibliographic punctuation is stronger evidence than an initial such as "J.". */
export function isBibliographicLine(text: string): boolean {
  return /\b(?:vol(?:ume)?\.?\s*\d|no\.\s*\d|pp?\.\s*\d|doi\s*:|ISBN\b|https?:\/\/|in\s+Proc\.)/i.test(text);
}

/** A citation marker is not a bibliography entry without author/publishing evidence. */
export function isBibliographicEntryStart(text: string): boolean {
  if (!/^\[\d+\]\s*[.,]?\s*/.test(text)) return false;
  return isBibliographicLine(text) ||
    /^\[\d+\]\s*[.,]?\s*(?:(?:[A-Z]\.\s*)+[A-Z][\p{L}'’−-]+|[A-Z][\p{L}'’−-]+,\s*(?:[A-Z]\.))/u.test(text);
}

export function endsReferenceSection(text: string): boolean {
  const compact = text.replace(/\s+/g, ' ').trim();
  return /^(?:(?:[IVXLCDM]+|\d+)[.)]?\s+)?(?:appendi(?:x|ces)(?:\s+[A-Z\d])?|acknowledg(?:e)?ments?|methods?|materials(?: and methods)?|results?|discussion|conclusions?|data availability|code availability|author contributions|competing interests|additional information|author(?:s| biographies| information)?|biographies|supplementary (?:material|information)|附录|致谢|作者简介)(?:\s*[:：].*)?$/i.test(compact);
}

/** Apply reference semantics in final reading order, including page/column continuations. */
export function classifyReferences(blocks: Block[]): void {
  let inReferences = false;
  for (const block of blocks) {
    if (isReferenceHeading(block)) { inReferences = true; continue; }
    if (block.readingRole === 'publication') continue;
    if (block.readingRole && ['authors', 'affiliations', 'biography'].includes(block.readingRole)) {
      inReferences = false;
      continue;
    }
    if (endsReferenceSection(block.text)) { inReferences = false; continue; }
    if (!inReferences || !['p', 'li', 'ref', 'h2', 'h3'].includes(block.kind)) continue;
    // Actual numbered appendix/section headings still end a bibliography. Initials
    // in journal and author names do not, regardless of the provisional heading tag.
    if (/^h[23]$/.test(block.kind) && !isBibliographicLine(block.text) &&
      /^(?:[IVXLCDM]{2,}|\d+(?:\.\d+)+)\.?\s+\S/.test(block.text)) {
      inReferences = false;
      continue;
    }
    block.kind = 'ref';
  }
}
