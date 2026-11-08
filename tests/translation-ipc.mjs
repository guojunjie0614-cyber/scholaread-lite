import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-translation-ipc-'));
try {
  await build({
    entryPoints: ['electron/translation-ipc.ts'], bundle: true, platform: 'node', format: 'esm',
    outfile: path.join(temporary, 'ipc.mjs'),
    plugins: [{ name: 'mock-provider', setup(builder) {
      builder.onResolve({ filter: /^\.\/translate\.js$/ }, () => ({ path: 'translate', namespace: 'mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
        contents: 'export const translateBatch=(...args)=>globalThis.translationIpcTest(...args); export const refreshTranslationQueue=()=>{}; export const readCachedTranslations=()=>[]; export class TranslationBatchFailure extends Error {}', loader: 'js',
      }));
    } }],
  });
  const calls = [];
  globalThis.translationIpcTest = (texts, target, signal) => new Promise((resolve, reject) => {
    calls.push({ texts, target, signal, resolve });
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });
  const { registerTranslationIpc } = await import(pathToFileURL(path.join(temporary, 'ipc.mjs')));
  const handlers = new Map();
  registerTranslationIpc({ handle: (name, fn) => handlers.set(name, fn) });
  const a = new EventEmitter(); const b = new EventEmitter();
  const batch = (sender, id) => handlers.get('translate:batch')({ sender }, ['sample'], 'zh-CN', id);
  const cancel = (sender, id) => handlers.get('translate:cancel')({ sender }, id);

  const pa = batch(a, 'shared-id'); const pb = batch(b, 'shared-id');
  const cancelledA = assert.rejects(pa, /cancelled/);
  cancel(a, 'shared-id');
  await cancelledA;
  assert.equal(calls[1].signal.aborted, false, 'one renderer cannot cancel another renderer');
  calls[1].resolve({ results: ['译文'] }); await pb;
  const reused = batch(a, 'shared-id');
  await assert.rejects(batch(a, 'shared-id'), /已在使用/);
  calls.at(-1).resolve({ results: ['译文'] }); await reused;

  for (const event of ['navigation', 'render-process-gone', 'destroyed']) {
    const pending = batch(a);
    const rejected = assert.rejects(pending, /cancelled/);
    if (event === 'navigation') {
      a.emit('did-start-navigation', {}, 'file://subframe', false, false);
      assert.equal(calls.at(-1).signal.aborted, false);
      a.emit('did-start-navigation', {}, 'file://main', false, true);
    } else a.emit(event);
    await rejected;
  }
  await assert.rejects(batch(b, ''), /ID 无效/);
  assert.throws(() => cancel(b, ''), /ID 无效/);
  cancel(b, 'already-finished');
  console.log('PASS translation IPC: scoped cancellation, duplicate IDs, completion cleanup, reload/crash/close abort and legacy calls');
} finally {
  delete globalThis.translationIpcTest;
  await fs.rm(temporary, { recursive: true, force: true });
}
