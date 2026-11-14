import { ENGLISH_LEXICON_DELTA } from './generated/english-lexicon.js';

let cachedWords: Set<string> | null = null;

function wordSet(): Set<string> {
  if (cachedWords) return cachedWords;
  const set = new Set<string>();
  let prev = '';
  let start = 0;
  const raw = ENGLISH_LEXICON_DELTA;
  while (start < raw.length) {
    let end = raw.indexOf('\n', start);
    if (end === -1) end = raw.length;
    if (end > start) {
      const code = raw.charCodeAt(start);
      const shared = code >= 65 ? code - 65 + 10 : code - 48;
      const word = prev.slice(0, shared) + raw.slice(start + 1, end);
      set.add(word);
      prev = word;
    }
    start = end + 1;
  }
  cachedWords = set;
  return set;
}

const INFLECTION_RULES: ReadonlyArray<readonly [suffix: string, replacement: string, allowDoubledConsonant?: boolean]> = [
  ['ies', 'y'],
  ['ied', 'y'],
  ['es', ''],
  ['s', ''],
  ['ed', '', true],
  ['ed', 'e'],
  ['ing', '', true],
  ['ing', 'e'],
  ['ers', '', true],
  ['ers', 'e'],
  ['er', '', true],
  ['er', 'e'],
  ['est', '', true],
  ['est', 'e'],
  ['ly', ''],
  ['ally', 'al'],
  ['ation', 'ate'],
  ['ations', 'ate'],
  ['ization', 'ize'],
  ['izations', 'ize'],
  ['able', ''],
  ['able', 'e'],
  ['ity', ''],
  ['ity', 'e'],
];

/** Check whether a lowercase ASCII word is an attested modern English word or productive inflection. */
export function isEnglishWord(word: string): boolean {
  const clean = word.toLowerCase();
  if (clean.length < 2 || !/^[a-z]+$/.test(clean)) return false;
  const dict = wordSet();
  if (dict.has(clean)) return true;
  for (const [suffix, replacement, allowDoubled] of INFLECTION_RULES) {
    if (!clean.endsWith(suffix) || clean.length - suffix.length < 3) continue;
    const stem = clean.slice(0, -suffix.length) + replacement;
    if (dict.has(stem)) return true;
    if (allowDoubled && stem.length >= 4 && stem.charCodeAt(stem.length - 1) === stem.charCodeAt(stem.length - 2)) {
      if (dict.has(stem.slice(0, -1))) return true;
    }
  }
  return false;
}

/**
 * Unbroken mid-line vocabulary observed in the current document.
 * Authorial usage inside the same paper overrides generic priors whenever present.
 */
export interface DocumentLexicon {
  midJoined: ReadonlyMap<string, number>;
  midHyphen: ReadonlyMap<string, number>;
}

export function createDocumentLexiconAccumulator() {
  const midJoined = new Map<string, number>();
  const midHyphen = new Map<string, number>();
  return {
    addTextItems(items: Iterable<{ str?: string; hasEOL?: boolean }>) {
      for (const item of items) {
        const s = item.str;
        if (!s || !s.trim()) continue;
        // Exclude trailing line-end hyphenated fragments so broken tokens never vote for themselves.
        const clean = item.hasEOL ? s.replace(/[A-Za-z0-9-]+-\s*$/, '') : s;
        for (const match of clean.matchAll(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g)) {
          const key = match[0].toLowerCase();
          midHyphen.set(key, (midHyphen.get(key) ?? 0) + 1);
        }
        for (const match of clean.matchAll(/(?<![A-Za-z0-9-])[A-Za-z]{3,}(?![A-Za-z0-9-])/g)) {
          const key = match[0].toLowerCase();
          midJoined.set(key, (midJoined.get(key) ?? 0) + 1);
        }
      }
    },
    /** Build from already-grouped visual lines (excluding line-final hyphenated words). */
    addLines(lines: Iterable<{ text: string }>) {
      for (const line of lines) {
        if (!line.text) continue;
        const clean = line.text.replace(/[A-Za-z0-9-]+-\s*$/, '');
        for (const match of clean.matchAll(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g)) {
          const key = match[0].toLowerCase();
          midHyphen.set(key, (midHyphen.get(key) ?? 0) + 1);
        }
        for (const match of clean.matchAll(/(?<![A-Za-z0-9-])[A-Za-z]{3,}(?![A-Za-z0-9-])/g)) {
          const key = match[0].toLowerCase();
          midJoined.set(key, (midJoined.get(key) ?? 0) + 1);
        }
      }
    },
    finish(): DocumentLexicon {
      return { midJoined, midHyphen };
    },
  };
}

/**
 * Decide whether an end-of-line hyphen (`left` ending in `-`, `right` starting with letters)
 * is a true compound hyphen (keep `-`) or soft typographic line-wrap hyphenation (remove `-`).
 *
 * Hierarchy:
 *   1. Orthographic structure invariants (digits, single-letter symbols like `k-means`,
 *      proper-case `Navier-Stokes`, acronym-head `SAR-based`).
 *   2. Intra-document self-consistency (`midHyphen` vs `midJoined` in non-EOL positions).
 *   3. Lexicon & morpheme validity (`isEnglishWord(joined)` vs `isEnglishWord(head) && isEnglishWord(tail)`).
 */
export function shouldKeepEndOfLineHyphen(left: string, right: string, docLexicon?: DocumentLexicon): boolean {
  const headMatch = left.match(/([A-Za-z0-9-]+)-$/);
  const tailMatch = right.match(/^([A-Za-z0-9-]+)/);
  if (!headMatch || !tailMatch) return true;
  const rawHead = headMatch[1];
  const rawTail = tailMatch[1];
  const head = rawHead.split('-').pop()!;
  const tail = rawTail.split('-')[0];

  // 1. Orthographic invariants
  if (/\d/.test(rawHead) || /\d/.test(rawTail)) return true;
  if (/^[A-Z]/.test(tail) || (head.length > 1 && /^[A-Z]+$/.test(head) && /^[a-z]/.test(tail))) return true;
  if (/^[A-Za-z]$/.test(rawHead)) return true;

  // 2. Intra-document authorial evidence
  if (docLexicon) {
    const fullJoined = (rawHead + rawTail).toLowerCase();
    const fullHyphen = `${rawHead}-${rawTail}`.toLowerCase();
    const subJoined = (head + tail).toLowerCase();
    const subHyphen = `${head}-${tail}`.toLowerCase();
    const joinedVotes = docLexicon.midJoined.get(fullJoined) ?? (!rawHead.includes('-') ? (docLexicon.midJoined.get(subJoined) ?? 0) : 0);
    const hyphenVotes = docLexicon.midHyphen.get(fullHyphen) ?? (!rawHead.includes('-') ? (docLexicon.midHyphen.get(subHyphen) ?? 0) : 0);
    if (hyphenVotes !== joinedVotes) {
      return hyphenVotes > joinedVotes;
    }
  }

  // 3. Multi-hyphen compound chain (e.g. `state-of-the-` + `art` vs `high-dimen-` + `sional`)
  const h = head.toLowerCase();
  const t = tail.toLowerCase();
  const joined = h + t;
  if (rawHead.includes('-')) {
    if (isEnglishWord(joined) && !(isEnglishWord(h) && isEnglishWord(t))) {
      return false;
    }
    return true;
  }

  // 4. Lexicon & morpheme validity
  if (isEnglishWord(joined)) return false;
  if (h.length >= 2 && t.length >= 3 && isEnglishWord(h) && isEnglishWord(t)) return true;
  return false;
}
