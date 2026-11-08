/**
 * Read-only acceptance for the supplied ISSCC figure-plate paper and IoTJ baseline.
 * node tests/conference-acceptance.mjs [isscc.pdf] [iotj.pdf] [iotj-before.json] [output-dir]
 * Requires the two local PDFs and the pre-change baseline; never opens the library database.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument, OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const library = path.join(os.homedir(), 'Library/Application Support/ScholarLite/library');
const conferencePath = process.argv[2] || path.join(library, 'd8971977-444b-49c7-9f22-3deac69b801b.pdf');
const iotjPath = process.argv[3] || path.join(library, '24d0b647-4e0e-47ad-a468-fb21b6418dd6.pdf');
const baselinePath = process.argv[4] || path.join(root, '.validation/conference-implementation/iotj-before.json');
const output = process.argv[5] || path.join(root, '.validation/conference-implementation/acceptance');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-conference-test-'));
const checks = [];
const documents = [];
function check(name, test) {
  try { test(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
}
const normalized = (text) => text.replace(/\s+/g, ' ').trim();

// Independent PDF image oracle: retain both paint extent and the portion visible through PDF clips.
// No region clustering, caption fitting, or reflow helper is reused here.
async function originalPage(page) {
  const viewport = page.getViewport({ scale: 1 });
  const operators = await page.getOperatorList();
  let matrix = [1, 0, 0, 1, 0, 0];
  let clip = [0, 0, viewport.width, viewport.height];
  let currentPath;
  const stack = [], images = [], rawImages = [];
  const intersection = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  const transformedBox = (bbox) => {
    const transform = Util.transform(viewport.transform, matrix);
    const corners = [[bbox[0], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[1]], [bbox[2], bbox[3]]]
      .map((point) => Util.applyTransform(point, transform));
    return [Math.min(...corners.map((p) => p[0])), Math.min(...corners.map((p) => p[1])),
      Math.max(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[1]))];
  };
  for (let i = 0; i < operators.fnArray.length; i++) {
    const operator = operators.fnArray[i], args = operators.argsArray[i];
    if (operator === OPS.save) stack.push({ matrix: [...matrix], clip: [...clip] });
    else if (operator === OPS.restore) ({ matrix, clip } = stack.pop());
    else if (operator === OPS.transform) matrix = Util.transform(matrix, args);
    else if (operator === OPS.paintFormXObjectBegin) {
      stack.push({ matrix: [...matrix], clip: [...clip] });
      if (args[0]) matrix = Util.transform(matrix, args[0]);
      if (args[1]) clip = intersection(clip, transformedBox(args[1]));
    } else if (operator === OPS.paintFormXObjectEnd) ({ matrix, clip } = stack.pop());
    else if (operator === OPS.constructPath) currentPath = { operations: args[0], bounds: transformedBox(args[2]) };
    else if (operator === OPS.clip || operator === OPS.eoClip) {
      // Supplied pages use a rectangle, sometimes followed by a non-painting moveTo.
      // Reject unsupported clip shapes instead of mistaking their bbox for the visible region.
      assert.ok(currentPath && currentPath.operations.filter((op) => op === OPS.rectangle).length === 1 &&
        currentPath.operations.every((op) => op === OPS.rectangle || op === OPS.moveTo), 'oracle needs a rectangular PDF clip');
      clip = intersection(clip, currentPath.bounds);
    } else if (operator === OPS.endPath) currentPath = undefined;
    else if ([OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(operator)) {
      const raw = transformedBox([0, 0, 1, 1]);
      const rect = intersection(raw, clip);
      if ((rect[2] - rect[0]) * (rect[3] - rect[1]) > 10_000) {
        images.push(rect);
        rawImages.push({ paintBounds: raw, clipBounds: [...clip], visibleBounds: rect });
      }
    }
  }
  const text = await page.getTextContent();
  const captions = text.items.filter((item) => /^Figure 14\.5\.[1-7]:/.test(item.str || '')).map((item) => {
    const transform = Util.transform(viewport.transform, item.transform);
    const style = text.styles[item.fontName];
    const height = Math.hypot(transform[2], transform[3]);
    return { text: item.str, label: item.str.match(/14\.5\.[1-7]/)[0],
      bbox: [transform[4], transform[5] - style.ascent * height,
        transform[4] + item.width, transform[5] - style.descent * height] };
  });
  return { width: viewport.width, height: viewport.height, images, rawImages, captions };
}

async function renderCrop(pdf, block, file) {
  const page = await pdf.getPage(block.page), scale = 2;
  const [x0, y0, x1, y1] = block.crop;
  const canvas = createCanvas(Math.ceil((x1 - x0) * scale), Math.ceil((y1 - y0) * scale));
  const context = canvas.getContext('2d');
  const scaleX = canvas.width / ((x1 - x0) * scale);
  const scaleY = canvas.height / ((y1 - y0) * scale);
  await page.render({ canvasContext: context, viewport: page.getViewport({ scale }),
    transform: [scaleX, 0, 0, scaleY, -x0 * scale * scaleX, -y0 * scale * scaleY] }).promise;
  await fs.writeFile(file, canvas.toBuffer('image/png'));
}

function canonicalBlocks(blocks) {
  return blocks.map((block) => {
    const { id, paperId, ord, analysisVersion, figureLabel, parentBlockId, ...semantic } = block;
    if (parentBlockId && block.kind !== 'caption') {
      const parent = blocks.find((entry) => entry.id === parentBlockId);
      semantic.parent = parent && { page: parent.page, kind: parent.kind, text: parent.text, crop: parent.crop };
    }
    // Baseline is serialized JSON; absent optional fields and in-memory undefined are equivalent.
    return JSON.parse(JSON.stringify(semantic));
  });
}

try {
  await fs.mkdir(output, { recursive: true });
  await build({ entryPoints: [path.join(root, 'renderer/src/reflow/analyze.ts')], bundle: true,
    platform: 'node', format: 'esm', outfile: path.join(temporary, 'analyze.mjs'),
    plugins: [{ name: 'pdfjs-node', setup(builder) {
      builder.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'), external: true }));
    } }],
  });
  const { analyzeDocument } = await import(pathToFileURL(path.join(temporary, 'analyze.mjs')));
  const open = async (file) => {
    const pdf = await getDocument({ data: new Uint8Array(await fs.readFile(file)), useSystemFonts: true }).promise;
    documents.push(pdf);
    return pdf;
  };
  const conference = await open(conferencePath);
  const result = await analyzeDocument(conference, 'conference', { keepFigures: true });
  await fs.writeFile(path.join(output, 'conference-blocks.json'), JSON.stringify(result, null, 2));
  const originals = {};
  for (const page of [2, 3]) originals[page] = await originalPage(await conference.getPage(page));
  await fs.writeFile(path.join(output, 'independent-original-bounds.json'), JSON.stringify(originals, null, 2));

  const figures = result.filter((block) => block.kind === 'figure');
  const captions = result.filter((block) => block.kind === 'caption');
  const labels = Array.from({ length: 7 }, (_, index) => `14.5.${index + 1}`);
  check('ISSCC exactly seven complete figures', () => assert.equal(figures.length, 7));
  check('ISSCC exactly seven separate captions', () => assert.equal(captions.length, 7));
  check('ISSCC figure reading order is 14.5.1 through 14.5.7', () => assert.deepEqual(figures.map((figure) => figure.figureLabel), labels));
  check('ISSCC captions follow the same numbered order', () => assert.deepEqual(captions.map((caption) => caption.text.match(/14\.5\.[1-7]/)?.[0]), labels));
  check('independent PDF oracle contains six page-2 bitmaps and one page-3 bitmap', () => {
    assert.equal(originals[2].images.length, 6); assert.equal(originals[3].images.length, 1);
  });

  const matchedOriginalImages = new Set();
  for (const label of labels) {
    const figure = figures.find((block) => block.figureLabel === label);
    const caption = captions.find((block) => block.text.startsWith(`Figure ${label}:`));
    const expectedPage = label === '14.5.7' ? 3 : 2;
    const originalCaption = originals[expectedPage].captions.find((entry) => entry.label === label);
    check(`${label} figure/caption pairing and exact caption`, () => {
      assert.ok(figure, 'missing labelled figure'); assert.ok(caption, 'missing caption');
      assert.equal(figure.page, expectedPage); assert.equal(caption.page, expectedPage);
      assert.equal(result.indexOf(caption), result.indexOf(figure) + 1, 'caption must immediately follow its figure');
      assert.equal(caption.parentBlockId, figure.id, 'caption must bind to the displayed figure');
      assert.equal(normalized(caption.text), normalized(originalCaption.text));
    });
    check(`${label} full original bitmap retained without caption or excess whitespace`, () => {
      assert.ok(figure?.crop, 'missing image crop');
      const crop = figure.crop;
      const candidates = originals[expectedPage].images.filter((rect) => {
        const center = (rect[0] + rect[2]) / 2;
        return center >= originalCaption.bbox[0] - 15 && center <= originalCaption.bbox[2] + 15 &&
          rect[3] <= originalCaption.bbox[1] + .25 && originalCaption.bbox[1] - rect[3] < 15;
      });
      assert.equal(candidates.length, 1, 'original bitmap must independently match this caption');
      const rect = candidates[0];
      matchedOriginalImages.add(`${expectedPage}:${rect.join(',')}`);
      assert.ok(crop[0] <= rect[0] + .1 && crop[1] <= rect[1] + .1 && crop[2] >= rect[2] - .1 && crop[3] >= rect[3] - .1,
        `crop ${JSON.stringify(crop)} truncates original bitmap ${JSON.stringify(rect)}`);
      assert.ok(crop[3] <= originalCaption.bbox[1] + .25, 'crop includes caption glyph band');
      assert.ok(rect[0] - crop[0] <= 5 && rect[1] - crop[1] <= 5 && crop[2] - rect[2] <= 5 && crop[3] - rect[3] <= 5,
        'crop includes unrelated whitespace or another plate cell');
    });
    if (figure?.crop && figure.crop.every(Number.isFinite) && figure.crop[2] > figure.crop[0] && figure.crop[3] > figure.crop[1]) {
      await renderCrop(conference, figure, path.join(output, `figure-${label}.png`));
    }
  }
  check('each original plate image belongs to exactly one figure', () => assert.equal(matchedOriginalImages.size, 7));
  check('Figure 14.5.6 keeps comparison table and both plots as one figure', () => {
    const figure = figures.find((block) => block.figureLabel === '14.5.6');
    assert.ok(figure?.crop);
    assert.ok(figure.crop[0] <= 311.373 && figure.crop[1] <= 519.286 && figure.crop[2] >= 578.021 && figure.crop[3] >= 748.744);
    assert.equal(result.filter((block) => block.page === 2 && block.kind === 'table').length, 0);
  });
  check('page 1 Figure references remain body prose, never captions/figures', () => {
    const page = result.filter((block) => block.page === 1);
    assert.equal(page.filter((block) => ['figure', 'caption'].includes(block.kind)).length, 0);
    const prose = page.filter((block) => block.kind === 'p').map((block) => block.text).join('\n');
    for (const label of labels) assert.ok(prose.includes(`Figure ${label}`) || prose.includes(`Fig. ${label}`), `missing prose reference ${label}`);
  });
  check('page 1 wrapped citation [13] remains joined to the FP8 body paragraph', () => {
    const paragraph = result.find(block => block.page === 1 && block.text.includes('FP8 can be represented'));
    assert.equal(paragraph?.kind, 'p');
    assert.match(paragraph.text, /higher training efficiency than BF16 \[13\]\. FP8 can be represented/);
    assert.match(paragraph.text, /smaller truncation window\./);
    assert.equal(result.filter(block => block.page === 1 && block.kind === 'ref').length, 0);
  });
  check('publisher copyright, licensing and running footers stay outside reading text', () => {
    assert.ok(!result.some(block => /©\s*2025|979-8-3315-4101-9|Authorized licensed use|DIGEST OF TECHNICAL PAPERS/.test(block.text)));
    const paragraph = result.find(block => block.page === 1 && block.text.includes('structure that accesses every 4b cell'));
    assert.ok(paragraph);
    assert.match(paragraph.text, /every 4b cell independently\./);
  });
  check('page 3 has fourteen complete numbered references and no blank-cell figures', () => {
    const page = result.filter((block) => block.page === 3);
    const references = page.filter((block) => block.kind === 'ref');
    assert.deepEqual(references.map((block) => block.text.match(/^\[(\d+)\]/)?.[1]), Array.from({ length: 14 }, (_, index) => String(index + 1)));
    assert.equal(page.filter((block) => block.kind === 'figure').length, 1);
    assert.equal(page.filter((block) => block.kind === 'table').length, 0);
    const identities = [
      ['31.6-TFLOPS/W', '128-130'], ['55.0TOPS/mm', '572-574'], ['38-to-102-TOPS/W', '130-132'],
      ['2219TOPS/W', '266-268'], ['83.23TFLOPS/W', '566-568'], ['73.3-163.3TOPS/W', '568-570'],
      ['Two-Way Transpose', '609-624'], ['Robust Charge-Domain', '2021'], ['CIMAT:', '944-954'],
      ['Gradient Distribution-Aware', '126269'], ['29.2TFLOPS/W', '255-257'], ['31.2TFLOPS/W', '580-582'],
      ['FP8 Formats', '2209.05433'], ['Bio-Inspired', '850-862'],
    ];
    identities.forEach(([titleAnchor, endAnchor], index) => {
      assert.ok(references[index].text.includes(titleAnchor) && references[index].text.includes(endAnchor),
        `reference [${index + 1}] must retain both its title and publication locator`);
    });
  });

  const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
  const iotj = await analyzeDocument(await open(iotjPath), 'sample', { keepFigures: true });
  await fs.writeFile(path.join(output, 'iotj-after.json'), JSON.stringify(iotj, null, 2));
  check('IoTJ every block retains text, semantic type, order, exact crop and formula structure', () =>
    assert.deepEqual(canonicalBlocks(iotj), canonicalBlocks(baseline)));
  check('IoTJ four table notes retain scripts and their actual parent table', () => {
    const before = baseline.filter((block) => block.kind === 'table-note');
    const after = iotj.filter((block) => block.kind === 'table-note');
    assert.equal(before.length, 4); assert.equal(after.length, 4);
    for (let index = 0; index < 4; index++) {
      assert.equal(after[index].text, before[index].text);
      assert.deepEqual(after[index].textRuns, before[index].textRuns);
      const oldParent = baseline.find((block) => block.id === before[index].parentBlockId);
      const newParent = iotj.find((block) => block.id === after[index].parentBlockId);
      assert.equal(newParent?.kind, 'table');
      assert.deepEqual(newParent.crop, oldParent.crop);
      assert.equal(newParent.page, after[index].page);
    }
  });
  const report = { conferencePath, iotjPath, baselinePath,
    figures: figures.map(({ figureLabel, page, crop }) => ({ figureLabel, page, crop })), checks,
    passed: checks.every((entry) => entry.passed) };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  for (const entry of checks) console.log(`${entry.passed ? 'PASS' : 'FAIL'} ${entry.name}${entry.passed ? '' : `: ${entry.error.slice(0, 1200)}`}`);
  console.log(`Saved ${output}`);
  if (!report.passed) process.exitCode = 1;
} finally {
  await Promise.all(documents.map((pdf) => pdf.destroy()));
  await fs.rm(temporary, { recursive: true, force: true });
}
