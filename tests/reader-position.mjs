/** Exercise the actual reader position selector without a DOM or model requests. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: ['renderer/src/lib/reader-layout.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { readingPageAtLine } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
  assert.equal(readingPageAtLine([], 72), null);
  assert.equal(readingPageAtLine([{ page: 1, top: 36, bottom: 10000 }], 72), 1);
  assert.equal(readingPageAtLine([
    { page: 4, top: -22000, bottom: -10 },
    { page: 5, top: -10, bottom: 12000 },
    { page: 6, top: 12000, bottom: 18000 },
  ], 72), 5, 'a very long current page remains current without crossing any intersection threshold');
  assert.equal(readingPageAtLine([
    { page: 4, top: -22000, bottom: -11930 },
    { page: 5, top: -11930, bottom: 70 },
    { page: 6, top: 70, bottom: 6070 },
  ], 72), 6, 'crossing the reading line updates immediately even if both pages have tiny visible ratios');
  assert.equal(readingPageAtLine([
    { page: 8, top: -12000, bottom: 0 },
    { page: 9, top: 0, bottom: 10000 },
  ], 72), 9, 'jumping to a page chooses its viewport position');
  assert.equal(readingPageAtLine([{ page: 14, top: -50, bottom: 50 }], 72), 14, 'the final short page remains selected near the bottom');
  console.log('PASS long-page tracking, reading-line boundaries, direct page jumps and final-page fallback');
