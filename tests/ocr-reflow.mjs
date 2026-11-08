// Raster-only PDF -> renderer rasterization -> native Vision -> reflow blocks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createCanvas } from '@napi-rs/canvas';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'slite-ocr-flow-'));
try {
  const bundle = path.join(temp, 'flow.mjs');
  await build({ stdin: { contents: `export {analyzeDocument} from './renderer/src/reflow/analyze'; export {recognizePage} from './renderer/src/reflow/ocr'; export {recognizeText} from './electron/ocr';`, resolveDir: process.cwd() },
    outfile: bundle, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'pdfjs-node', setup(b) {
      b.onResolve({filter: /^pdfjs-dist$/}, () => ({path: path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs'), external: true}));
    }}] });
  let recognize;
  globalThis.window = {requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout, lite: {ocr: {recognize: (png) => recognize(png)}}};
  globalThis.document = {createElement: () => createCanvas(1, 1)};
  const {analyzeDocument, recognizePage, recognizeText} = await import(pathToFileURL(bundle));
  recognize = (png) => recognizeText(png, {cacheDir: temp, sourcePath: path.resolve('scripts/native-ocr.swift')});
  const canvas = createCanvas(1200, 500), ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1200, 500);
  ctx.fillStyle = 'black'; ctx.font = '36px Arial';
  ctx.fillText('A scanned paper retains the correct reading order.', 70, 130);
  ctx.fillText('The second paragraph contains measured results.', 70, 280);
  const jpg = canvas.toBuffer('image/jpeg');
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 250] /Resources << /XObject << /Im 4 0 R >> >> /Contents 5 0 R >>'),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 500 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`), jpg, Buffer.from('\nendstream')]),
    Buffer.from('<< /Length 31 >>\nstream\nq 600 0 0 250 0 0 cm /Im Do Q\n\nendstream'),
  ];
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0];
  let offset = chunks[0].length;
  for (const [i,obj] of objects.entries()) {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),obj,Buffer.from('\nendobj\n')]);
    chunks.push(chunk); offset += chunk.length;
  }
  chunks.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(x=>`${String(x).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`));
  const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({data: new Uint8Array(Buffer.concat(chunks))}).promise;
  const result = await analyzeDocument(doc, 'scan', {keepFigures: true, ocrPage: recognizePage});
  const text = result.map(b=>b.text).join(' ');
  assert.match(text, /A scanned paper retains the correct reading order\./);
  assert.match(text, /The second paragraph contains measured results\./);
  assert.ok(text.indexOf('A scanned') < text.indexOf('The second'));
  assert.ok(result.every(b=>b.source === 'ocr'));
  assert.ok(result.every(b=>b.bbox && b.bbox[0]>=0 && b.bbox[2]<=600));
  await doc.destroy();
  console.log('PASS raster-only PDF -> Vision -> ordered, positioned OCR blocks');
} finally { await fs.rm(temp, {recursive:true,force:true}); }
