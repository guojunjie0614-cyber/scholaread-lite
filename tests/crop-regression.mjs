import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  entryPoints: [path.join(root, 'renderer/src/lib/pdf.ts')], bundle: true, write: false,
  platform: 'node', format: 'esm', target: 'node22',
  plugins: [{ name: 'pdf-browser-imports', setup(builder) {
    builder.onResolve({ filter: /^pdfjs-dist/ }, (args) => ({ path: args.path, namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, (args) => ({
      contents: args.path.includes('?url') ? 'export default "mock-worker";' :
        'export const GlobalWorkerOptions = {}; export function getDocument() { throw new Error("Not used in crop test"); }',
      loader: 'js',
    }));
  } }],
});
const { cropPageRegionBlob } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const originalDocument = globalThis.document;
const canvases = [];
globalThis.document = { createElement(tag) {
  assert.equal(tag, 'canvas');
  const canvas = { width: 0, height: 0, label: '',
    getContext() { return { canvas }; }, toBlob(callback) { callback(new Blob([canvas.label], { type: 'image/png' })); } };
  canvases.push(canvas);
  return canvas;
} };
function fakeDocument(label, failFirst = false) {
  const document = { requests: 0, renders: 0, dimensions: [], async getPage() {
    document.requests++;
    return { getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
      render({ canvasContext, transform, background }) {
        document.renders++;
        document.dimensions.push([canvasContext.canvas.width, canvasContext.canvas.height]);
        assert.ok(transform.every(Number.isFinite));
        assert.ok(background);
        return { promise: Promise.resolve().then(() => {
          if (failFirst && document.renders === 1) throw new Error('simulated render failure');
          canvasContext.canvas.label = label;
        }) };
      } };
  } };
  return document;
}
try {
  const a = fakeDocument('A');
  const b = fakeDocument('B');
  const region = [10, 20, 100, 80];
  const [first, duplicate] = await Promise.all([cropPageRegionBlob(a, 1, region), cropPageRegionBlob(a, 1, region)]);
  assert.equal(first, duplicate);
  assert.equal(a.requests, 1);
  assert.equal(a.renders, 1);
  assert.equal(await cropPageRegionBlob(a, 1, region), first);
  assert.equal(a.renders, 1);
  assert.notEqual(await cropPageRegionBlob(b, 1, region), first, 'documents must never share crops');
  assert.equal(b.renders, 1);
  assert.deepEqual(a.dimensions, [[180, 120]]);

  let complete;
  let cancellations = 0;
  const delayed = { requests: 0, async getPage() {
    this.requests++;
    return { getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
      render({ canvasContext }) {
        return { promise: new Promise(resolve => { complete = () => { canvasContext.canvas.label = 'shared'; resolve(); }; }),
          cancel() { cancellations++; complete(); } };
      } };
  } };
  const firstController = new AbortController();
  const firstWaiter = cropPageRegionBlob(delayed, 1, region, 2, { signal: firstController.signal });
  const secondWaiter = cropPageRegionBlob(delayed, 1, region);
  await Promise.resolve();
  firstController.abort();
  await assert.rejects(firstWaiter, { name: 'AbortError' });
  assert.equal(cancellations, 0, 'one cancelled waiter must not cancel the shared render');
  complete();
  assert.equal(await (await secondWaiter).text(), 'shared');
  assert.equal(delayed.requests, 1);
  const alone = new AbortController();
  const cancelled = cropPageRegionBlob(delayed, 2, region, 2, { signal: alone.signal });
  await Promise.resolve();
  alone.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(cancellations, 1, 'the render is cancelled when its last waiter leaves');
  const fresh = cropPageRegionBlob(delayed, 2, region);
  await Promise.resolve();
  complete();
  assert.equal(await (await fresh).text(), 'shared', 'a cancelled render must be retryable');

  const retry = fakeDocument('retry', true);
  await assert.rejects(cropPageRegionBlob(retry, 1, region), /simulated render failure/);
  assert.equal(await (await cropPageRegionBlob(retry, 1, region)).text(), 'retry');
  assert.equal(retry.renders, 2);
  const outside = fakeDocument('outside');
  await assert.rejects(cropPageRegionBlob(outside, 1, [700, 0, 800, 100]), /页面之外/);
  await assert.rejects(cropPageRegionBlob(outside, 1, [0, 0, 0, 100]), /无效/);
  await assert.rejects(cropPageRegionBlob(outside, 1, [0, 0, NaN, 100]), /无效/);
  assert.equal(outside.renders, 0);
  assert.ok(canvases.every((canvas) => canvas.label === '' || (canvas.width === 0 && canvas.height === 0)),
    'successful crops release canvas backing storage');
  globalThis.document = { createElement: () => {
    const canvas = createCanvas(1, 1);
    canvas.toBlob = (callback) => callback(new Blob([canvas.toBuffer('image/png')], { type: 'image/png' }));
    return canvas;
  } };
  const fractional = { async getPage() {
    return { getViewport: ({scale}) => ({width:100*scale, height:100*scale}), render({canvasContext, transform}) {
      canvasContext.transform(...transform);
      // Simulate the top of a caption lying outside y=1.25 but inside the rounded two-pixel canvas.
      canvasContext.fillStyle = '#000';
      canvasContext.fillRect(0, 1.5, 2, .5);
      return {promise:Promise.resolve()};
    }};
  }};
  const png = await cropPageRegionBlob(fractional, 1, [0,0,2,1.25], 1, {transparent:true});
  const decoded = await loadImage(Buffer.from(await png.arrayBuffer())), pixels = createCanvas(decoded.width, decoded.height);
  pixels.getContext('2d').drawImage(decoded, 0, 0);
  assert.equal(pixels.getContext('2d').getImageData(0, 1, 1, 1).data[3], 0,
    'ceil canvas padding must not include caption ink beyond the exact crop');
  console.log('PASS cross-document isolation, concurrent dedupe, cache reuse, retry, invalid/outside rejection');
} finally {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
}
