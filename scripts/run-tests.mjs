import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Run all self-contained unit & integration regression suites.
 * Argument-driven or user-library corpus benchmarks (`corpus-acceptance`, `conference-acceptance`,
 * `formula-ocr`, `reflow-sample`) have dedicated commands (`npm run test:corpus`, `npm run inspect:reflow`).
 */
const MANUAL_OR_CORPUS_SUITES = new Set([
  'conference-acceptance.mjs',
  'corpus-acceptance.mjs',
  'formula-ocr.mjs',
  'reflow-sample.mjs',
]);

const testFiles = fs
  .readdirSync(path.resolve('tests'))
  .filter(f => f.endsWith('.mjs') && !MANUAL_OR_CORPUS_SUITES.has(f))
  .sort()
  .map(f => path.join('tests', f));

const commands = [
  ...testFiles.map(file => ({ label: file, args: [file] })),
  { label: 'scripts/test-pdf-metadata.mjs', args: ['scripts/test-pdf-metadata.mjs'] },
];

let failed = 0;
const startedAll = Date.now();
for (const { label, args } of commands) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120_000 });
  const ms = Date.now() - t0;
  if (res.status === 0) {
    console.log(`PASS ${label} (${ms}ms)`);
  } else {
    failed++;
    console.error(`FAIL ${label} (exit=${res.status}, ${ms}ms)`);
    if (res.stdout) console.error(res.stdout.trim());
    if (res.stderr) console.error(res.stderr.trim());
  }
}

console.log(`\n${commands.length - failed}/${commands.length} suites passed in ${((Date.now() - startedAll) / 1000).toFixed(1)}s`);
if (failed > 0) process.exit(1);
