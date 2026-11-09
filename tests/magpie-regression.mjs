/** Exercise gateway discovery and both translation protocols without paid model calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-magpie-'));
const requests = [];
let catalogue = { data: [
  { id: 'chat/model', magpie_label: 'Chat · 本地网关', native_endpoints: ['/v1/chat/completions'] },
  { id: 'codex/model', display_name: 'Codex', native_endpoints: ['/v1/responses'] },
  { id: 'chat/model' },
  { id: 'audio/model', native_endpoints: ['/v1/audio/transcriptions'] },
  { id: '' },
] };
let catalogueStatus = 200;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  requests.push({ url: req.url, headers: req.headers, body });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') {
    res.writeHead(catalogueStatus);
    return res.end(JSON.stringify(catalogue));
  }
  if (req.url === '/v1/chat/completions') {
    const marker = body.messages[1].content.split('\n', 1)[0];
    return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: `${marker}\n测试译文` } }] }));
  }
  if (req.url === '/v1/responses') {
    const marker = body.input.split('\n', 1)[0];
    return res.end(JSON.stringify({ status: 'completed', output: [
      { type: 'reasoning', summary: [{ text: 'Internal reasoning must not enter the translation' }] },
      { type: 'message', content: [{ type: 'output_text', text: `${marker}\nResponses 译文` }] },
    ] }));
  }
  res.writeHead(404); res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

try {
  const stubs = {
    './settings.js': 'export const settings={get:()=>globalThis.magpieTestSettings};',
    './db.js': 'export const translations={candidates:()=>[],choose:()=>{},set:()=>{}};',
  };
  await build({
    entryPoints: ['electron/magpie.ts', 'electron/translate.ts'], bundle: true,
    platform: 'node', format: 'esm', target: 'node22', outdir: temporary, outExtension: { '.js': '.mjs' },
    plugins: [{ name: 'isolated-translation', setup(builder) {
      builder.onResolve({ filter: /^\.\/(settings|db)\.js$/ }, args => ({ path: args.path, namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }],
  });
  const { magpieModels, magpieBaseUrl, providerModels } = await import(pathToFileURL(path.join(temporary, 'magpie.mjs')));
  const { translateBatch } = await import(pathToFileURL(path.join(temporary, 'translate.mjs')));
  assert.equal(magpieBaseUrl('http://127.0.0.1:3425/'), 'http://127.0.0.1:3425/v1');
  assert.equal(magpieBaseUrl(`${baseUrl}///`), baseUrl);
  for (const invalid of ['file:///tmp/gateway', 'http://name:password@localhost/v1', `${baseUrl}?key=test`, '']) {
    assert.throws(() => magpieBaseUrl(invalid));
  }
  const models = await magpieModels(baseUrl);
  assert.deepEqual(models, [
    { id: 'chat/model', label: 'Chat · 本地网关', api: 'chat-completions' },
    { id: 'codex/model', label: 'Codex', api: 'responses' },
  ]);
  assert.equal(requests.at(-1).headers.authorization, undefined);
  await assert.rejects(providerModels('openai', { baseUrl, apiKey: '' }), /API Key/);
  const openaiModels = await providerModels('openai', { baseUrl, apiKey: 'sk-test-123' });
  assert.equal(requests.at(-1).headers.authorization, 'Bearer sk-test-123');
  assert.deepEqual(openaiModels, [
    { id: 'chat/model', label: 'chat/model', api: 'chat-completions' },
    { id: 'codex/model', label: 'Codex', api: 'chat-completions' },
  ]);
  catalogue = { data: [] };
  await assert.rejects(magpieModels(baseUrl), /未提供可用于翻译的模型/);
  catalogue = { error: 'not a catalogue' };
  await assert.rejects(magpieModels(baseUrl), /缺少 data 数组/);
  catalogueStatus = 401;
  await assert.rejects(magpieModels(baseUrl), /HTTP 401/);

  globalThis.magpieTestSettings = { targetLang: 'zh-CN', translate: {
    activeProvider: 'magpie', providers: { magpie: { baseUrl, model: models[0].id, api: models[0].api } },
  } };
  assert.deepEqual((await translateBatch(['sample'])).results, ['测试译文']);
  let request = requests.at(-1);
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.body.model, 'chat/model');
  assert.equal(request.body.messages[1].content, '⟦SEG:0⟧\nsample');

  globalThis.magpieTestSettings.translate.providers.magpie = { baseUrl, model: models[1].id, api: models[1].api };
  assert.deepEqual((await translateBatch(['another sample'])).results, ['Responses 译文']);
  request = requests.at(-1);
  assert.equal(request.url, '/v1/responses');
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.body.model, 'codex/model');
  assert.equal(request.body.input, '⟦SEG:0⟧\nanother sample');
  assert.match(request.body.instructions, /学术文献/);
  assert.equal(request.body.temperature, undefined);

  const before = requests.length;
  globalThis.magpieTestSettings.translate.providers.magpie.model = '';
  await assert.rejects(translateBatch(['sample']), /选择模型/);
  globalThis.magpieTestSettings.translate.activeProvider = 'openai';
  globalThis.magpieTestSettings.translate.providers.openai = { baseUrl, model: 'legacy-model' };
  await assert.rejects(translateBatch(['sample']), /未配置 API Key/);
  assert.equal(requests.length, before, 'invalid configuration must fail before a request');
  globalThis.magpieTestSettings.translate.providers.openai.apiKey = 'local-test-only';
  await translateBatch(['sample']);
  assert.equal(requests.at(-1).headers.authorization, 'Bearer local-test-only');

  const config = path.join(temporary, 'config.json');
  const settingsBundle = path.join(temporary, 'actual-settings.mjs');
  await build({ entryPoints: ['electron/settings.ts'], bundle: true, platform: 'node', format: 'esm', outfile: settingsBundle,
    plugins: [{ name: 'isolated-settings', setup(builder) {
      builder.onResolve({ filter: /^\.\/paths\.js$/ }, () => ({ path: 'paths', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export const paths={config:()=>${JSON.stringify(config)}};`, loader: 'js' }));
    } }] });
  const { settings } = await import(pathToFileURL(settingsBundle));
  const original = structuredClone(settings.get());
  assert.equal(original.translate.providers.magpie.baseUrl, 'http://127.0.0.1:3425/v1');
  assert.equal(settings.providers().find(provider => provider.id === 'magpie').needsKey, false);
  assert.throws(() => settings.set({ translate: { activeProvider: 'magpie' } }), /获取并选择/);
  assert.deepEqual(settings.get(), original, 'rejected save must preserve active settings');
  assert.throws(() => settings.set({ translate: { activeProvider: 'magpie', providers: { magpie: { baseUrl: 'invalid', model: 'chat/model' } } } }), /有效/);
  assert.deepEqual(settings.get(), original);
  const saved = settings.set({ translate: { activeProvider: 'magpie', providers: { magpie: { baseUrl: `${baseUrl}/`, model: ' chat/model ', api: 'chat-completions' } } } });
  assert.equal(saved.translate.providers.magpie.baseUrl, baseUrl);
  assert.equal(JSON.parse(await fs.readFile(config, 'utf8')).translate.providers.magpie.model, 'chat/model');
  console.log('PASS Magpie live HTTP discovery, explicit errors, chat/Responses translation, no-key auth, legacy auth and atomic settings validation');
} finally {
  delete globalThis.magpieTestSettings;
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
}
