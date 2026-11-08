/** Exercise the actual reader position selector without a DOM or model requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-reader-position-'));
try {
  const outfile = path.join(temp, 'position.mjs');
  await build({
    stdin: { contents: "export { readingPageAtLine } from './renderer/src/components/Reader.tsx';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile, tsconfigRaw: { compilerOptions: { jsx: 'react' } },
    plugins: [{ name: 'omit-unneeded-ui-imports', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => args.path.endsWith('/Reader.tsx') ? undefined : { path: args.path, external: true, sideEffects: false });
    } }],
  });
  const { readingPageAtLine } = await import(pathToFileURL(outfile));
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
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
