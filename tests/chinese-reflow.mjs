/** Segment-priority renderer scheduling and scientific text, using local deterministic responses only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-chinese-'));
try {
  const bundle = path.join(temp, 'translate.mjs');
  await build({ entryPoints: ['renderer/src/lib/chinese-reflow.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundle });
  const { prepareChineseReflow, restoreCachedReflow, translationPageProgress, translationPageFeedback, translatableBlocks } = await import(pathToFileURL(bundle));
  const block = (id, kind, text) => ({ id, paperId: 'test-paper', page: 1, ord: 0, kind, text });
  const blocks = [block('title', 'h1', 'Title'), block('body', 'p', 'Paragraph'), block('caption', 'caption', 'Figure 1: diagram'),
    block('ref', 'ref', '[1] Author, paper.'), block('note', 'table-note', 'Conditions'), block('empty', 'p', ''),
    block('math', 'math', 'x + y'), block('figure', 'figure', 'diagram pixels'), block('table', 'table', 'table pixels'), block('algorithm', 'algorithm', 'Algorithm 1'),
    { ...block('authors', 'p', 'Alice Wang, Bob Chen'), readingRole: 'authors' },
    { ...block('bio', 'p', 'Alice received her Ph.D. degree.'), readingRole: 'biography' },
    block('refs-heading', 'h2', 'REFERENCES')];
  const original = structuredClone(blocks);
  let progress = [], calls = 0;
  const options = { cancelled: () => false, onProgress: (done, total) => progress.push([done, total]), onBatch() {} };
  const translate = async (texts, target) => { calls++; assert.equal(target, 'zh-CN'); return { results: texts.map(t => `中文 ${t}`), provider: 'test', model: 'test', cached: false }; };
  const result = await prepareChineseReflow(blocks, {}, translate, options);
  assert.deepEqual(Object.keys(result).sort(), ['body', 'caption', 'note', 'title']);
  assert.deepEqual(blocks, original, 'translation cannot mutate source blocks');
  assert.deepEqual(progress.at(-1), [4, 4]);
  assert.equal(translatableBlocks(blocks).length, 4);
  await prepareChineseReflow(blocks, result, async () => { throw new Error('Complete cache should avoid requests'); }, options);
  let reused = [];
  await prepareChineseReflow([block('body', 'p', 'Changed paragraph')], result, async texts => {
    reused = texts; return { results: ['新段落'], provider: 'test', model: 'test', cached: false };
  }, options);
  assert.deepEqual(reused, ['Changed paragraph'], 'reused block IDs cannot reuse stale source translations');
  for (const results of [[], [''], ['one', 'two']]) {
    await assert.rejects(prepareChineseReflow([blocks[0]], {}, async () => ({ results }), options), /缺失的段落/);
  }
  await assert.rejects(prepareChineseReflow(blocks, {}, async () => { throw new Error('Provider failed'); }, options), /Provider failed/);
  let cancelled = false, batchCalls = 0, released;
  const pending = new Promise(resolve => { released = resolve; });
  const longBlocks = [block('one', 'p', 'a'.repeat(3500)), block('two', 'p', 'b'.repeat(3500))];
  const working = prepareChineseReflow(longBlocks, {}, async () => { batchCalls++; await pending; return { results: ['迟到的译文'] }; }, { ...options, cancelled: () => cancelled, onBatch() { throw new Error('Cancelled response must not publish'); } });
  cancelled = true; released();
  assert.equal(await working, null);
  assert.equal(batchCalls, 2, 'at most the already-started batches may finish after cancellation');
  let partial = {};
  batchCalls = 0;
  await assert.rejects(prepareChineseReflow(longBlocks, {}, async () => {
    if (++batchCalls === 2) throw new Error('Second batch failed');
    return { results: ['第一段译文'] };
  }, { ...options, onBatch: value => { partial = value; } }), /Second batch failed/);
  assert.deepEqual(Object.keys(partial), ['one']);
  batchCalls = 0;
  const resumed = await prepareChineseReflow(longBlocks, partial, async texts => {
    batchCalls++; assert.deepEqual(texts, ['b'.repeat(3500)]); return { results: ['第二段译文'] };
  }, options);
  assert.equal(batchCalls, 1);
  assert.equal(Object.keys(resumed).length, 2);
  // The visible page starts first; background requests reserve one configured slot.
  // These are renderer promises, not HTTP calls; the backend owns the global HTTP cap.
  const pageBlocks = Array.from({ length: 9 }, (_, i) => ({ ...block(`page-${i + 1}`, 'p', `Page ${i + 1}`), page: i + 1 }));
  let visiblePage = 5, active = 0, maxActive = 0;
  const starts = [], releases = new Map(), readyPages = [], states = new Map();
  const scheduled = prepareChineseReflow(pageBlocks, {}, async texts => {
    const page = Number(texts[0].slice(5));
    starts.push(page); active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => releases.set(page, resolve));
    active--;
    return { results: [`中文第 ${page} 页`] };
  }, { ...options, getCurrentPage: () => visiblePage,
    onPageState: (page, state) => states.set(page, state.status),
    onPageReady: page => readyPages.push(page),
  });
  assert.deepEqual(starts, [5, 6, 4, 7]);
  assert.equal(maxActive, 4);
  visiblePage = 9;
  releases.get(5)();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(readyPages, [5], 'ready current page publishes before the full document');
  assert.equal(starts.at(-1), 9, 'pending work follows a newly selected page');
  while (releases.size) {
    for (const [page, release] of [...releases]) { releases.delete(page); release(); }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(Object.keys(await scheduled).length, 9);
  assert.ok(maxActive <= 5, 'renderer requests allow at most one foreground reserve beyond configured concurrency');
  assert.equal(readyPages.length, 9);

  // A wholly visible workload may submit one extra foreground promise to the backend queue.
  for (const concurrency of [1, 2, 6]) {
    let running = 0, peak = 0;
    const configuredReleases = [];
    const configured = prepareChineseReflow(pageBlocks, {}, async texts => {
      running++; peak = Math.max(peak, running);
      await new Promise(resolve => configuredReleases.push(resolve));
      running--;
      return { results: texts };
    }, { ...options, concurrency, getVisibleBlockIds: () => pageBlocks.map(block => block.id) });
    assert.equal(running, concurrency + 1, 'renderer may submit one foreground reserve without changing the HTTP cap');
    while (configuredReleases.length) {
      configuredReleases.splice(0).forEach(release => release());
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(Object.keys(await configured).length, 9);
    assert.equal(peak, concurrency + 1, 'renderer promises stay bounded to configured concurrency plus one reserve');
  }

  // A validated segment publishes before its batch finishes; a partial page is not fully ready.
  const multiPage = [
    { ...block('multi-one', 'p', 'A'.repeat(3500)), page: 2 },
    { ...block('multi-two', 'p', 'B'.repeat(3500)), page: 2 },
    { ...block('other', 'p', 'Other'), page: 3 },
  ];
  const multiRelease = new Map(), pageReady = [];
  let progressive = {};
  const multi = prepareChineseReflow(multiPage, {}, async (texts, target, batch) => {
    const id = texts[0][0];
    if (id === 'A') batch.onSegment(0, `中文${texts[0]}`);
    await new Promise(resolve => multiRelease.set(id, resolve));
    return { results: texts.map(t => `中文${t}`) };
  }, { ...options, getCurrentPage: () => 2, onBatch: value => { progressive = value; }, onPageReady: page => pageReady.push(page) });
  assert.deepEqual(Object.keys(progressive), ['multi-one'], 'a complete segment publishes while the rest of its page is still pending');
  multiRelease.get('A')(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pageReady, [], 'a partial page is not ready');
  multiRelease.get('B')(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pageReady, [2]);
  multiRelease.get('O')(); await multi;

  // One failed page does not stop independent pages, and retry reuses complete batches.
  let surviving = {}, independentReady = [];
  await assert.rejects(prepareChineseReflow(multiPage, {}, async texts => {
    if (texts[0][0] === 'B') throw new Error('Recoverable page failure');
    return { results: texts.map(t => `中文${t}`) };
  }, { ...options, onBatch: value => { surviving = value; }, onPageReady: page => independentReady.push(page) }), /第 2 页.*Recoverable/);
  assert.deepEqual(independentReady, [3]);
  assert.deepEqual(Object.keys(surviving).sort(), ['multi-one', 'other']);
  let retried = [];
  const recovered = await prepareChineseReflow(multiPage, surviving, async texts => {
    retried.push(...texts); return { results: texts.map(t => `中文${t}`) };
  }, options);
  assert.deepEqual(retried, ['B'.repeat(3500)]);
  assert.equal(Object.keys(recovered).length, 3);

  // Abort settles promptly, does not publish late responses, and never starts queued jobs.
  const controller = new AbortController();
  let abortCalls = 0, batchAborts = 0, lateRelease;
  const late = new Promise(resolve => { lateRelease = resolve; });
  const aborting = prepareChineseReflow(pageBlocks, {}, async (texts, target, batch) => {
    batch.signal.addEventListener('abort', () => { batchAborts++; }, { once: true });
    abortCalls++; await late; return { results: texts };
  }, { ...options, signal: controller.signal, onBatch() { assert.fail('aborted results cannot publish'); } });
  assert.equal(abortCalls, 4);
  controller.abort();
  assert.equal(batchAborts, abortCalls, 'session abort propagates to every active batch');
  assert.equal(await aborting, null, 'renderer cancellation must not wait for the provider');
  lateRelease(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(abortCalls, 4);
  // Same script sequences as the actual IoTJ TABLE VI notes: H_1 and P_FA = 10^-3.
  const scientific = { ...block('scientific', 'table-note', 'H1 input; target PFA = 10−3.'), page: 10,
    textRuns: [{ text: 'H' }, { text: '1', script: 'sub' }, { text: ' input; target P' },
      { text: 'FA', script: 'sub' }, { text: ' = 10' }, { text: '−3', script: 'sup' }, { text: '.' }] };
  const sourceCopy = structuredClone(scientific);
  const annotatedSource = 'H<sub>1</sub> input; target P<sub>FA</sub> = 10<sup>−3</sup>.';
  const accepted = await prepareChineseReflow([scientific, blocks[6], blocks[7], blocks[8]], {}, async texts => {
    assert.deepEqual(texts, [annotatedSource]);
    return { results: ['H<sub>1</sub> 输入；目标 P<sub>FA</sub> = 10<sup>−3</sup>。'] };
  }, options);
  assert.deepEqual(accepted.scientific.runs.filter(run => run.script), [
    { text: '1', script: 'sub' }, { text: 'FA', script: 'sub' }, { text: '−3', script: 'sup' },
  ]);
  assert.deepEqual(scientific, sourceCopy);
  assert.deepEqual(Object.keys(accepted), ['scientific'], 'formula/image/table blocks remain untouched');
  assert.equal(accepted.scientific.source, annotatedSource);
  assert.equal(accepted.scientific.text, 'H1 输入；目标 PFA = 10−3。');

  // Out-of-order completion keeps the slow middle explicit, never counting it as done.
  const middleBlocks = ['first', 'middle', 'last'].map((id, ord) => ({ ...block(id, 'p', id.repeat(1300)), ord }));
  const middleStates = {}, middleReleases = new Map(), middleReady = [];
  let middlePublished = {};
  const middleRun = prepareChineseReflow(middleBlocks, {}, async texts => {
    const id = middleBlocks.find(block => block.text === texts[0]).id;
    await new Promise(resolve => middleReleases.set(id, resolve));
    return { results: [`中文 ${id}`] };
  }, { ...options, concurrency: 2, states: middleStates,
    getVisibleBlockIds: () => middleBlocks.map(block => block.id),
    onBatch: partial => { middlePublished = partial; }, onPageReady: page => middleReady.push(page) });
  middleReleases.get('first')(); middleReleases.get('last')();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Object.keys(middlePublished).sort(), ['first', 'last']);
  assert.equal(middleStates.middle.status, 'running');
  assert.deepEqual(translationPageProgress(middleBlocks, 1, middlePublished, middleStates),
    { done: 2, total: 3, restored: 0, completed: 2, failed: 0, untranslated: 0 });
  assert.deepEqual(middleReady, []);
  middleReleases.get('middle')(); await middleRun;
  assert.deepEqual(middleReady, [1]);

  // Three cached auxiliary blocks are not three newly translated paragraphs.
  const cacheBlocks = ['title', 'caption', 'heading'].map((id, ord) => ({ ...block(id, ord ? 'caption' : 'h1', `Source ${id}`), ord }));
  const abstract = { ...block('abstract', 'p', 'The complete abstract is still pending.'), ord: 3 };
  const restored = restoreCachedReflow(cacheBlocks, cacheBlocks.map(block => ({ text: `缓存 ${block.id}`, provider: 'test', model: 'test' })), {});
  assert.deepEqual(translationPageProgress([...cacheBlocks, abstract], 1, restored.translations, { abstract: { status: 'queued', attempts: 0 } }),
    { done: 3, total: 4, restored: 3, completed: 0, failed: 0, untranslated: 0 });
  assert.deepEqual(translationPageProgress([...cacheBlocks, { ...abstract, page: 2 }], 2, restored.translations, {}),
    { done: 0, total: 1, restored: 0, completed: 0, failed: 0, untranslated: 0 });
  const mixedCache = restoreCachedReflow([cacheBlocks[0], scientific, abstract], [
    { text: '已有标题', provider: 'test', model: 'test' },
    { text: 'H1 缺失上下标', provider: 'test', model: 'test' },
    { text: '已有完整摘要', provider: 'test', model: 'test' },
  ], {});
  assert.deepEqual(mixedCache.rejectedIds, ['scientific']);
  assert.deepEqual(Object.keys(mixedCache.translations), ['title', 'abstract'], 'invalid cache entries cannot abort restoration of later paragraphs');
  let cacheReloadCalls = [];
  const reload = await prepareChineseReflow([cacheBlocks[0], scientific, abstract], mixedCache.translations, async texts => {
    cacheReloadCalls.push(...texts); return { results: [annotatedSource] };
  }, options);
  assert.deepEqual(cacheReloadCalls, [annotatedSource]);
  assert.equal(Object.keys(reload).length, 3);
  assert.equal(translationPageFeedback([cacheBlocks[0], abstract], 1, { title: mixedCache.translations.title },
    { title: { status: 'succeeded', attempts: 1 }, abstract: { status: 'failed', attempts: 3, error: '摘要失败' } }).status, 'mixed',
  'a successful title-only retry cannot mark a still-failed abstract as ready');
  assert.equal(translationPageFeedback([cacheBlocks[0], abstract], 1, mixedCache.translations, {}).status, 'ready');

  // Visible body precedes visible captions; missing earlier body keeps reading continuity.
  const priorityBlocks = [
    { ...block('priority-caption', 'caption', 'Caption'), ord: 4 },
    { ...block('priority-visible', 'p', 'V'.repeat(2300)), ord: 3 },
    { ...block('priority-gap', 'p', 'G'.repeat(2300)), ord: 1 },
    { ...block('priority-abstract', 'p', 'A'.repeat(2300)), ord: 2 },
  ];
  const priorityStarts = [];
  await prepareChineseReflow(priorityBlocks, {}, async (texts, target, batch) => {
    priorityStarts.push(...batch.blocks.map(block => block.id)); return { results: texts.map(text => `中文 ${text}`) };
  }, { ...options, concurrency: 1, getVisibleBlockIds: () => ['priority-caption', 'priority-visible'] });
  assert.deepEqual(priorityStarts, ['priority-visible', 'priority-gap', 'priority-abstract', 'priority-caption']);

  // Source validation is a paragraph boundary, both on initial and viewport-triggered pumps.
  for (const damagedSource of ['bad\ufffdparagraph', '<slmath>broken</slmath>']) {
    const damagedBlocks = [block('valid-before', 'p', 'Good paragraph'), block('damaged-source', 'p', damagedSource),
      { ...block('valid-after', 'p', 'Good later'), page: 2 }];
    const damagedStates = {}, damagedCalls = [];
    let damagedPartial = {}, damagedViewport, damagedPage = 1, firstRelease;
    const damagedRun = prepareChineseReflow(damagedBlocks, {}, async texts => {
      damagedCalls.push(...texts);
      if (texts.includes('Good paragraph')) await new Promise(resolve => { firstRelease = resolve; });
      return { results: texts.map(text => `中文 ${text}`) };
    }, { ...options, scope: 'reading', states: damagedStates, getCurrentPage: () => damagedPage,
      onBatch: partial => { damagedPartial = partial; }, subscribeViewport: listener => { damagedViewport = listener; return () => {}; } });
    // Attach the expected rejection before resolving asynchronous jobs.
    const damagedSettled = assert.rejects(damagedRun, /第 1 页.*(?:字符|数学结构)/);
    assert.equal(damagedStates['damaged-source'].status, 'failed');
    assert.ok(damagedCalls.includes('Good paragraph'), 'bad source cannot prevent an earlier valid paragraph from starting');
    damagedPage = 2;
    assert.doesNotThrow(() => damagedViewport(), 'viewport re-pumps cannot throw a source error into a browser event');
    firstRelease(); await damagedSettled;
    assert.deepEqual(Object.keys(damagedPartial).sort(), ['valid-after', 'valid-before']);
    assert.equal(damagedCalls.includes(damagedSource), false);
    assert.equal(translationPageProgress(damagedBlocks, 1, damagedPartial, damagedStates).failed, 1);
  }

  // Retryable transport errors retry only the missing block, with a finite attempt budget.
  const retryStates = {};
  let retryCalls = 0, retryPartial = {};
  const retryBlock = block('transport-retry', 'p', 'Transport input');
  const retryResult = await prepareChineseReflow([retryBlock], {}, async () => {
    if (++retryCalls === 1) throw new Error('fetch failed: connection reset');
    return { results: ['网络恢复后的译文'] };
  }, { ...options, states: retryStates, onBatch: partial => { retryPartial = partial; } });
  assert.equal(retryCalls, 2);
  assert.equal(retryStates['transport-retry'].status, 'succeeded');
  assert.equal(Object.keys(retryResult).length, 1);
  assert.equal(Object.keys(retryPartial).length, 1);
  const failedStates = {};
  let failedCalls = 0, failedPartial = {};
  await assert.rejects(prepareChineseReflow([retryBlock], {}, async () => {
    failedCalls++; return { results: [''], failures: [{ index: 0, message: '服务临时不可用', retryable: true }] };
  }, { ...options, states: failedStates, onBatch: partial => { failedPartial = partial; } }), /第 1 页.*服务临时不可用/);
  assert.equal(failedCalls, 3);
  assert.equal(failedStates['transport-retry'].status, 'failed');
  assert.deepEqual(translationPageProgress([retryBlock], 1, failedPartial, failedStates),
    { done: 0, total: 1, restored: 0, completed: 0, failed: 1, untranslated: 0 });
  for (const damaged of [
    'H1 输入；目标 PFA = 10−3。',
    'H<sub>1</sub> 输入；目标 P<sub>FA</sub> = 10<sup>3</sup>。',
    'H<sub>1</sub> 输入；目标 P<sub>FA</sub> = 10<sub>−3</sub>。',
    'H<sub>1</sub> 输入；目标 P<sub>FA</sub> = 10<sup>−3</sup><sup>2</sup>。',
    'H<sub class="fake">1</sub> 输入；目标 P<sub>FA</sub> = 10<sup>−3</sup>。',
  ]) {
    await assert.rejects(prepareChineseReflow([scientific], {}, async () => ({ results: [damaged] }), options), /第 10 页.*上下标/);
  }
  const newSemantic = { ...scientific, textRuns: scientific.textRuns.map(run => run.script === 'sup' ? { ...run, script: 'sub' } : run) };
  let semanticRequest;
  await prepareChineseReflow([newSemantic], accepted, async texts => {
    semanticRequest = texts[0]; return { results: texts };
  }, options);
  assert.match(semanticRequest, /10<sub>−3<\/sub>/, 'script-only source changes must invalidate translations');
  const componentBundle = path.join(temp, 'component.mjs');
  await build({ entryPoints: ['renderer/src/components/TranslationText.tsx'], bundle: true, platform: 'node',
    format: 'esm', jsx: 'automatic', outfile: componentBundle });
  const { TranslationText } = await import(pathToFileURL(componentBundle));
  const rendered = renderToStaticMarkup(createElement(TranslationText, { runs: accepted.scientific.runs }));
  assert.match(rendered, /<sub>1<\/sub>/);
  assert.match(rendered, /<sub>FA<\/sub>/);
  assert.match(rendered, /<sup>−3<\/sup>/);
  const safe = await prepareChineseReflow([scientific], {}, async () => ({ results: [annotatedSource + '<img src=x onerror=alert(1)>'] }), options);
  const safeHtml = renderToStaticMarkup(createElement(TranslationText, { runs: safe.scientific.runs }));
  assert.equal(safeHtml.includes('<img'), false, 'unrecognized markup must remain escaped text');
  assert.match(safeHtml, /&lt;img/);
  const escaped = await prepareChineseReflow([scientific], {}, async () => ({ results: [annotatedSource.replace(/</g, '&lt;').replace(/>/g, '&gt;')] }), options);
  assert.deepEqual(escaped.scientific.runs.filter(run => run.script), accepted.scientific.runs.filter(run => run.script),
    'HTML-escaped text API responses should preserve exact approved scripts');
  console.log('PASS body/gap/viewport priority, bounded concurrency, slow-middle progress, cache restoration isolation/reload, source-damage isolation, bounded retries, independent failure recovery, abort/late suppression, scientific scripts and safe React rendering');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
