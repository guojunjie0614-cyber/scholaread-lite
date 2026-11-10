import type { TextRun } from './types.js';

export type TranslationRun = TextRun;

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeText = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const scriptSource = (run: TranslationRun) => run.script
  ? `<${run.script}>${escapeText(run.text)}</${run.script}>` : escapeText(run.text);
const spatialPattern = () => /<slmath>([^<>]*)<\/slmath>/g;

function spatialRuns(encoded: string): TranslationRun[] {
  let runs: TranslationRun[];
  try { runs = JSON.parse(decodeURIComponent(encoded)); }
  catch { throw new Error('原文数学结构标记损坏，请重新解析。'); }
  if (!Array.isArray(runs) || !runs.length || runs.some(run => {
    const p = run?.mathPosition;
    return typeof run?.text !== 'string' || (run.script !== undefined && run.script !== 'sub' && run.script !== 'sup') ||
      !p || typeof p.group !== 'string' || !p.group || p.group !== runs[0]?.mathPosition?.group ||
      ![p.x, p.y, p.width, p.size].every(Number.isFinite) || p.width < 0 || p.size <= 0;
  })) throw new Error('原文数学结构标记损坏，请重新解析。');
  return runs;
}

/** Geometry is part of source identity, but never sent to the translation provider. */
export function translationSource(block: { text: string; textRuns?: TranslationRun[] }): string {
  if (!block.textRuns?.some(run => run.script || run.mathPosition)) return block.text;
  const runs = block.textRuns, parts: string[] = [];
  for (let index = 0; index < runs.length;) {
    const group = runs[index].mathPosition?.group;
    if (!group) { parts.push(scriptSource(runs[index++])); continue; }
    const start = index++;
    while (index < runs.length && runs[index].mathPosition?.group === group) index++;
    parts.push(`<slmath>${encodeURIComponent(JSON.stringify(runs.slice(start, index)))}</slmath>`);
  }
  return parts.join('');
}

/** The pre-geometry cache key, retained only to adopt valid existing translations. */
export function legacyTranslationSource(source: string): string {
  return source.replace(spatialPattern(), (_value, encoded) => spatialRuns(encoded).map(scriptSource).join(''));
}

const scriptPattern = () => /<(sub|sup)>([^<>]*)<\/\1>/g;
const damagedCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/;

export function assertTranslationSource(source: string): void {
  if (damagedCharacters.test(source)) throw new Error('原文含无法识别的字符，请重新解析或对照原页后再翻译。');
  const plain = legacyTranslationSource(source);
  if (damagedCharacters.test(plain)) throw new Error('原文含无法识别的字符，请重新解析或对照原页后再翻译。');
  if (/<\/?slmath\b/i.test(plain)) throw new Error('原文数学结构标记损坏，请重新解析。');
}

// Keep the variable together with its scripts: protecting only <sub>i</sub>
// would still allow the model to replace or drop the f in f_i. Symbolic bases
// start with a letter so numeric coefficients like 0.127 in 0.127V_DD stay in prose.
const mathPattern = () =>
  /((?:[A-Za-z\u0370-\u03ff\u1d00-\u1d7f][A-Za-z0-9\u0370-\u03ff\u1d00-\u1d7f]*|[0-9]+)[ \t]*)?((?:<(?:sub|sup)>[^<>]*<\/(?:sub|sup)>[ \t]*)+)(\([A-Za-z0-9\u0370-\u03ff,+−-]+\))?/g;

const SYMBOL_HEAD_CHAR = /[A-Za-z\u0370-\u03ff\u1d00-\u1d7f]/;
const ATOM_CONT_CHAR = /[A-Za-z0-9\u0370-\u03ff\u1d00-\u1d7f]/;
const CJK_OR_TARGET_SCRIPT = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const SECTION_OR_LABEL_HEAD = /^(?:(?:\d+(?:\.\d+)*\.?\s+|[IVXLCDM]+\.\s+|[A-Z]\.\s+)[A-Za-z]{3,}|(?:index\s+terms|abstract|keywords?|fig(?:ure)?\.?\s*\d+|table\s+[IVXLCDM\d]+)\b)/i;

function isEchoableEnglishPrefix(prefix: string): boolean {
  const plain = unescapeText(
    prefix
      .replace(spatialPattern(), ' ')
      .replace(/<\/?(?:sub|sup)>/g, ' ')
      .replace(/⟦SLMATH_*:[^⟧]*⟧/g, ' '),
  ).trim();
  if (!plain || CJK_OR_TARGET_SCRIPT.test(plain) || !/[A-Za-z]{3,}/.test(plain)) return false;
  if (SECTION_OR_LABEL_HEAD.test(plain) || /[.!?;:]$/.test(plain)) return true;
  const words = plain.match(/[A-Za-z]{2,}/g) ?? [];
  return words.length >= 4;
}

function extractRemainderAfterEchoedPrefix(candidatePrefix: string, fullText: string, target = 'zh-CN'): string | null {
  if (/^en\b/i.test(target)) return null;
  const trimmedPrefix = candidatePrefix.trim();
  const trimmedFull = fullText.trim();
  if (!trimmedPrefix || !trimmedFull || trimmedFull.length <= trimmedPrefix.length) return null;
  if (!isEchoableEnglishPrefix(trimmedPrefix)) return null;
  const escaped = trimmedPrefix
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const match = trimmedFull.match(new RegExp(`^(${escaped})([\\s\\S]+)$`));
  if (!match) return null;
  const matchedHead = match[1];
  const after = match[2];
  const validBoundary =
    /^[\s\r\n:;—–-]+/.test(after) ||
    /[.!?;:)\]]$/.test(matchedHead) ||
    CJK_OR_TARGET_SCRIPT.test(after[0] ?? '');
  if (!validBoundary) return null;
  const remainder = after.replace(/^[\s\r\n]+/, '').trim();
  if (!remainder || remainder === matchedHead.trim()) return null;
  if (/^(?:zh|ja|ko)\b/i.test(target)) {
    const cjkCount = (remainder.match(new RegExp(CJK_OR_TARGET_SCRIPT.source, 'g')) ?? []).length;
    if (cjkCount === 0) return null;
    if (!SECTION_OR_LABEL_HEAD.test(matchedHead.trim()) && !/[.!?;:]$/.test(matchedHead.trim()) && cjkCount < 4) {
      return null;
    }
  }
  return remainder;
}

export function protectTranslationMath(source: string, segment: number): { text: string; restore(value: string): string } {
  assertTranslationSource(source);
  let prefix = 'SLMATH';
  while (source.includes(`⟦${prefix}:`)) prefix += '_';
  const tokens: string[] = [], values: string[] = [];
  const atoms = new RegExp(`${spatialPattern().source}(?:\\([A-Za-z0-9\\u0370-\\u03ff,+−-]+\\))?|${mathPattern().source}`, 'g');
  const text = source.replace(atoms, value => {
    // Whitespace belongs to prose, not the protected atom.
    const atom = value.trimEnd(), suffix = value.slice(atom.length);
    const token = `⟦${prefix}:${segment}:${tokens.length}⟧`;
    tokens.push(token); values.push(atom);
    return token + suffix;
  });
  return { text, restore(value) {
    const originalMarkers: string[] = source.match(/⟦SLMATH_*:[^⟧]*⟧/g) ?? [];
    const legacy = legacyTranslationSource(source);
    const plainWire = unescapeText(legacy.replace(/<\/?(?:sub|sup)>/g, ''));
    for (const candidatePrefix of [text, source, legacy, plainWire]) {
      const remainder = extractRemainderAfterEchoedPrefix(candidatePrefix, value, 'zh-CN');
      if (!remainder) continue;
      const remMarkers: string[] = remainder.match(/⟦SLMATH_*:[^⟧]*⟧/g) ?? [];
      const remReceived = remMarkers.filter(marker => !originalMarkers.includes(marker));
      if (remReceived.length === tokens.length && remReceived.every((marker, idx) => marker === tokens[idx])) {
        value = remainder;
        break;
      }
    }
    const markers: string[] = value.match(/⟦SLMATH_*:[^⟧]*⟧/g) ?? [];
    const received = markers.filter(marker => !originalMarkers.includes(marker));
    if (received.length !== tokens.length || received.some((marker, index) => marker !== tokens[index])) {
      const missing = tokens.filter(token => !received.includes(token));
      const unknown = received.filter(token => !tokens.includes(token));
      const duplicate = [...new Set(received.filter((token, index) => received.indexOf(token) !== index))];
      const details = [missing.length ? `缺失 ${missing.join('、')}` : '', unknown.length ? `未知 ${unknown.join('、')}` : '',
        duplicate.length ? `重复 ${duplicate.join('、')}` : '', !missing.length && !unknown.length && !duplicate.length ? '顺序改变' : ''].filter(Boolean);
      throw new Error(`翻译结果未能完整保留数学上下标占位符（${details.join('；')}），请重试。`);
    }
    let restored = value;
    tokens.forEach((token, index) => {
      const atom = values[index];
      const pos = restored.indexOf(token);
      if (pos < 0) return;
      const prev = pos > 0 ? restored[pos - 1] : '';
      const plainAtom = unescapeText(legacyTranslationSource(atom));
      const needsLeadingSpace = prev !== '' && (
        (SYMBOL_HEAD_CHAR.test(plainAtom[0] ?? '') && SYMBOL_HEAD_CHAR.test(prev)) ||
        (/^[0-9]/.test(plainAtom) && ATOM_CONT_CHAR.test(prev)) ||
        (plainAtom.startsWith('<') && ATOM_CONT_CHAR.test(prev))
      );
      const replacement = (needsLeadingSpace ? ' ' : '') + atom;
      restored = restored.slice(0, pos) + replacement + restored.slice(pos + token.length);
    });
    return restored;
  } };
}

/** Recognize only the two exact tags we emitted. All other characters remain ordinary text. */
function translatedScriptRuns(source: string, translated: string): TranslationRun[] {
  assertTranslationSource(source);
  if (damagedCharacters.test(translated)) throw new Error('译文含损坏字符，已保留原文，请重试。');
  const expected = [...source.matchAll(scriptPattern())];
  if (!expected.length) return [{ text: translated }];
  // Some text APIs HTML-escape their response. Decode only the exact supported tag delimiters.
  const marked = translated.replace(/&lt;(\/?(?:sub|sup))&gt;/g, '<$1>');
  const actual = [...marked.matchAll(scriptPattern())];
  if (actual.length !== expected.length || actual.some((match, index) => match[0] !== expected[index][0])) {
    throw new Error('翻译结果丢失或改写了上下标，请重试或更换翻译服务。');
  }
  const sourceMatches = [...source.matchAll(mathPattern())];
  let cursor = 0, previousAtomEnd = 0;
  for (const match of sourceMatches) {
    const base = unescapeText((match[1] ?? '').trim());
    const tagCount = [...match[2].matchAll(scriptPattern())].length;
    const argSuffix = unescapeText((match[3] ?? '').trim());
    if (cursor + tagCount > actual.length) {
      throw new Error('翻译结果丢失或改写了上下标，请重试或更换翻译服务。');
    }
    for (let t = 1; t < tagCount; t++) {
      const prevTag = actual[cursor + t - 1], nextTag = actual[cursor + t];
      if (!/^[ \t]*$/.test(marked.slice(prevTag.index! + prevTag[0].length, nextTag.index!))) {
        throw new Error('翻译结果改写了上下标所属的数学变量，请重试。');
      }
    }
    const firstTag = actual[cursor], lastTag = actual[cursor + tagCount - 1];
    const firstStart = firstTag.index!, lastEnd = lastTag.index! + lastTag[0].length;
    const before = unescapeText(marked.slice(previousAtomEnd, firstStart));
    if (SYMBOL_HEAD_CHAR.test(base[0] ?? '')) {
      const actualBase = before.match(/([A-Za-z\u0370-\u03ff\u1d00-\u1d7f][A-Za-z0-9\u0370-\u03ff\u1d00-\u1d7f]*)[ \t]*$/)?.[1] ?? '';
      if (actualBase !== base) throw new Error('翻译结果改写了上下标所属的数学变量，请重试。');
    } else if (/^[0-9]+$/.test(base)) {
      const actualBase = before.match(/([A-Za-z0-9\u0370-\u03ff\u1d00-\u1d7f]+)[ \t]*$/)?.[1] ?? '';
      if (actualBase !== base) throw new Error('翻译结果改写了上下标所属的数学变量，请重试。');
    } else if (ATOM_CONT_CHAR.test(before.slice(-1))) {
      throw new Error('翻译结果改写了上下标所属的数学变量，请重试。');
    }
    let atomEnd = lastEnd;
    if (argSuffix) {
      const afterSlice = marked.slice(lastEnd);
      const ws = afterSlice.match(/^[ \t]*/)?.[0] ?? '';
      const decodedAfter = unescapeText(afterSlice.slice(ws.length));
      if (!decodedAfter.startsWith(argSuffix)) {
        throw new Error('翻译结果改写了上下标所属的数学变量，请重试。');
      }
      atomEnd = lastEnd + ws.length + escapeText(argSuffix).length;
    }
    previousAtomEnd = atomEnd;
    cursor += tagCount;
  }
  const runs: TranslationRun[] = [];
  let offset = 0;
  for (const match of actual) {
    const text = marked.slice(offset, match.index);
    // Malformed/nested script tags must not masquerade as harmless translated prose.
    if (/<\/?(?:sub|sup)\b/i.test(text)) throw new Error('翻译结果包含不完整的上下标标记。');
    if (text) runs.push({ text: unescapeText(text) });
    runs.push({ text: unescapeText(match[2]), script: match[1] as 'sub' | 'sup' });
    offset = match.index! + match[0].length;
  }
  const tail = marked.slice(offset);
  if (/<\/?(?:sub|sup)\b/i.test(tail)) throw new Error('翻译结果包含不完整的上下标标记。');
  if (tail) runs.push({ text: unescapeText(tail) });
  return runs;
}

/** Verify the exact source atoms before restoring their original spatial runs. */
export function translatedRuns(source: string, translated: string): TranslationRun[] {
  assertTranslationSource(source);
  const expected = [...source.matchAll(spatialPattern())];
  if (!expected.length) return translatedScriptRuns(source, translated);
  const marked = translated.replace(/&lt;(\/?(?:sub|sup|slmath))&gt;/g, '<$1>');
  const actual = [...marked.matchAll(spatialPattern())];
  if (actual.length !== expected.length || actual.some((match, index) => match[0] !== expected[index][0])) {
    throw new Error('翻译结果丢失或改写了数学结构，请重试。');
  }
  // Check scripts and function arguments outside the spatial wrapper too.
  translatedScriptRuns(legacyTranslationSource(source), legacyTranslationSource(marked));
  const runs: TranslationRun[] = [];
  let offset = 0;
  for (const match of actual) {
    const prose = marked.slice(offset, match.index);
    if (/<\/?slmath\b/i.test(prose)) throw new Error('翻译结果包含不完整的数学结构标记。');
    if (prose) runs.push(...translatedScriptRuns(prose, prose));
    runs.push(...spatialRuns(match[1]));
    offset = match.index! + match[0].length;
  }
  const tail = marked.slice(offset);
  if (/<\/?slmath\b/i.test(tail)) throw new Error('翻译结果包含不完整的数学结构标记。');
  if (tail) runs.push(...translatedScriptRuns(tail, tail));
  return runs;
}

/** Upgrade a legacy cache only when every spatial atom still occurs intact, in source order. */
export function restoreCachedTranslationMath(source: string, translated: string): string {
  const expected = [...source.matchAll(spatialPattern())];
  if (!expected.length) { translatedRuns(source, translated); return translated; }
  if (spatialPattern().test(translated)) { translatedRuns(source, translated); return translated; }
  const marked = translated.replace(/&lt;(\/?(?:sub|sup))&gt;/g, '<$1>');
  translatedScriptRuns(legacyTranslationSource(source), marked);
  const atoms = expected.map(match => legacyTranslationSource(match[0]));
  const alternatives = [...new Set(atoms)].sort((a, b) => b.length - a.length)
    .map(atom => atom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const matches = [...marked.matchAll(new RegExp(alternatives.join('|'), 'g'))].filter(match => {
    const before = marked.slice(0, match.index).slice(-1), after = marked.slice(match.index! + match[0].length)[0] ?? '';
    return !(ATOM_CONT_CHAR.test(match[0][0]) && ATOM_CONT_CHAR.test(before)) &&
      !(ATOM_CONT_CHAR.test(match[0].slice(-1)) && ATOM_CONT_CHAR.test(after));
  });
  if (matches.length !== atoms.length || matches.some((match, index) => match[0] !== atoms[index])) {
    throw new Error('已有译文未完整保留数学结构，需要重新翻译该段。');
  }
  let result = '', offset = 0;
  matches.forEach((match, index) => {
    result += marked.slice(offset, match.index) + expected[index][0];
    offset = match.index! + match[0].length;
  });
  result += marked.slice(offset);
  translatedRuns(source, result);
  return result;
}

/**
 * Strip an echoed English source prefix when a model outputs "<English source> <Translated text>"
 * while preserving all math/script/spatial integrity invariants on the remaining translation.
 */
export function stripEchoedSourcePrefix(source: string, translated: string, target = 'zh-CN'): string {
  if (!source.trim() || !translated.trim() || /^en\b/i.test(target)) return translated;
  let legacy = source;
  try {
    legacy = legacyTranslationSource(source);
  } catch {
    return translated;
  }
  const plain = unescapeText(legacy.replace(/<\/?(?:sub|sup)>/g, ''));
  const candidates = [...new Set([source, legacy, plain])];
  let current = translated;
  for (let pass = 0; pass < 2; pass++) {
    let matchedRemainder: string | null = null;
    for (const prefix of candidates) {
      const remainder = extractRemainderAfterEchoedPrefix(prefix, current, target);
      if (!remainder) continue;
      try {
        restoreCachedTranslationMath(source, remainder);
        matchedRemainder = remainder;
        break;
      } catch {
        try {
          translatedRuns(source, remainder);
          matchedRemainder = remainder;
          break;
        } catch {
          /* Remainder does not preserve required math/script structure; do not strip. */
        }
      }
    }
    if (!matchedRemainder) break;
    current = matchedRemainder;
  }
  return current;
}
