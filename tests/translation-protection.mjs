/** Scientific symbols survive the actual provider wire and old corrupt caches are rejected. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-translation-protection-'));
try {
  const file = path.join(temp, 'scripts.mjs');
  await build({entryPoints:['shared/translation-scripts.ts'],bundle:true,platform:'node',format:'esm',outfile:file});
  const { translatedRuns, protectTranslationMath } = await import(pathToFileURL(file));
  assert.throws(() => translatedRuns('φ<sup>th</sup> = 0', '�<sup>th</sup> = 0'), /字符|乱码/,
    'a replacement character outside the script cannot be accepted and cached');
  assert.throws(() => translatedRuns('\u0004<sup>th</sup> = 0', 'φ<sup>th</sup> = 0'), /原文|字符/,
    'the translator cannot silently invent a symbol missing from the source');
  assert.throws(() => translatedRuns('φ = 0', '� = 0'), /字符/,
    'plain mathematical symbols are checked even without script tags');
  assert.throws(() => translatedRuns('f<sub>i</sub>', 'φ<sub>i</sub>'), /数学变量/,
    'matching scripts alone cannot validate a changed variable');
  assert.throws(() => translatedRuns('V<sub>DD</sub>', 'XV<sub>DD</sub>'), /数学变量/,
    'prefixing another identifier onto a variable must be rejected');
  assert.throws(() => translatedRuns('V<sub>DD</sub>', '0.8VV<sub>DD</sub>'), /数学变量/,
    'unseparated duplicate unit-variable collision must be rejected');
  assert.throws(() => translatedRuns('f<sub>i</sub>(j)', 'f<sub>i</sub>(k)'), /数学变量/,
    'mutating a protected function argument must be rejected');
  const coeffSource = 'Swing is [0.127V<sub>DD</sub>, 1.247V<sub>DD</sub>] at 1/2V<sub>DD</sub> and 0.8-V V<sub>DD</sub> in ADC V<sub>m</sub>.';
  const coeffProtected = protectTranslationMath(coeffSource, 2);
  assert(coeffProtected.text.includes('0.127⟦SLMATH:2:0⟧') && coeffProtected.text.includes('1/2⟦SLMATH:2:2⟧'));
  assert.throws(() => coeffProtected.restore(
    '摆幅在0.5⟦SLMATH:2:2⟧及0.8V⟦SLMATH:2:3⟧下为[0.127⟦SLMATH:2:0⟧, 1.247⟦SLMATH:2:1⟧]，见ADC⟦SLMATH:2:4⟧(a)。',
  ), /占位符/);
  const orderedRestored = coeffProtected.restore(
    '摆幅为[0.127⟦SLMATH:2:0⟧, 1.247⟦SLMATH:2:1⟧]，处于0.5⟦SLMATH:2:2⟧与0.8V⟦SLMATH:2:3⟧下的ADC⟦SLMATH:2:4⟧(a)。',
  );
  assert(orderedRestored.includes('0.8V V<sub>DD</sub>') && orderedRestored.includes('ADC V<sub>m</sub>(a)'));
  assert.doesNotThrow(() => translatedRuns(coeffSource, orderedRestored));
  const scientific = 'Threshold Approximation: f <sub>i</sub><sup>th</sup> (j) is nearest to f <sub>i</sub>(j), with φ<sub>0</sub><sup>th</sup> = 1 and 10<sup>−3</sup>.';
  const protectedValue = protectTranslationMath(scientific, 7);
  assert(!/<(?:sub|sup)>/.test(protectedValue.text));
  const markers = protectedValue.text.match(/⟦SLMATH:[^⟧]+⟧/g);
  assert.equal(markers.length, 4);
  assert.throws(() => protectTranslationMath('ordinary prose', 1).restore('普通文字 ⟦SLMATH:0:0⟧'), /占位符/);
  const translated = protectedValue.restore(protectedValue.text.replace('Threshold Approximation', '阈值近似'));
  assert.equal(translated, scientific.replace('Threshold Approximation', '阈值近似'));
  assert.doesNotThrow(() => translatedRuns(scientific, translated));
  assert.throws(() => translatedRuns('f<sub>i</sub><sup>th</sup> + f<sup>th</sup><sub>i</sub>',
    'f<sup>th</sup><sub>i</sub> + f<sub>i</sub><sup>th</sup>'), /上下标/,
    'the same variable with different script order must not be exchanged');
  for (const corrupt of [protectedValue.text.replace(markers[0], ''), protectedValue.text + markers[0],
    protectedValue.text.replace(markers[0], '⟦SLMATH:7:999⟧'),
    protectedValue.text.replace(markers[0], markers[1]).replace(markers[1], markers[0])]) {
    if (corrupt !== protectedValue.text) assert.throws(() => protectedValue.restore(corrupt), /占位符/);
  }
  console.log('PASS corrupt source/result, changed-base rejection, protected complete variable/script/function atoms, missing/duplicate/unknown marker rejection');

  globalThis.protectionCache = new Map();
  globalThis.protectionPoison = null;
  const backend = path.join(temp, 'backend.mjs');
  const stubs = {
    './settings.js': `export const settings={get:()=>({targetLang:'zh-CN',translate:{activeProvider:'openai',providers:{openai:{apiKey:'fixture',baseUrl:'https://fixture.invalid/v1',model:'fixture'}}}})};`,
    './db.js': `export const translations={candidates:(_key,target,source)=>globalThis.protectionPoison?[{hash:'poison',provider:'openai',model:'fixture',result:globalThis.protectionPoison}]:[...globalThis.protectionCache.values()].filter(r=>r.source===source&&r.target===target),choose:()=>{},set:(hash,target,provider,model,source,result)=>globalThis.protectionCache.set(hash,{hash,target,provider,model,source,result})};`,
  };
  await build({entryPoints:['electron/translate.ts'],bundle:true,platform:'node',format:'esm',outfile:backend,
    plugins:[{name:'isolated-translator',setup(b){
      b.onResolve({filter:/^\.\/(settings|db)\.js$/},args=>({path:args.path,namespace:'test'}));
      b.onLoad({filter:/.*/,namespace:'test'},args=>({contents:stubs[args.path],loader:'js'}));
    }}]});
  const previousFetch = globalThis.fetch;
  let requests = [], mode = 'normal';
  globalThis.fetch = async (_url, options) => {
    const input = JSON.parse(options.body).messages[1].content;
    requests.push(input);
    // Reproduces a provider that rewrites exposed HTML, but leaves protected atoms intact.
    let output = input.replace(/<\/?(?:sub|sup)>/g, '').replace('Threshold Approximation', '阈值近似');
    if (mode === 'missing') output = output.replace(/⟦SLMATH:[^⟧]+⟧/, '');
    return new Response(JSON.stringify({choices:[{message:{content:output}}]}),{status:200});
  };
  try {
    const {translateBatch,readCachedTranslations}=await import(pathToFileURL(backend));
    const published=[];
    const result=await translateBatch(['Before',scientific,'After'],undefined,undefined,{onSegment:(index,text)=>published.push({index,text})});
    assert.equal(result.results[1],translated, 'middle scientific paragraph is accepted without giving its HTML to the model');
    assert.equal(published.length,3);
    assert.deepEqual(published.map(value=>value.index),[0,1,2]);
    assert.equal(requests.length,1,'protection prevents repeated format-repair calls');
    assert(requests[0].includes('⟦SLMATH:1:0⟧'));
    assert(!requests[0].includes('<sub>'));
    globalThis.protectionPoison='�<sup>th</sup> = 0';
    assert.equal(readCachedTranslations(['φ<sup>th</sup> = 0'],'zh-CN')[0],null,'a corrupt legacy cache is not adopted');
    globalThis.protectionPoison='� = 0';
    assert.equal(readCachedTranslations(['φ = 0'],'zh-CN')[0],null,'a corrupt plain-symbol cache is not adopted');
    globalThis.protectionPoison=null;
    const before=requests.length;
    await assert.rejects(translateBatch(['new valid paragraph','\u0004<sup>th</sup> = 0']),error=>{
      assert.equal(error.result.results[0],'new valid paragraph');
      assert.equal(error.result.failures[0].index,1);
      assert.equal(error.result.failures[0].retryable,false);
      return /原文/.test(error.message);
    });
    assert.equal(requests.length,before+1);
    assert(!requests.at(-1).includes('\u0004'), 'damaged source is not submitted');
    mode='missing';
    await assert.rejects(translateBatch([scientific+' altered']),/上下标/);
    assert(![...globalThis.protectionCache.values()].some(r=>r.source===scientific+' altered'));
    console.log('PASS real backend middle-paragraph recovery, ordered streaming callbacks, corrupt cache filtering, bad-source isolation and malformed-token cache rejection');
  } finally { globalThis.fetch=previousFetch; delete globalThis.protectionCache; delete globalThis.protectionPoison; }
} finally { await fs.rm(temp,{recursive:true,force:true}); }
