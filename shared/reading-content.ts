import type { Block } from './types';

type ReadingBlock = Pick<Block, 'kind' | 'readingRole' | 'text' | 'sourceTextFallback'>;

/** Keep source blocks in storage for notes; the reading projection omits author metadata and page furniture. */
export function isReadingContent(block: ReadingBlock): boolean {
  return !['authors', 'affiliations', 'biography', 'publication'].includes(block.readingRole ?? '');
}

export function isReferenceHeading(block: Pick<Block, 'kind' | 'text'>): boolean {
  if (!['h1', 'h2', 'h3', 'p'].includes(block.kind)) return false;
  // PDF small caps often split "R EFERENCES" into separate items.
  return /^(?:(?:[IVXLCDM]+|\d+)[.)]?)?(?:REFERENCES|BIBLIOGRAPHY|参考文献)[:：]?$/i.test(block.text.replace(/\s+/g, ''));
}

function isTranslationText(block: ReadingBlock): boolean {
  return isReadingContent(block) && block.text.trim().length > 0 &&
    !['math', 'figure', 'table', 'algorithm', 'ref'].includes(block.kind) && block.readingRole !== 'publication' &&
    !isReferenceHeading(block);
}

/** References remain original; unresolved source text is counted separately, never sent as corrupt text. */
export function isTranslatableContent(block: ReadingBlock): boolean {
  return isTranslationText(block) && !block.sourceTextFallback;
}

export function isUntranslatedSourceContent(block: ReadingBlock): boolean {
  return isTranslationText(block) && !!block.sourceTextFallback;
}
