import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-regression-'));
try {
  const modules = {};
  for (const name of ['analyze', 'regions', 'math', 'captions', 'figure-plates']) {
    const file = path.join(tmp, `${name}.mjs`);
    await build({ entryPoints: [`renderer/src/reflow/${name}.ts`], bundle: true, platform: 'node', format: 'esm', outfile: file, plugins: [{ name: 'pdfjs-node', setup(build) { build.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs'), external: true })); } }] });
    modules[name] = await import(pathToFileURL(file));
  }
  const { analyzePage, analyzeDocument, detectGutter, orderFloatingContent } = modules.analyze;
  const { extractMathRegions } = modules.math;
  const { extractPageRegions } = modules.regions;
  const { parseCaption } = modules.captions;
  const { matchFigurePlates, groupFigurePlateRows } = modules['figure-plates'];
  const item = (str, x, y, width = 180, size = 10, font = 'body') => ({ str, width, height: size, fontName: font, transform: [size, 0, 0, size, x, 800 - y] });
  const page = (items, drawings = [], viewport = {}) => ({
    getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800], ...viewport }),
    getTextContent: async () => ({ items, styles: { body: { ascent: .8, descent: -.2, fontFamily: 'Times' }, math: { ascent: .8, descent: -.2, fontFamily: 'CMMI10' } } }),
    getOperatorList: async () => ({ fnArray: [OPS.setFont, OPS.setFont, ...drawings.flatMap(() => [OPS.constructPath, OPS.stroke])], argsArray: [['body', 10], ['math', 10], ...drawings.flatMap(([x0, y0, x1, y1]) => [[[], [], [x0, 800 - y1, x1, 800 - y0]], []])] }),
    commonObjs: { has: () => true, get: id => ({ name: id === 'math' ? 'CMMI10' : 'Times' }) },
    cleanup() {},
  });
  let count = 0;
  const check = async (name, fn) => { await fn(); count++; console.log(`ok ${count} - ${name}`); };

  await check('caption labels support dotted identifiers and distinguish punctuation from prose', () => {
    assert.deepEqual(parseCaption('Figure 3.2.7: A complete plate.'), {
      kind: 'figure', label: '3.2.7', hasDelimiter: true, text: 'A complete plate.',
    });
    assert.equal(parseCaption('Fig. 12. A normal figure.').label, '12');
    assert.equal(parseCaption('Table IV Parameters').kind, 'table');
    assert.equal(parseCaption('Figure 3.2.7 describes the architecture.').hasDelimiter, false);
  });
  await check('nearby image seeds stay separate and plates read row-major rather than column-major', () => {
    const image = (x, y) => ({ kind: 'image', x0: x, y0: y, x1: x + 250, y1: y + 180, horizontal: false, vertical: false });
    const caption = (x, y, label) => ({ text: `Figure ${label}: A caption.`, items: [], x0: x, y0: y + 185, x1: x + 230, y1: y + 194, y: y + 191, size: 8 });
    const images = [image(30, 50), image(284, 50), image(30, 300), image(284, 300)];
    const labels = [caption(30, 50, '3.2.1'), caption(284, 50, '3.2.2'), caption(30, 300, '3.2.3'), caption(284, 300, '3.2.4')];
    const mergedRows = [50, 300].map(y => ({ kind: 'figure', x0: 30, y0: y,
      x1: 534, y1: y + 180, parts: 2, rules: { h: 0, v: 0 } }));
    const plates = matchFigurePlates(images, mergedRows, labels, 600, 800, () => true);
    assert.equal(plates.length, 4);
    assert.deepEqual(groupFigurePlateRows(plates).flat().map(plate => plate.figureLabel), ['3.2.1', '3.2.2', '3.2.3', '3.2.4']);
    const independent = [plates[0], { ...plates[1], figureLabel: '3.2.4' }];
    assert.equal(groupFigurePlateRows(independent).length, 2, 'nonconsecutive figures must follow column order');
    assert(plates.every(plate => plate.crop[2] - plate.crop[0] < 260));
  });
  await check('matched image seeds replace an over-merged geometry region without duplicate figures', async () => {
    const mock = page([
      item('Figure 3.2.1: Left panel.', 30, 244, 230, 8),
      item('Figure 3.2.2: Right panel.', 284, 244, 230, 8),
    ]);
    mock.getOperatorList = async () => ({
      fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore,
        OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
      argsArray: [[], [250, 0, 0, 180, 30, 570], ['left', 250, 180], [],
        [], [250, 0, 0, 180, 284, 570], ['right', 250, 180], []],
    });
    const blocks = await analyzePage(mock, 2, 'plate', { keepFigures: true });
    assert.equal(blocks.filter(b => b.kind === 'figure').length, 2);
    assert.equal(blocks.filter(b => b.kind === 'caption').length, 2);
    assert.deepEqual(blocks.filter(b => b.kind === 'figure').map(b => b.figureLabel), ['3.2.1', '3.2.2']);
  });
  await check('a full-width caption joins separate visual panels without swallowing the body', async () => {
    const mock = page([
      item('ARTICLE', 500, 20, 60, 14),
      item('Fig. 1 Composite figure of two panels.', 40, 350, 520, 8),
      item('This caption describes both experimental panels.', 40, 360, 520, 8),
      item('A body paragraph follows the complete illustration.', 40, 400, 230),
      item('A second column supplies another ordinary paragraph.', 330, 400, 230),
      item('Another body line establishes the page text size.', 40, 420, 230),
      item('Another column line establishes the page text size.', 330, 420, 230),
    ]);
    mock.getOperatorList = async () => ({ fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore,
      OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
      argsArray: [[], [200, 0, 0, 230, 60, 480], ['left', 200, 230], [],
        [], [200, 0, 0, 230, 340, 480], ['right', 200, 230], []] });
    const blocks = await analyzePage(mock, 3, 'composite', {keepFigures: true});
    const figures = blocks.filter(b => b.kind === 'figure');
    assert.equal(figures.length, 1);
    assert(figures[0].crop[0] < 60 && figures[0].crop[2] > 540);
    assert(blocks.some(b => b.kind === 'caption' && b.text.includes('both experimental panels')));
    assert(blocks.findIndex(b => b.kind === 'figure') < blocks.findIndex(b => b.text.startsWith('A body paragraph')));
  });
  await check('a single-column bitmap does not pull the other column before its own body', async () => {
    const items = [];
    for (const y of [80, 110, 140, 170, 440, 470, 500, 530]) {
      for (const x of [40, 330]) items.push(item(`${x === 40 ? 'LEFT' : 'RIGHT'} ${y} ordinary paragraph ends.`, x, y, 230));
    }
    items.push(item('Figure 1: A complete bitmap.', 40, 415, 230, 8));
    const mock = page(items);
    mock.getOperatorList = async () => ({
      fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
      argsArray: [[], [230, 0, 0, 190, 40, 400], ['image', 230, 190], []],
    });
    const blocks = await analyzePage(mock, 2, 'column-image', { keepFigures: true });
    const figure = blocks.findIndex(block => block.kind === 'figure');
    const caption = blocks.findIndex(block => block.kind === 'caption');
    assert.equal(caption, figure + 1);
    assert(figure > blocks.findIndex(block => block.text.startsWith('LEFT 170')));
    assert(caption < blocks.findIndex(block => block.text.startsWith('LEFT 440')));
    assert(blocks.findIndex(block => block.text.startsWith('LEFT 530')) <
      blocks.findIndex(block => block.text.startsWith('RIGHT 80')));
  });
  await check('bitmap captions stop before same-size section headings', async () => {
    const mock = page([
      item('A normal introductory body paragraph.', 40, 100, 400),
      item('Figure 1: A complete bitmap.', 40, 415, 230, 8),
      item('Results', 40, 427, 60, 8),
      item('A following body paragraph.', 40, 460, 400),
    ]);
    mock.getOperatorList = async () => ({
      fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
      argsArray: [[], [230, 0, 0, 190, 40, 400], ['image', 230, 190], []],
    });
    const blocks = await analyzePage(mock, 2, 'bitmap-caption', { keepFigures: true });
    assert.equal(blocks.find(block => block.kind === 'caption').text, 'Figure 1: A complete bitmap.');
    assert(blocks.some(block => block.kind === 'h2' && block.text === 'Results'));
  });
  await check('a bitmap embedded in a larger vector figure is not promoted to a separate plate', () => {
    const image = { kind: 'image', x0: 80, y0: 50, x1: 190, y1: 150, horizontal: false, vertical: false };
    const region = { kind: 'figure', x0: 50, y0: 40, x1: 500, y1: 170, parts: 20, rules: { h: 3, v: 3 } };
    const line = { text: 'Figure 3.2.1: A combined diagram.', items: [], x0: 50, y0: 176, x1: 500, y1: 185, y: 182, size: 8 };
    assert.equal(matchFigurePlates([image], [region], [line], 600, 800, () => true).length, 0);
  });
  await check('blank template cells and Figure references do not create plate figures', () => {
    const path = { kind: 'path', x0: 30, y0: 50, x1: 280, y1: 230, horizontal: false, vertical: false };
    const line = { text: 'Figure 3.2.1: A caption.', items: [], x0: 30, y0: 235, x1: 260, y1: 244, y: 241, size: 8 };
    assert.equal(matchFigurePlates([path], [], [line], 600, 800, () => true).length, 0);
    assert.equal(matchFigurePlates([{ ...path, kind: 'image' }], [], [{ ...line, text: 'Figure 3.2.1 illustrates the architecture.' }], 600, 800, () => true).length, 0);
  });
  await check('regular word spacing is not a column gutter', () => {
    const words = [];
    for (let y = 100; y < 400; y += 12) for (let x = 50; x < 550; x += 50) words.push({ str: 'word', x, y, w: 40, h: 10, bold: false, font: '' });
    assert.equal(detectGutter(words, 600), null);
  });
  await check('different body and reference fonts still reveal the same column gutter', () => {
    const raw = [];
    for (let i = 0; i < 18; i++) {
      raw.push({ str: 'Body sentence', x: 45, y: 100 + i * 12, w: 235, h: 10, bold: false, font: 'Times' });
      raw.push({ str: '[1] Smaller references', x: 320, y: 101 + i * 10, w: 235, h: 8, bold: false, font: 'Times' });
    }
    const gutter = detectGutter(raw, 600);
    assert(gutter > 280 && gutter < 320);
  });
  await check('caption does not swallow a heading or nearby body text', async () => {
    const blocks = await analyzePage(page([
      item('A sufficiently long body paragraph introduces the following illustration.', 50, 100, 400),
      item('Fig. 1. A longer caption describes the measurement and the corresponding control.', 50, 300, 400, 8),
      item('Results', 50, 345, 70, 14),
      item('Another complete body paragraph follows the section heading.', 50, 375, 400),
    ], [[50, 200, 250, 260]]), 2, 'test', { keepFigures: true });
    assert(blocks.some(b => b.kind === 'h2' && b.text === 'Results'));
    assert(!blocks.find(b => b.kind === 'caption').text.includes('Results'));
  });
  await check('unmatched large initial and a small body number are preserved', async () => {
    const blocks = await analyzePage(page([item('A', 50, 100, 15, 20), item('ordinary body paragraph with sufficient text', 100, 200, 300), item('value =', 50, 755, 40), item('1', 95, 757, 5, 7)]), 2, 'test', { keepFigures: true });
    assert(blocks.some(b => b.text.includes('A')));
    assert(blocks.some(b => b.text.includes('value = 1')));
  });
  await check('a multi-line drop cap joins the first line without disturbing later rows', async () => {
    const blocks = await analyzePage(page([
      item('A', 40, 130, 28, 40), item(' ', 68, 130, 1, 40),
      item('dynamical system evolves in time, with examples', 76, 110, 250),
      item('including a weather system and instruments.', 69, 121, 230),
      item('A later line completes the description.', 69, 132, 230),
      item('The next paragraph follows naturally.', 40, 155, 280),
    ]), 2, 'dropcap', { keepFigures: true });
    const text = blocks.map(b => b.text).join(' ');
    assert.match(text, /^A dynamical system evolves in time, with examples including a weather system and instruments\. A later line/);
  });
  await check('right column equations precede the explanation below them', async () => {
    const items = [];
    for (let i = 0; i < 12; i++) for (const [x, label] of [[50, 'Left'], [350, 'Right']]) items.push(item(`${label} paragraph has several ordinary words.`, x, 70 + i * 18, 240));
    items.push(item('x', 380, 320, 8, 10, 'math'), item('=', 400, 320, 8, 10, 'math'), item('y', 420, 320, 8, 10, 'math'), item('(1)', 575, 320, 15), item('where the following variables have their usual meaning.', 350, 355, 240));
    const blocks = await analyzePage(page(items), 2, 'test', { keepFigures: true });
    const eq = blocks.findIndex(b => b.eqNo === '(1)');
    assert(eq >= 0);
    assert(eq < blocks.findIndex(b => b.text.startsWith('where')));
    assert(blocks[eq].eqNoInCrop);
    assert(blocks[eq].recognitionCrop[2] < 575);
  });
  await check('simultaneous equations in two columns remain independent', () => {
    const items = [];
    for (const x of [50, 350]) {
      for (const [dx, str] of [[20, 'x'], [40, '='], [60, 'y']]) items.push({ str, x: x + dx, y: 100, w: 8, h: 10, font: 'CMMI10' });
      items.push({ str: x === 50 ? '(1)' : '(2)', x: x + 220, y: 100, w: 20, h: 10, font: 'Times' });
    }
    const eqs = extractMathRegions(items, 10, 600, [{ x0: 50, x1: 290 }, { x0: 350, x1: 590 }]);
    assert.deepEqual(eqs.map(e => e.eqNo), ['(1)', '(2)']);
  });
  await check('thin table rules enclose the last row, not only the header', async () => {
    const blocks = await analyzePage(page([
      item('TABLE II', 190, 110, 60, 8), item('Symbol Definition Value', 50, 153, 350, 8), item('alpha example first row', 50, 180, 350, 8), item('omega final table row', 50, 325, 350, 8), item('The following ordinary body paragraph is outside the table.', 50, 380, 400),
    ], [[50, 140, 450, 140], [50, 160, 450, 160], [50, 340, 450, 340]]), 2, 'test', { keepFigures: true });
    const table = blocks.find(b => b.kind === 'table');
    assert(table && table.crop[3] > 340);
    assert(!blocks.some(b => b.kind === 'p' && b.text.includes('omega')));
    assert(blocks.some(b => b.text.startsWith('The following')));
  });
  await check('marked table notes keep their continuations, scripts and table relationship', async () => {
    const blocks = await analyzePage(page([
      item('A normal body paragraph establishes the main reading font and text size.', 50, 70, 500),
      item('TABLE VI', 250, 110, 70, 8),
      item('Header and cells', 50, 150, 500, 8),
      item('* The first table note wraps at the page edge', 50, 248, 500, 8),
      item('and continues without becoming another paragraph.', 58, 258, 250, 8),
      item('† A second independent table note.', 50, 269, 240, 8),
      item('‡ Target P', 50, 280, 52, 8),
      item('FA', 102, 281.5, 9, 6), item(' = 10', 112, 280, 24, 8),
      item('−3', 136, 277.2, 8, 6), item('.', 145, 280, 3, 8),
      item('packing reduces ordinary traffic and belongs to the body.', 50, 310, 240),
      item('C. PPA Evaluation', 50, 340, 200),
      item('A following body paragraph remains distinct from table notes.', 50, 365, 400),
    ], [[50, 140, 550, 140], [50, 160, 550, 160], [50, 235, 550, 235]]), 10, 'notes', { keepFigures: true });
    const table = blocks.find(b => b.kind === 'table');
    const notes = blocks.filter(b => b.kind === 'table-note');
    assert.equal(notes.length, 3);
    assert(notes.every(note => note.parentBlockId === table.id));
    assert(notes[0].text.includes('continues without becoming another paragraph'));
    assert(notes[2].textRuns.some(run => run.text === 'FA' && run.script === 'sub'));
    assert(notes[2].textRuns.some(run => run.text === '−3' && run.script === 'sup'));
    assert(notes.every(note => note.textRuns.map(run => run.text).join('') === note.text));
    assert(notes.every(note => !note.text.includes('packing reduces')));
    assert(blocks.some(b => b.kind === 'h3' && b.text === 'C. PPA Evaluation'));
    assert(blocks.findIndex(b => b.text.startsWith('packing reduces')) > blocks.indexOf(notes[2]));
    assert(notes[0].crop[3] < notes[1].bbox[1]);
    assert(notes[1].crop[1] > notes[0].bbox[3]);
  });
  await check('unmarked notes need close alignment and stop before the next body paragraph', async () => {
    const blocks = await analyzePage(page([
      item('A normal body paragraph establishes the main reading font and text size.', 50, 70, 500),
      item('TABLE IV', 250, 110, 70, 8), item('Header and cells', 50, 150, 500, 8),
      item('Peripheral state: signed 20-bit compensated sums', 50, 246, 300, 8),
      item('and signed 24-bit complex sums.', 50, 255, 250, 8),
      item('The ordinary body resumes below the table.', 50, 280, 400),
    ], [[50, 140, 550, 140], [50, 160, 550, 160], [50, 235, 550, 235]]), 6, 'notes', { keepFigures: true });
    const notes = blocks.filter(b => b.kind === 'table-note');
    assert.equal(notes.length, 1);
    assert(notes[0].text.includes('20-bit') && notes[0].text.includes('24-bit'));
    assert(!notes[0].text.includes('ordinary body'));
    assert(blocks.some(b => b.kind === 'p' && b.text.startsWith('The ordinary')));
  });
  await check('distant small print is not attached to a table', async () => {
    const blocks = await analyzePage(page([
      item('A normal body paragraph establishes the main reading font and text size.', 50, 70, 500),
      item('TABLE IV', 250, 110, 70, 8), item('Header and cells', 50, 150, 500, 8),
      item('Distant small print is a separate object.', 50, 280, 300, 8),
    ], [[50, 140, 550, 140], [50, 160, 550, 160], [50, 235, 550, 235]]), 6, 'notes', { keepFigures: true });
    assert(!blocks.some(b => b.kind === 'table-note'));
    assert(blocks.some(b => b.text.includes('Distant small print')));
  });
  await check('full-width headings separate left-right reading bands', async () => {
    const items = [];
    for (const y of [100, 130, 160, 190, 320, 350, 380, 410]) for (const x of [50, 350]) items.push(item(`${x === 50 ? 'LEFT' : 'RIGHT'} ${y < 250 ? 'TOP' : 'BOTTOM'} ordinary prose.`, x, y, 230));
    items.push(item('2.1 Middle section', 50, 250, 500, 16));
    const blocks = await analyzePage(page(items), 2, 'test', { keepFigures: true });
    const text = blocks.map(b => b.text).join('|');
    assert(text.indexOf('LEFT TOP') < text.indexOf('RIGHT TOP'));
    assert(text.indexOf('RIGHT TOP') < text.indexOf('Middle section'));
    assert(text.indexOf('Middle section') < text.indexOf('LEFT BOTTOM'));
    assert(text.indexOf('LEFT BOTTOM') < text.indexOf('RIGHT BOTTOM'));
  });
  await check('rotated and offset viewports transform drawing coordinates', async () => {
    const mock = page([], [[10, 700, 110, 750]], { width: 800, height: 600, transform: [0, 1, 1, 0, -20, -5] });
    const geom = await extractPageRegions(mock);
    assert(geom.drawings.some(r => Math.abs(r.x0 - 29.5) < .01 && Math.abs(r.y0 - 4.5) < .01));
  });
  await check('empty OCR of a nonblank image page preserves the original page', async () => {
    const blocks = await analyzePage(page([], [[20, 20, 580, 780]]), 1, 'scan', { keepFigures: true, ocrPage: async () => [] });
    assert.deepEqual(blocks[0].crop, [0, 0, 600, 800]);
  });
  await check('full-page scan images survive the background filter when OCR is empty', async () => {
    const scan = page([]);
    scan.getOperatorList = async () => ({
      fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
      argsArray: [[], [600, 0, 0, 800, 0, 0], ['scan', 600, 800], []],
    });
    const blocks = await analyzePage(scan, 1, 'scan', { keepFigures: true, ocrPage: async () => [] });
    assert.deepEqual(blocks[0].crop, [0, 0, 600, 800]);
  });
  await check('list and reference continuation lines remain in their semantic block', async () => {
    const blocks = await analyzePage(page([
      item('1) A numbered contribution begins', 50, 100, 300),
      item('and continues on the next line.', 65, 112, 280),
      item('[1] A. Author, A real reference title,', 50, 180, 300, 8),
      item('Journal name, volume and year.', 65, 190, 280, 8),
    ]), 2, 'test', { keepFigures: true });
    assert(blocks.some(b => b.kind === 'li' && b.text.includes('continues on the next line')));
    assert(blocks.some(b => b.kind === 'ref' && b.text.includes('Journal name')));
  });
  await check('a sentence-ending citation on a wrapped line remains body prose', async () => {
    const blocks = await analyzePage(page([
      item('The format improves accuracy compared with the earlier representation', 50, 100, 480),
      item('[13]. It uses a wider exponent and a smaller mantissa.', 50, 112, 480),
      item('The next line continues the same explanation.', 50, 124, 400),
      item('References', 50, 180, 100),
      item('[13] A. Author, A real reference title,', 50, 200, 300, 8),
      item('Journal name, volume and year.', 50, 210, 280, 8),
    ]), 2, 'test', { keepFigures: true });
    const prose = blocks.find(b => b.text.startsWith('The format'));
    assert.equal(prose.kind, 'p');
    assert.match(prose.text, /representation \[13\]\. It uses/);
    assert.match(prose.text, /same explanation/);
    assert.equal(blocks.filter(b => b.kind === 'ref').length, 1);
    assert.match(blocks.find(b => b.kind === 'ref').text, /Journal name/);
  });
  await check('a wrapped leading citation followed by a long technical paragraph stays prose', async () => {
    const blocks = await analyzePage(page([
      item('Cohn and Lempel presented a method for permuting the sequence matrix', 50, 100, 480),
      item('[36] to achieve fast LFSR-sequence phase acquisition for the standard,', 50, 112, 480),
      item('resulting in significant reductions in synchronization time. However,', 50, 124, 480),
      item('the theory has not yet been applied to acquisition in high-dynamic scenarios.', 50, 136, 480),
      item('Our primary contributions are as follows.', 50, 148, 400),
    ]), 2, 'leading-citation', { keepFigures: true });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'p');
    assert.match(blocks[0].text, /matrix \[36\] to achieve/);
    assert.match(blocks[0].text, /Our primary contributions/);
    const isolated = await analyzePage(page([item('[36] to achieve the result, we apply the proposed transform.', 50, 60, 480)]), 2, 'citation-new-column', { keepFigures: true });
    assert.equal(isolated[0].kind, 'p', 'a new column/page is not by itself a bibliography signal');
  });
  await check('a distant margin item does not turn a wrapped citation into a reference', async () => {
    const blocks = await analyzePage(page([
      item('Margin marker', 550, 60, 45, 7),
      item('The comparison is made against earlier systems [16],', 50, 100, 250),
      item('[19]. This improves the energy efficiency.', 50, 112, 250),
    ]), 6, 'citation-margin', { keepFigures: true });
    assert(blocks.some(b => b.kind === 'p' && b.text.includes('[19]. This improves')));
    assert(!blocks.some(b => b.kind === 'ref' && b.text.includes('[19]. This improves')));
  });
  await check('small URL footnote markers stay with their links, outside the other column', async () => {
    const blocks = await analyzePage(page([
      ...[100, 112, 124, 136, 148, 160, 172, 184].flatMap(y => [
        item('A left column has ordinary scientific prose.', 50, y, 230),
        item('The right column has ordinary scientific prose.', 330, y, 230),
      ]),
      item('4', 302, 148, 3, 5), item('https://example.org/four', 312, 148, 120, 5),
    ]), 7, 'footnote-url', {keepFigures: true});
    const source = blocks.find(b => b.text.includes('https://example.org/four'));
    assert(source && /4\s+https:\/\//.test(source.text));
    assert(!blocks.some(b => b.text.includes('prose. 4')));
  });
  await check('period-delimited reference entries keep their type and continuation under References', async () => {
    const blocks = await analyzePage(page([
      item('References:', 50, 100, 100),
      item('The following sources provide background', 50, 112, 480),
      item('[1]. A. Author, First reference title,', 50, 124, 480),
      item('Journal name, volume 2, pp. 10-20, 2024.', 50, 136, 400),
      item('[2]. Example Research Group, Second reference title,', 50, 160, 480),
      item('Conference proceedings, pp. 30-40, 2025.', 50, 172, 400),
    ]), 3, 'test', { keepFigures: true });
    const references = blocks.filter(b => b.kind === 'ref');
    assert.equal(references.length, 2);
    assert.match(references[0].text, /^\[1\]\. A\. Author/);
    assert.match(references[0].text, /10-20, 2024\./);
    assert.match(references[1].text, /^\[2\]\. Example Research Group/);
    assert.match(references[1].text, /30-40, 2025\./);
  });
  await check('period-delimited references remain references when continued on a new page', async () => {
    const pages = [page([
      item('References', 50, 100, 100),
      item('[1]. A. Author, First reference,', 50, 120, 480),
      item('Journal name, 2024.', 50, 132, 250),
    ]), page([
      item('[2]. Example Research Group, Second reference,', 50, 60, 480),
      item('Proceedings, pp. 30-40, 2025.', 50, 72, 300),
    ])];
    const blocks = await analyzeDocument({ numPages: 2, getPage: async n => pages[n - 1] }, 'test', { keepFigures: true });
    const references = blocks.filter(b => b.kind === 'ref');
    assert.equal(references.length, 2);
    assert.equal(references[1].page, 2);
    assert.match(references[1].text, /^\[2\]\. Example Research Group/);
    assert.match(references[1].text, /30-40, 2025\./);
  });
  await check('journal initials and cross-page bibliography continuation never become headings', async () => {
    const pages = [page([
      item('References', 50, 100, 100), item('[9] T. Author, A scientific work, IEEE', 50, 120, 480),
      item('J. Solid-State Circuits, vol. 40, no. 4, pp. 20–30.', 65, 132, 430),
      item('[10] A. Author, Another scientific work,', 50, 156, 480),
    ]), page([
      item('D. Example Journal, volume 3, pp. 5–9.', 65, 60, 430),
      item('[11] B. Author, A final work, Journal, 2025.', 50, 84, 480),
      item('Methods', 50, 140, 100), item('This technical section must remain prose.', 50, 160, 480),
    ])];
    const blocks = await analyzeDocument({ numPages: 2, getPage: async n => pages[n - 1] }, 'bibliography', { keepFigures: true });
    assert(blocks.find(block => block.text.includes('J. Solid-State')).kind === 'ref');
    assert(blocks.find(block => block.text.includes('D. Example Journal')).kind === 'ref');
    assert(blocks.find(block => block.text.startsWith('This technical')).kind === 'p');
    assert(!blocks.some(block => /^h/.test(block.kind) && /vol\.|pp\./.test(block.text)));
  });
  await check('an author-led reference after unfinished body text is not a citation continuation', async () => {
    const blocks = await analyzePage(page([
      item('An unfinished prose line before a bibliography without a heading', 50, 100, 480),
      item('[1]. A. Author, First reference title,', 50, 112, 480),
      item('Journal name, 2025.', 50, 124, 400),
    ]), 2, 'test', { keepFigures: true });
    assert.equal(blocks.filter(b => b.kind === 'ref').length, 1);
    assert.match(blocks.find(b => b.kind === 'ref').text, /Journal name, 2025/);
  });
  await check('page-edge publication notices do not become body text or swallow references', async () => {
    const rotated = item('2025 Example Conference | 979-8-1234-5678-9 ©2025 Publisher', 10, 700, 450, 8);
    rotated.transform = [0, 8, -8, 0, 15, 100];
    const blocks = await analyzePage(page([
      item('A real paragraph about copyright policies remains in the document.', 50, 100, 480),
      item('[14] A. Author, The last reference, Journal,', 50, 720, 480, 8),
      item('volume 57, pp. 850-862, 2010.', 50, 730, 280, 8),
      item('• 2025 Example Conference', 20, 788, 200),
      item('979-8-1234-5678-9 ©2025 Publisher', 360, 788, 230),
      item('Authorized licensed use limited to: a university. Restrictions apply.', 60, 774, 470, 7),
      rotated,
    ]), 3, 'test', { keepFigures: true });
    assert(blocks.some(b => b.kind === 'p' && b.text.includes('copyright policies')));
    assert(blocks.some(b => b.kind === 'ref' && b.text.includes('850-862, 2010')));
    assert(!blocks.some(b => /Example Conference|979-8|©|licensed use/.test(b.text)));
  });
  await check('publication running footer is removed while a low reference is retained', async () => {
    const blocks = await analyzePage(page([
      item('A regular body paragraph establishes the text size.', 50, 100, 400),
      item('[9] A. Author, Copyright in publishing, Proceedings of a conference, 2024.', 50, 770, 490, 8),
      item('DIGEST OF TECHNICAL PAPERS • 259', 350, 792, 230),
    ]), 3, 'test', { keepFigures: true });
    assert(blocks.some(b => b.kind === 'ref' && b.text.includes('Copyright in publishing')));
    assert(!blocks.some(b => b.text.includes('DIGEST OF')));
  });
  await check('rotated preprint stamps at page edges never combine with ordinary text', async () => {
    const stamp = item('arXiv:1900.00000v1 [cs.LG]', 0, 0, 250, 20);
    stamp.transform = [0, 20, -20, 0, 32, 230];
    const doi = item('Preprint doi', 0, 0, 50, 9);
    doi.transform = [0, 9, -9, 0, 590, 370];
    const marker = item('012345678901():,;', 0, 0, 34, 5);
    marker.transform = [0, 5, -5, 0, 10, 448];
    const blocks = await analyzePage(page([stamp, doi, marker,
      item('A normal body paragraph contains a useful result.', 50, 220, 250),
      item('and a continuation is preserved correctly.', 50, 240, 250),
    ]), 1, 'test', { keepFigures: true });
    assert(!blocks.some(b => /arXiv:|Preprint doi|012345678901/.test(b.text)));
    assert(blocks.some(b => b.text.includes('continuation is preserved')));
  });
  await check('small affiliation footnotes follow both body columns', async () => {
    const items = [];
    for (let i = 0; i < 12; i++) for (const [x, label] of [[50, 'LEFT'], [350, 'RIGHT']]) {
      items.push(item(`${label} ordinary text continues across the page.`, x, 100 + i * 20, 230));
    }
    items.push(item('The authors are with the University research institute.', 50, 700, 230, 8));
    const blocks = await analyzePage(page(items), 1, 'test', { keepFigures: true });
    assert(blocks.at(-1).text.includes('University'));
  });
  await check('numbered section headings with ordinary-sized fonts remain distinct from their body', async () => {
    const blocks = await analyzePage(page([
      item('A preceding paragraph concludes here.', 50, 100, 400),
      item('2.3 Historical Remarks', 50, 135, 180),
      item('Historically, research in this field evolved steadily.', 50, 157, 400),
      item('3.1 Sampling Methods on Dynamic Spaces', 50, 240, 300),
      item('There are several approaches to sampling.', 50, 262, 400),
    ]), 4, 'headings', { keepFigures: true });
    for (const title of ['2.3 Historical Remarks', '3.1 Sampling Methods on Dynamic Spaces'])
      assert(blocks.some(b => b.kind === 'h2' && b.text === title), title);
    assert(blocks.some(b => b.kind === 'p' && b.text.startsWith('Historically')));
  });
  await check('a wrapped decimal measurement is not a section heading', async () => {
    const blocks = await analyzePage(page([
      item('The throughput ranges from 0.178 to', 50, 100, 400),
      item('12.7 TOPS/mm2, which enables fast signal acquisition.', 50, 112, 400),
      item('A later paragraph provides the results.', 50, 155, 400),
    ]), 11, 'decimal', { keepFigures: true });
    assert(!blocks.some(b => /^h/.test(b.kind) && b.text.startsWith('12.7')));
  });
  await check('floating figures and a running header do not split a continued sentence', () => {
    const blocks = [
      { kind: 'p', text: 'The signal is modulated onto the carrier wave' },
      { kind: 'p', readingRole: 'publication', text: 'Journal header' },
      { kind: 'figure', text: '' }, { kind: 'caption', text: 'Fig. 1. Signal components.' },
      { kind: 'figure', text: '' }, { kind: 'caption', text: 'Fig. 2. Processing chain.' },
      { kind: 'p', text: 'using binary phase shift keying. The receiver processes it.' },
    ];
    const ordered = orderFloatingContent(blocks);
    assert.deepEqual(ordered.map(b => b.text), ['Journal header', blocks[0].text, blocks[6].text,
      '', 'Fig. 1. Signal components.', '', 'Fig. 2. Processing chain.']);
    const complete = [{ kind: 'p', text: 'A completed sentence.' }, ...blocks.slice(2, 4), blocks[6]];
    assert.deepEqual(orderFloatingContent(complete), complete, 'a completed sentence must not relocate a figure');
  });
  await check('first-page publisher notes and corporate affiliations follow both columns', async () => {
    const items = [];
    for (let i = 0; i < 12; i++) for (const [x, label] of [[50, 'LEFT'], [350, 'RIGHT']]) {
      items.push(item(`${label} ordinary body text continues across this page.`, x, 100 + i * 20, 230));
    }
    items.push(item('Alice Wang is with Example Technologies Company Ltd.', 50, 650, 230, 8));
    items.push(item('Color versions of figures are available online.', 50, 680, 230, 8));
    items.push(item('Digital Object Identifier 10.1234/example', 50, 710, 230, 8));
    const blocks = await analyzePage(page(items), 1, 'test', { keepFigures: true });
    const lastBody = blocks.findLastIndex(b => b.text.includes('RIGHT ordinary'));
    for (const phrase of ['Alice Wang', 'Color versions', 'Digital Object']) {
      assert(blocks.findIndex(b => b.text.includes(phrase)) > lastBody, phrase);
    }
  });
  await check('same-baseline left caption and right-column list item never form a bogus composite figure', async () => {
    const items = [
      item('Fig. 10. RMEM circuit implementation.', 49, 205, 140, 8),
      item('Fig. 11. Simulated power breakdown of the PE array.', 49, 290, 190, 8),
      item('Fig. 13. Switching order of control signals.', 312, 195, 150, 8),
      item('1) The eva signal must be asserted after rst is released.', 322, 290, 240, 10),
    ];
    for (let i = 0; i < 10; i++) {
      items.push(item(`Left column prose line ${i} establishes gutter.`, 49, 550 + i * 16, 250, 10));
      items.push(item(`Right column prose line ${i} establishes gutter.`, 312, 550 + i * 16, 250, 10));
    }
    const mock = page(items);
    mock.getOperatorList = async () => ({
      fnArray: [
        OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore,
        OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore,
        OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore,
      ],
      argsArray: [
        [], [200, 0, 0, 130, 75, 605], ['fig10', 200, 130], [],
        [], [160, 0, 0, 55, 95, 520], ['fig11', 160, 55], [],
        [], [220, 0, 0, 125, 325, 615], ['fig13', 220, 125], [],
      ],
    });
    const blocks = await analyzePage(mock, 7, 'two-col-figs', { keepFigures: true });
    assert.deepEqual(blocks.filter(b => b.kind === 'figure').map(b => b.figureLabel), ['10', '11', '13']);
    const cap11 = blocks.find(b => b.kind === 'caption' && b.figureLabel === '11');
    assert(cap11 && !cap11.text.includes('1) The eva signal'));
    assert(blocks.some(b => b.kind === 'li' && b.text.startsWith('1) The eva signal')));
  });
  await check('word-spaced full-width caption across gutter still joins composite panels', async () => {
    const items = [
      item('Fig. 2 Forecasting a dynamical system using', 44, 325, 251, 8),
      item('the NG-RC across two visual panels.', 298, 325, 250, 8),
    ];
    for (let i = 0; i < 8; i++) {
      items.push(item(`Left body paragraph line ${i} below composite.`, 44, 420 + i * 16, 245, 10));
      items.push(item(`Right body paragraph line ${i} below composite.`, 304, 420 + i * 16, 245, 10));
    }
    const mock = page(items);
    mock.getOperatorList = async () => ({
      fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore,
        OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
      argsArray: [[], [220, 0, 0, 220, 50, 490], ['left', 220, 220], [],
        [], [220, 0, 0, 220, 320, 490], ['right', 220, 220], []],
    });
    const blocks = await analyzePage(mock, 5, 'word-spaced-composite', { keepFigures: true });
    const figures = blocks.filter(b => b.kind === 'figure');
    assert.equal(figures.length, 1);
    assert(figures[0].crop[0] < 60 && figures[0].crop[2] > 530);
    assert(blocks.some(b => b.kind === 'caption' && b.text.includes('using the NG-RC')));
  });
  await check('page failure rejects the document instead of returning a partial success', async () => {
    const good = page([item('A legitimate opening paragraph.', 50, 100, 300)]);
    const broken = { ...good, getTextContent: async () => { throw new Error('broken content'); } };
    await assert.rejects(analyzeDocument({ numPages: 2, getPage: async p => p === 1 ? good : broken }, 'test', { keepFigures: true }), /第 2 页解析失败/);
  });
  await check('wrapped prose mention of Fig. N. or Chinese 图 N at line start stays in its paragraph', async () => {
    const blocks = await analyzePage(page([
      item('Signal acquisition is a 2-D searching process for the PN code phase, as shown in', 312, 640, 250, 10),
      item('Fig. 3. The PN code phase shift represents the time delay between the transmitted', 312, 652, 250, 10),
      item('and the received PN code, which ranges from 0 chip to 1022 chips.', 312, 664, 240, 10),
      item('图 2 说明了该架构在不同信噪比条件下的捕获概率与传统方法对比。', 312, 700, 250, 10),
    ]), 2, 'wrapped-fig-mention', { keepFigures: true });
    assert.equal(blocks.filter(b => b.kind === 'caption').length, 0);
    assert(blocks.some(b => b.kind === 'p' && b.text.includes('as shown in Fig. 3. The PN code phase shift')));
    assert(blocks.some(b => b.kind === 'p' && b.text.includes('图 2 说明了')));
  });
  await check('centered two-line TABLE heading across gutter stays intact and avoids duplicate figure/table', async () => {
    const items = [
      item('TABLE I', 289, 178, 32, 8),
      item('COMPARISON OF APPROXIMATE F', 189, 190, 115, 8),
      item('OURIER TRANSFORM PROCESSORS', 304.8, 190, 118, 8),
      item('Metric   Design A   Design B', 80, 215, 420, 8),
    ];
    for (let i = 0; i < 8; i++) {
      items.push(item(`Left column prose line ${i} below table.`, 49, 360 + i * 16, 250, 10));
      items.push(item(`Right column prose line ${i} below table.`, 312, 360 + i * 16, 250, 10));
    }
    const blocks = await analyzePage(page(items, [
      [62, 204, 550, 204],
      [62, 224, 550, 224],
      [62, 313, 550, 313],
      [62, 316, 470, 322],
    ]), 12, 'split-table-title', { keepFigures: true });
    const captions = blocks.filter(b => b.kind === 'caption');
    assert.equal(captions.length, 1);
    assert.match(captions[0].text, /^TABLE I COMPARISON OF APPROXIMATE F\s?OURIER TRANSFORM PROCESSORS$/);
    assert.equal(blocks.filter(b => b.kind === 'table').length, 1);
    assert.equal(blocks.filter(b => b.kind === 'figure').length, 0);
    assert(blocks.find(b => b.kind === 'table').crop[3] >= 322);
  });
  console.log(`${count} reflow regression checks passed.`);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
