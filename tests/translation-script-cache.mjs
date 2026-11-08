/** Exercise the actual translator with local provider responses and an isolated cache. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-script-cache-'));
const originalFetch = globalThis.fetch;
globalThis.scriptCache = new Map();
globalThis.scriptWrites = 0;
globalThis.scriptPoison = false;
try {
  const bundled = path.join(temp, 'translator.mjs');
  const stubs = {
    './settings.js': `export const settings={get:()=>({targetLang:'zh-CN',translate:{activeProvider:'openai',providers:{openai:{apiKey:'local-test-key',baseUrl:'https://test.invalid/v1',model:'test-model'}}}})};`,
    './db.js': `export const translations={candidates:(_key,target,source)=>globalThis.scriptPoison?[{hash:'invalid',provider:'openai',model:'test-model',result:'PFA = 10−3'}]:[...globalThis.scriptCache.values()].filter(row=>row.target===target&&row.source===source),choose:()=>{},set:(key,target,provider,model,source,result)=>{globalThis.scriptWrites++;globalThis.scriptCache.set(key,{hash:key,target,provider,model,source,result});}};`,
  };
  await build({ entryPoints: ['electron/translate.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundled,
    plugins: [{ name: 'isolated-translator', setup(builder) {
      builder.onResolve({ filter: /^\.\/(settings|db)\.js$/ }, args => ({ path: args.path, namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }] });
  let calls = 0, valid = false;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    assert.match(request.messages[0].content, /<sub>.*<sup>.*逐字保留/);
    const source = request.messages[1].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: valid ? source.replace('target', '目标') : 'PFA = 10−3' } }] }), { status: 200 });
  };
  const { translateBatch } = await import(pathToFileURL(bundled));
  const source = 'target P<sub>FA</sub> = 10<sup>−3</sup>';
  await assert.rejects(translateBatch([source]), /上下标/);
  assert.equal(globalThis.scriptWrites, 0, 'invalid scripts must not enter persistent cache');
  valid = true;
  const translated = await translateBatch([source]);
  assert.equal(translated.results[0], '目标 P<sub>FA</sub> = 10<sup>−3</sup>');
  assert.equal(globalThis.scriptWrites, 1);
  const callsBeforeCache = calls;
  await translateBatch([source]);
  assert.equal(calls, callsBeforeCache, 'validated cache hit should be reused');
  globalThis.scriptPoison = true;
  await translateBatch([source]);
  assert.equal(calls, callsBeforeCache + 1, 'an invalid legacy cache entry must be replaced');
  assert.equal(globalThis.scriptWrites, 2);
  console.log('PASS provider script instructions, rejection before cache writes, validated cache reuse and invalid-cache recovery');
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.scriptCache; delete globalThis.scriptWrites; delete globalThis.scriptPoison;
  await fs.rm(temp, { recursive: true, force: true });
}
