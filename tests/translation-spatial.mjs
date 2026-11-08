/** Real SWCS source runs and existing cache excerpts; never opens the user's database. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-spatial-translation-'));
const originalFetch = globalThis.fetch;
try {
  const helpersFile = path.join(temp, 'helpers.mjs');
  const componentsFile = path.join(temp, 'components.mjs');
  await build({ entryPoints: ['shared/translation-scripts.ts'], bundle: true, platform: 'node', format: 'esm', outfile: helpersFile });
  await build({ stdin: { contents: `export {InlineText} from './renderer/src/components/InlineText'; export {TranslationText} from './renderer/src/components/TranslationText';`, resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', outfile: componentsFile });
  const { translationSource, legacyTranslationSource, protectTranslationMath, translatedRuns, restoreCachedTranslationMath } = await import(pathToFileURL(helpersFile));
  const { InlineText, TranslationText } = await import(pathToFileURL(componentsFile));
  const fixtures = JSON.parse(await fs.readFile('tests/fixtures/translation-spatial.json', 'utf8'));
  const render = (Component, runs) => renderToStaticMarkup(createElement(Component, { runs }));
  const geometry = runs => runs.filter(run => run.mathPosition);
  let legacyCount = 0;
  for (const block of fixtures) {
    const source = translationSource(block);
    const protectedSource = protectTranslationMath(source, 3);
    assert(!protectedSource.text.includes('<slmath>') && !protectedSource.text.includes('%7B'));
    const restored = protectedSource.restore(protectedSource.text);
    assert.equal(restored, source, `${block.id}: identity provider must round-trip exactly`);
    const runs = translatedRuns(source, restored);
    assert.equal(runs.map(run => run.text).join(''), block.text);
    assert.deepEqual(geometry(runs), geometry(block.textRuns));
    assert.equal(render(TranslationText, runs).replace(/<[^>]*>/g, ''), render(InlineText, block.textRuns).replace(/<[^>]*>/g, ''));
    assert.equal((render(TranslationText, runs).match(/class="inline-math"/g) ?? []).length,
      (render(InlineText, block.textRuns).match(/class="inline-math"/g) ?? []).length);
    for (const cached of block.caches) {
      assert.equal(legacyTranslationSource(source), cached.source);
      const upgraded = restoreCachedTranslationMath(source, cached.result);
      assert.deepEqual(geometry(translatedRuns(source, upgraded)), geometry(block.textRuns), `${block.id}: existing cache restores all source geometry`);
      assert.equal(translatedRuns(source, upgraded).map(run => run.text).join(''), translatedRuns(cached.source, cached.result).map(run => run.text).join(''));
      legacyCount++;
    }
    const markers = protectedSource.text.match(/⟦SLMATH:[^⟧]+⟧/g);
    assert.throws(() => protectedSource.restore(protectedSource.text.replace(markers[0], '')), /缺失.*SLMATH/);
    assert.throws(() => protectedSource.restore(protectedSource.text + markers[0]), /重复.*SLMATH/);
    if (markers.length > 1) {
      const reordered = protectedSource.text.replace(markers[0], '@TEMP@').replace(markers[1], markers[0]).replace('@TEMP@', markers[1]);
      assert.throws(() => protectedSource.restore(reordered), /顺序改变/);
    }
    const changed = structuredClone(block); changed.textRuns.find(run => run.mathPosition).mathPosition.y += .1;
    assert.notEqual(translationSource(changed), source, 'geometry-only reparse changes source identity');
  }
  // Accents and integral limits use the same indivisible spatial contract, not special-case Unicode replacements.
  const synthetic = { text: 'x̂ + ∫10', textRuns: [
    { text: 'x', italic: true, mathPosition: { group: 'accent', x: 0, y: 0, width: .5, size: 1 } },
    { text: '̂', mathPosition: { group: 'accent', x: .1, y: -.4, width: .3, size: 1 } }, { text: ' + ' },
    { text: '∫', mathPosition: { group: 'limit', x: 0, y: 0, width: .5, size: 1 } },
    { text: '1', script: 'sup', mathPosition: { group: 'limit', x: .5, y: -.5, width: .3, size: .7 } },
    { text: '0', script: 'sub', mathPosition: { group: 'limit', x: .5, y: .3, width: .3, size: .7 } },
  ] };
  const syntheticSource = translationSource(synthetic), syntheticProtected = protectTranslationMath(syntheticSource, 0);
  assert.deepEqual(translatedRuns(syntheticSource, syntheticProtected.restore(syntheticProtected.text)), synthetic.textRuns);
  assert.throws(() => restoreCachedTranslationMath(syntheticSource, 'x + ∫<sup>1</sup><sub>0</sub>'), /结构/);
  assert.throws(() => translatedRuns(syntheticSource, syntheticSource.replace(/<slmath>[^<]*<\/slmath>/, 'x')), /结构/);
  const circle = fixtures.find(block => block.id === '2:30');
  assert.match(render(TranslationText, translatedRuns(translationSource(circle), translationSource(circle))), /class="inline-circle"/);

  globalThis.spatialCache = new Map();
  globalThis.spatialChoices = new Map();
  let writes = 0;
  globalThis.spatialWrite = (hash, row) => { writes++; globalThis.spatialCache.set(hash, { hash, ...row }); };
  for (const block of fixtures) for (const [index, cached] of block.caches.entries()) {
    const hash = `${block.id}-${index}`;
    globalThis.spatialCache.set(hash, { hash, target: 'zh-CN', ...cached });
  }
  const backend = path.join(temp, 'backend.mjs');
  const stubs = {
    './settings.js': `export const settings={get:()=>({targetLang:'zh-CN',translate:{activeProvider:'openai',providers:{openai:{apiKey:'fixture',baseUrl:'https://fixture.invalid/v1',model:'fixture'}}}})};`,
    './db.js': `export const translations={candidates:(_key,target,source)=>[...globalThis.spatialCache.values()].filter(r=>r.source===source&&r.target===target),choose:(key,hash)=>globalThis.spatialChoices.set(key,hash),set:(hash,target,provider,model,source,result)=>globalThis.spatialWrite(hash,{target,provider,model,source,result})};`,
  };
  await build({ entryPoints: ['electron/translate.ts'], bundle: true, platform: 'node', format: 'esm', outfile: backend,
    plugins: [{ name: 'spatial-test-isolation', setup(b) {
      b.onResolve({ filter: /^\.\/(settings|db)\.js$/ }, args => ({ path: args.path, namespace: 'test' }));
      b.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }] });
  let requests = 0, mode = 'identity';
  globalThis.fetch = async (_url, options) => {
    requests++;
    const input = JSON.parse(options.body).messages[1].content;
    assert(!input.includes('<slmath>') && !input.includes('mathPosition'));
    const output = mode === 'identity' ? input : input.replace(/⟦SLMATH:[^⟧]+⟧/, '');
    return new Response(JSON.stringify({ choices: [{ message: { content: output } }] }), { status: 200 });
  };
  const { readCachedTranslations, translateBatch } = await import(pathToFileURL(backend));
  const sources = fixtures.map(translationSource);
  const cached = readCachedTranslations(sources, 'zh-CN');
  assert(cached.every(Boolean));
  assert.equal(writes, legacyCount, 'only new geometry cache records are adopted; old records are retained');
  const cacheSize = globalThis.spatialCache.size;
  const result = await translateBatch(sources);
  assert.equal(requests, 0, 'all six real paragraph caches survive the source format upgrade');
  assert.equal(globalThis.spatialCache.size, cacheSize);
  result.results.forEach((value, index) => assert.deepEqual(geometry(translatedRuns(sources[index], value)), geometry(fixtures[index].textRuns)));
  const fresh = await translateBatch(sources, undefined, undefined, { refresh: true });
  assert.equal(requests, 1, 'geometry payload size must not split this short protected wire request');
  fresh.results.forEach((value, index) => assert.deepEqual(geometry(translatedRuns(sources[index], value)), geometry(fixtures[index].textRuns)));
  mode = 'missing';
  const writesBefore = writes;
  await assert.rejects(translateBatch([sources[4]], undefined, undefined, { refresh: true }), error => {
    assert.match(error.result.failures[0].message, /缺失.*SLMATH:0:0/);
    return true;
  });
  assert.equal(writes, writesBefore, 'invalid spatial output is never cached');
  console.log(`PASS ${fixtures.length} real spatial paragraphs, ${legacyCount} existing cache upgrades, exact geometry/style restoration, circles/accents/nested scripts/limits, missing/reordered tokens, cache-only and identity backend paths`);
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.spatialCache; delete globalThis.spatialChoices; delete globalThis.spatialWrite;
  await fs.rm(temp, { recursive: true, force: true });
}
