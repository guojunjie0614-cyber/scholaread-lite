/** Frozen real SWCS page-5 glyph evidence; optional argv[2] reparses the complete original page. No library writes or AI calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-source-fallback-'));
try {
  const modules = {};
  for (const [name, entry] of Object.entries({ analyze: 'renderer/src/reflow/analyze.ts',
    glyph: 'renderer/src/reflow/glyph-recovery.ts', reading: 'shared/reading-content.ts',
    translation: 'renderer/src/lib/chinese-reflow.ts', scripts: 'shared/translation-scripts.ts' })) {
    const file = path.join(temp, `${name}.mjs`);
    await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: file,
      plugins: [{ name: 'pdfjs-node', setup(builder) {
        builder.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs'), external: true }));
      } }] });
    modules[name] = await import(pathToFileURL(file));
  }
  const { isTranslatableContent, isUntranslatedSourceContent } = modules.reading;
  const { recoverEncodedGlyphs, hasUnmappedGlyphs } = modules.glyph;
  const { prepareChineseReflow, translationPageProgress, translationPageFeedback } = modules.translation;
  const fixture = JSON.parse(await fs.readFile('tests/fixtures/swcs-source-fallback.json', 'utf8'));
  const fonts = Object.fromEntries(Object.entries(fixture.fonts).map(([id, font]) => [id,
    { ...font, ...(font.dataBase64 ? { data: new Uint8Array(Buffer.from(font.dataBase64, 'base64')) } : {}) }]));
  const marker = fixture.items.find(item => item.str === '\u0004');
  assert(marker);
  assert.match(fonts[marker.fontName].name, /MSAM10$/);
  assert.equal(fonts[marker.fontName].toFontChar[4], 0xe000);
  assert.equal(recoverEncodedGlyphs(marker.str, fonts[marker.fontName]), '■', 'recover the embedded squaresolid glyph, not a guessed control-code meaning');
  assert.equal(recoverEncodedGlyphs('\u0004', { differences: { 4: 'unknownGlyph' } }), '\u0004', 'unknown math glyphs are never stripped');
  assert.equal(recoverEncodedGlyphs('\u0004', { differences: { 4: 'Phi1' } }), 'Φ', 'the same code in another font retains its own glyph meaning');
  const page = {
    getViewport: () => fixture.viewport,
    getTextContent: async () => ({ items: fixture.items, styles: fixture.styles }),
    getOperatorList: async () => ({ fnArray: Object.keys(fonts).map(() => OPS.setFont), argsArray: Object.keys(fonts).map(id => [id, 10]) }),
    commonObjs: { has: id => !!fonts[id], get: id => fonts[id] },
  };
  const checkRecovered = blocks => {
    const recovered = blocks.find(block => /^■ By combing/.test(block.text));
    assert(recovered, 'the original page-5 black-square sentence remains readable text');
    assert.equal(recovered.kind, 'li');
    assert(!recovered.sourceTextFallback);
    assert(!hasUnmappedGlyphs(recovered.text));
    assert(isTranslatableContent(recovered));
    assert.equal(recovered.textRuns.map(run => run.text).join(''), recovered.text, 'canonical source/selection offsets retain exact run concatenation');
    assert(recovered.textRuns.some(run => run.mathPosition), 'recovering a list marker cannot flatten its inline formula');
    const source = modules.scripts.translationSource(recovered);
    const protectedMath = modules.scripts.protectTranslationMath(source, 0);
    assert.match(protectedMath.text, /■ By combing/);
    assert.match(protectedMath.text, /⟦SLMATH/);
    return recovered;
  };
  const recovered = checkRecovered(await modules.analyze.analyzePage(page, 5, 'swcs-marker', { keepFigures: true }));

  // Truly unknown native text remains a visible, counted translation gap, even after all usable text succeeds.
  const unresolved = { ...recovered, id: 'unresolved', text: '\u0004 Unknown source glyph in body prose.', textRuns: undefined,
    sourceTextFallback: true, crop: [40, 90, 280, 110] };
  const skipped = ['math', 'ref', 'figure'].map(kind => ({ ...unresolved, id: kind, kind }));
  skipped.push({ ...unresolved, id: 'authors', readingRole: 'authors' });
  assert(isUntranslatedSourceContent(unresolved));
  assert(!isTranslatableContent(unresolved));
  assert(skipped.every(block => !isUntranslatedSourceContent(block)), 'intentional original-only content is not a missing body translation');
  const calls = [], progress = [], ready = [], pageStates = [];
  const sourceCopy = structuredClone(recovered);
  const translated = await prepareChineseReflow([recovered, unresolved, ...skipped], {}, async texts => {
    calls.push(...texts);
    // Retain all scientific source markup while changing only the prose in this local pipeline check.
    return { results: texts.map(text => text.replace('By combing', '通过结合')) };
  }, { cancelled: () => false, onProgress: (done, total) => progress.push([done, total]), onBatch() {},
    onPageReady: page => ready.push(page), onPageState: (page, state) => pageStates.push(state.status) });
  assert.equal(calls.length, 1, 'only recovered, valid source reaches the translator');
  assert.equal(calls[0], modules.scripts.translationSource(recovered));
  assert.deepEqual(recovered, sourceCopy, 'translation never rewrites the canonical source or its offsets');
  assert.deepEqual(translated[recovered.id].runs.filter(run => run.mathPosition), recovered.textRuns.filter(run => run.mathPosition));
  assert.deepEqual(progress.at(-1), [1, 2], 'an unresolved body block prevents false 100% progress');
  assert.deepEqual(translationPageProgress([recovered, unresolved, ...skipped], 5, translated, {}),
    { done: 1, total: 2, restored: 0, completed: 1, failed: 0, untranslated: 1 });
  assert.equal(translationPageFeedback([recovered, unresolved], 5, translated, {}).status, 'mixed');
  assert.equal(pageStates.at(-1), 'mixed');
  assert.deepEqual(ready, [], 'a fallback image never counts as a translated page');
  assert.equal(translationPageFeedback([unresolved], 5, {}, {}).status, 'untranslated');
  let fallbackState;
  await prepareChineseReflow([unresolved], {}, async () => assert.fail('unknown source cannot generate an AI request'),
    { cancelled: () => false, onProgress() {}, onBatch() {}, onPageState: (page, state) => { fallbackState = state.status; } });
  assert.equal(fallbackState, 'untranslated');
  assert.equal(unresolved.text, '\u0004 Unknown source glyph in body prose.');
  console.log('PASS real page-5 embedded squaresolid recovery, canonical inline math, counted/untranslated original fallback, no false ready page');

  if (process.argv[2]) {
    const pdf = await getDocument({ data: new Uint8Array(await fs.readFile(process.argv[2])), useSystemFonts: true, fontExtraProperties: true }).promise;
    try {
      const blocks = await modules.analyze.analyzePage(await pdf.getPage(5), 5, 'actual-swcs', { keepFigures: true, documentPageCount: pdf.numPages });
      const actual = checkRecovered(blocks);
      console.log(`PASS complete original page 5: ${actual.id}, ${actual.text.length} source characters, ${blocks.filter(isTranslatableContent).length} translatable blocks, ${blocks.filter(isUntranslatedSourceContent).length} unresolved body blocks`);
    } finally { await pdf.destroy(); }
  }
} finally { await fs.rm(temp, { recursive: true, force: true }); }
