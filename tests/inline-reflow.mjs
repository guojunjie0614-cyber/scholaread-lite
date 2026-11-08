/** node tests/inline-reflow.mjs [isscc.pdf] [sram-pim.pdf] — never writes the library. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-inline-test-'));
try {
  const modules = {};
  for (const [name, entry] of Object.entries({ analyze: 'renderer/src/reflow/analyze.ts',
    inline: 'renderer/src/reflow/inline-text.ts', reanchor: 'electron/reanchor.ts',
    translation: 'shared/translation-scripts.ts', reading: 'shared/reading-content.ts' })) {
    const file = path.join(temp, `${name}.mjs`);
    await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: file,
      plugins: [{ name: 'pdfjs-node', setup(builder) {
        builder.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs'), external: true }));
      } }] });
    modules[name] = await import(pathToFileURL(file));
  }
  const { analyzePage, analyzeDocument, REFLOW_ENGINE_VERSION } = modules.analyze;
  const { lineTextRuns, joinTextRuns } = modules.inline;
  const { reanchorNotes } = modules.reanchor;
  const { translationSource, translatedRuns } = modules.translation;
  const raw = (str, x, y = 100, h = 10, w = str.length * 5, extra = {}) => ({ str, x, y, h, w, bold: false, font: '', ...extra });
  const line = items => ({ items, y: 100, size: 10 });
  const runs = lineTextRuns(line([raw('V', 0, 100, 10, 6, { italic: true }),
    raw('DD', 6, 102, 6, 8), raw(' = 10', 14, 100, 10, 25), raw('−3', 39, 96, 6, 8),
    raw(' FP8 INT8', 47, 100, 10, 50)]));
  assert.deepEqual(runs.filter(run => run.script), [{ text: 'DD', script: 'sub' }, { text: '−3', script: 'sup' }]);
  assert.equal(runs[0].italic, true);
  assert.equal(runs.map(run => run.text).join(''), 'VDD = 10−3 FP8 INT8');
  assert(!lineTextRuns(line([raw('FP', 0), raw('8', 10, 100, 7)])).some(run => run.script), 'small caps on the baseline are not scripts');
  assert(!lineTextRuns(line([raw('x', 0), raw('ˆ', 3, 96, 6)])).some(run => run.script), 'an accent is not an exponent');
  const leading = lineTextRuns(line([raw('1', 0, 96, 6, 3), raw('Institute of Science', 3)]));
  assert.equal(leading[0].script, 'sup', 'affiliation markers retain their actual geometry');
  const whitespace = lineTextRuns(line([raw('  A\t', 0), raw(' \nB ', 20, 100, 10, 10, { italic: true })]));
  assert.equal(whitespace.map(run => run.text).join(''), 'A B');
  const joined = joinTextRuns([{ text: 'com-', italic: true }], [{ text: 'putation is useful.' }], 'computation is useful.');
  assert.equal(joined.map(run => run.text).join(''), 'computation is useful.');
  assert.deepEqual(joined[0], { text: 'com', italic: true });
  const spatial = lineTextRuns(line([raw('r', 0, 100, 10, 6),
    raw('comb', 6, 103, 7, 20), raw('[t]', 6, 95, 7, 10), raw(',n', 26, 103, 7, 8),
    raw('comb', 34, 104, 5, 12), raw('−1', 46, 103, 7, 8)]));
  assert.equal(spatial.map(run => run.text).join(''), 'rcomb[t],ncomb−1');
  assert.equal(new Set(spatial.map(run => run.mathPosition?.group)).size, 1, 'dual and nested scripts share the base atom');
  assert(spatial.some(run => run.mathPosition?.size === .5));
  const wordsInScript = lineTextRuns(line([raw('r', 0, 100, 10, 6), raw('i − 1', 6, 103, 7, 20), raw('[t]', 6, 95, 7, 10)]));
  assert(wordsInScript.some(run => run.text === 'i − 1' && run.mathPosition), 'one positioned PDF item is not split into overlapping words');
  const circle = lineTextRuns(line([raw('• ', 0, 100, 10, 10), raw('⃝', 10, 100, 10, 10), raw('1', 13.25, 99.7, 7, 3.5), raw(' Text', 22)]));
  assert.equal(circle.map(run => run.text).join(''), '• ⃝1 Text');
  assert.equal(circle.find(run => run.text === '⃝').mathPosition.group, circle.find(run => run.text === '1').mathPosition.group);
  const source = translationSource({ text: runs.map(run => run.text).join(''), textRuns: runs });
  assert.match(source, /V<sub>DD<\/sub> = 10<sup>−3<\/sup>/);
  assert.deepEqual(translatedRuns(source, '电压 V<sub>DD</sub> = 10<sup>−3</sup>，FP8 和 INT8。').filter(run => run.script), runs.filter(run => run.script));
  assert.throws(() => translatedRuns(source, '电压 VDD = 10−3。'), /上下标/);

  const item = (str, x, y, width, size = 10, fontName = 'body') => ({ str, width, height: size, fontName, transform: [size, 0, 0, size, x, 800 - y] });
  const fonts = { body: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic' };
  const page = items => ({
    getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
    getTextContent: async () => ({ items, styles: Object.fromEntries(Object.entries(fonts).map(([id, fontFamily]) => [id, { ascent: .8, descent: -.2, fontFamily }])) }),
    getOperatorList: async () => ({ fnArray: Object.keys(fonts).map(() => OPS.setFont), argsArray: Object.keys(fonts).map(id => [id, 10]) }),
    commonObjs: { has: () => true, get: id => ({ name: fonts[id] }) }, cleanup() {},
  });
  const paragraph = await analyzePage(page([
    item('The supply V', 40, 100, 70), item('DD', 110, 102, 8, 6),
    item(' is low and ', 118, 100, 70), item('x', 188, 100, 6, 10, 'italic'),
    item('2', 194, 96, 4, 6), item(' measures FP8 and INT8 accuracy.', 198, 100, 242),
    item('A following sentence keeps its scientific meaning.', 40, 112, 400),
  ]), 2, 'inline', { keepFigures: true });
  assert.equal(paragraph.length, 1);
  assert.equal(paragraph[0].kind, 'p');
  assert(paragraph[0].textRuns.some(run => run.text === 'DD' && run.script === 'sub'));
  assert(paragraph[0].textRuns.some(run => run.text === 'x' && run.italic));
  assert(paragraph[0].textRuns.some(run => run.text === '2' && run.script === 'sup'));
  assert.equal(paragraph[0].textRuns.map(run => run.text).join(''), paragraph[0].text);
  const tight = await analyzePage(page([
    item('The first line has ordinary content.', 40, 100, 260),
    item('The next line contains x', 40, 111, 260), item('2', 300, 105.4, 4, 6),
  ]), 2, 'tight-scripts', { keepFigures: true });
  const tightText = tight.map(block => block.text).join(' ');
  assert.match(tightText, /content\. The next line contains x2/);
  assert(tight.flatMap(block => block.textRuns ?? []).some(run => run.text === '2' && run.script === 'sup'));
  const fragmented = await analyzePage(page([
    item('A', 40, 100, 8), item('V', 48, 100, 6),
    item('nc', 54, 101.5, 7, 7), item(',', 61, 101.5, 2, 7), item('k', 63, 101.5, 3, 7),
    item('A second line of ordinary prose.', 40, 120, 260),
  ]), 2, 'fragmented-scripts', { keepFigures: true });
  assert(fragmented.some(b => b.text.includes('Vnc,k') && b.textRuns.some(r => r.script === 'sub' && r.text.includes('nc'))));
  assert(!fragmented.some(b => b.text === 'nc,k'));
  const deep = await analyzePage(page([
    item('A scientific sentence containing ', 40, 100, 200), item('r', 240, 100, 6),
    item('c,λ', 246, 105.57, 12, 7), item('swcs-max', 258, 106.8, 24, 5),
    item('[t]', 253, 101.9, 9, 5), item(' remains intact.', 285, 100, 100),
    item('A following line must not steal the nested label.', 40, 111.5, 400),
  ]), 2, 'deep-scripts', { keepFigures: true });
  assert(!deep.some(block => block.text.startsWith('c,λ') || block.text.startsWith('swcs-max')), 'a genuine nested subscript is never a separate paragraph');
  assert.match(deep[0].text, /rc,λ/);
  const nestedLabel = deep[0].textRuns.find(run => run.text === 'swcs-max');
  assert.equal(nestedLabel.mathPosition.group, deep[0].textRuns.find(run => run.text === 'r').mathPosition.group, 'nested label remains with r, not the next line');
  const badLine = await analyzePage(page([
    item('Ordinary preceding sentence.', 40, 100, 220), item('\u0004 One unmapped line.', 40, 112, 220),
    item('Ordinary following sentence.', 40, 124, 220),
  ]), 2, 'local-fallback', { keepFigures: true });
  const fallback = badLine.filter(block => block.sourceTextFallback);
  assert.equal(fallback.length, 1);
  assert(!fallback[0].text.includes('preceding') && !fallback[0].text.includes('following'));
  assert.equal(fallback[0].sourceFontSize, 10);
  const caption = await analyzePage(page([
    item('Body text sets a reliable size for this page.', 40, 50, 400),
    item('Figure 1: Supply V', 40, 100, 85, 8), item('DD', 125, 101.5, 6, 5),
    item(' and energy.', 131, 100, 60, 8),
  ]), 2, 'caption', { keepFigures: true });
  assert(caption.find(block => block.kind === 'caption')?.textRuns.some(run => run.text === 'DD' && run.script === 'sub'));

  const header = await analyzePage(page([
    item('ISSCC 2025 / SESSION 14 / COMPUTE-IN-MEMORY / 14.5', 40, 20, 400, 15, 'bold'),
    item('14.5 A scientific paper with a wrapped', 40, 50, 280, 12, 'bold'),
    item('title that belongs to the same article', 65, 65, 280, 12, 'bold'),
    item('Alice Wang, Bob Chen', 40, 90, 150), item('1', 190, 86, 4, 6),
    item('1', 40, 107, 4, 5), item('Institute of Science, Beijing', 44, 110, 200, 8),
    item('The body is ordinary prose and must remain body text.', 40, 140, 400),
    item('Another sentence provides enough body font statistics.', 40, 152, 400),
    item('A third sentence has no front matter styling.', 40, 164, 400),
  ]), 1, 'header', { keepFigures: true });
  assert.equal(header[0].readingRole, 'publication');
  assert.equal(header[0].kind, 'p');
  const title = header.find(block => block.readingRole === 'title');
  assert.equal(header.filter(block => block.readingRole === 'title').length, 1);
  assert.match(title.text, /wrapped title/);
  assert(header.some(block => block.readingRole === 'authors'));
  assert(header.some(block => block.readingRole === 'affiliations'), JSON.stringify(header.map(block => ({text: block.text, kind: block.kind, role: block.readingRole}))));
  assert(header.some(block => block.text.startsWith('The body') && !block.readingRole));
  const preprint = await analyzePage(page([
    item('A scientific paper describing optimization', 50, 50, 400, 18, 'bold'),
    item('Preprint, compiled July 26, 2019', 200, 80, 200, 9),
    item('Alice Wang, Bob Chen, and Carol Lin', 100, 105, 300, 10),
    item('Example Networks, Inc.', 200, 125, 160, 9),
    item('Abstract', 260, 160, 70, 11, 'bold'),
    item('We propose a general algorithm for efficient optimization.', 50, 190, 450, 10),
    item('Our experimental method improves ordinary results.', 50, 210, 450, 10),
  ]), 1, 'preprint', { keepFigures: true });
  assert(preprint.some(block => block.readingRole === 'authors' && block.text.includes('Alice Wang')));
  assert(preprint.some(block => block.readingRole === 'affiliations' && block.text.includes('Example Networks')));
  assert.equal(REFLOW_ENGINE_VERSION, 30, 'older cached blocks must be reparsed');
  for (const [pageNumber, label] of [[2, 'ISSCC 2025 / February 18, 2025 / 10:05 AM'],
    [3, 'ISSCC 2025 PAPER CONTINUATIONS AND REFERENCES']]) {
    const later = await analyzePage(page([
      item(label, 40, 20, 400, 15, 'bold'),
      item('A later-page heading is not the title of this article', 40, 65, 400, 15, 'bold'),
      item('This body discusses an ISSCC 2025 SESSION presentation.', 40, 100, 400),
      item('ISSCC 2025 PAPER CONTINUATIONS AND REFERENCES', 40, 180, 400),
    ]), pageNumber, 'later-header', { keepFigures: true });
    assert.equal(later[0].readingRole, 'publication');
    assert.equal(later[0].kind, 'p');
    assert.equal(later[0].text, label);
    assert.equal(later[0].textRuns.map(run => run.text).join(''), label);
    assert(!later.slice(1).some(block => block.readingRole), 'body mentions and below-margin labels stay ordinary content; later pages never gain title roles');
  }
  const mention = await analyzePage(page([
    item('We compare the ISSCC 2025 SESSION 14 results.', 40, 25, 400),
    item('Further measurements follow in this paragraph.', 40, 40, 400),
  ]), 2, 'mention', { keepFigures: true });
  assert(!mention.some(block => block.readingRole), 'top-margin body mentions alone are not publication headers');

  const oldTitle = { ...title, id: 'old-title-tail', text: 'title that belongs to the same article' };
  const note = { id: 'note', paperId: 'header', blockId: oldTitle.id, page: 1,
    quote: 'belongs to', startOffset: 11, endOffset: 21, body: 'Keep this annotation.' };
  const [migrated] = reanchorNotes([oldTitle], header, [note]);
  assert.equal(migrated.blockId, title.id);
  assert.equal(title.text.slice(migrated.startOffset, migrated.endOffset), 'belongs to');
  const context = { ...oldTitle, text: 'part of a scientific article' };
  const combined = { ...title, text: 'A study of methods: part of a scientific article' };
  const [contextNote] = reanchorNotes([context], [combined], [{ ...note, startOffset: 5, endOffset: 7, quote: 'of' }]);
  assert.equal(contextNote.blockId, combined.id, 'merged blocks use full old context to anchor a repeated short quote');
  assert.equal(contextNote.startOffset, combined.text.lastIndexOf('of'));
  assert.equal(contextNote.endOffset, combined.text.lastIndexOf('of') + 2);
  const oldParagraph = { ...paragraph[0], textRuns: undefined };
  const selected = { ...note, blockId: oldParagraph.id, paperId: 'inline', page: 2,
    startOffset: 11, endOffset: 14, quote: 'VDD' };
  const [scriptNote] = reanchorNotes([oldParagraph], paragraph, [selected]);
  assert.equal(scriptNote.startOffset, 11);
  assert.equal(scriptNote.endOffset, 14);
  assert.equal(paragraph[0].text.slice(scriptNote.startOffset, scriptNote.endOffset), 'VDD');
  console.log('PASS geometry scripts, small caps/FP8, italic runs, whitespace, dehyphenation, translation integrity, body/caption extraction, title hierarchy and merged-title/script note anchors');

  for (const [index, file] of process.argv.slice(2).entries()) {
    const pdf = await getDocument({ data: new Uint8Array(await fs.readFile(file)), useSystemFonts: true, fontExtraProperties: true }).promise;
    try {
      const blocks = await analyzeDocument(pdf, 'sample', { keepFigures: true });
      for (const block of blocks.filter(block => block.textRuns)) assert.equal(block.textRuns.map(run => run.text).join(''), block.text, `${block.id} retains text offsets`);
      for (const block of blocks.filter(block => ['authors', 'affiliations', 'biography'].includes(block.readingRole))) {
        assert(!modules.reading.isReadingContent(block), 'author source blocks are retained for anchors but excluded from reading');
        assert(!modules.reading.isTranslatableContent(block));
      }
      if (index === 0) {
        assert.equal(blocks.filter(block => block.page === 1 && block.kind === 'h1').length, 1);
        assert.match(blocks.find(block => block.readingRole === 'title').text, /Accurate\/Approximate.*Floating-Point Edge Training and Inference/);
        assert(blocks.find(block => block.readingRole === 'authors').textRuns.some(run => run.text === '1,2' && run.script === 'sup'));
        const mantissa = blocks.find(block => block.text.includes('shared exponent'));
        assert(mantissa.textRuns.some(run => run.text === 'max' && run.script === 'sub'));
        assert(mantissa.textRuns.some(run => run.text === 'E-Bias' && run.script === 'sup'));
        assert(!blocks.flatMap(block => block.textRuns ?? []).some(run => run.script && /FP8|INT8/.test(run.text)));
        for (const pageNumber of [2, 3]) {
          const runningHeader = blocks.find(block => block.page === pageNumber && block.text.startsWith('ISSCC 2025'));
          assert.equal(runningHeader?.readingRole, 'publication');
          assert.equal(runningHeader.kind, 'p');
        }
      } else {
        assert(blocks.find(block => block.readingRole === 'authors').textRuns.some(run => run.italic && run.text.includes('Member')));
      }
      console.log(`PASS supplied PDF ${index + 1}: ${blocks.length} blocks, ${blocks.filter(block => block.textRuns?.some(run => run.script)).length} blocks with verified script structure; every run preserves canonical text`);
    } finally { await pdf.destroy(); }
  }
} finally { await fs.rm(temp, { recursive: true, force: true }); }
