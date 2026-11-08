/** Optional argv[2]: original SRAM-PIM PDF; no library writes or AI calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'reading-content-'));
try {
  const modules = {};
  for (const [name, entry] of Object.entries({ reading: 'shared/reading-content.ts', roles: 'renderer/src/reflow/reading-roles.ts',
    glyph: 'renderer/src/reflow/glyph-recovery.ts', analyze: 'renderer/src/reflow/analyze.ts' })) {
    const file = path.join(temporary, `${name}.mjs`);
    await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: file,
      plugins: [{ name: 'pdfjs-node', setup(builder) {
        builder.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs'), external: true }));
      } }] });
    modules[name] = await import(pathToFileURL(file));
  }
  const { isReadingContent, isTranslatableContent } = modules.reading;
  const { classifyReadingRoles } = modules.roles;
  const { recoverEncodedGlyphs, hasUnmappedGlyphs, composeDottedEquals, composeEquationNumbers } = modules.glyph;
  const block = (text, extra = {}) => ({ id: 'b', paperId: 'p', page: 1, ord: 0, kind: 'p', text, ...extra });
  const sourceBlocks = [
    block('Alice Wang, Bob Chen', { readingRole: 'authors' }),
    block('University of Example', { readingRole: 'affiliations' }),
    block('Alice Wang received the Ph.D. degree.', { readingRole: 'biography', page: 10 }),
    block('[1] A. Author, Paper title, 2026.', { kind: 'ref', page: 9 }),
    block('IX. R EFERENCES', { kind: 'h2', page: 9 }),
    block('参考文献', { kind: 'p', page: 9 }),
    block('We use references to compare accuracy.'),
    block('IEEE TRANSACTIONS, VOL. 45', { readingRole: 'publication' }),
  ];
  assert.deepEqual(sourceBlocks.map(isReadingContent), [false, false, false, true, true, true, true, false]);
  assert.deepEqual(sourceBlocks.map(isTranslatableContent), [false, false, false, false, false, false, true, false]);
  assert.equal(sourceBlocks.length, 8, 'projection never deletes stored source blocks');
  for (const kind of ['math', 'figure', 'table', 'algorithm']) assert(!isTranslatableContent(block('A nonempty label', { kind })));
  assert(!isTranslatableContent(block('   ')));
  const sections = [
    block('Alice Wang is with the Department of Engineering, Example University.'),
    block('Alice Wang received the Ph.D. degree from Example University.', { page: 3 }),
    block('Technical paper title', { page: 8, kind: 'h2' }),
    block('Our proposed research method improves throughput.', { page: 8 }),
    block('[7] Alice Wang received an award.', { page: 8, kind: 'ref' }),
    block('Alice Wang received the Ph.D. degree from Example University.', { page: 9 }),
    block('Her research interests include accelerator architecture.', { page: 9 }),
    block('Bob Chen (Member, IEEE) received the M.S. degree from the', { page: 9 }),
    block('Department of Engineering, Example University. He is a Researcher.', { page: 10 }),
    block('His current research interests include memory circuits.', { page: 10 }),
    block('Appendix: Supplementary experiments', { page: 10, kind: 'h2' }),
    block('This research evaluates the compiler throughput.', { page: 10 }),
    block('He proposes a new algorithm.', { page: 10 }),
  ];
  classifyReadingRoles(sections, 10);
  assert.equal(sections[0].readingRole, 'affiliations');
  const company = [block('Alice Wang is with Example Technologies Company Ltd., London, UK.')];
  classifyReadingRoles(company, 10);
  assert.equal(company[0].readingRole, 'affiliations');
  const opening = [block('A scientific title', {kind: 'h1', readingRole: 'title'}),
    block('Alice Wang1, Bob Chen1, and Carol Lin1'), block('1Example Networks, Inc.'),
    block('Abstract', {kind: 'h2'}), block('We propose a new method.')];
  classifyReadingRoles(opening, 10);
  assert.equal(opening[1].readingRole, 'authors');
  assert.equal(opening[2].readingRole, 'affiliations');
  assert(!opening[4].readingRole);
  const journalOpening = [block('ARTICLE'), block('A scientific title', {kind: 'h1', bbox: [60, 80, 500, 105]}),
    block('1,2 ✉ Alice Wang1, Bob Chen2 & Carol Lin'), block('A scientific abstract about reservoir computing.'),
    block('1 The Example University, Department of Physics, City, Country.')];
  classifyReadingRoles(journalOpening, 10);
  assert.equal(journalOpening[1].readingRole, 'title');
  assert.equal(journalOpening[2].readingRole, 'authors');
  assert.equal(journalOpening[4].readingRole, 'affiliations');
  assert(!journalOpening[3].readingRole);
  assert(sections.slice(1, 5).every(block => !block.readingRole), 'a body education example and reference entries must remain');
  assert(sections.slice(5, 10).every(block => block.readingRole === 'biography'), 'biography continues over a page boundary');
  assert(sections.slice(10).every(block => !block.readingRole), 'a technical heading terminates biography context');
  const fundingText = 'This work was supported by Grant 123. (Corresponding authors: Alice Wang.) Alice Wang and Bob Chen are with Example University.';
  const funding = [block(fundingText, { textRuns: [{ text: fundingText }] })];
  classifyReadingRoles(funding, 10);
  assert.equal(funding.length, 2);
  assert.equal(funding[0].text, 'This work was supported by Grant 123.');
  assert(isReadingContent(funding[0]) && isTranslatableContent(funding[0]));
  assert(!isReadingContent(funding[1]) && !isTranslatableContent(funding[1]));
  assert.equal(funding.map(block => block.text).join(' '), fundingText, 'splitting author metadata retains the complete source');
  for (const part of funding) assert.equal(part.textRuns.map(run => run.text).join(''), part.text);
  const sourceFont = { differences: { 4: 'Phi1' } };
  assert.equal(recoverEncodedGlyphs('(\u0004', sourceFont), '(Φ');
  assert.equal(recoverEncodedGlyphs('\u0004', { differences: { 4: 'unknownGlyph' } }), '\u0004');
  assert.equal(recoverEncodedGlyphs('\uFFFD', sourceFont), '\uFFFD', 'replacement characters do not reveal an original character code');
  const mathTimeFont = {
    composite: false,
    differences: { 49: 'Delta1', 54: 'Sigma1' },
    toFontChar: Object.assign([], { 49: 0xe004, 54: 0xe005 }),
    toUnicode: { _map: Object.assign([], { 44: ',' }) },
  };
  assert.equal(recoverEncodedGlyphs('1,6', mathTimeFont), 'Δ,Σ', 'injective unmapped PUA math slots recover upright Greek');
  const collidingFont = {
    composite: false,
    differences: { 49: 'Delta1' },
    toFontChar: Object.assign([], { 49: 0xe004, 99: 0xe010 }),
    toUnicode: { _map: Object.assign([], { 99: '1' }) },
  };
  assert.equal(recoverEncodedGlyphs('1', collidingFont), '1', 'never overwrite a character produced by another mapped glyph');
  // Word/Cambria Math: a CID without ToUnicode surfaces as its raw value (U+0BDC for subscript i).
  const cambriaMath = {
    composite: true,
    toFontChar: Object.assign([], { 0xbdc: 0xe059, 0xbe1: 0xe05e, 150: 0xe001, 2000: 0xe100 }),
    toUnicode: { _map: Object.assign([], { 150: 't', 2000: '𝑊', 3000: '储' }) },
  };
  assert.equal(recoverEncodedGlyphs('𝑊௜௡', cambriaMath), '𝑊\uFFFD\uFFFD', 'raw CIDs are unmapped, not Tamil text');
  assert(hasUnmappedGlyphs(recoverEncodedGlyphs('𝑊௜௡', cambriaMath)));
  assert.equal(recoverEncodedGlyphs('储备池 t', cambriaMath), '储备池 t', 'ToUnicode-mapped CJK and Latin are untouched');
  assert.equal(recoverEncodedGlyphs('ð þ Þ ¼ ½ 2 k F', { name: 'AGCBMJ+AdvP4C4E74', composite: false }), '( + ) = \uFFFD ∈ ‖ \uFFFD',
    'Advent math-symbol slots verified on rendered pages recover; every other slot stays unmapped');
  assert.equal(recoverEncodedGlyphs('h ð i Þ f g', { name: 'FDNJJO+AdvMacMthSyN', composite: false }), '⟨ ( ⟩ ) { }');
  assert.equal(recoverEncodedGlyphs('ð', { name: 'AdvOT1ef757c0', composite: false }), 'ð', 'text fonts keep their real eth');
  const run = (str, x, w, font = 'AdvGulliv-R') => ({ str, x, y: 643.7, w, h: 8.4, bold: false, font });
  assert.deepEqual(composeEquationNumbers([run('b', 74, 4), run('(', 272.5, 3.2, 'AdvP4C4E74'), run('17', 275.7, 9.7), run(')', 285.4, 3.3, 'AdvP4C4E74')])
    .map(item => item.str), ['b', '(17)']);
  assert.deepEqual(composeEquationNumbers([run('(', 100, 3), run('17', 140, 9), run(')', 150, 3)]).map(item => item.str), ['(', '17', ')'],
    'separated parentheses are not an equation number');
  assert(hasUnmappedGlyphs('\u0004'));
  const equals = { str: '=', x: 20, y: 100, w: 8, h: 10, bold: false, font: 'MTSYN' };
  const dot = { ...equals, str: '.', x: 22.5, y: 94.3, w: 3, font: 'RMTMI' };
  assert.equal(composeDottedEquals([dot, equals])[0].str, '≐');
  assert.deepEqual(composeDottedEquals([{ ...equals, str: '===' }, { ...dot, x: 60 }]).map(item => item.str), ['===', '.']);
  assert.deepEqual(composeDottedEquals([equals, { ...dot, y: 100 }]).map(item => item.str), ['=', '.'], 'ordinary adjacent punctuation remains unchanged');

  const item = (str, x, width, fontName = 'body') => ({ str, width, height: 10, fontName, transform: [10, 0, 0, 10, x, 700] });
  const page = {
    getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
    getTextContent: async () => ({ items: [item('A reliable body paragraph contains ', 40, 200), item('\u0004', 240, 8, 'unknown'), item(' and remains visible.', 248, 150)],
      styles: { body: { ascent: .8, descent: -.2, fontFamily: 'Times' }, unknown: { ascent: .8, descent: -.2, fontFamily: 'UnknownFont' } } }),
    getOperatorList: async () => ({ fnArray: [OPS.setFont, OPS.setFont], argsArray: [['body', 10], ['unknown', 10]] }),
    commonObjs: { has: () => true, get: id => ({ name: id === 'body' ? 'Times' : 'UnknownFont' }) },
  };
  const unresolved = await modules.analyze.analyzePage(page, 2, 'source-fallback', { keepFigures: true });
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].sourceTextFallback, true);
  assert(unresolved[0].crop);
  assert(isReadingContent(unresolved[0]));
  assert(!isTranslatableContent(unresolved[0]));
  assert.equal(unresolved[0].textRuns.map(run => run.text).join(''), unresolved[0].text);
  console.log('PASS source-preserving reading/translation policies, bounded biography/continuation classification, glyph-name recovery, dotted-equals geometry, unknown-glyph original fallback');

  if (process.argv[2]) {
    const pdf = await getDocument({ data: new Uint8Array(await fs.readFile(process.argv[2])), useSystemFonts: true, fontExtraProperties: true }).promise;
    try {
      const blocks = await modules.analyze.analyzeDocument(pdf, 'sample', { keepFigures: true });
      const threshold = blocks.find(block => block.text.startsWith('from 100%'));
      assert(threshold);
      assert.match(threshold.text, /Φth === 0, Φth ≐/);
      assert.match(threshold.text, /Φth === 2/);
      assert(!hasUnmappedGlyphs(threshold.text));
      assert(!threshold.sourceTextFallback);
      assert(!blocks.some(block => hasUnmappedGlyphs(block.text) && isTranslatableContent(block)), 'unknown native characters never enter translation');
      const biographies = blocks.filter(block => block.readingRole === 'biography');
      assert(biographies.length >= 24);
      const firstBiography = blocks.findIndex(block => block.text.startsWith('Cenlin Duan received'));
      assert(firstBiography >= 0);
      assert(blocks.slice(firstBiography).filter(block => block.kind === 'p' && block.readingRole !== 'publication')
        .every(block => block.readingRole === 'biography'), 'all source biography paragraphs including wrapped degree fragments are omitted');
      assert(biographies.every(block => !isReadingContent(block) && !isTranslatableContent(block)));
      const technicalTail = blocks.find(block => block.page === 12 && block.text.startsWith('In this article'));
      assert(technicalTail && isReadingContent(technicalTail) && isTranslatableContent(technicalTail));
      const references = blocks.filter(block => block.kind === 'ref');
      assert(references.length >= 37);
      assert(references.every(block => isReadingContent(block) && !isTranslatableContent(block)));
      for (const block of blocks.filter(block => block.textRuns)) assert.equal(block.textRuns.map(run => run.text).join(''), block.text);
      console.log(`PASS real PDF: Φ recovered from Phi1 encoding, source === retained, ≐ reconstructed; ${biographies.length} biography paragraphs omitted from reading, ${references.length} references retained in original form`);
    } finally { await pdf.destroy(); }
  }
  for (const [index, file] of process.argv.slice(3).entries()) {
    const pdf = await getDocument({ data: new Uint8Array(await fs.readFile(file)), useSystemFonts: true, fontExtraProperties: true }).promise;
    try {
      const blocks = await modules.analyze.analyzeDocument(pdf, 'sample', { keepFigures: true });
      const name = index === 0 ? 'Junjie Guo' : 'Yiyang Yuan';
      const authors = blocks.find(block => block.page === 1 && block.readingRole === 'authors' && block.text.includes(name));
      assert(authors, `first-page authors must be classified in supplied PDF ${index + 2}`);
      assert(!isReadingContent(authors) && !isTranslatableContent(authors));
      assert(blocks.some(block => block.readingRole === 'title' && isReadingContent(block)));
      for (const block of blocks.filter(block => block.textRuns)) assert.equal(block.textRuns.map(run => run.text).join(''), block.text);
      if (index === 0) {
        assert(!blocks.filter(isReadingContent).some(block => block.page === 1 && /Junjie Guo/.test(block.text)), 'mixed funding/author footnote must hide only author metadata');
        assert(blocks.filter(isReadingContent).some(block => block.text.startsWith('This work was partially supported')));
      }
      console.log(`PASS supplied PDF ${index + 2}: ${name} author list hidden, title retained, funding and text-run contracts intact`);
    } finally { await pdf.destroy(); }
  }
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
