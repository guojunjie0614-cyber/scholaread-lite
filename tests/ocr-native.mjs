import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { createCanvas } from '@napi-rs/canvas';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(root, 'electron/ocr.ts'), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'node22' });
const { recognizeText, getOcrAvailability } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const availability = await getOcrAvailability();
if (!availability.available) throw new Error(availability.reason);

const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-ocr-test-'));
const options = { cacheDir, sourcePath: path.join(root, 'scripts/native-ocr.swift') };
try {
  await assert.rejects(recognizeText('not-an-image', options), /PNG/);
  await assert.rejects(recognizeText('data:image/png;base64,AAAA', options), /有效的 PNG/);
  const canvas = createCanvas(1400, 420);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000';
  context.font = '44px Arial';
  context.fillText('Reading order preserves paragraphs.', 80, 100);
  context.fillText('Table 2 contains 1023 samples.', 80, 190);
  context.font = '44px "Songti SC"';
  context.fillText('论文文字识别与阅读顺序', 80, 280);
  const started = Date.now();
  const result = await recognizeText(canvas.toDataURL('image/png'), options);
  const text = result.lines.map((line) => line.text).join('\n');
  assert.match(text, /Reading order preserves paragraphs\./);
  assert.match(text, /Table 2 contains 1023 samples\./);
  assert.match(text.replace(/\s/g, ''), /论文文字识别与阅读顺序/);
  assert.equal(result.width, 1400);
  assert.equal(result.height, 420);
  for (const line of result.lines) {
    assert.ok(line.confidence > 0);
    assert.ok(line.bbox[0] < line.bbox[2] && line.bbox[1] < line.bbox[3]);
    assert.ok(line.bbox.every((value) => value >= 0 && value <= 1));
    assert.ok(line.words.length > 0);
  }
  assert.ok(result.lines[0].bbox[1] < result.lines[1].bbox[1], 'top-left coordinates preserve vertical order');
  const firstMs = Date.now() - started;
  const warmStart = Date.now();
  const warm = await recognizeText(canvas.toDataURL('image/png'), options);
  assert.deepEqual(warm, result);
  const warmMs = Date.now() - warmStart;
  const contents = await fs.readdir(cacheDir);
  assert.deepEqual(contents, [`vision-${process.arch}`], 'page images are removed after OCR');
  console.log(JSON.stringify({ firstMs, warmMs, text, lines: result.lines.length, words: result.lines.reduce((sum, line) => sum + line.words.length, 0) }, null, 2));
} finally {
  await fs.rm(cacheDir, { recursive: true, force: true });
}
