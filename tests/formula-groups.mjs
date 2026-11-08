/** Geometry captured from the original SWCS/ReFFT PDFs; no library or OCR required. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'formula-groups-'));
try {
  const file = path.join(temp, 'math.mjs');
  await build({ entryPoints: ['renderer/src/reflow/math.ts'], bundle: true, platform: 'node', format: 'esm', outfile: file });
  const { extractMathRegions } = await import(pathToFileURL(file));
  const fixtures = JSON.parse(await fs.readFile('tests/fixtures/reflow-formula-layout.json', 'utf8'));
  for (const fixture of fixtures) {
    const regions = extractMathRegions(fixture.items, fixture.body, fixture.pageWidth, fixture.columns, fixture.obstacles, fixture.drawings);
    const owners = new Map();
    for (const region of regions) {
      assert([region.x0, region.y0, region.x1, region.y1].every(Number.isFinite));
      assert(region.x1 > region.x0 && region.y1 > region.y0, `${fixture.name}: positive source crop`);
      for (const item of region.items) {
        assert(!owners.has(item), `${fixture.name}: ${item.str} at ${item.x},${item.y} has one source owner`);
        owners.set(item, region);
        if (!item.str.trim()) continue; // blank advances are not source ink
        assert(item.x >= region.x0 - .001 && item.x + item.w <= region.x1 + .001);
        assert((item.top ?? item.y - item.h * .85) >= region.y0 - .001);
        assert((item.bottom ?? item.y + item.h * .3) <= region.y1 + .001);
      }
      if ((region.eqNo?.match(/\(/g)?.length ?? 0) > 1) {
        assert(!region.nativeLatex, 'a partial single-equation candidate cannot represent a compound source crop');
        assert(region.structureWarnings?.length);
      }
    }
    for (const number of fixture.expected) {
      const anchor = fixture.items.find(item => item.str.trim() === number);
      assert(anchor && owners.has(anchor), `${fixture.name}: ${number} is a display, never a prose fragment`);
    }
    if (fixture.name === 'swcs-p3') {
      for (const [number, y, label] of [['(8)', 323.39, 'comb'], ['(13)', 717, 'sum-weight'], ['(14)', 87.08, 'weight']]) {
        const script = fixture.items.find(item => Math.abs(item.y - y) < .1 && item.str === label);
        const anchor = fixture.items.find(item => item.str.trim() === number);
        assert(script && owners.get(script) === owners.get(anchor), `${number}: English script retains its formula owner`);
      }
      const eq8 = owners.get(fixture.items.find(item => item.str.trim() === '(8)'));
      assert(eq8.y0 < 290.3 && eq8.y1 > 341, 'both cases branches and their complete lower condition remain visible');
    }
    if (fixture.name === 'refft-p3') {
      const tail = fixture.items.find(item => item.str.trim() === 'according to');
      assert(tail && !owners.has(tail), 'short sentence tails remain selectable prose, not formula ink');
    }
    console.log(`PASS ${fixture.name}: complete numbered displays, unique ownership, member-enclosing positive crops`);
  }
} finally { await fs.rm(temp, { recursive: true, force: true }); }
