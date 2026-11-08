/** Real local model integration: node tests/formula-ocr.mjs /absolute/formula.png */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-formula-'));
let stop;
try {
  const modulePath = path.join(temporary, 'formula-ocr.mjs');
  await build({ entryPoints: ['electron/formula-ocr.ts'], bundle: true, platform: 'node', format: 'esm', outfile: modulePath });
  const { recognizeFormula, getFormulaOcrAvailability, stopFormulaOcr } = await import(pathToFileURL(modulePath));
  stop = stopFormulaOcr;
  const options = { projectDir: process.cwd() };
  assert.equal((await getFormulaOcrAvailability({ projectDir: temporary })).available, false);
  assert.equal((await getFormulaOcrAvailability(options)).available, true);
  await assert.rejects(recognizeFormula('not a PNG', options), /PNG/);
  const png = 'data:image/png;base64,' + (await fs.readFile(process.argv[2])).toString('base64');
  const start = performance.now();
  const [first, second] = await Promise.all([recognizeFormula(png, options), recognizeFormula(png, options)]);
  assert.equal(first.engine, 'pix2tex');
  assert.ok(first.latex.length > 0);
  assert.equal(second.latex, first.latex);
  const sharedMs = Math.round(performance.now() - start);
  stopFormulaOcr();
  const restarted = await recognizeFormula(png, options);
  assert.equal(restarted.latex, first.latex);
  console.log(JSON.stringify({ engine: first.engine, latex: first.latex, twoRequestsMs: sharedMs, restart: 'passed' }, null, 2));
} finally {
  stop?.();
  await fs.rm(temporary, { recursive: true, force: true });
}
