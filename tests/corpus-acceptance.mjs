/**
 * Real-paper reflow acceptance on a fixed corpus (tests/fixtures/corpus-acceptance.json).
 * PDFs come from the local ScholarLite library and are never modified; missing files are
 * reported as SKIP so the suite stays runnable on other machines.
 *   node tests/corpus-acceptance.mjs [--only <id>] [--role dev|holdout|regression]
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const role = args.includes('--role') ? args[args.indexOf('--role') + 1] : null;
const manifest = JSON.parse(await fs.readFile('tests/fixtures/corpus-acceptance.json', 'utf8'));
const libraryDir = manifest.libraryDir.replace(/^~/, os.homedir());
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-corpus-'));
// Unassigned Indic/Syriac code points produced when a CID is emitted as text, controls, U+FFFD.
const GARBLED = /[\u0600-\u07FF\u0B00-\u0D7F\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]|[ðÞ¼þ]/;
let failures = 0, skipped = 0, checked = 0;
try {
  const modules = {};
  for (const name of ['analyze', 'captions']) {
    const file = path.join(tmp, `${name}.mjs`);
    await build({ entryPoints: [`renderer/src/reflow/${name}.ts`], bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'error',
      plugins: [{ name: 'pdfjs-node', setup(b) { b.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs'), external: true })); } }] });
    modules[name] = await import(pathToFileURL(file));
  }
  const { analyzeDocument } = modules.analyze;
  const { parseCaption, isProseCaptionReference } = modules.captions;
  const { isReadingContent } = await (async () => {
    const file = path.join(tmp, 'reading-content.mjs');
    await build({ entryPoints: ['shared/reading-content.ts'], bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'error' });
    return import(pathToFileURL(file));
  })();
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const originalWarn = console.log;
  for (const paper of manifest.papers) {
    if ((only && paper.id !== only) || (role && paper.role !== role)) continue;
    const file = path.join(libraryDir, paper.file);
    try { await fs.access(file); } catch { skipped++; console.log(`SKIP ${paper.id} (${paper.category}): PDF not in local library`); continue; }
    const problems = [];
    const started = Date.now();
    let blocks = [];
    try {
      const pdf = await getDocument({ data: new Uint8Array(await fs.readFile(file)), useSystemFonts: true, fontExtraProperties: true, verbosity: 0 }).promise;
      blocks = await analyzeDocument(pdf, paper.id, { keepFigures: true });
      await pdf.destroy();
    } catch (error) { problems.push(`document failed: ${error.message}`); }
    const seconds = (Date.now() - started) / 1000;
    if (blocks.length) {
      const captions = blocks.filter(b => b.kind === 'caption').map(b => ({ block: b, label: parseCaption(b.text) }));
      const found = { figure: new Set(), table: new Set() };
      for (const { block, label } of captions) {
        if (!label) { problems.push(`p${block.page} caption without label: ${block.text.slice(0, 70)}`); continue; }
        if (isProseCaptionReference(label)) problems.push(`p${block.page} prose sentence classified as caption: ${block.text.slice(0, 70)}`);
        found[label.kind].add(label.label);
      }
      const gaps = paper.knownGaps ?? {};
      const missing = kind => (kind === 'figure' ? paper.figures : paper.tables).filter(label => !found[kind].has(label) && !gaps[`${kind}:${label}`]);
      if (missing('figure').length) problems.push(`figure captions missing: ${missing('figure').join(', ')}`);
      if (missing('table').length) problems.push(`table captions missing: ${missing('table').join(', ')}`);
      const unbound = captions.filter(({ label, block }) => label?.kind === 'figure' && paper.figures.includes(label.label) && !block.parentBlockId)
        .map(({ label }) => label.label);
      // Bilingual thesis captions repeat a label; one bound copy per label is enough.
      const unboundLabels = [...new Set(unbound)].filter(label => !gaps[`bind:${label}`] &&
        !captions.some(c => c.label?.label === label && c.label.kind === 'figure' && c.block.parentBlockId));
      if (unboundLabels.length) problems.push(`figure captions not bound to a figure: ${unboundLabels.join(', ')}`);
      const readable = blocks.filter(b => isReadingContent(b) && !['math', 'figure', 'table', 'algorithm'].includes(b.kind) && !b.sourceTextFallback);
      const garbled = readable.filter(b => GARBLED.test(b.text));
      for (const b of garbled.slice(0, 5)) problems.push(`p${b.page} garbled glyphs shown as text: ${JSON.stringify(b.text.slice(0, 70))}`);
      if (garbled.length > 5) problems.push(`… ${garbled.length - 5} more garbled blocks`);
      for (const pattern of paper.furniture ?? []) {
        const leaks = readable.filter(b => new RegExp(pattern).test(b.text.trim()));
        if (leaks.length) problems.push(`running head/page number /${pattern}/ shown in ${leaks.length} blocks (first p${leaks[0].page})`);
      }
    }
    checked++;
    const status = problems.length ? 'FAIL' : 'PASS';
    if (problems.length) failures++;
    originalWarn(`${status} ${paper.id} [${paper.role}] ${paper.category} — ${blocks.length} blocks, ${seconds.toFixed(1)}s`);
    for (const problem of problems) originalWarn(`     - ${problem}`);
    for (const [key, reason] of Object.entries(paper.knownGaps ?? {})) originalWarn(`     ~ known gap ${key}: ${reason}`);
  }
  console.log(`corpus acceptance: ${checked - failures}/${checked} passed, ${skipped} skipped`);
  assert.equal(failures, 0, `${failures} corpus papers failed acceptance`);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
