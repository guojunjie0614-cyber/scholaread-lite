import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Block, BlockKind, TextRun } from '@shared/types';
import { extractPageRegions, multiplyMatrices, transformRect, unionRects, type Rect, type PageRegion, type Drawing } from './regions';
import { extractMathRegions } from './math';
import { MATH_EXTENSION_FONT, MATH_FONT } from './math-fonts';
import { extractTableNotes } from './table-notes';
import { parseCaption, isProseCaptionReference, isWrappedProseMention } from './captions';
import { matchFigurePlates, groupFigurePlateRows } from './figure-plates';
import { identifyAlgorithms, identifyCodeFigures } from './algorithms';
import { identifyAuthorPortraits } from './portraits';
import { lineTextRuns, linesTextRuns, joinTextRuns, filterSubSpaceItems, spaceThreshold } from './inline-text';
import { identifyFrontMatter, identifyPublicationHeaders, identifyRepeatedPublicationHeaders } from './front-matter';
import { classifyReadingRoles } from './reading-roles';
import { classifyReferences, endsReferenceSection, isBibliographicLine, isBibliographicEntryStart } from './references';
import { isReferenceHeading } from '@shared/reading-content';
import { composeDottedEquals, composeEquationNumbers, hasUnmappedGlyphs, recoverEncodedGlyphs, splitInterleavedMathRuns } from './glyph-recovery';
export const REFLOW_ENGINE_VERSION = 31;

/** Running headers and floating figures must not interrupt an unfinished sentence. */
export function orderFloatingContent<T extends Pick<Block, 'kind' | 'text' | 'readingRole'>>(blocks: T[]): T[] {
  const headers = blocks.filter(block => block.readingRole === 'publication');
  const result = blocks.filter(block => block.readingRole !== 'publication');
  for (let i = 0; i < result.length; i++) {
    const before = result[i];
    if (before.kind !== 'p' || !/[\p{L}\p{N},;:]$/u.test(before.text.trim())) continue;
    let next = i + 1;
    while (next < result.length && (result[next].kind === 'figure' || result[next].kind === 'caption')) next++;
    if (next === i + 1 || next >= result.length || result[next].kind !== 'p' ||
      !/^\p{Ll}/u.test(result[next].text.trim())) continue;
    const [continuation] = result.splice(next, 1);
    result.splice(i + 1, 0, continuation);
    i++;
  }
  return [...headers, ...result];
}
export interface RawItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bold: boolean;
  italic?: boolean;
  font: string;
  top?: number;
  bottom?: number;
  confidence?: number;
}

interface Line extends Rect {
  items: RawItem[];
  text: string;
  y: number;
  size: number;
  bold: boolean;
  readingRole?: Block['readingRole'];
}

interface Paragraph extends Rect {
  text: string;
  size: number;
  bold: boolean;
  lines: number;
  kind: BlockKind;
  textRuns: TextRun[];
  readingRole?: Block['readingRole'];
}

interface Placed {
  block: Block;
  box: Rect;
  column: number;
  footnote?: boolean;
}
type Column = {
  x0: number;
  x1: number;
};
export interface AnalyzeOptions {
  keepFigures: boolean;
  /** Document context is required before suppressing author portraits. */
  documentPageCount?: number;
  ocrPage?: (page: PDFPageProxy) => Promise<RawItem[]>;
  onProgress?: (done: number, total: number) => void;
}

const HEADING = /^(?:[IVXLC]{1,6}\.\s+|[A-Z]\.\s+|\d+(?:\.\d+)+\.?\s+)\S/;
const SECTION = /^(?:abstract|introduction|related work|background|methods?|methodology|results?|discussion|conclusions?|references|acknowledg(?:e)?ments?|appendix|摘要|引言|相关工作|方法|实验|结果|讨论|结论|参考文献|致谢)$/i;
const LIST = /^(?:[•‣▪◦■]|[-–—]\s|\d{1,2}[.)]\s|[a-z][.)]\s)/;
const PUBLICATION_NOTICE = /©\s*\d{4}|\bcopyright\b|\bauthorized licensed use\b|\brestrictions apply\b|\b97[89](?:[- ]?\d){10,}|^arxiv:|^preprint\s+doi\b/i;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const bounds = (it: RawItem): Rect => ({ x0: it.x, y0: it.top ?? it.y - it.h * .82, x1: it.x + it.w, y1: it.bottom ?? it.y + it.h * .22 });
const centerInside = (it: RawItem, r: Rect) => { const b = bounds(it), x = (b.x0 + b.x1) / 2, y = (b.y0 + b.y1) / 2; return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1; };
const xOverlap = (a: Pick<Rect, 'x0' | 'x1'>, b: Pick<Rect, 'x0' | 'x1'>) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
function bodySize(items: RawItem[]): number {
  const hist = new Map<number, number>();
  for (const it of items) {
    if (!it.str.trim())
      continue;
    const size = Math.round(it.h * 2) / 2;
    hist.set(size, (hist.get(size) ?? 0) + it.str.length);
  }
  return [...hist].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
}

function joinItems(items: RawItem[]): string {
  const sorted = filterSubSpaceItems([...items].sort((a, b) => a.x - b.x));
  let text = '', end = -Infinity, prevInk: RawItem | null = null;
  for (const it of sorted) {
    if (text && /\S/.test(it.str) && it.x - end > spaceThreshold(prevInk, it) && !(/\s$/.test(text) || /^\s/.test(it.str)))
      text += ' ';
    text += it.str;
    end = Math.max(end, it.x + it.w);
    if (/\S/.test(it.str)) prevInk = it;
  }
  return norm(text);
}
/** Preserve source order within visual baselines; whitespace items contribute actual spaces. */
function toLines(items: RawItem[], maxGap = Infinity, gutter: number | null = null): Line[] {
  const rows: Array<{
    y: number;
    items: RawItem[];
  }> = [];
  const decoration = (it: RawItem) => /^[ˆ̂˙̸¯]$/.test(it.str.trim());
  const extensionOperator = (it: RawItem) => MATH_EXTENSION_FONT.test(it.font) && /^[∫∑∏]$/.test(it.str.trim());
  // Establish main baselines before assigning smaller superscripts/subscripts.
  // CMEX operators use a top-origin font transform, not a text baseline.
  // Establish their surrounding text first, but still assign them before limits.
  const priority = (it: RawItem) => decoration(it) || !it.str.trim() && MATH_EXTENSION_FONT.test(it.font) ? 0 : extensionOperator(it) ? it.h * .84 : it.h;
  const ordered = [...items].sort((a, b) => priority(a) - priority(b)).reverse();
  for (const it of ordered) {
    const candidates = rows.filter(row => {
      const size = Math.max(...row.items.map(x => x.h));
      const offset = it.y - row.y;
      if (extensionOperator(it)) return Math.abs(row.y - (it.y + it.h * .8)) < it.h * .65 &&
        row.items.some(host => !extensionOperator(host) && host.h >= it.h * .85 &&
          it.x <= host.x + host.w + it.h * 1.5 && it.x + it.w >= host.x - it.h * 1.5);
      if (Math.abs(offset) <= Math.max(1, size * .14)) return true;
      if (it.h >= size * .88 && !decoration(it)) return Math.abs(offset) <= Math.max(2, size * .30);
      // Descenders move much less than superscripts. A symmetric nearest-row
      // window assigns a high exponent to the preceding tightly spaced line.
      if (offset < -size * (it.h < size * .56 ? 1.25 : .75) || offset > size * (it.h < size * .56 ? .85 : .65)) return false;
      if (/^[′″‴]+$/.test(it.str.trim()) && offset > size * .1) return false;
      return row.items.some(host => (host.h >= size * .88 && Math.abs(host.y - row.y) <= size * .25 && offset >= -size * .75 && offset <= size * .65 ||
          it.h < host.h * .8 && Math.abs(it.y - host.y) <= host.h * .65) &&
        (offset <= size * .38 || /[\p{L}\p{N})\]}]$/u.test(host.str.trim())) &&
        it.x <= host.x + host.w + size * .85 && it.x + it.w >= host.x - size * .5);
    });
    candidates.sort((a, b) => {
      const distance = (row: typeof a) => Math.min(...row.items.map(host =>
        Math.max(0, it.x - (host.x + host.w), host.x - (it.x + it.w)) + Math.abs(host.y - it.y) * .3));
      return distance(a) - distance(b);
    });
    if (candidates[0])
      candidates[0].items.push(it);
    else
      rows.push({ y: it.y, items: [it] });
  }
  // A subscript may arrive right-to-left: its last glyph can start a small
  // row before the glyph beside the host is visited. Reattach the whole row
  // once its horizontal extent makes that host unambiguous.
  for (const row of [...rows]) {
    const rowSize = Math.max(...row.items.map(it => it.h));
    const candidates = rows.filter(host => host !== row).flatMap(host => {
      const hostMax = Math.max(...host.items.map(x => x.h));
      return host.items.filter(h => h.h > rowSize / .88 || (hostMax > rowSize / .88 && Math.abs(h.y - host.y) <= Math.max(1, h.h * .2)))
        .map(h => ({ host, size: Math.max(h.h, hostMax), offset: row.y - h.y,
          distance: Math.min(...row.items.map(it => Math.max(0, it.x - (h.x + h.w), h.x - (it.x + it.w)))) }));
    })
      .filter(x => x.offset >= -x.size * (rowSize < x.size * .56 ? .95 : .75) && x.offset <= x.size * .65 && x.distance <= x.size * .5 &&
        (!row.items.every(it => /^[′″‴]+$/.test(it.str.trim())) || x.offset <= x.size * .1))
      .sort((a, b) => a.distance - b.distance || Math.abs(a.offset) - Math.abs(b.offset));
    if (candidates[0]) {
      candidates[0].host.items.push(...row.items);
      rows.splice(rows.indexOf(row), 1);
    }
  }
  const lines: Line[] = [];
  for (const row of rows) {
    const sorted = row.items.sort((a, b) => a.x - b.x);
    // Sharing a baseline never joins independent columns. Only an actual ink item
    // or ordinary word spacing bridging the gutter is evidence of a full-width row.
    const rowInk = sorted.filter(it => it.str.trim());
    const rowSize = rowInk.length ? Math.max(...rowInk.map(x => x.h)) : 10;
    const bridgesGutter = gutter !== null && (
      rowInk.some(it => it.x < gutter - 2 && it.x + it.w > gutter + 2) ||
      rowInk.some((it, idx) => idx > 0 && rowInk[idx - 1].x < gutter - 2 && it.x + it.w > gutter + 2 &&
        rowInk[idx - 1].x + rowInk[idx - 1].w <= gutter + 4 && it.x >= gutter - 4 &&
        it.x - (rowInk[idx - 1].x + rowInk[idx - 1].w) <= Math.max(5, rowSize * .75))
    );
    const splitColumns = gutter !== null && !bridgesGutter;
    let group: RawItem[] = [];
    let end = -Infinity;
    const flush = () => {
      if (!group.some(x => x.str.trim()))
        return;
      const box = unionRects(group.map(bounds));
      const ink = group.filter(x => x.str.trim());
      lines.push({
        ...box,
        items: group,
        text: joinItems(group),
        y: row.y,
        size: Math.max(...ink.map(x => x.h)),
        bold: ink.filter(x => x.bold).reduce((s, x) => s + x.str.length, 0) > ink.reduce((s, x) => s + x.str.length, 0) * .65
      });
    };
    for (const it of sorted) {
      const crossesColumn = gutter !== null && splitColumns && group.length > 0 &&
        group[0].x + group[0].w / 2 < gutter && it.x + it.w / 2 >= gutter;
      if (group.length && (it.x - end > maxGap || crossesColumn)) {
        flush();
        group = [];
      }
      group.push(it);
      end = it.x + it.w;
    }
    flush();
  }
  return lines.sort((a, b) => a.y - b.y || a.x0 - b.x0);
}
/** Require a persistent inter-column gap wider than ordinary word spacing. */
export function detectGutter(items: RawItem[], pageWidth: number): number | null {
  if (items.filter(x => x.str.trim()).length < 12)
    return null;
  const body = bodySize(items);
  // Gutter evidence comes from horizontal bands, not semantic text baselines.
  // Adjacent columns may use different fonts/line spacing (body vs references);
  // their ink still bounds a persistent whitespace corridor.
  const rows: Array<{ y: number; items: RawItem[] }> = [];
  for (const item of [...items].sort((a, b) => b.h - a.h)) {
    const row = rows.filter(row => Math.abs(row.y - item.y) <= Math.max(2, item.h * .55, ...row.items.map(x => x.h * .65)))
      .sort((a, b) => Math.abs(a.y - item.y) - Math.abs(b.y - item.y))[0];
    if (row) row.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }
  for (const row of rows) row.items.sort((a, b) => a.x - b.x);
  let best: {
    x: number;
    score: number;
  } | null = null;
  for (let x = pageWidth * .30; x <= pageWidth * .70; x += 1) {
    let support = 0, cross = 0;
    for (const row of rows) {
      const ink = row.items.filter(it => it.str.trim());
      const left = ink.filter(it => it.x + it.w <= x), right = ink.filter(it => it.x >= x);
      if (ink.some(it => it.x < x && it.x + it.w > x)) {
        cross++;
        continue;
      }
      if (!left.length || !right.length)
        continue;
      const l = Math.max(...left.map(it => it.x + it.w)), r = Math.min(...right.map(it => it.x));
      const gaps = ink.slice(1).map((it, i) => it.x - (ink[i].x + ink[i].w)).filter(g => g > 1).sort((a, b) => a - b);
      const ordinaryGap = gaps.length >= 4 ? gaps[Math.floor(gaps.length / 2)] : 0;
      if (r - l >= Math.max(8, body * .8) && r - l > ordinaryGap * 1.6 && x - l >= 2 && r - x >= 2)
        support++;
    }
    if (support < 4 || support < rows.length * .16)
      continue;
    const score = support - cross * .3 - Math.abs(x - pageWidth / 2) * .04;
    if (score > 0 && (!best || score > best.score))
      best = { x, score };
  }
  return best?.x ?? null;
}

function columnsFor(items: RawItem[], width: number, gutter: number | null): Column[] {
  if (gutter === null)
    return [{ x0: Math.min(...items.map(x => x.x)), x1: Math.max(...items.map(x => x.x + x.w)) }];
  return [[0, gutter], [gutter, width]].map(([lo, hi]) => {
    const own = items.filter(it => it.x >= lo - 1 && it.x + it.w <= hi + 1 && it.str.trim());
    return {
      x0: own.length ? Math.min(...own.map(x => x.x)) : lo,
      x1: own.length ? Math.max(...own.map(x => x.x + x.w)) : hi
    };
  });
}

function lineKind(line: Line, body: number, page: number): BlockKind {
  const text = line.text;
  if (!isBibliographicLine(text) && HEADING.test(text) && text.length < 130 && (!/^\d/.test(text) || line.bold || line.size > body * 1.1))
    return /^\d+\.\d+\.\d+/.test(text) ? 'h3' : /^[A-H]\./.test(text) ? 'h3' : 'h2';
  if (SECTION.test(text))
    return 'h2';
  if (page === 1 && line.size >= body * 1.5 && text.length < 240)
    return 'h1';
  if (line.bold && line.size >= body * 1.08 && text.length < 120)
    return 'h3';
  if (LIST.test(text))
    return 'li';
  if (isBibliographicEntryStart(text))
    return 'ref';
  return 'p';
}

const COMPOUND_PREFIX = /^(?:non|self|multi|cross|co|re|pre|post|anti|semi|quasi|sub|super|ultra|inter|intra|macro|micro|mini|mono|bi|tri|quad|poly|auto|meta|para|proto|pseudo|neo|pan|vice|ex|all|full|half|low|high|mid|wide|narrow|long|short|fast|slow|hard|soft|real|single|double|triple|dual|two|three|four|five|six|seven|eight|nine|ten|first|second|third|one|zero|well|ill|best|least|most|less|more|near|far|off|on|in|out|up|down|over|under|back|front|side|top|bottom|left|right|hand|eye|head|base|state|time|space|rate|bit|byte|word|line|row|col|column|page|block|cell|node|edge|path|tree|graph|net|network|mesh|grid|ring|bus|port|link|channel|band|wave|beam|pulse|clock|phase|mode|step|stage|level|tier|layer|plane|domain|field|zone|region|area|point|spot|site|end|start|mid|center|core|edge|shell|frame|box|case|set|group|class|type|kind|form|style|model|scheme|method|rule|law|norm|bound|limit|range|scale|size|width|length|height|depth|mass|weight|load|force|power|energy|heat|light|sound|noise|signal|data|code|key|tag|flag|mark|sign|token|item|unit|part|piece|ank|bank|array|list|table|map|pair|tuple|vector|matrix|tensor|scalar|rank|order|degree|grade|score|rate|ratio|factor|index|value|cost|price|fee|tax|gain|loss|risk|error|fault|bug|gap|drop|rise|shift|jump|step|turn|spin|roll|pitch|yaw|flow|stream|wave|current|voltage|charge|flux|field|gate|source|drain|bulk|well|oxide|metal|wire|line|track|trace|pad|pin|via|hole|slot|gap|fin|sheet|layer|film|stack|die|chip|core|tile|slice|bank|mat|subarray|row|column|cell|bitline|wordline|crossbar|memristor|resistor|capacitor|inductor|transistor|diode|laser|sensor|detector|actuator|motor|pump|valve|filter|mixer|amp|amplifier|oscillator|pll|adc|dac|mux|demux|alu|mac|fpu|cpu|gpu|npu|tpu|fpga|asic|soc|noc|pim|cim|cam|tcams|sram|dram|rram|reram|pcm|mram|feffet|fefet|flash|rom|ram|fifo|lifo|lut|bram|dsp|pe|se|cu|sm|warp|thread|task|job|work|workload|benchmark|dataset|test|train|val|eval|run|pass|cycle|epoch|batch|sample|token|word|char|pixel|voxel|patch|frame|clip|view|shot|pose|track|object|person|face|hand|body|car|road|lane|sign|light|tree|sky|building|room|wall|floor|door|window|chair|table|bed|sofa|lamp|book|paper|doc|file|folder|dir|path|url|uri|api|sdk|cli|gui|ui|ux|os|vm|db|sql|xml|json|yaml|html|css|js|ts|py|cpp|rust|go|java|fine|coarse|large|small|big|tiny|huge|vast|deep|shallow|thick|thin|flat|steep|sharp|blunt|smooth|rough|clean|dirty|pure|mixed|raw|cooked|dry|wet|hot|cold|warm|cool|bright|dark|dim|clear|blurry|loud|quiet|strong|weak|heavy|light|dense|sparse|tight|loose|stiff|soft|rigid|flexible|stable|unstable|static|dynamic|fixed|free|open|closed|public|private|local|global|inner|outer|upper|lower|early|late|old|new|young|fresh|stale|good|bad|fine|poor|rich|lean|fat|thick|thin|true|false|right|wrong|safe|unsafe|sure|unsure|easy|hard|simple|complex|plain|fancy|common|rare|odd|even|main|sub|aux|extra|spare|free|busy|idle|live|dead|active|passive|online|offline|inline|outline|onchip|offchip|inmemory|near|far|pre|post|co|re|de|un|non|mis|dis|over|under|out|up|down|cross|counter|fore|inter|intra|mid|mini|multi|non|over|post|pre|pro|re|self|semi|sub|super|trans|twi|ultra|un|under)$/i;

const COMPOUND_SUFFIX = /^(?:based|driven|aware|free|like|wise|wide|side|time|space|scale|level|stage|step|rate|mode|type|style|form|kind|class|set|group|band|width|length|height|depth|size|range|bound|limit|point|line|plane|field|zone|area|region|domain|layer|tier|shell|core|unit|part|block|cell|node|edge|path|net|mesh|grid|ring|bus|port|link|channel|wave|beam|pulse|clock|phase|flow|stream|current|voltage|power|energy|force|load|mass|weight|cost|gain|loss|risk|error|fault|gap|drop|rise|shift|jump|turn|spin|roll|pitch|yaw|ratio|factor|index|value|score|grade|degree|order|rank|matrix|vector|tensor|array|list|table|map|pair|tree|graph|model|scheme|method|rule|law|norm|system|network|circuit|device|sensor|detector|filter|amplifier|processor|controller|converter|inverter|driver|buffer|memory|storage|cache|register|counter|timer|adder|multiplier|divider|decoder|encoder|multiplexer|comparator|correlator|estimator|predictor|classifier|regressor|detector|tracker|segmenter|generator|discriminator|academia|industry|specific|independent|dependent|oriented|centric|friendly|ready|safe|proof|resistant|tolerant|sensitive|insensitive|variant|invariant|linear|nonlinear|stationary|nonstationary|symmetric|asymmetric|synchronous|asynchronous|parallel|serial|digital|analog|mixed|hybrid|local|global|static|dynamic|active|passive|online|offline|inline|chip|memory|package|board|die|wafer|gate|source|drain|bulk|oxide|metal|wire|track|pad|pin|via|fin|sheet|film|stack|tile|slice|bank|mat|row|column|crossbar|bit|byte|word|page|frame|packet|flit|phit|cycle|step|pass|run|test|train|eval|workload|benchmark|dataset|record|records|candidate|candidates|architecture|algorithm|design|co-design|codesign|refinement|grained|dimensional|order|precision|accuracy|resolution|speed|throughput|latency|efficiency|density|capacity|bandwidth|overhead|margin|budget|constraint|constrained|coupled|decoupled|assisted|guided|induced|triggered|controlled|modulated|regulated|stabilized|calibrated|compensated|optimized|accelerated|enabled|disabled|configured|connected|disconnected|coupled|isolated|integrated|embedded|distributed|centralized|federated|hierarchical|modular|scalable|reconfigurable|programmable|adaptive|programmable|tunable|adjustable|selectable|switchable|reversible|irreversible)$/i;

function shouldKeepHyphen(left: string, right: string): boolean {
  const headMatch = left.match(/([A-Za-z0-9-]+)-$/);
  const tailMatch = right.match(/^([A-Za-z0-9-]+)/);
  if (!headMatch || !tailMatch) return true;
  const rawHead = headMatch[1], rawTail = tailMatch[1];
  const head = rawHead.split('-').pop()!;
  const tail = rawTail.split('-')[0];
  if (/\d/.test(rawHead) || /\d/.test(rawTail)) return true;
  if (/^[A-Z]/.test(tail) || (head.length > 1 && /^[A-Z]+$/.test(head))) return true;
  if (/^[A-Za-z]$/.test(rawHead)) return true;
  if (rawHead.includes('-')) {
    return COMPOUND_PREFIX.test(head) || COMPOUND_SUFFIX.test(tail);
  }
  const h = head.toLowerCase(), t = tail.toLowerCase();
  if (/^(?:self|multi|non|cross|quasi|semi|anti|post|ultra|intra|macro|micro|mini|mono|poly|auto|meta|proto|pseudo|neo|pan|vice|all|full|half|low|high|mid|wide|long|short|fast|slow|soft|real|single|double|triple|dual|two|three|four|five|first|second|third|one|zero|well|ill|best|least|most|less|more|near|far|off|on|out|up|down|over|under|back|front|side|top|bottom|left|right|fine|coarse|large|small|big|tiny|deep|shallow|flat|sharp|smooth|rough|clean|pure|mixed|raw|dry|wet|hot|cold|warm|cool|bright|dark|clear|loud|quiet|strong|weak|heavy|light|dense|sparse|tight|loose|stiff|rigid|stable|static|fixed|free|open|closed|public|private|local|global|inner|outer|upper|lower|early|late|old|new|good|bad|rich|lean|true|false|safe|easy|simple|plain|common|rare|odd|even|main|extra|spare|busy|idle|live|dead|active|passive|online|offline|inline)$/.test(h)) return true;
  if (/^(?:co|re|pre|de|un|in|im|dis|mis|sub|inter|trans|super|counter|out|over|under)$/.test(h)) {
    if (h === 'co' && /^(?:design|designed|designs|designing|author|authors|authored|locate|located|location|operate|operation|operative|optimize|optimization|processor|processors|processing|simulation|simulations|exist|existence|existing|adaptation|adaptive|evolution|evolving|ordinate|ordinates|ordination|planar|prime|worker|workers|working|founder|founders|pilot|channel|channels|variance|variant|variants|occurrence|occurring|opt|opted|opting|pay|payment|produce|production|star|stars|teacher|teaching|terminous|tracker|tracking|train|training|verification|verify)$/.test(t)) return true;
    if (h === 're' && /^(?:enter|entries|entry|establish|established|establishing|evaluate|evaluated|evaluation|examine|examined|examination|elect|elected|election|enact|enacted|energize|engineer|engineered|engineering|ice|ink|issue|issued|orient|oriented|orientation|open|opened|opening|order|ordered|ordering|organize|organized|organization|read|reading|run|running|use|used|using|write|writing)$/.test(t)) return true;
    if (h === 'pre' && /^(?:existing|war|workout|school|process|processed|processing|processor|processors|amplify|amplifier|amplifiers|charge|charged|charging|chargers|compile|compiled|compiler|compute|computed|computing|condition|conditioned|conditioning|conditioner|configure|configured|configuration|decode|decoded|decoder|decoding|define|defined|emphasis|emphatic|empt|emption|emptive|fabricate|fabricated|fetch|fetched|fetching|filter|filtered|filtering|heat|heated|heating|lay|layout|load|loaded|loading|paid|pay|program|programmed|programming|record|recorded|recording|register|registered|registration|release|released|requisite|requisites|route|routed|routing|scale|scaled|scaler|scaling|select|selected|selection|selector|set|setting|sort|sorted|sorting|store|stored|storing|train|trained|training|treat|treated|treatment|view|viewed|viewing|warm|warmed|warming)$/.test(t)) return true;
    if (h === 'in' && /^(?:memory|chip|situ|line|plane|phase|place|order|band|loop|house|depth|flight|focus|group|kind|law|laws|network|package|patient|person|pixel|play|point|process|Sensor|sensor|service|sight|source|specie|state|step|store|stream|system|tank|target|text|time|touch|transit|turn|use|vitro|vivo|wall|water|world)$/.test(t)) return true;
    if (h === 'sub' && /^(?:array|arrays|band|bands|block|blocks|channel|channels|circuit|circuits|class|classes|clock|clocks|column|columns|component|components|cycle|cycles|domain|domains|field|fields|figure|figures|frame|frames|graph|graphs|group|groups|grid|grids|image|images|interval|intervals|item|items|layer|layers|line|lines|list|lists|Map|map|maps|matrix|matrices|menu|menus|micron|mm|model|models|module|modules|ms|net|nets|network|networks|node|nodes|ns|optimal|page|pages|panel|panels|part|parts|path|paths|pattern|patterns|phase|phases|pixel|pixels|plane|planes|problem|problems|process|processes|program|programs|project|projects|region|regions|ring|rings|routine|routines|row|rows|sample|samples|Sampling|sampling|scale|scales|scheme|schemes|section|sections|sequence|sequences|set|sets|space|spaces|stage|stages|state|states|step|steps|stream|streams|string|strings|structure|structures|system|systems|table|tables|task|tasks|tensor|tensors|test|tests|text|texts|threshold|tile|tiles|topic|topics|total|tree|trees|type|types|unit|units|value|values|vector|vectors|view|views|window|windows|word|words|zone|zones|zero|diagonal)$/.test(t)) return true;
    return false;
  }
  if (COMPOUND_PREFIX.test(h) && COMPOUND_SUFFIX.test(t) && h.length >= 3 && t.length >= 3) return true;
  if (COMPOUND_SUFFIX.test(t) && h.length >= 4 && !/^(?:tion|sion|ment|ness|ance|ence|able|ible|ture|tive|less|ship|hood|ward|wise)$/.test(t)) {
    const joined = h + t;
    if (!/^(?:perform|inform|transform|conform|deform|reform|platform|uniform|algorithm|logarithm|arithmetic|character|temperature|literature|architecture|manufacture|infrastructure|microstructure|superstructure|substructure|nomenclature|expenditure|legislature|candidature|investiture|miniature|caricature|signature|curvature|armature|ligature|aperture|overture|conjecture|lecture|picture|structure|culture|nature|feature|creature|future|mature|capture|rapture|rupture|sculpture|tea|measure|pleasure|treasure|closure|exposure|composure|enclosure|disclosure|foreclosure|erasure|leisure|seizure|fissure|pressure|assure|ensure|insure|reassure|procure|secure|obscure|endure|manure|tenure|venture|adventure|indenture|jointure|posture|gesture|vesture|texture|mixture|fixture|tincture|juncture|puncture|acupuncture|stricture|depicture|configure|reconfigure|disfigure|transfigure|prefigure|hardware|software|firmware|middleware|malware|spyware|adware|freeware|shareware|groupware|courseware|bloatware|vaporware|tableware|glassware|silverware|cookware|kitchenware|earthenware|stoneware|ironware|tinware|woodenware|houseware|giftware|holloware|flatware|stemware|drinkware|bakeware|serveware|ovens|warehouse|aware|unaware|beware|square|compare|prepare|declare|welfare|warfare|fanfare|thoroughfare|airfare|busfare|cabfare|carfare|seafare|wayfare|fieldfare|chaffinch|nightmare|share|spare|stare|glare|flare|scare|snare|bare|care|dare|fare|hare|mare|pare|rare|tare|ware|yare)/.test(joined))
      return true;
  }
  return false;
}

function joinLines(left: string, right: string): string {
  if (/\u00ad$/.test(left))
    return left.slice(0, -1) + right;
  if (/[a-z]-$/i.test(left) && /^[a-z]/i.test(right)) {
    return shouldKeepHyphen(left, right) ? left + right : left.slice(0, -1) + right;
  }
  if (/[\u3400-\u9fff]$/.test(left) && /^[\u3400-\u9fff]/.test(right))
    return left + right;
  return `${left} ${right}`;
}

/**
 * Theses set body text at 1.5–2× leading; a fixed 1.75× gap would cut every line into
 * its own paragraph. Returns a paragraph-break gap from the dominant body-line pitch
 * (0 when there is too little evidence, leaving the fixed thresholds in charge).
 */
function dominantLeading(lines: Line[], body: number): number {
  const votes = new Map<number, number>();
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i], gap = b.y - a.y;
    if (Math.abs(a.size - body) > 1 || Math.abs(b.size - body) > 1 || gap <= 0 || gap > body * 3 || xOverlap(a, b) <= 0) continue;
    const key = Math.round(gap * 2) / 2;
    votes.set(key, (votes.get(key) ?? 0) + 1);
  }
  const [pitch, count] = [...votes].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] ?? [0, 0];
  return count >= 3 ? pitch * 1.3 : 0;
}

function paragraphs(lines: Line[], body: number, page: number, referenceState = { active: false }, leadingHint?: number): Paragraph[] {
  const out: Paragraph[] = [];
  let prev: Line | null = null;
  let inReferences = referenceState.active;
  const right = Math.max(...lines.map(l => l.x1));
  const leading = leadingHint ?? dominantLeading(lines, body);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], next = lines[index + 1], afterNext = lines[index + 2];
    let kind = line.readingRole === 'title' ? 'h1' as const : line.readingRole ? 'p' as const : lineKind(line, body, page);
    const last = out[out.length - 1];
    // A decimal value or single-letter equation symbol at the start of a wrapped line is not a section heading.
    const wrappedDecimal = /^(?:\d+\.\d+|[A-Z]\.)\s/.test(line.text) && last?.kind === 'p' && prev &&
      !/[.!?;:。！？]$/.test(prev.text) && last.x1 - last.x0 > body * 12 && prev.x1 >= last.x1 - body * 2.5 &&
      Math.abs(line.x0 - prev.x0) < body * .5 && line.y - prev.y > 0 && line.y - prev.y < body * 1.75;
    if (/^h[23]$/.test(kind) && wrappedDecimal) kind = 'p';
    const headingGap = next && (next.y - line.y > body * 1.4 ||
      next.x0 > line.x0 + body && afterNext && afterNext.y - next.y > body * 1.4);
    if (!wrappedDecimal && !line.readingRole && kind === 'p' && /^\d+(?:\.\d+)*\s+[A-Z]/.test(line.text) &&
      line.text.length < 120 && !/[.!?。！？]$/.test(line.text) && headingGap &&
      (!prev || line.y - prev.y > body * 1.4)) kind = 'h2';
    if (kind === 'p' && (last?.kind === 'h2' || last?.kind === 'h3') && prev && !/[.!?。！？]$/.test(line.text) && line.y - prev.y < body * 1.35 &&
      ((/^\d+(?:\.\d+)*\s/.test(last.text) && line.x0 > last.x0 + body && next && next.y - line.y > body * 1.4) ||
       (/^[IVXLC]{1,6}\.\s+/.test(last.text) && !/[a-z]{3}/.test(prev.text) && !/[a-z]{3}/.test(line.text) &&
        Math.abs((line.x0 + line.x1) / 2 - (prev.x0 + prev.x1) / 2) <= body * 2.5) ||
       (last.kind === 'h3' && /^[A-Z]\.\s+/.test(last.text) && !/[.!?;:。！？]$/.test(prev.text) &&
        line.x0 >= last.x0 + body * .4 && Math.abs(line.size - prev.size) <= .8 &&
        next && next.y - line.y > line.y - prev.y + 1))) kind = last.kind;
    const referenceHeading = isReferenceHeading({ kind, text: line.text });
    if (referenceHeading) inReferences = true;
    else if (endsReferenceSection(line.text)) inReferences = false;
    else if (inReferences && !line.readingRole && (/^\[\d+\]/.test(line.text) || isBibliographicLine(line.text) || /^h[23]$/.test(kind))) kind = 'ref';
    // Heading-less bibliographies can continue with organization-led entries.
    // Require a preceding real entry or the next consecutive entry's strong
    // author/publishing evidence; an isolated “[36] to achieve ...” stays prose.
    const marker = /^\[(\d+)\]/.exec(line.text);
    if (!inReferences && !line.readingRole && kind === 'p' && marker) {
      const following = lines.slice(index + 1, index + 9).find(candidate => /^\[\d+\]/.test(candidate.text));
      const nextNumber = following?.text.match(/^\[(\d+)\]/)?.[1];
      if (last?.kind === 'ref' || following && Number(nextNumber) === Number(marker[1]) + 1 && isBibliographicEntryStart(following.text)) kind = 'ref';
    }
    const startsItem = kind === 'li' || kind === 'ref' && /^\[\d+\]/.test(line.text);
    const continuesItem = last && prev && kind === 'p' &&
      (last.kind === 'li' || last.kind === 'ref') &&
      (line.x0 >= last.x0 + (last.kind === 'ref' ? -.5 : body * .3) ||
        last.kind === 'li' && /^[•‣▪◦■]/.test(last.text) && line.x0 >= last.x0 - body * 1.2 && !/[.!?;:]$/.test(prev.text)) &&
      line.y - prev.y < body * 1.75;
    if (continuesItem) kind = last.kind;
    const indented = prev && line.x0 - prev.x0 > body * .8 &&
      (/[.!?;:。！？]$/.test(prev.text) || line.y - prev.y > body * 1.4);
    const shortEnd = prev && prev.x1 < right - body * 2.5 && /[.!?。！？]$/.test(prev.text);
    const newParagraph = !last || !prev || kind !== last.kind || line.readingRole !== last.readingRole || startsItem ||
      hasUnmappedGlyphs(line.text) || hasUnmappedGlyphs(prev.text) ||
      line.y - prev.y > Math.max(body * 1.75, prev.size * 1.8, leading) ||
      Math.abs(line.size - prev.size) > 1.4 || (kind === 'p' && !line.readingRole && (indented || shortEnd));
    if (newParagraph)
      out.push({ ...line, text: line.text, textRuns: lineTextRuns(line), size: line.size, bold: line.bold, lines: 1, kind });
    else {
      last.text = norm(joinLines(last.text, line.text));
      last.textRuns = joinTextRuns(last.textRuns, lineTextRuns(line), last.text);
      Object.assign(last, unionRects([last, line]));
      last.lines++;
    }
    prev = line;
  }
  referenceState.active = inReferences;
  return out;
}

function prevInColumn(lines: Line[], index: number): Line | undefined {
  const target = lines[index];
  for (let k = index - 1; k >= 0; k--) {
    const candidate = lines[k];
    if (xOverlap(candidate, target) > Math.min(candidate.x1 - candidate.x0, target.x1 - target.x0) * .35 ||
        Math.abs((candidate.x0 + candidate.x1) / 2 - (target.x0 + target.x1) / 2) <= target.size * 6) {
      return candidate;
    }
  }
  return undefined;
}

function canContinueCaption(
  first: Line,
  last: Line,
  next: Line,
  body: number,
  pageNumber: number,
  rightLimit?: number,
): boolean {
  if (parseCaption(next.text) || lineKind(next, body, pageNumber) !== 'p') return false;
  if (next.y - last.y <= first.size * .2 || next.y - last.y > Math.max(first.size * 1.75, body * 1.5)) return false;
  if (Math.abs(next.size - first.size) > 1.2) return false;
  const label = parseCaption(first.text);
  if (label?.kind === 'table' && last !== first && !/[a-z]{3}/.test(first.text) && !/[a-z]{3}/.test(last.text) &&
      /[a-z]{3}/.test(next.text) && next.y - last.y > (last.y - first.y) * 1.15) return false;
  const shortTableHead = label?.kind === 'table' && first.x1 - first.x0 < body * 14;
  const centered = Math.abs((next.x0 + next.x1) / 2 - (first.x0 + first.x1) / 2) <= body * 3 &&
    (shortTableHead || (next.x0 >= first.x0 - body * 1.5 && next.x1 <= first.x1 + body * 1.5));
  const leftAligned = next.x0 >= first.x0 - first.size * 1.5 && next.x0 <= first.x0 + body * 2.2 &&
    next.x1 <= Math.max(first.x1, last.x1) + first.size * 2 && next.x1 >= first.x0;
  if (!centered && !leftAligned) return false;
  const prevEnded = /[.!?。！？]$/.test(last.text.trim());
  const rightEdge = Math.max(first.x1, last.x1, rightLimit ?? 0);
  if (prevEnded && last.x1 < rightEdge - first.size * 3) return false;
  if (prevEnded && !shortTableHead && next.x0 - first.x0 > first.size * .8 && next.x0 - last.x0 > first.size * .8) return false;
  return true;
}

/** pdfplumber-style snap & join for collinear segmented horizontal table rules. */
function joinHorizontalRules(drawings: Drawing[]): Drawing[] {
  const rules = drawings
    .filter(r => r.horizontal || (r.kind === 'path' && r.y1 - r.y0 < 2.2 && r.x1 - r.x0 >= 3))
    .map(r => ({ ...r }))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const joined: Drawing[] = [];
  for (const r of rules) {
    const prev = joined.find(p => Math.abs(p.y0 - r.y0) <= 2 && r.x0 <= p.x1 + 8 && r.x1 >= p.x0 - 8);
    if (prev) {
      prev.x0 = Math.min(prev.x0, r.x0);
      prev.y0 = Math.min(prev.y0, r.y0);
      prev.x1 = Math.max(prev.x1, r.x1);
      prev.y1 = Math.max(prev.y1, r.y1);
    } else {
      joined.push(r);
    }
  }
  return joined.filter(r => r.x1 - r.x0 > 30);
}

/** Find horizontal rule bands of tables so internal table column gaps do not pollute detectGutter. */
function tableRuleBands(drawings: Drawing[], pageHeight: number): Rect[] {
  const rules = joinHorizontalRules(drawings).filter(r => r.x1 - r.x0 > 80);
  const bands: Rect[] = [];
  const used = new Set<Drawing>();
  for (const top of rules) {
    if (used.has(top)) continue;
    const aligned = rules.filter(r => !used.has(r) && r.y0 >= top.y0 - 2 && r.y1 - top.y0 < pageHeight * .75 &&
      Math.abs(r.x0 - top.x0) < 12 && Math.abs(r.x1 - top.x1) < 12);
    if (aligned.length >= 2) {
      const box = unionRects(aligned);
      if (box.y1 - box.y0 >= 14) {
        aligned.forEach(r => used.add(r));
        bands.push(box);
      }
    }
  }
  return bands;
}

function identifyTables(
  lines: Line[],
  drawings: Drawing[],
  visibleRegions: PageRegion[],
  cols: Column[],
  body: number,
  pageNumber: number,
  height: number,
): PageRegion[] {
  const tables: PageRegion[] = [];
  const hRules = joinHorizontalRules(drawings);
  const captions: Array<{ first: Line; box: Rect }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const label = parseCaption(line.text);
    if (label?.kind !== 'table' || isProseCaptionReference(label) || isWrappedProseMention(prevInColumn(lines, i), line)) continue;
    const parts = [line];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j], last = parts[parts.length - 1];
      if (xOverlap(next, line) === 0 && Math.abs((next.x0 + next.x1) / 2 - (line.x0 + line.x1) / 2) > body * 6) continue;
      const cx = (line.x0 + line.x1) / 2;
      if (hRules.some(r => r.y0 > last.y0 && r.y0 < next.y1 && r.x0 < cx && r.x1 > cx && r.x1 - r.x0 > 80)) break;
      if (parts.length >= 2 && !/[a-z]{3}/.test(last.text) && /[a-z]{3}/.test(next.text) &&
          hRules.some(r => r.y0 >= next.y1 - 1 && r.y0 - next.y1 <= 4 && r.x0 < cx && r.x1 > cx && r.x1 - r.x0 > 80)) break;
      if (!canContinueCaption(line, last, next, body, pageNumber)) break;
      parts.push(next);
    }
    captions.push({ first: line, box: unionRects(parts) });
  }
  for (let idx = 0; idx < captions.length; idx++) {
    const { first: caption, box: captionBox } = captions[idx];
    const cx = (captionBox.x0 + captionBox.x1) / 2;
    const spansGutter = cols.length > 1 && captionBox.x0 < cols[0].x1 - 4 && captionBox.x1 > cols[1].x0 + 4;
    const col = spansGutter
      ? { x0: cols[0].x0, x1: cols[cols.length - 1].x1 }
      : (cols.find(c => cx >= c.x0 && cx <= c.x1) ?? { x0: cols[0].x0, x1: cols[cols.length - 1].x1 });
    const nextCaption = captions.slice(idx + 1).find(c => c.box.y0 > captionBox.y0 && c.box.x0 < col.x1 && c.box.x1 > col.x0);
    const limitY = nextCaption?.box.y0 ?? height * .96;
    const rawRulesBelow = hRules.filter(r => r.y0 > caption.y && r.y1 < limitY && r.x1 - r.x0 > 60).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const wideTop = rawRulesBelow.find(r => r.y0 - captionBox.y1 <= 65 && r.x0 < cx && r.x1 > cx &&
      cols.length > 1 && r.x0 < cols[0].x1 - 4 && r.x1 > cols[1].x0 + 4);
    const spanX0 = Math.min(col.x0, captionBox.x0, wideTop ? cols[0].x0 : col.x0);
    const spanX1 = Math.max(col.x1, captionBox.x1, wideTop ? cols[cols.length - 1].x1 : col.x1);
    // Side-by-side subtables under one caption (e.g. C2-LSM Table I) share y-aligned horizontal rules across the span.
    const mergedRules: Drawing[] = [];
    for (const r of rawRulesBelow) {
      if (r.x0 < spanX0 - 12 || r.x1 > spanX1 + 12) continue;
      const sameY = mergedRules.find(m => Math.abs(m.y0 - r.y0) <= 2);
      if (sameY) {
        sameY.x0 = Math.min(sameY.x0, r.x0);
        sameY.y0 = Math.min(sameY.y0, r.y0);
        sameY.x1 = Math.max(sameY.x1, r.x1);
        sameY.y1 = Math.max(sameY.y1, r.y1);
      } else {
        mergedRules.push({ ...r });
      }
    }
    const rules = mergedRules.filter(r => r.x0 < cx && r.x1 > cx && r.x1 - r.x0 > 80).sort((a, b) => a.y0 - b.y0);
    const top = rules[0];
    if (top && top.y0 - captionBox.y1 <= 65) {
      const maxRuleWidth = Math.max(...rules.filter(r => r.y0 - captionBox.y1 <= 85).map(r => r.x1 - r.x0));
      const fullRules = rules.filter(r => r.x1 - r.x0 >= maxRuleWidth - 12);
      const bottomFull = fullRules[fullRules.length - 1];
      if (bottomFull && (bottomFull !== top || rules.length >= 2)) {
        const tableRules = mergedRules.filter(r => r.y0 >= top.y0 - 2 && r.y1 <= bottomFull.y1 + 2 &&
          r.x0 >= Math.min(spanX0, top.x0) - 8 && r.x1 <= Math.max(spanX1, top.x1) + 8);
        let box = unionRects([top, bottomFull, ...tableRules]);
        const headerLinesAboveTop = lines.filter(l => l.y0 > captionBox.y1 + 2 && top.y0 - l.y1 >= -1 && top.y0 - l.y1 <= 4 &&
          l.x0 >= box.x0 - 8 && l.x1 <= box.x1 + 8);
        if (headerLinesAboveTop.length) box = unionRects([box, ...headerLinesAboveTop]);
        const cellLines = lines.filter(l => l.y0 >= box.y0 - 2 && l.y1 <= box.y1 + 2 &&
          l.x0 >= Math.min(spanX0, box.x0) - 8 && l.x1 <= Math.max(spanX1, box.x1) + 8);
        if (cellLines.length) box = unionRects([box, ...cellLines]);
        if (box.y1 - box.y0 >= 16) {
          // If the clustered drawing region includes outlined table notes or bottom borders
          // immediately below the last rule, union it so the table is neither clipped nor duplicated.
          const matchingRegion = visibleRegions.find(reg =>
            Math.abs(reg.x0 - box.x0) < 8 && Math.abs(reg.x1 - box.x1) < 8 &&
            reg.y0 <= box.y0 + 4 && reg.y1 >= box.y1 - 2 && reg.y1 <= Math.min(limitY, box.y1 + body * 2.5));
          if (matchingRegion) box = unionRects([box, matchingRegion]);
          const attachedDrawings = drawings.filter(d =>
            d.x0 >= box.x0 - 4 && d.x1 <= box.x1 + 4 &&
            d.y0 >= box.y0 - 2 && d.y0 <= box.y1 + body * .6 &&
            d.y1 <= Math.min(limitY, box.y1 + body * 2));
          if (attachedDrawings.length) box = unionRects([box, ...attachedDrawings]);
          tables.push({ ...box, kind: 'table', parts: tableRules.length, rules: { h: tableRules.length, v: 0 } });
          continue;
        }
      }
    }
    // Fallback for bitmap/boxed tables without individual horizontal path strokes (e.g. JSSC comparison tables).
    const bitmapTable = visibleRegions.find(reg =>
      reg.y0 >= captionBox.y0 - 2 && reg.y0 - captionBox.y1 <= 30 && reg.y1 < limitY &&
      reg.x0 < cx && reg.x1 > cx && reg.x1 - reg.x0 > 120 && reg.y1 - reg.y0 >= 24 &&
      !lines.some(l => parseCaption(l.text)?.kind === 'figure' && l.y0 >= reg.y1 - 3 && l.y0 - reg.y1 < 40 && xOverlap(l, reg) > 0));
    if (bitmapTable) {
      tables.push({ ...bitmapTable, kind: 'table' });
    }
  }
  return tables;
}

function fitFigures(regions: PageRegion[], items: RawItem[], lines: Line[], body: number, width: number, height: number, tables: PageRegion[], cols: Column[] = []): PageRegion[] {
  // Filter out regions already claimed by a table (even when outlined notes slightly extend the region).
  const unclaimed = regions.filter(region => !tables.some(t => {
    const ox = xOverlap(t, region);
    const oy = Math.max(0, Math.min(t.y1, region.y1) - Math.max(t.y0, region.y0));
    return ox > Math.min(t.x1 - t.x0, region.x1 - region.x0) * .6 &&
      (oy > Math.min(t.y1 - t.y0, region.y1 - region.y0) * .5 || (region.y0 >= t.y0 - 6 && region.y1 <= t.y1 + 16));
  }));

  // PDFFigures 2.0 corridor consolidation: merge stacked/adjacent subfigure regions in the same column
  // when they share a single figure caption below and have no intervening prose or caption between them.
  const mergedRegions = [...unclaimed];
  const consumed = new Set<PageRegion>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const label = parseCaption(l.text);
    if (!label || label.kind === 'table' || isProseCaptionReference(label) || isWrappedProseMention(prevInColumn(lines, i), l) || l.size > body * 1.05) continue;
    const primary = mergedRegions.filter(r => !consumed.has(r) && l.y0 >= r.y1 - 3 && l.y0 - r.y1 < 55 && xOverlap(l, r) > 0)
      .sort((a, b) => b.y1 - a.y1)[0];
    if (!primary) continue;
    // A caption running across the (possibly figure-label-induced) gutter owns a page-wide figure.
    const spansGutter = cols.length > 1 && l.x0 < cols[0].x1 - 4 && l.x1 > cols[1].x0 + 4;
    const col = spansGutter ? { x0: 0, x1: width } : cols.find(c => primary.x0 >= c.x0 - 4 && primary.x1 <= c.x1 + 4);
    if (!col) continue;
    // Find the ceiling (nearest preceding prose paragraph, heading, table, or caption in the same column).
    // Panel labels such as "a) Memristor-I (Lorenz-x)" belong to the figure, not to the prose above it.
    const panelLabel = (line: Line) => /^\(?[a-h]\)\s*\S/.test(line.text) && line.x1 - line.x0 < (col.x1 - col.x0) * .6;
    const ceiling = Math.max(
      0,
      ...tables.filter(t => xOverlap(t, col) > 0 && t.y1 <= primary.y0 + 2).map(t => t.y1),
      ...lines.filter((prev, idx) => idx < i && prev.y1 <= primary.y0 + 2 && xOverlap(prev, col) > (col.x1 - col.x0) * .3 &&
        !panelLabel(prev) &&
        (parseCaption(prev.text) || lineKind(prev, body, 2) !== 'p' ||
          (prev.size >= body * .92 && (prev.x1 - prev.x0 > (col.x1 - col.x0) * .55 || prev.text.length > 45))))
        .map(prev => prev.y1),
    );
    // Grow row by row: a 3×2 panel grid touches the caption only through its bottom row.
    for (let grown = true; grown;) {
      const siblings = mergedRegions.filter(r => !consumed.has(r) && r !== primary &&
        r.x0 >= col.x0 - 4 && r.x1 <= col.x1 + 4 &&
        r.y0 >= ceiling && r.y1 <= l.y0 + 3 && primary.y0 - r.y1 < body * 4);
      grown = siblings.length > 0;
      if (grown) {
        Object.assign(primary, unionRects([primary, ...siblings]));
        siblings.forEach(s => consumed.add(s));
      }
    }
  }

  const figures: PageRegion[] = [];
  for (const source of mergedRegions.filter(r => !consumed.has(r))) {
    // Elsevier paints one background rectangle behind a figure and its caption. A real
    // caption line in the frame's lower half ends the figure; it is text, not artwork.
    const framed = lines.filter((l, idx) => {
      const label = parseCaption(l.text);
      return label && label.kind !== 'table' && (label.hasDelimiter || !label.text) && !isProseCaptionReference(label) &&
        !isWrappedProseMention(prevInColumn(lines, idx), l) && l.size <= body * 1.02 && xOverlap(l, source) > 0 &&
        l.y0 > source.y0 + (source.y1 - source.y0) * .5 && l.y1 <= source.y1 + 3;
    }).sort((a, b) => a.y0 - b.y0)[0];
    const region = framed ? { ...source, y1: framed.y0 - 3 } : source;
    const caption = lines.filter((l, idx) => {
      const label = parseCaption(l.text);
      return label && label.kind !== 'table' && !isProseCaptionReference(label) && !isWrappedProseMention(prevInColumn(lines, idx), l) &&
        l.size <= body * 1.02 && l.y0 >= region.y1 - 3 && l.y0 - region.y1 < 55 && xOverlap(l, region) > 0;
    }).sort((a, b) => a.y0 - b.y0)[0];
    const lower = caption ? caption.y0 - 3 : region.y1 + Math.max(8, body * 1.2);
    const labelMargin = caption ? body * 4.5 : Math.max(14, body * 2);
    const col = cols.find(col => region.x0 >= col.x0 - 2 && region.x1 <= col.x1 + 2);
    const labelLeft = Math.max(col?.x0 ?? 0, region.x0 - labelMargin);
    const labelRight = Math.min(col?.x1 ?? width, region.x1 + labelMargin);
    const upperExpand = caption ? Math.max(12, body * 1.6) : 10;
    const labels = items.filter(it => {
      const b = bounds(it);
      if (it.h > body * 1.05 || it.x < labelLeft - 1 || it.x + it.w > labelRight + 1 || b.y0 < region.y0 - upperExpand || b.y1 > lower)
        return false;
      // Do not absorb a body prose line above or below the figure when expanding for axis/legend labels.
      if (b.y1 < region.y0 || b.y0 > region.y1) {
        const hostLine = lines.find(l => l.items.includes(it));
        const panel = hostLine && /^\(?[a-h]\)\s*\S/.test(hostLine.text) && hostLine.x1 - hostLine.x0 < (region.x1 - region.x0) * .6;
        if (hostLine && !panel && (parseCaption(hostLine.text) || lineKind(hostLine, body, 2) !== 'p' ||
            (hostLine.size >= body * .94 && (hostLine.x1 - hostLine.x0 > (col ? (col.x1 - col.x0) * .6 : width * .35) || hostLine.text.length > 50))))
          return false;
      }
      return true;
    });
    const box = unionRects([region, ...labels.map(bounds)]);
    figures.push({
      ...region,
      ...box,
      x0: Math.max(0, box.x0 - 3),
      y0: Math.max(0, box.y0 - 3),
      x1: Math.min(width, box.x1 + 3),
      y1: Math.min(height, box.y1 + 3)
    });
  }
  return figures;
}

interface CompositeFigure { box: Rect; caption: Line[]; label: string; }
/** Join separate image/vector fragments only when a single full-width caption owns them. */
function identifyCompositeFigures(items: RawItem[], regions: PageRegion[], body: number, width: number, height: number, gutter: number | null): CompositeFigure[] {
  const lines = toLines(items, Math.max(12, body * 1.2), gutter);
  const results: CompositeFigure[] = [];
  let previousCaptionBottom = 0;
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i], label = parseCaption(first.text);
    const spansColumns = first.x1 - first.x0 >= width * .65 ||
      (gutter !== null && first.x0 < gutter - body * 2 && first.x1 > gutter + body * 2);
    if (!label || label.kind !== 'figure' || isProseCaptionReference(label) || isWrappedProseMention(lines[i - 1], first) || !spansColumns) continue;
    if (!label.hasDelimiter && label.text && first.size >= body * .95) continue;
    const caption = [first];
    while (i + 1 < lines.length) {
      const next = lines[i + 1], prev = caption[caption.length - 1];
      if (!canContinueCaption(first, prev, next, body, 2, first.x1)) break;
      caption.push(next); i++;
    }
    const corridorLeft = Math.min(first.x0, gutter !== null ? width * .06 : first.x0) - body;
    const corridorRight = Math.max(first.x1, gutter !== null ? width * .94 : first.x1) + body;
    const candidates = regions.filter(r => r.kind === 'figure' && r.y1 <= first.y0 + 3 &&
      r.y0 >= Math.max(previousCaptionBottom, first.y0 - height * .65) &&
      r.x0 >= corridorLeft && r.x1 <= corridorRight);
    const left = candidates.some(r => (r.x0 + r.x1) / 2 < width / 2);
    const right = candidates.some(r => (r.x0 + r.x1) / 2 >= width / 2);
    if (left && right && candidates.length >= 2) {
      const top = Math.min(...candidates.map(r => r.y0));
      const prose = lines.some(line => line.y0 >= top && line.y1 < first.y0 && line.size >= body * .95 &&
        line.text.length > 100 && line.x1 - line.x0 > width * .3);
      if (!prose) {
        const boxLeft = Math.min(first.x0, ...candidates.map(r => r.x0));
        const boxRight = Math.max(first.x1, ...candidates.map(r => r.x1));
        results.push({ box: { x0: boxLeft, y0: Math.max(0, top - body), x1: boxRight, y1: first.y0 - 2 }, caption, label: label.label });
      }
    }
    previousCaptionBottom = caption[caption.length - 1].y1;
  }
  return results;
}

export async function analyzePage(page: PDFPageProxy, pageNumber: number, paperId: string, options: AnalyzeOptions): Promise<Block[]> {
  const viewport = page.getViewport({ scale: 1 }), W = viewport.width, H = viewport.height;
  const geom = await extractPageRegions(page), content = await page.getTextContent();
  let raw: RawItem[] = [];
  // OCR is for pages whose native text is broken. Glyphs we deliberately mark unmapped
  // (U+FFFD for raw CIDs, unknown symbol slots) get a source crop and must not tip the page into OCR.
  let sourceReplacements = 0;
  for (const item of content.items as any[]) {
    if (typeof item.str !== 'string' || !item.str)
      continue;
    const tx = multiplyMatrices(viewport.transform, item.transform), size = Math.hypot(tx[2], tx[3]) || item.height || 10;
    const style = content.styles[item.fontName];
    const font = geom.fontNames.get(item.fontName) ?? style?.fontFamily ?? '';
    const extension = MATH_EXTENSION_FONT.test(font) && !!item.str.trim() && !/^[ˆ̂˙¯]+$/.test(item.str.trim());
    const ascent = extension ? 0 : (style?.ascent || .82), descent = extension ? -1.8 : (style?.descent || -.22);
    const rawWidth = item.width || (/^\s+$/.test(item.str) ? 0 : size * item.str.length * .5);
    const length = rawWidth / Math.max(.001, Math.hypot(tx[0], tx[1]));
    const box = transformRect(tx, 0, descent, length, ascent);
    // Publisher stamps can run vertically along the outer page edge. Feeding their
    // baseline into horizontal line grouping would splice the entire stamp into prose.
    const vertical = Math.abs(tx[1]) > Math.abs(tx[0]) * 4;
    if (vertical && ((box.x0 + box.x1) / 2 < W * .08 || (box.x0 + box.x1) / 2 > W * .92) &&
      (PUBLICATION_NOTICE.test(item.str) || /^\d{8,}[\d():,;\s]*$/.test(item.str.trim())))
      continue;
    sourceReplacements += (item.str.match(/\uFFFD/g) ?? []).length;
    raw.push({
      str: recoverEncodedGlyphs(item.str, page.commonObjs.has(item.fontName) ? page.commonObjs.get(item.fontName) : undefined),
      x: box.x0,
      y: tx[5],
      w: box.x1 - box.x0,
      h: size,
      top: box.y0,
      bottom: box.y1,
      bold: /bold|black|semibold|demi|medi/i.test(font),
      italic: /italic|oblique|(?:^|[+\-])(?:CMMI|CMTI|CMSL)\d*/i.test(font),
      font
    });
  }
  raw = composeEquationNumbers(splitInterleavedMathRuns(composeDottedEquals(raw), font => MATH_FONT.test(font)));
  const nativeText = raw.map(x => x.str).join('');
  const bad = (nativeText.match(/[\u0000-\u0008]/g) ?? []).length + sourceReplacements;
  const needsOCR = nativeText.trim().length < 8 || (nativeText.length > 0 && bad / nativeText.length > .03);
  let usedOCR = false;
  if (needsOCR && options.ocrPage) {
    raw = await options.ocrPage(page);
    usedOCR = true;
  }
  if (!raw.some(x => x.str.trim()))
    return geom.drawings.length ? [{
        id: `${paperId}:${pageNumber}:page`,
        paperId,
        page: pageNumber,
        ord: 0,
        kind: 'figure',
        text: '',
        crop: [0, 0, W, H],
        source: 'native'
      }] : [];
  const body = bodySize(raw);
  // Footnote numbers and URLs can share vertical positions with the other
  // column's prose. Pair them by line and size before constructing text rows.
  const footnoteUrls = raw.filter(it => it.h < body * .7 && /^(?:https?:\/\/|www\.)/i.test(it.str.trim()));
  const urlFootnotes: RawItem[] = [];
  const footnoteMarkers = new Set(raw.filter(it => /^\d{1,2}$/.test(it.str.trim()) && it.h < body * .7 &&
    footnoteUrls.some(url => Math.abs(url.y - it.y) < body * .35 && url.x >= it.x + it.w && url.x - it.x - it.w < body * 2)));
  // Keep marker and URL together as one source item for search and provenance.
  for (const marker of footnoteMarkers) {
    const url = footnoteUrls.find(item => Math.abs(item.y - marker.y) < body * .35 && item.x >= marker.x + marker.w && item.x - marker.x - marker.w < body * 2)!;
    urlFootnotes.push({ ...url, x: marker.x, w: url.w + url.x - marker.x, str: `${marker.str} ${url.str}` });
  }
  const pairedUrls = new Set(footnoteUrls.filter(url => [...footnoteMarkers].some(marker =>
    Math.abs(url.y - marker.y) < body * .35 && url.x >= marker.x + marker.w && url.x - marker.x - marker.w < body * 2)));
  raw = raw.filter(it => !footnoteMarkers.has(it) && !pairedUrls.has(it));
  // Classify whole margin lines before column splitting. The publication name and
  // copyright/ISBN often share a footer baseline but occupy opposite columns.
  const marginItems = new Set(toLines(raw)
    .filter(line => (/^[-–—]?\d{1,4}[-–—]?$/.test(line.text) &&
      (line.y < H * .065 || line.y > H * .95)) ||
      (line.y0 > H * .95 && !/^\[\d+\]/.test(line.text) &&
        (PUBLICATION_NOTICE.test(line.text) || /^(?:\d+\s*[•·]\s*)?(?:digest|proceedings) of\b/i.test(line.text))))
    .flatMap(line => line.items));
  let items = raw.filter(it => !marginItems.has(it));
  // Rejoin a drop cap only when its adjacent first line is actually found.
  const consumed = new Set<RawItem>();
  items = items.map(it => ({ ...it }));
  for (const cap of items.filter(it => /^[A-Z]$/.test(it.str) && it.h > body * 1.5)) {
    const box = bounds(cap);
    const target = items.filter(it => it !== cap && /^[A-Za-z]/.test(it.str) && it.h <= body * 1.2 &&
      it.x >= cap.x + cap.w - 3 && it.x - cap.x - cap.w < body &&
      it.y >= box.y0 && it.y <= box.y1 + body * .2).sort((a, b) => a.y - b.y)[0];
    if (target) {
      const gap = target.x - cap.x - cap.w;
      target.str = cap.str + (gap > body * .3 ? ' ' : '') + target.str;
      target.w = target.x + target.w - cap.x;
      target.x = cap.x;
      consumed.add(cap);
      // Some PDFs emit an empty item in the drop cap's large font. Its baseline
      // spans several text rows but contributes no visible whitespace.
      for (const blank of items) if (!blank.str.trim() && blank.h > body * 1.5 && Math.abs(blank.y - cap.y) < 1)
        consumed.add(blank);
    }
  }
  items = items.filter(it => !consumed.has(it));
  const algorithms = identifyAlgorithms(items, geom.drawings, body, toLines);
  const codeFigures = options.keepFigures ? identifyCodeFigures(items, geom.drawings, body, toLines) : [];
  // Code listings still provide strong evidence for a column boundary even
  // though their glyphs are removed from ordinary text immediately afterward.
  // Algorithm glyphs and line numbers never participate in ordinary columns or paragraphs.
  items = items.filter(it => ![...algorithms, ...codeFigures].some(region => centerInside(it, region)));
  const ruleBands = tableRuleBands(geom.drawings, H);
  const inTableBand = (it: RawItem) => ruleBands.some(b =>
    it.x + it.w / 2 >= b.x0 - 6 && it.x + it.w / 2 <= b.x1 + 6 &&
    it.y >= b.y0 - body * 1.2 && it.y <= b.y1 + 4);
  const preGutter = detectGutter(items.filter(it => !inTableBand(it) && !algorithms.some(region => centerInside(it, region))), W);
  const composites = options.keepFigures ? identifyCompositeFigures(items, geom.regions, body, W, H, preGutter) : [];
  const compositeCaptionItems = new Set(composites.flatMap(figure => figure.caption.flatMap(line => line.items)));
  const gutter = detectGutter(items.filter(it => !inTableBand(it) && !algorithms.some(region => centerInside(it, region)) &&
    !compositeCaptionItems.has(it) && !composites.some(figure => centerInside(it, figure.box))), W);
  items = items.filter(it => !compositeCaptionItems.has(it) && !composites.some(figure => centerInside(it, figure.box)));
  const portraits = usedOCR ? [] : identifyAuthorPortraits(items, geom.drawings, W, H, body,
    pageNumber, options.documentPageCount, toLines);
  const coveredBy = (region: Rect, masks: Rect[]) => masks.some(mask => {
    const area = xOverlap(region, mask) * Math.max(0, Math.min(region.y1, mask.y1) - Math.max(region.y0, mask.y0));
    return area > 0 && area >= (region.x1 - region.x0) * (region.y1 - region.y0) * .8;
  });
  const visibleRegions = geom.regions.filter(region => !coveredBy(region, [...algorithms, ...codeFigures, ...portraits, ...composites.map(x => x.box)]));
  const visibleDrawings = geom.drawings.filter(drawing => !coveredBy(drawing, [...algorithms, ...codeFigures, ...portraits, ...composites.map(x => x.box)]));
  const cols = columnsFor(items, W, gutter);
  const allLines = toLines(items, Math.max(12, body * 1.2), gutter);
  const tables = usedOCR ? [] : identifyTables(allLines, visibleDrawings, visibleRegions, cols, body, pageNumber, H);
  const plates = usedOCR || !options.keepFigures ? [] :
    matchFigurePlates(visibleDrawings, visibleRegions, allLines, W, H, line => lineKind(line, body, pageNumber) === 'p');
  const plateItems = new Set(plates.flatMap(plate => plate.caption.items));
  const normalRegions = visibleRegions.filter(region => {
    const coveredArea = plates.reduce((sum, plate) => sum + xOverlap(region, plate.image) *
      Math.max(0, Math.min(region.y1, plate.image.y1) - Math.max(region.y0, plate.image.y0)), 0);
    return coveredArea < (region.x1 - region.x0) * (region.y1 - region.y0) * .8;
  });
  const figures = usedOCR ? [] : fitFigures(normalRegions, items, allLines, body, W, H, tables, cols);
  const regions = [...tables, ...figures];
  const tableNotes = options.keepFigures ? extractTableNotes(tables, items, body, toLines) : [];
  const tableNoteItems = new Set(tableNotes.flatMap(note => note.items));
  const spanningProse = gutter === null ? [] : allLines.filter(l => l.x0 < gutter - 2 && l.x1 > gutter + 2 &&
    l.items.some(it => /[A-Za-z]{3,}/.test(it.str)));
  const wideItems = new Set(spanningProse.flatMap(l => l.items));
  const captionProtectedBoxes: Rect[] = [];
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i], label = parseCaption(line.text);
    if (!label || isProseCaptionReference(label) || isWrappedProseMention(prevInColumn(allLines, i), line)) continue;
    const nearVisual = [...figures, ...tables, ...codeFigures].some(r =>
      xOverlap(line, r) > Math.min(line.x1 - line.x0, r.x1 - r.x0) * .35 &&
      (Math.abs(line.y0 - r.y1) < body * 5 || Math.abs(r.y0 - line.y1) < body * 5));
    if (!label.text || label.hasDelimiter || nearVisual) {
      const parts = [line];
      for (let j = i + 1; j < allLines.length; j++) {
        const next = allLines[j], last = parts[parts.length - 1];
        if (xOverlap(next, line) === 0 && Math.abs((next.x0 + next.x1) / 2 - (line.x0 + line.x1) / 2) > body * 6) continue;
        if (!canContinueCaption(line, last, next, body, pageNumber, line.x1)) break;
        parts.push(next);
      }
      captionProtectedBoxes.push(unionRects(parts));
    }
  }
  const inProtectedCaption = (it: RawItem) => captionProtectedBoxes.some(box =>
    it.x + it.w / 2 >= box.x0 - 2 && it.x + it.w / 2 <= box.x1 + body &&
    it.y >= box.y0 - body * .5 && it.y <= box.y1 + body * .5);
  const equations = extractMathRegions(
    items.filter(it => !wideItems.has(it) && !tableNoteItems.has(it) && !plateItems.has(it) && !inProtectedCaption(it)),
    body, W, cols, [...regions, ...plates.map(plate => plate.image)], visibleDrawings);
  const placed: Placed[] = [];
  let serial = 0;
  const columnFor = (box: Rect) => gutter === null ? 0 : (box.x0 < gutter - 2 && box.x1 > gutter + 2 ? -1 : (box.x0 + box.x1) / 2 < gutter ? 0 : 1);
  const add = (kind: BlockKind, text: string, box: Rect, extra: Partial<Block> = {}) => {
    const block: Block = {
      id: `${paperId}:${pageNumber}:${serial++}`,
      paperId,
      page: pageNumber,
      ord: 0,
      kind,
      text,
      source: usedOCR ? 'ocr' : 'native',
      bbox: [box.x0, box.y0, box.x1, box.y1],
      ...extra
    };
    if (!['math', 'figure', 'table', 'algorithm'].includes(kind) && hasUnmappedGlyphs(text)) {
      block.sourceTextFallback = true;
      block.crop = [Math.max(0, box.x0 - 1), Math.max(0, box.y0), Math.min(W, box.x1 + 1), Math.min(H, box.y1)];
    }
    placed.push({ block, box, column: columnFor(box) });
    return block;
  };
  for (const algorithm of algorithms) {
    add('algorithm', algorithm.text, algorithm, { sourceFontSize: body,
      crop: [Math.max(0, algorithm.x0 - 2), Math.max(0, algorithm.y0 - 2), Math.min(W, algorithm.x1 + 2), Math.min(H, algorithm.y1 + 2)],
    });
  }
  for (const portrait of portraits) {
    add('figure', '', portrait, { readingRole: 'biography',
      crop: [Math.max(0, portrait.x0 - 2), Math.max(0, portrait.y0 - 2), Math.min(W, portrait.x1 + 2), Math.min(H, portrait.y1 + 2)] });
  }
  for (const code of codeFigures) {
    add('figure', code.text, code, { figureLabel: code.label,
      crop: [Math.max(0, code.x0 - 2), Math.max(0, code.y0 - 2), Math.min(W, code.x1 + 2), Math.min(H, code.y1 + 2)] });
  }
  for (const note of urlFootnotes) {
    add('p', note.str, bounds(note), { sourceFontSize: note.h });
    placed[placed.length - 1].footnote = true;
  }
  for (const composite of composites) {
    const figure = add('figure', '', composite.box, { figureLabel: composite.label,
      crop: [composite.box.x0, composite.box.y0, composite.box.x1, composite.box.y1] });
    const box = unionRects(composite.caption);
    add('caption', composite.caption.map(line => line.text).join(' '), box,
      { figureLabel: composite.label, parentBlockId: figure.id, sourceFontSize: composite.caption[0].size,
        textRuns: linesTextRuns(composite.caption) });
  }
  const tableBlocks = new Map<PageRegion, Block>();
  for (const region of regions) {
    if (!options.keepFigures) continue;
    const hasTightNote = region.kind === 'table' && tableNotes.some(note => note.table === region && note.y0 <= region.y1 + 2);
    const block = add(region.kind, '', region, {
      crop: [Math.max(0, region.x0 - 2), Math.max(0, region.y0 - 2), Math.min(W, region.x1 + 2), Math.min(H, region.y1 + (hasTightNote ? .5 : 2))],
    });
    if (region.kind === 'table') tableBlocks.set(region, block);
  }
  for (const note of tableNotes) {
    const siblings = tableNotes.filter(candidate => candidate.table === note.table);
    const index = siblings.indexOf(note);
    const previousBottom = index > 0 ? siblings[index - 1].y1 + .1 : note.table.y1 + .5;
    const nextTop = index + 1 < siblings.length ? siblings[index + 1].y0 - .1 : H;
    add('table-note', note.text, note, {
      parentBlockId: tableBlocks.get(note.table)!.id,
      sourceFontSize: note.sourceFontSize,
      textRuns: note.textRuns,
      crop: [Math.max(0, note.x0 - 1.5), Math.max(previousBottom, note.y0 - 1.5), Math.min(W, note.x1 + 1.5), Math.min(nextTop, note.y1 + 1.5)],
    });
    // A short continuation of a full-width table note must not fall into the left column.
    placed[placed.length - 1].column = columnFor(note.table);
  }
  for (const eq of equations)
    add('math', eq.text, eq, {
      crop: [eq.x0, eq.y0, eq.x1, Math.min(H, eq.y1)],
      eqNo: eq.eqNo ?? undefined,
      eqNoInCrop: !!eq.eqNo,
      sourceFontSize: body,
      recognitionCrop: eq.recognitionCrop,
      nativeLatex: eq.nativeLatex,
      structureWarnings: eq.structureWarnings,
    });
  const equationItems = new Set(equations.flatMap(eq => eq.items));
  const excluded = options.keepFigures ? [...regions, ...plates.map(plate => plate.image)] : [];
  let remaining = items.filter(it => !equationItems.has(it) && !tableNoteItems.has(it) && !plateItems.has(it) && !excluded.some(r => centerInside(it, r)));
  // Recover full-width title/author rows before dividing into columns.
  const fullRows = toLines(remaining, Math.max(12, body * 1.2), gutter);
  const spans = gutter === null ? [] : fullRows.filter(l => l.x0 < gutter - 2 && l.x1 > gutter + 2);
  if (gutter !== null) {
    for (let i = 0; i < fullRows.length; i++) {
      const line = fullRows[i];
      const label = parseCaption(line.text);
      if (!label || isProseCaptionReference(label) || isWrappedProseMention(prevInColumn(fullRows, i), line)) continue;
      const parts = [line];
      let prev = line;
      for (const next of fullRows.filter(l => l.y > line.y).sort((a, b) => a.y - b.y)) {
        if (!canContinueCaption(line, prev, next, body, pageNumber, Math.max(line.x1, prev.x1)))
          break;
        parts.push(next);
        prev = next;
      }
      const box = unionRects(parts);
      if (box.x0 < gutter - 2 && box.x1 > gutter + 2) {
        for (const part of parts) {
          if (!spans.includes(part)) spans.push(part);
        }
      }
    }
  }
  const spanItems = new Set(spans.flatMap(l => l.items));
  remaining = remaining.filter(it => !spanItems.has(it));
  const streams = gutter === null ? [{ column: 0, items: remaining }] : [
    { column: 0, items: remaining.filter(it => it.x + it.w / 2 < gutter) },
    { column: 1, items: remaining.filter(it => it.x + it.w / 2 >= gutter) },
    { column: -1, items: [...spanItems] },
  ];
  const referenceState = { active: false };
  for (const stream of streams) {
    const lines = toLines(stream.items);
    identifyPublicationHeaders(lines, H, pageNumber);
    if (pageNumber === 1) identifyFrontMatter(lines, body, H);
    const ordinary: Line[] = [];
    // Captions split the stream into short batches; measure leading on the whole stream.
    const leading = dominantLeading(lines, body);
    const flush = () => {
      for (const p of paragraphs(ordinary, body, pageNumber, referenceState, leading)) {
        add(p.kind, p.text, p, { sourceFontSize: p.size, textRuns: p.textRuns, readingRole: p.readingRole });
        const current = placed[placed.length - 1];
        current.column = stream.column;
        current.footnote = p.kind === 'p' && p.size < body * .9 && p.y0 > H * .72 &&
          /supported|corresponding author|authors? (?:are|is)|\b(?:is|are) with\b|university|institute|e-mail|基金|作者|通讯|\bcolor versions? of\b|\bdigital object identifier\b/i.test(p.text);
      }
      ordinary.length = 0;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const label = parseCaption(line.text);
      const wrappedMention = isWrappedProseMention(lines[i - 1], line);
      const relatedVisual = label && !wrappedMention && [...figures, ...tables, ...codeFigures].some(region =>
        (label.kind === 'table' ? tables.includes(region as PageRegion) : !tables.includes(region as PageRegion)) &&
        xOverlap(line, region) > Math.min(line.x1 - line.x0, region.x1 - region.x0) * .35 &&
        (line.y0 >= region.y1 - 3 && line.y0 - region.y1 < body * 5 ||
          label.kind === 'table' && region.y0 >= line.y1 && region.y0 - line.y1 < body * 5));
      const proseReference = isProseCaptionReference(label);
      const caption = label && !wrappedMention && !proseReference && (!label.text || label.hasDelimiter || relatedVisual);
      if (!caption) {
        ordinary.push(line);
        continue;
      }
      flush();
      const colWidth = cols.find(c => line.x0 >= c.x0 - 4 && line.x1 <= c.x1 + 4);
      const rightLimit = colWidth ? colWidth.x1 : line.x1;
      const parts = [line];
      while (i + 1 < lines.length) {
        const next = lines[i + 1], last = parts[parts.length - 1];
        if (!canContinueCaption(line, last, next, body, pageNumber, rightLimit))
          break;
        parts.push(next);
        i++;
      }
      const box = unionRects(parts);
      add('caption', parts.map(p => p.text).join(' '), box, { sourceFontSize: line.size, textRuns: linesTextRuns(parts) });
      placed[placed.length - 1].column = stream.column;
    }
    flush();
  }
  // Bind vector figures before sorting, just like bitmap plates. Otherwise a
  // caption near the top of the right column can interrupt left-column prose.
  const captionsByFigure = new Map<Placed, Placed>();
  for (const entry of placed) {
    if (entry.block.kind !== 'caption') continue;
    if (entry.block.parentBlockId) {
      const parent = placed.find(candidate => candidate.block.id === entry.block.parentBlockId);
      if (parent) captionsByFigure.set(parent, entry);
      continue;
    }
    const label = parseCaption(entry.block.text);
    if (label?.kind !== 'figure') continue;
    const figure = placed.filter(candidate => candidate.block.kind === 'figure' &&
      !captionsByFigure.has(candidate) && (candidate.column === entry.column || candidate.column === -1) &&
      candidate.box.y1 <= entry.box.y0 + 3 && entry.box.y0 - candidate.box.y1 < 55 &&
      xOverlap(candidate.box, entry.box) >= Math.min(candidate.box.x1 - candidate.box.x0,
        entry.box.x1 - entry.box.x0) * .6)
      .sort((a, b) => Number(b.column === entry.column) - Number(a.column === entry.column) || b.box.y1 - a.box.y1)[0];
    if (!figure) continue;
    figure.block.figureLabel = label.label;
    entry.block.figureLabel = label.label;
    entry.block.parentBlockId = figure.block.id;
    captionsByFigure.set(figure, entry);
  }
  const linkedCaptions = new Set(captionsByFigure.values());
  const reading = placed.filter(entry => !linkedCaptions.has(entry)).map(entry => {
    const caption = captionsByFigure.get(entry);
    const entries = caption ? [entry, caption] : [entry];
    return { entries, box: unionRects(entries.map(part => part.box)),
      column: entry.column, footnote: entry.footnote };
  });
  // Aligned plate cells share one reading unit; single-column plates stay in-column.
  for (const row of groupFigurePlateRows(plates)) {
    const entries: Placed[] = [];
    for (const plate of row) {
      const figure = add('figure', '', plate.image, {
        crop: plate.crop,
        figureLabel: plate.figureLabel,
      });
      entries.push(placed[placed.length - 1]);
      add('caption', plate.caption.text, plate.caption, {
        parentBlockId: figure.id,
        figureLabel: plate.figureLabel,
        sourceFontSize: plate.caption.size,
        textRuns: plate.caption.textRuns,
      });
      entries.push(placed[placed.length - 1]);
    }
    const box = unionRects(entries.map(entry => entry.box));
    reading.push({ entries, box, column: columnFor(box), footnote: false });
  }
  const footnotes = reading.filter(unit => unit.footnote);
  const main = reading.filter(unit => !unit.footnote);
  const sorted: typeof reading = [];
  if (gutter === null)
    sorted.push(...main.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0));
  else {
    // A full-width block separates reading bands. Each band reads left column then right column.
    const span = main.filter(p => p.column === -1).sort((a, b) => a.box.y0 - b.box.y0);
    let rest = main.filter(p => p.column !== -1);
    const flush = (limit: number) => {
      const band = rest.filter(p => p.box.y0 < limit);
      rest = rest.filter(p => p.box.y0 >= limit);
      sorted.push(...band.sort((a, b) => a.column - b.column || a.box.y0 - b.box.y0));
    };
    for (const p of span) {
      // A full-width visual occupies its whole vertical band. Content below it
      // is ordered after the figure even if its baseline overlaps a tall panel.
      flush(p.entries[0].block.kind === 'figure' ? p.box.y1 : p.box.y0);
      sorted.push(p);
    }
    flush(Infinity);
  }
  sorted.push(...footnotes.sort((a, b) => a.box.y0 - b.box.y0));
  const ordered = sorted.flatMap(unit => unit.entries);

  return orderFloatingContent(ordered.map(entry => entry.block)).map((block, ord) => ({ ...block, ord }));
}

export async function analyzeDocument(pdf: PDFDocumentProxy, paperId: string, options: AnalyzeOptions): Promise<Block[]> {
  const blocks: Block[] = [];
  const pageHeights = new Map<number, number>();
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    pageHeights.set(p, page.getViewport({ scale: 1 }).height);
    try {
      blocks.push(...await analyzePage(page, p, paperId, { ...options, documentPageCount: pdf.numPages }));
    }
    catch (error) {
      throw new Error(`第 ${p} 页解析失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    finally {
      page.cleanup();
    }
    options.onProgress?.(p, pdf.numPages);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  identifyRepeatedPublicationHeaders(blocks, pageHeights);
  const result = blocks.map((block, ord) => ({ ...block, ord }));
  classifyReadingRoles(result, pdf.numPages);
  classifyReferences(result);
  return result;
}
