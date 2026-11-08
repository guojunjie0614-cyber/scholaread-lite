import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'scholarlite-pdf-metadata-'));
try {
  const testFile = path.join(temporary, 'pdf-metadata.test.mjs');
  await build({
    entryPoints: ['tests/pdf-metadata.test.ts'],
    outfile: testFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
  execFileSync(process.execPath, ['--test', testFile], { stdio: 'inherit' });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
