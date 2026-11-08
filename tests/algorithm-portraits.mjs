import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-panels-'));
try {
  const file = path.join(temp, 'entry.mjs');
  await build({ stdin: { contents: "export { analyzePage, analyzeDocument } from './renderer/src/reflow/analyze.ts'; export { reanchorNotes } from './electron/reanchor.ts';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: file,
    plugins: [{ name: 'node-pdf', setup(b) { b.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs'), external: true })); } }] });
  const { analyzePage, analyzeDocument, reanchorNotes } = await import(pathToFileURL(file));
  const item = (str, x, y, width = 200, size = 10) => ({ str, width, height: size, fontName: 'body', transform: [size, 0, 0, size, x, 800 - y] });
  const page = (items, rules = [], images = []) => ({
    getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
    getTextContent: async () => ({ items, styles: { body: { ascent: .8, descent: -.2, fontFamily: 'Times' } } }),
    getOperatorList: async () => ({
      fnArray: [...rules.flatMap(() => [OPS.constructPath, OPS.stroke]), ...images.flatMap(() => [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore])],
      argsArray: [...rules.flatMap(([x0, y0, x1, y1]) => [[[], [], [x0, 800 - y1, x1, 800 - y0]], []]),
        ...images.flatMap(([x, y, w, h]) => [[], [w, 0, 0, h, x, 800 - y - h], ['photo', w, h], []])],
    }), commonObjs: { has: () => true, get: () => ({ name: 'Times' }) }, cleanup() {},
  });
  const algorithm = [item('Algorithm 1: Preserve structure', 325, 90, 210), item('Input: matrix X', 325, 110), item('Output: result Y', 325, 125),
    ...['for each row do', 'if valid then', 'return Y', 'end'].flatMap((text, i) => [item(String(i + 1), 312, 150 + i * 15, 7, 7), item(text, 330, 150 + i * 15, 150)])];
  const prose = [80, 110, 140, 170, 200, 260, 280, 300].flatMap(y => [item(`Left paragraph at ${y}.`, 40, y, 250), ...(y > 240 ? [item(`Right paragraph at ${y}.`, 310, y, 250)] : [])]);
  const rules = [[310, 76, 565, 76], [310, 96, 565, 96], [310, 210, 565, 210]];
  const blocks = await analyzePage(page([...prose, ...algorithm], rules), 6, 'sample', { keepFigures: true });
  const panel = blocks.find(b => b.kind === 'algorithm');
  assert(panel && panel.crop[0] < 310 && panel.crop[1] < 76 && panel.crop[2] > 565 && panel.crop[3] > 210);
  assert.equal(blocks.filter(b => b.kind === 'algorithm').length, 1);
  assert(!blocks.some(b => b.kind !== 'algorithm' && /Input:|Output:|for each row|return Y/.test(b.text)));
  assert(!blocks.some(b => b.kind === 'p' && /\d\. \d/.test(b.text)), 'line numbers must not enter neighboring prose');
  assert.equal((await analyzePage(page([...prose, ...algorithm], rules), 6, 'sample', { keepFigures: false })).filter(b => b.kind === 'algorithm').length, 1);
  assert.equal((await analyzePage(page([...prose, ...algorithm], rules.slice(0, 2)), 6, 'sample', { keepFigures: true })).filter(b => b.kind === 'algorithm').length, 1, 'structured pseudocode establishes its own boundary without a bottom rule');
  assert.equal((await analyzePage(page([...prose, item('Algorithm 1 describes the method.', 325, 90)], rules), 6, 'sample', { keepFigures: true })).filter(b => b.kind === 'algorithm').length, 0);

  const borderless = await analyzePage(page([...prose, ...algorithm]), 6, 'borderless', { keepFigures: true });
  assert.equal(borderless.filter(block => block.kind === 'algorithm').length, 1);
  assert(!borderless.some(block => block.kind !== 'algorithm' && /Input:|Output:|for each row|return Y/.test(block.text)));

  const sequential = [item('Algorithm 2 A sequential procedure', 325, 90, 210), item('Inputs: matrix X', 325, 110), item('Outputs: result Y', 325, 125),
    ...['1: Step 1: initialize X', '2: Compute a transform', '3: Update the estimate', '4: Return the result'].map((text, i) => item(text, 315, 150 + i * 15, 240))];
  const sequentialBlocks = await analyzePage(page([...prose, ...sequential], rules), 6, 'numbered', { keepFigures: true });
  assert.equal(sequentialBlocks.filter(block => block.kind === 'algorithm').length, 1, 'sequential algorithms do not need three control statements');
  assert(sequentialBlocks.find(block => block.kind === 'algorithm').text.includes('Compute a transform'), 'AI/search retain algorithm text independently of the crop');
  const aboveRule = sequential.map((entry, i) => i ? entry : item('Algorithm 2 A sequential procedure', 315, 70, 240));
  assert((await analyzePage(page([...prose, ...aboveRule], rules), 6, 'above-rule', { keepFigures: true })).some(block => block.kind === 'algorithm' && block.crop[1] < 70));
  const code = ['import example', 'def objective(trial):', '    value = trial.sample()', '    return value'].flatMap((text, i) =>
    [item(String(i + 1), 312, 110 + i * 15, 7, 7), item(text, 330, 110 + i * 15, 190, 8)]);
  const codeBlocks = await analyzePage(page([...prose, ...code, item('Figure 1: Example code for a trial.', 310, 180, 250, 8)],
    [[310, 95, 565, 95], [310, 168, 565, 168]]), 2, 'code', { keepFigures: true });
  assert(codeBlocks.some(b => b.kind === 'figure' && b.readingRole !== 'biography' && b.crop && b.text.includes('trial.sample')));
  assert(!codeBlocks.some(b => b.kind === 'p' && b.text.includes('trial.sample')));
  const missingBottomWithLaterRule = [...rules.slice(0, 2), [310, 340, 565, 340]];
  for (const [name, following] of [
    ['ordinary paragraph after a clear gap', [item('The measured throughput improves with batch size.', 310, 240, 250), item('The remaining results are discussed below.', 310, 255, 250)]],
    ['next section', [item('IV. RESULTS', 310, 210, 120), item('The proposed method improves throughput.', 310, 225, 240)]],
    ['next figure caption', [item('Fig. 2. Measured throughput.', 310, 210, 240)]],
    ['next table caption', [item('TABLE II', 310, 210, 120), item('Measured throughput.', 310, 225, 200)]],
    ['another algorithm heading', [item('Algorithm 2: A second method', 325, 210, 220)]],
  ]) {
    const result = await analyzePage(page([...algorithm, ...following], missingBottomWithLaterRule), 6, 'boundary', { keepFigures: true });
    const recovered = result.find(b => b.kind === 'algorithm');
    assert(recovered && !recovered.text.includes(following[0].str), `borderless recovery must not consume ${name}`);
    assert(recovered.crop[3] < 215, 'the unrelated later rule is never the inferred boundary');
    assert(result.some(b => b.text.includes(following[0].str)), `preserve ${name} as text`);
  }

  const biography = [item('Alex Smith received the B.S. degree', 130, 110, 165, 8), item('in engineering from Example University.', 130, 121, 165, 8), item('His research interests include circuits.', 130, 132, 165, 8)];
  const photo = [40, 100, 72, 90];
  const authorPage = page(biography, [], [photo]);
  const late = await analyzePage(authorPage, 9, 'bio', { keepFigures: true, documentPageCount: 10 });
  assert(!late.some(b => b.kind === 'figure' && b.readingRole !== 'biography'));
  assert(late.map(b => b.text).join(' ').includes('Alex Smith received the B.S. degree'));
  assert((await analyzePage(authorPage, 2, 'bio', { keepFigures: true, documentPageCount: 10 })).some(b => b.kind === 'figure' && b.readingRole !== 'biography'));
  assert((await analyzePage(authorPage, 9, 'bio', { keepFigures: true })).some(b => b.kind === 'figure' && b.readingRole !== 'biography'), 'unknown document context preserves images');
  const withCaption = page([...biography, item('Fig. 8. A face recognition experiment.', 40, 205, 255, 8)], [], [photo]);
  assert((await analyzePage(withCaption, 9, 'bio', { keepFigures: true, documentPageCount: 10 })).some(b => b.kind === 'figure' && b.readingRole !== 'biography'));
  const appendix = page([item('Appendix', 40, 70), item('The sensor received the signal shown.', 130, 110, 165, 8), item('We compare the measured input amplitude.', 130, 121, 165, 8)], [], [photo]);
  assert((await analyzePage(appendix, 10, 'appendix', { keepFigures: true, documentPageCount: 10 })).some(b => b.kind === 'figure' && b.readingRole !== 'biography'));
  const document = await analyzeDocument({ numPages: 2, getPage: async n => n === 1 ? page(prose) : authorPage }, 'bio', { keepFigures: true });
  assert(!document.some(b => b.page === 2 && b.kind === 'figure' && b.readingRole !== 'biography'));

  const source = { id: 'old', page: 6, kind: 'p', text: 'for each row do return Y', bbox: [325, 140, 550, 200] };
  const note = { id: 'note', blockId: 'old', page: 6, quote: 'return Y', body: 'Keep my thought', startOffset: 16, endOffset: 24 };
  const [anchored] = reanchorNotes([source], [panel], [note]);
  assert.equal(anchored.blockId, panel.id); assert.equal(anchored.startOffset, null); assert.equal(anchored.body, note.body); assert.equal(anchored.quote, note.quote);
  console.log('PASS ruled algorithm crop, single unit, excluded glyphs, keepFigures=false, missing-boundary/prose negatives; late biography portraits, scientific-image/appendix negatives, document context; note migration');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
