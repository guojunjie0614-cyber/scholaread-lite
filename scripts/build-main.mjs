import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist-electron', { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron'],
};

await build({
  ...common,
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.cjs',
  format: 'cjs',
});

await build({
  ...common,
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  format: 'cjs',
});

console.log('main + preload built');
