import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(path.join(os.tmpdir(), 'math-crop-'));
try {
  const file = path.join(dir, 'math.mjs');
  await build({ entryPoints: ['renderer/src/reflow/math.ts'], bundle: true, platform: 'node', format: 'esm', outfile: file });
  const { extractMathRegions } = await import(pathToFileURL(file));
  const item = (str, x, y, w, h, font) => ({ str, x, y, w, h, font });
  // The sum limit and tall brackets occupy separate baselines within the crop.
  const limit = item('1023', 158, 552.8, 13.9, 7, 'Times');
  const left = item('(', 173.7, 554.4, 5.4, 10, 'BLEX');
  const right = item(')', 216, 554.4, 5.4, 10, 'BLEX');
  const above = item('This is body before', 49, 537.5, 200, 10, 'Times');
  const below = item('This is body after', 49, 595, 200, 10, 'Times');
  const items = [limit, item('∑', 157.9, 555.9, 14.1, 10, 'BLEX'), left, right,
    item('C', 124.8, 565.4, 6.6, 10, 'CMMI10'), item('=', 147.4, 565.4, 7.8, 10, 'MTSYN'),
    item('X', 179.9, 565.4, 6.1, 10, 'CMMI10'), item('·', 192.9, 565.4, 2.8, 10, 'MTSYN'),
    item('Y', 197.9, 565.4, 5.5, 10, 'CMMI10'), item('(1)', 288.4, 565.4, 11.6, 10, 'Times'),
    item('k', 158.8, 577.3, 3.1, 7, 'CMMI10'), item('=', 162.3, 577.3, 5.4, 7, 'MTSYN'),
    item('1', 167.7, 577.3, 3.5, 7, 'Times'), above, below];
  const [region] = extractMathRegions(items, 10, 612, [{ x0: 49, x1: 300 }]);
  assert(region);
  for (const glyph of [limit, left, right]) assert(region.items.includes(glyph), `${glyph.str} must belong to the image`);
  for (const prose of [above, below]) assert(!region.items.includes(prose), 'adjacent prose must remain selectable');
  assert(region.y0 > above.y && region.y1 < below.y);
  console.log('PASS formula crop owns its separate-baseline glyphs and preserves surrounding prose');
} finally {
  await rm(dir, { recursive: true, force: true });
}
