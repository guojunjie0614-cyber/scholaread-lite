/** Real backend against local HTTP fixtures; never sends a model-generation request. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-backend-'));
const requests = [];
const hits = new Map();
const controlled = new Map();
let active = 0, maxActive = 0;
const server = http.createServer(async (req, res) => {
  let data = '';
  for await (const chunk of req) data += chunk;
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ data: [
      { id: 'flash', reasoning: true, reasoning_levels: ['low', 'high', 'max'], native_endpoints: ['/v1/chat/completions'] },
      { id: 'response', reasoning: true, reasoning_levels: ['low', 'high'], native_endpoints: ['/v1/responses'] },
      { id: 'plain', reasoning: false, native_endpoints: ['/v1/chat/completions'] },
    ] }));
  }
  const body = JSON.parse(data);
  const wireInput = body.input ?? body.messages[1].content;
  const markers = [...wireInput.matchAll(/^⟦SEG:(\d+)⟧\r?\n/gm)];
  const segments = markers.map((marker, index) => ({ id: Number(marker[1]),
    text: wireInput.slice(marker.index + marker[0].length, markers[index + 1]?.index).trimEnd() }));
  const input = segments.map(segment => segment.text).join('\n⟦SEG⟧\n');
  const translated = () => segments.map(segment => `⟦SEG:${segment.id}⟧\n译:${segment.text}`).join('\n');
  const entry = { body, input, wireInput, closed: false, at: Date.now() };
  requests.push(entry);
  const count = (hits.get(input) ?? 0) + 1;
  hits.set(input, count);
  active++; maxActive = Math.max(maxActive, active);
  res.on('close', () => { active--; entry.closed = true; });
  res.setHeader('content-type', 'application/json');
  const respond = content => res.end(JSON.stringify(req.url === '/v1/responses'
    ? { status: 'completed', output: [{ type: 'reasoning', summary: [{ text: 'never display' }] }, { type: 'message', content: [{ type: 'output_text', text: content }] }] }
    : { choices: [{ finish_reason: 'stop', message: { content } }] }));
  if (input.startsWith('auth')) { res.writeHead(401); return res.end('{"error":"test auth"}'); }
  if (input.startsWith('server-error')) { res.writeHead(503); return res.end('{"error":"temporary"}'); }
  if ((input.startsWith('retry') || input.startsWith('backoff-cancel')) && count === 1) {
    res.writeHead(429, { 'retry-after': input.startsWith('backoff-cancel') ? '1' : '0' });
    return res.end('{"error":"rate limit"}');
  }
  if (input.startsWith('long-rate')) { res.writeHead(429, { 'retry-after': '30' }); return res.end('{}'); }
  if (input.startsWith('network')) return req.socket.destroy();
  if (input.startsWith('malformed') && segments.length > 1) return respond('unseparated text');
  if (input.startsWith('scripts-bad')) return respond(`⟦SEG:${segments[0].id}⟧\nscripts removed`);
  if (input.startsWith('empty')) return respond(`⟦SEG:${segments[0].id}⟧\n`);
  if (input.startsWith('controlled')) return controlled.set(input, () => respond(translated()));
  await delay(input.startsWith('slow') || input.startsWith('queued') || input.startsWith('shared') ? 140 : 12);
  if (!res.destroyed) respond(translated());
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
globalThis.backendTestSettings = { targetLang: 'zh-CN', translate: { activeProvider: 'magpie', concurrency: 4, providers: { magpie: { baseUrl, model: 'flash', api: 'chat-completions', temperature: 0.2, reasoningEffort: 'low' } } } };
globalThis.backendTestCache = new Map();
const waitFor = async (predicate, message) => {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await delay(10); }
  assert.fail(message);
};
try {
  await build({ entryPoints: ['electron/translate.ts', 'electron/magpie.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm', outdir: temporary, outExtension: { '.js': '.mjs' },
    plugins: [{ name: 'isolate-state', setup(builder) {
      builder.onResolve({ filter: /^\.\/(settings|db)\.js$/ }, args => ({ path: args.path, namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ loader: 'js', contents: args.path.includes('settings')
        ? 'export const settings={get:()=>globalThis.backendTestSettings};'
        : 'export const translations={candidates:(_key,target,source)=>[...globalThis.backendTestCache.values()].filter(row=>row.target===target&&row.source===source&&row.provider!=="echo"),choose:()=>{},set:(key,target,provider,model,source,result)=>globalThis.backendTestCache.set(key,{hash:key,target,provider,model,source,result})};' }));
    } }] });
  const { translateBatch } = await import(pathToFileURL(path.join(temporary, 'translate.mjs')));
  const { magpieModels } = await import(pathToFileURL(path.join(temporary, 'magpie.mjs')));
  const catalogue = await magpieModels(baseUrl);
  assert.deepEqual(catalogue[0].reasoningLevels, ['low', 'high', 'max']);
  assert.equal(catalogue[2].reasoningLevels, undefined);
  assert.deepEqual((await translateBatch(['low setting'])).results, ['译:low setting']);
  assert.equal(requests.at(-1).body.reasoning_effort, 'low');
  assert.equal(requests.at(-1).body.model, 'flash');
  const beforeCache = requests.length;
  assert.equal((await translateBatch(['low setting'])).cached, true);
  assert.equal(requests.length, beforeCache);

  // Four calls run together; a fifth is queued and can be cancelled without HTTP.
  const blockers = Array.from({ length: 4 }, (_, i) => translateBatch([`slow blocker ${i}`]));
  await waitFor(() => active === 4, 'four requests should be in flight');
  const queuedAbort = new AbortController();
  const queued = translateBatch(['queued never sent'], undefined, queuedAbort.signal);
  const queuedRejected = assert.rejects(queued, error => error.name === 'AbortError');
  queuedAbort.abort(); await queuedRejected;
  await Promise.all(blockers);
  assert.equal(hits.has('queued never sent'), false);
  maxActive = 0;
  await Promise.all(Array.from({ length: 10 }, (_, i) => translateBatch([`slow concurrent ${i}`])));
  assert.equal(maxActive, 4, 'global HTTP concurrency must equal the requested cap');

  for (const concurrency of [1, 2, 6]) {
    globalThis.backendTestSettings.translate.concurrency = concurrency;
    maxActive = 0;
    await Promise.all(Array.from({ length: 8 }, (_, i) => translateBatch([`slow configured ${concurrency} ${i}`])));
    assert.equal(maxActive, concurrency, 'HTTP admissions must follow the configured cap');
  }
  globalThis.backendTestSettings.translate.concurrency = 4;
  const lowering = Array.from({ length: 7 }, (_, i) => translateBatch([`controlled lowering ${i}`]));
  await waitFor(() => active === 4, 'controlled requests should fill four slots');
  globalThis.backendTestSettings.translate.concurrency = 2;
  for (let i = 0; i < 2; i++) {
    controlled.get(`controlled lowering ${i}`)();
    await lowering[i];
    await delay(20);
    assert.equal(hits.has('controlled lowering 4'), false, 'lowering cap cannot refill while active count is at or above the new cap');
  }
  controlled.get('controlled lowering 2')(); await lowering[2];
  await waitFor(() => hits.has('controlled lowering 4'), 'a queued request starts after active count falls below the lowered cap');
  assert.equal(active, 2);
  for (let i = 3; i < 7; i++) {
    await waitFor(() => controlled.has(`controlled lowering ${i}`), 'remaining request should be admitted');
    controlled.get(`controlled lowering ${i}`)();
    await lowering[i];
  }
  await Promise.all(lowering);
  globalThis.backendTestSettings.translate.concurrency = 4;

  // Cancellation is scoped to consumers; identical in-flight work is sent once.
  const consumer = new AbortController();
  const sharedA = translateBatch(['shared work'], undefined, consumer.signal);
  const sharedRejected = assert.rejects(sharedA, error => error.name === 'AbortError');
  const sharedB = translateBatch(['shared work']);
  await waitFor(() => hits.get('shared work') === 1, 'shared request should start');
  consumer.abort(); await sharedRejected;
  assert.deepEqual((await sharedB).results, ['译:shared work']);
  assert.equal(hits.get('shared work'), 1);

  const abortAll = new AbortController();
  const abortPromise = translateBatch(['slow abort all'], undefined, abortAll.signal);
  const aborted = assert.rejects(abortPromise, error => error.name === 'AbortError');
  await waitFor(() => hits.has('slow abort all'), 'request should start before abort');
  abortAll.abort(); await aborted;
  await waitFor(() => requests.find(r => r.input === 'slow abort all').closed, 'abort must close the actual HTTP response');
  assert.equal(hits.get('slow abort all'), 1);
  const restarted = await translateBatch(['slow abort all']);
  assert.deepEqual(restarted.results, ['译:slow abort all']);
  assert.equal(hits.get('slow abort all'), 2, 'new request must not attach to abandoned flight');

  const beforeAuth = requests.length;
  await assert.rejects(translateBatch(['auth one', 'auth two', 'auth three']), /401/);
  assert.equal(requests.length - beforeAuth, 1, 'auth failure must not retry or fan out');
  const beforeServer = requests.length;
  await assert.rejects(translateBatch(['server-error one', 'server-error two']), /503/);
  assert.equal(requests.length - beforeServer, 2, 'server failures retry once, without per-segment fanout');
  const beforeNetwork = requests.length;
  await assert.rejects(translateBatch(['network one', 'network two']), /请求失败/);
  assert.equal(requests.length - beforeNetwork, 2);
  const beforeLong = requests.length;
  await assert.rejects(translateBatch(['long-rate']), /429/);
  assert.equal(requests.length - beforeLong, 1, 'long retry-after must surface without early retry');
  const beforeRetry = requests.length;
  await translateBatch(['retry normal']);
  assert.equal(requests.length - beforeRetry, 2);

  const backoffAbort = new AbortController();
  const duringBackoff = translateBatch(['backoff-cancel now'], undefined, backoffAbort.signal);
  const backoffRejected = assert.rejects(duringBackoff, error => error.name === 'AbortError');
  await waitFor(() => hits.has('backoff-cancel now'), 'rate limited request should finish');
  backoffAbort.abort(); await backoffRejected;
  await delay(1050);
  assert.equal(hits.get('backoff-cancel now'), 1, 'cancellation must stop retry backoff');

  const originalTimeout = AbortSignal.timeout;
  try {
    AbortSignal.timeout = ms => originalTimeout.call(AbortSignal, ms === 90_000 ? 30 : ms);
    await assert.rejects(translateBatch(['slow timeout']), /超时/);
    await waitFor(() => requests.find(r => r.input === 'slow timeout')?.closed, 'timeout must close HTTP');
    assert.equal(hits.get('slow timeout'), 1, 'a deadline timeout must not restart a long request');
  } finally { AbortSignal.timeout = originalTimeout; }

  const beforeMalformed = requests.length;
  assert.deepEqual((await translateBatch(['malformed first', 'malformed second'])).results, ['译:malformed first', '译:malformed second']);
  assert.equal(requests.length - beforeMalformed, 3, 'segment mismatch recovers only missing IDs in smaller requests');
  const cacheBeforeInvalid = globalThis.backendTestCache.size;
  await assert.rejects(translateBatch(['scripts-bad x<sub>1</sub>']), /上下标/);
  assert.equal(globalThis.backendTestCache.size, cacheBeforeInvalid);
  await assert.rejects(translateBatch(['empty result']), /缺少段落/);
  assert.equal(globalThis.backendTestCache.size, cacheBeforeInvalid);

  // Settings changes after submission must not change the queued request's model or temperature.
  const old = globalThis.backendTestSettings.translate.providers.magpie;
  const held = Array.from({ length: 4 }, (_, i) => translateBatch([`slow snapshot blocker ${i}`]));
  await waitFor(() => active === 4, 'snapshot blockers should start');
  const snapshot = translateBatch(['snapshot request']);
  globalThis.backendTestSettings.translate.providers.magpie.model = 'plain';
  globalThis.backendTestSettings.translate.providers.magpie.temperature = 0.8;
  await snapshot; await Promise.all(held);
  const snapshotRequest = requests.find(r => r.input === 'snapshot request');
  assert.equal(snapshotRequest.body.model, 'flash');
  assert.equal(snapshotRequest.body.temperature, 0.2);
  delete globalThis.backendTestSettings.translate.providers.magpie.reasoningEffort;
  await translateBatch(['plain request']);
  assert.equal(requests.at(-1).body.reasoning_effort, undefined);
  globalThis.backendTestSettings.translate.providers.magpie = { ...old, model: 'response', api: 'responses', reasoningEffort: 'low' };
  assert.deepEqual((await translateBatch(['responses low'])).results, ['译:responses low']);
  assert.deepEqual(requests.at(-1).body.reasoning, { effort: 'low' });
  assert.equal(requests.at(-1).body.reasoning_effort, undefined);
  for (const api of ['chat-completions', 'responses']) {
    for (const reasoningEffort of ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      globalThis.backendTestSettings.translate.providers.magpie = { ...old, api, reasoningEffort };
      await translateBatch([`thinking ${api} ${reasoningEffort}`]);
      const body = requests.at(-1).body;
      const expected = reasoningEffort === 'default' ? undefined : reasoningEffort;
      assert.equal(api === 'responses' ? body.reasoning?.effort : body.reasoning_effort, expected);
      assert.equal(api === 'responses' ? body.reasoning_effort : body.reasoning, undefined);
    }
  }
  console.log('PASS backend: configurable HTTP cap and safe lowering, queue abort, shared consumer cancellation, real HTTP abort, restart, cache, bounded retries, Retry-After, abort during backoff, format-only recovery, script integrity, settings snapshots and all thinking levels in both protocols');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
  delete globalThis.backendTestSettings; delete globalThis.backendTestCache;
}
