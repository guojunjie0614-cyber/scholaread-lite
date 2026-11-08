/** Original SWCS p4 glyphs: the inline integral belongs after Eq.(22), not the line above. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-integral-'));
try {
  const source = await fs.readFile('renderer/src/reflow/analyze.ts', 'utf8');
  const file = path.join(temp, 'analyze.mjs');
  await build({ stdin: { contents: source + '\nexport { toLines, lineTextRuns };', resolveDir: path.resolve('renderer/src/reflow'), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: file,
    plugins: [{ name: 'pdfjs-node', setup(builder) { builder.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs'), external: true })); } }] });
  const { toLines, lineTextRuns } = await import(pathToFileURL(file));
  const fixture = JSON.parse(await fs.readFile('tests/fixtures/swcs-inline-integral.json', 'utf8'));
  const integral = fixture.items.find(item => item.str === '∫');
  const upper = fixture.items.find(item => item.str === 'x' && Math.abs(item.y - 245.78) < .01);
  const lower = fixture.items.find(item => item.str === '0' && Math.abs(item.y - 254.88) < .01);
  const lines = toLines(fixture.items);
  const line = lines.find(line => line.text.startsWith('can be given by Eq. (22)'));
  assert(line);
  for (const item of [integral, upper, lower]) assert(line.items.includes(item), `${item.str} belongs to the Eq.(22) explanatory line`);
  assert(!lines.find(line => line.text.includes('CDF')).items.includes(integral), 'CMEX origin is not the preceding text baseline');
  const runs = lineTextRuns(line);
  assert.equal(runs.map(run => run.text).join(''), line.text, 'geometry preserves canonical text offsets');
  const op = runs.find(run => run.text === '∫');
  const upperRun = runs.find(run => run.text === 'x' && run.script === 'sup');
  const lowerRun = runs.find(run => run.text === '0' && run.script === 'sub');
  assert(op.mathPosition, 'the integral is the shared spatial host');
  assert.equal(op.mathPosition.y, 0, 'a top-origin extension font is normalized to the actual expression baseline');
  for (const run of [upperRun, lowerRun]) assert.equal(run.mathPosition.group, op.mathPosition.group);
  assert(upperRun.mathPosition.y < 0 && lowerRun.mathPosition.y > 0);
  const seen = new Set(); let previous;
  for (const run of runs) { const group = run.mathPosition?.group; if (group !== previous) assert(!seen.has(group)); if (group) seen.add(group); previous = group; }
  console.log('PASS original SWCS p4 inline integral: correct text line, shared operator/limits geometry and canonical offsets');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
