import type { RawItem } from './analyze';

interface SourceFont {
  composite?: boolean;
  differences?: Array<string | undefined>;
  defaultEncoding?: Array<string | undefined>;
  toFontChar?: Array<number | undefined>;
  toUnicode?: { _map?: Array<string | undefined>; get?: (code: number) => string | null | undefined };
  data?: Uint8Array;
}

// Glyph names come from the PDF's Encoding/Differences or embedded Type 1 CFF charset,
// not from surrounding prose. MathTime's *1 names are upright capital Greek glyphs.
const GLYPHS: Record<string, string> = {
  Phi: 'Φ', Phi1: 'Φ', phi: 'φ', phi1: 'ϕ', alpha: 'α', beta: 'β', gamma: 'γ',
  delta: 'δ', epsilon: 'ε', varepsilon: 'ϵ', zeta: 'ζ', eta: 'η', theta: 'θ',
  vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
  upsilon: 'υ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Gamma1: 'Γ', Delta: 'Δ', Delta1: 'Δ', Theta: 'Θ', Theta1: 'Θ', varTheta: 'ϴ',
  Lambda: 'Λ', Lambda1: 'Λ', Xi: 'Ξ', Xi1: 'Ξ', Pi: 'Π', Pi1: 'Π',
  Sigma: 'Σ', Sigma1: 'Σ', Upsilon: 'Υ', Upsilon1: 'Υ', Psi: 'Ψ', Psi1: 'Ψ',
  Omega: 'Ω', Omega1: 'Ω', minus: '−', multiply: '×', lessequal: '≤', greaterequal: '≥',
  squaresolid: '■',
};

const cffGlyphCache = new WeakMap<object, Map<number, string> | null>();
const injectiveUnicodeCache = new WeakMap<object, Set<string>>();

function extractCffCodepointToGlyphName(data: Uint8Array | undefined): Map<number, string> | null {
  if (!data || data.byteLength < 12) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numTables = view.getUint16(4);
  let cmapOffset = 0, cffOffset = 0, cffLength = 0;
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    if (off + 16 > data.byteLength) return null;
    const tag = String.fromCharCode(data[off], data[off + 1], data[off + 2], data[off + 3]);
    if (tag === 'cmap') cmapOffset = view.getUint32(off + 8);
    else if (tag === 'CFF ') {
      cffOffset = view.getUint32(off + 8);
      cffLength = view.getUint32(off + 12);
    }
  }
  if (!cmapOffset || !cffOffset || cffOffset + cffLength > data.byteLength) return null;

  const cpToGid = new Map<number, number>();
  const numSubtables = view.getUint16(cmapOffset + 2);
  for (let i = 0; i < numSubtables; i++) {
    const subOff = cmapOffset + view.getUint32(cmapOffset + 4 + i * 8 + 4);
    if (subOff + 14 > data.byteLength) continue;
    if (view.getUint16(subOff) !== 4) continue;
    const segCount = view.getUint16(subOff + 6) >> 1;
    const endCodeOff = subOff + 14;
    const startCodeOff = endCodeOff + segCount * 2 + 2;
    const idDeltaOff = startCodeOff + segCount * 2;
    const idRangeOff = idDeltaOff + segCount * 2;
    if (idRangeOff + segCount * 2 > data.byteLength) continue;
    for (let s = 0; s < segCount; s++) {
      const endC = view.getUint16(endCodeOff + s * 2);
      const startC = view.getUint16(startCodeOff + s * 2);
      if (startC === 0xffff) break;
      const delta = view.getInt16(idDeltaOff + s * 2);
      const rangeOffset = view.getUint16(idRangeOff + s * 2);
      for (let c = startC; c <= endC; c++) {
        let gid = 0;
        if (rangeOffset === 0) gid = (c + delta) & 0xffff;
        else {
          const addr = idRangeOff + s * 2 + rangeOffset + (c - startC) * 2;
          if (addr + 2 <= data.byteLength) {
            const g = view.getUint16(addr);
            if (g !== 0) gid = (g + delta) & 0xffff;
          }
        }
        if (gid) cpToGid.set(c, gid);
      }
    }
    break;
  }
  if (!cpToGid.size) return null;

  const cff = data.subarray(cffOffset, cffOffset + cffLength);
  const readIndex = (pos: number): { items: Uint8Array[]; next: number } | null => {
    if (pos + 2 > cff.length) return null;
    const count = (cff[pos] << 8) | cff[pos + 1];
    if (count === 0) return { items: [], next: pos + 2 };
    const offSize = cff[pos + 2];
    if (offSize < 1 || offSize > 4 || pos + 3 + (count + 1) * offSize > cff.length) return null;
    const offsets: number[] = [];
    let p = pos + 3;
    for (let i = 0; i <= count; i++) {
      let v = 0;
      for (let b = 0; b < offSize; b++) v = (v << 8) | cff[p++];
      offsets.push(v);
    }
    const dataStart = p - 1;
    const end = dataStart + offsets[count];
    if (end > cff.length) return null;
    const items: Uint8Array[] = [];
    for (let i = 0; i < count; i++) items.push(cff.subarray(dataStart + offsets[i], dataStart + offsets[i + 1]));
    return { items, next: end };
  };

  const nameIdx = readIndex(cff[2]);
  const topDictIdx = nameIdx ? readIndex(nameIdx.next) : null;
  const strIdx = topDictIdx ? readIndex(topDictIdx.next) : null;
  if (!topDictIdx?.items[0] || !strIdx) return null;
  const customStrings = strIdx.items.map(bytes => String.fromCharCode(...bytes));

  const dict = topDictIdx.items[0];
  let charsetOff = 0, charStringsOff = 0;
  const operands: number[] = [];
  for (let p = 0; p < dict.length;) {
    const b0 = dict[p++];
    if (b0 <= 21) {
      const op = b0 === 12 ? 1200 + dict[p++] : b0;
      if (op === 15 && operands.length) charsetOff = operands[operands.length - 1];
      if (op === 17 && operands.length) charStringsOff = operands[operands.length - 1];
      operands.length = 0;
    } else if (b0 === 28) {
      const raw = (dict[p] << 8) | dict[p + 1];
      operands.push(raw >= 0x8000 ? raw - 0x10000 : raw);
      p += 2;
    } else if (b0 === 29) {
      operands.push((dict[p] << 24) | (dict[p + 1] << 16) | (dict[p + 2] << 8) | dict[p + 3]);
      p += 4;
    } else if (b0 >= 32 && b0 <= 246) operands.push(b0 - 139);
    else if (b0 >= 247 && b0 <= 250) operands.push((b0 - 247) * 256 + dict[p++] + 108);
    else if (b0 >= 251 && b0 <= 254) operands.push(-(b0 - 251) * 256 - dict[p++] - 108);
    else if (b0 === 30) {
      while (p < dict.length && (dict[p++] & 0x0f) !== 0x0f);
      operands.push(0);
    }
  }
  if (!charsetOff || !charStringsOff || charStringsOff + 2 > cff.length || charsetOff >= cff.length) return null;
  const nGlyphs = (cff[charStringsOff] << 8) | cff[charStringsOff + 1];
  const gidToSid = [0];
  const fmt = cff[charsetOff];
  let cp = charsetOff + 1;
  if (fmt === 0) {
    for (let g = 1; g < nGlyphs && cp + 1 < cff.length; g++) {
      gidToSid.push((cff[cp] << 8) | cff[cp + 1]);
      cp += 2;
    }
  } else if (fmt === 1 || fmt === 2) {
    while (gidToSid.length < nGlyphs && cp + (fmt === 2 ? 3 : 2) < cff.length) {
      const first = (cff[cp] << 8) | cff[cp + 1];
      cp += 2;
      const nLeft = fmt === 1 ? cff[cp++] : ((cff[cp] << 8) | cff[cp + 1]);
      if (fmt === 2) cp += 2;
      for (let k = 0; k <= nLeft && gidToSid.length < nGlyphs; k++) gidToSid.push(first + k);
    }
  }
  // PDF.js's CFFCompiler.compileCharset writes charset[0] (".notdef", SID 0) into the first
  // Format 0 slot when wrapping Type 1 fonts, shifting each glyphId's SID index by +1.
  const pdfjsNotdefShift = fmt === 0 && gidToSid[1] === 0 ? 1 : 0;
  const out = new Map<number, string>();
  for (const [codepoint, gid] of cpToGid) {
    const sid = gidToSid[gid + pdfjsNotdefShift];
    if (sid !== undefined && sid >= 391 && customStrings[sid - 391]) {
      out.set(codepoint, customStrings[sid - 391]);
    }
  }
  return out;
}

function cffGlyphsFor(font: SourceFont): Map<number, string> | null {
  if (!cffGlyphCache.has(font)) {
    cffGlyphCache.set(font, extractCffCodepointToGlyphName(font.data));
  }
  return cffGlyphCache.get(font) ?? null;
}

function mappedUnicodeChars(font: SourceFont): Set<string> | null {
  const map = font.toUnicode?._map;
  if (!Array.isArray(map)) return null;
  if (!injectiveUnicodeCache.has(font)) {
    const chars = new Set<string>();
    for (const entry of map) {
      if (typeof entry === 'string') {
        for (const ch of entry) chars.add(ch);
      }
    }
    injectiveUnicodeCache.set(font, chars);
  }
  return injectiveUnicodeCache.get(font)!;
}

function resolveGlyphUnicode(name: string | undefined): string | null {
  if (!name) return null;
  if (GLYPHS[name]) return GLYPHS[name];
  const unicode = /^(?:uni([0-9A-F]{4})|u([0-9A-F]{4,6}))$/i.exec(name);
  if (!unicode) return null;
  const point = parseInt(unicode[1] ?? unicode[2], 16);
  return point >= 32 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) && point !== 0xfffd
    ? String.fromCodePoint(point) : null;
}

export function hasUnmappedGlyphs(text: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/.test(text);
}

export function recoverEncodedGlyphs(text: string, font: SourceFont | undefined): string {
  if (!font) return text;
  let next = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, character => {
    const code = character.charCodeAt(0);
    const fc = font.toFontChar?.[code];
    const cffName = fc !== undefined ? cffGlyphsFor(font)?.get(fc) : undefined;
    const name = font.differences?.[code] ?? cffName ?? font.defaultEncoding?.[code];
    return resolveGlyphUnicode(name) ?? character;
  });
  // Printable single-byte fallback recovery: only when PDF.js had no ToUnicode entry for
  // this code, mapped its font glyph into PUA, AND no other code in this font produces the
  // same character (strict injectivity prevents corrupting real digits/letters).
  if (!font.composite && Array.isArray(font.toUnicode?._map) && Array.isArray(font.toFontChar)) {
    const mapped = mappedUnicodeChars(font)!;
    next = next.replace(/[\u0021-\u007E\u00A1-\u00FF]/g, character => {
      const code = character.charCodeAt(0);
      const hasToUnicode = font.toUnicode?.get ? font.toUnicode.get(code) != null : font.toUnicode!._map![code] !== undefined;
      if (hasToUnicode || mapped.has(character)) return character;
      const fc = font.toFontChar![code];
      if (fc === undefined || fc < 0xe000 || fc > 0xf8ff) return character;
      const name = font.differences?.[code] ?? cffGlyphsFor(font)?.get(fc);
      return resolveGlyphUnicode(name) ?? character;
    });
  }
  return next;
}

/** A centered dot painted above '=' is one relation; adjacent '=' glyphs stay separate. */
export function composeDottedEquals(items: RawItem[]): RawItem[] {
  const removed = new Set<RawItem>();
  const replacements = new Map<RawItem, RawItem>();
  for (const dot of items.filter(item => item.str === '.')) {
    const owners = items.filter(item => item.str === '=' && Math.abs(item.h - dot.h) < item.h * .15 &&
      item.y - dot.y > item.h * .4 && item.y - dot.y < item.h * .75 &&
      Math.abs(item.x + item.w / 2 - dot.x - dot.w / 2) < item.h * .12);
    if (owners.length !== 1 || replacements.has(owners[0])) continue;
    const owner = owners[0];
    replacements.set(owner, { ...owner, str: '≐', top: Math.min(owner.top ?? owner.y - owner.h * .82, dot.top ?? dot.y - dot.h * .82) });
    removed.add(dot);
  }
  return items.filter(item => !removed.has(item)).map(item => replacements.get(item) ?? item);
}
