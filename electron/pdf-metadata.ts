import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PaperMeta } from '../shared/types.js';
import { canonicalVenue } from '../shared/venue.js';

export interface PdfMetadataSource {
  info: Record<string, unknown>;
  xmp: Record<string, unknown>;
  /** Only page headers are eligible for journal / conference-year inference. */
  headers: string[];
  firstPage: string[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function yearIn(value: unknown): number | null {
  const match = text(value).match(/\b((?:19|20)\d{2})\b/);
  return match ? Number(match[1]) : null;
}

const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const journalDate = new RegExp(`\\b(?:VOL(?:UME)?\\.?|NO\\.|ISSUE)\\s*\\d+.*?\\b${MONTH}\\.?\\s+((?:19|20)\\d{2})\\b`, 'i');

function publicationYear(source: PdfMetadataSource): number | null {
  // The printed issue date wins over online-first, copyright and file dates.
  for (const header of source.headers) {
    const match = header.match(journalDate);
    if (match) return Number(match[1]);
  }
  for (const key of ['prism:coverdate', 'prism:coverdisplaydate']) {
    const year = yearIn(source.xmp[key]);
    if (year) return year;
  }
  // IEEE embeds a structured venue;year;volume;issue;DOI description.
  for (const description of [source.xmp['dc:description'], source.info.Subject]) {
    const parts = text(description).split(';');
    if (parts.length >= 4 && /journal|transactions|conference|proceedings|symposium/i.test(parts[0]) && /^(?:19|20)\d{2}$/.test(parts[1]?.trim()))
      return Number(parts[1].trim());
  }
  for (const header of source.headers) {
    const match = header.match(/\b(?:ISSCC|IEDM|DAC|DATE|VLSI)\s+((?:19|20)\d{2})\b/i)
      ?? header.match(/\b((?:19|20)\d{2})\s+(?:IEEE|ACM|International)[^\n]*?\b(?:Conference|Symposium|Workshop)\b/i);
    if (match) return Number(match[1]);
  }
  const publicationDate = yearIn(source.xmp['prism:publicationdate']);
  if (publicationDate) return publicationDate;
  for (const line of source.firstPage) {
    const match = line.match(/\bDate of publication\s+([^;\n]{0,70}?(?:19|20)\d{2})/i);
    if (match) return yearIn(match[1]);
  }
  // A publisher's copyright notice is useful when no issue/conference date exists.
  // Never scan arbitrary four-digit numbers, references or PDF CreationDate.
  for (const line of source.firstPage) {
    const match = line.match(/(?:©|\bcopyright\b)\s*(?:\(c\)\s*)?((?:19|20)\d{2})\s+(?:IEEE|ACM|Elsevier|Springer|The Authors?\b)/i);
    if (match) return Number(match[1]);
  }
  return null;
}

function publicationVenue(source: PdfMetadataSource): string | undefined {
  const embedded = text(source.xmp['prism:publicationname']);
  if (embedded) return canonicalVenue(embedded);
  for (const description of [source.xmp['dc:description'], source.info.Subject]) {
    const parts = text(description).split(';');
    if (parts.length >= 4 && /journal|transactions|conference|proceedings|symposium/i.test(parts[0]) && /^(?:19|20)\d{2}$/.test(parts[1]?.trim()))
      return canonicalVenue(parts[0]);
  }
  for (const raw of source.headers) {
    const header = text(raw).replace(/^\d+\s+/, '');
    const conference = /^(ISSCC|IEDM)\s+(?:19|20)\d{2}\b/i.exec(header);
    if (conference) return canonicalVenue(conference[1]);
    // A printed journal header identifies the venue even on an undated manuscript.
    // Do not infer an acceptance/publication date from this identity alone.
    const name = header.split(/,?\s+\b(?:VOL(?:UME)?\.?|NO\.|ISSUE)\s*\d/i)[0]
      .replace(/\s+\d+$/, '').trim();
    if (/^(?:IEEE|ACM)\b/i.test(name) && /\b(?:JOURNAL|TRANSACTIONS|LETTERS)\b/i.test(name) &&
      !/[;:]|\b(?:et al|doi|downloaded|authorized)\b/i.test(name) &&
      !/\b(?:ON|OF|AND|THE)$/i.test(name)) return canonicalVenue(name);
  }
  return undefined;
}

export function inferPdfMetadata(source: PdfMetadataSource): PaperMeta {
  const title = text(source.xmp['dc:title']) || text(source.info.Title);
  const creators = source.xmp['dc:creator'];
  const authors = Array.isArray(creators)
    ? creators.map(text).filter(Boolean)
    : text(source.info.Author).split(/\s*[,;]\s*/).filter(Boolean);
  const doiText = text(source.xmp['prism:doi']) || text(source.info.Subject);
  const doi = doiText.match(/10\.\d{4,9}\/[^\s;"<>]+/i)?.[0]?.replace(/[.)]+$/, '');
  return {
    title: title || undefined,
    authors,
    year: publicationYear(source),
    doi: doi || undefined,
    venue: publicationVenue(source),
  };
}

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<Pdfjs> | undefined;

/** Resolve at runtime: PDF.js and its worker stay as native ESM beside node_modules. */
export async function readPdfMetadata(filePath: string, projectDir: string): Promise<PaperMeta> {
  if (!pdfjsPromise) {
    const require = createRequire(path.join(projectDir, 'package.json'));
    const moduleUrl = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
    pdfjsPromise = import(moduleUrl);
  }
  const pdfjs = await pdfjsPromise;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(filePath)),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  try {
    const doc = await task.promise;
    const { info, metadata } = await doc.getMetadata();
    const source: PdfMetadataSource = { info: info as Record<string, unknown>, xmp: metadata?.getAll() ?? {}, headers: [], firstPage: [] };
    // Journal issue headers sometimes start on page 2; body/reference pages are excluded.
    for (let pageNumber = 1; pageNumber <= Math.min(2, doc.numPages); pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const lines: Array<{ y: number; items: Array<{ x: number; value: string }> }> = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        let line = lines.find((line) => Math.abs(line.y - y) < 2);
        if (!line) lines.push(line = { y, items: [] });
        line.items.push({ x, value: item.str });
      }
      lines.sort((a, b) => a.y - b.y);
      for (const line of lines) {
        const value = line.items.sort((a, b) => a.x - b.x).map((item) => item.value).join(' ');
        if (line.y < viewport.height * 0.15) source.headers.push(value);
        if (pageNumber === 1) source.firstPage.push(value);
      }
    }
    return inferPdfMetadata(source);
  } finally {
    await task.destroy();
  }
}

