import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-agy-env-'));
try {
  const output = path.join(root, 'environment.mjs');
  await build({ entryPoints: [path.resolve(import.meta.dirname, '../electron/chat/agy-environment.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'esm', external: ['electron'] });
  const { agyEnvironment } = await import(pathToFileURL(output).href);
  const targets = [];
  const inherited = { HOME: '/example', NO_PROXY: 'localhost,.internal', ELECTRON_RUN_AS_NODE: '1', CLAUDECODE: '1' };
  const environment = await agyEnvironment(async url => { targets.push(url); return 'PROXY 127.0.0.1:7897; DIRECT'; }, inherited);
  assert.deepEqual(targets, ['http://cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com']);
  assert.equal(environment.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.equal(environment.HTTPS_PROXY, 'http://127.0.0.1:7897');
  assert.equal(environment.NO_PROXY, inherited.NO_PROXY);
  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(environment.CLAUDECODE, undefined);
  assert.equal(inherited.ELECTRON_RUN_AS_NODE, '1', 'only the child environment may change');
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    let queried = false;
    const explicit = await agyEnvironment(async () => { queried = true; return 'PROXY ignored:80'; }, { [key]: '', no_proxy: 'keep.example' });
    assert.equal(queried, false, `an explicit ${key}, including empty values, must be respected`);
    assert.equal(explicit[key], '');
    assert.equal(explicit.no_proxy, 'keep.example');
  }
  const direct = await agyEnvironment(async () => 'DIRECT', {});
  assert.equal(direct.HTTP_PROXY, undefined);
  assert.equal(direct.HTTPS_PROXY, undefined);
  const socks = await agyEnvironment(async () => 'SOCKS5 localhost:1080', {});
  assert.equal(socks.HTTPS_PROXY, 'socks5://localhost:1080');
  await assert.rejects(() => agyEnvironment(async () => 'SOCKS4 localhost:1080', {}), /代理类型暂不支持/);
  await assert.rejects(() => agyEnvironment(async () => { throw new Error('native resolver failed'); }, {}), /native resolver failed/);
  console.log('agy environment: native proxy resolution, explicit CLI overrides, NO_PROXY, supported proxy types and child-only changes passed.');
} finally { await fs.rm(root, { recursive: true, force: true }); }
