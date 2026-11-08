import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy };

export interface PdfRenderOptions {
  signal?: AbortSignal;
  /** Larger values run first; a callback lets queued work follow the viewport. */
  priority?: number | (() => number);
}

type RenderJob = {
  doc: PDFDocumentProxy;
  controller: AbortController;
  priority: () => number;
  start: () => void;
};
const queue: RenderJob[] = [];
const jobs = new Set<RenderJob>();
const RENDER_CONCURRENCY = 2;
let running = 0;

function aborted(): DOMException {
  return new DOMException('图像加载已取消', 'AbortError');
}
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw aborted();
}
function drainQueue() {
  while (running < RENDER_CONCURRENCY && queue.length) {
    queue.sort((a, b) => b.priority() - a.priority());
    queue.shift()!.start();
  }
}

function scheduleRender<T>(doc: PDFDocumentProxy, work: (signal: AbortSignal) => Promise<T>, options: PdfRenderOptions): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let started = false;
    const detach = () => {
      options.signal?.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', cancelQueued);
      jobs.delete(job);
    };
    const cancel = () => controller.abort();
    const cancelQueued = () => {
      if (started) return;
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      detach();
      reject(aborted());
    };
    const job: RenderJob = {
      doc,
      controller,
      priority: () => typeof options.priority === 'function' ? options.priority() : options.priority ?? 0,
      start: () => {
        started = true;
        running++;
        void (async () => {
          try {
            checkAbort(controller.signal);
            const value = await work(controller.signal);
            checkAbort(controller.signal);
            resolve(value);
          } catch (error) {
            reject(controller.signal.aborted ? aborted() : error);
          } finally {
            running--;
            detach();
            drainQueue();
          }
        })();
      },
    };
    jobs.add(job);
    queue.push(job);
    options.signal?.addEventListener('abort', cancel, { once: true });
    controller.signal.addEventListener('abort', cancelQueued, { once: true });
    drainQueue();
  });
}

async function awaitRender(task: RenderTask, signal: AbortSignal) {
  const cancel = () => task.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try { await task.promise; }
  finally { signal.removeEventListener('abort', cancel); }
  checkAbort(signal);
}

export async function loadPdf(paperId: string): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({
    url: `slite://paper/${paperId}`,
    isEvalSupported: false,
    fontExtraProperties: true,
    useSystemFonts: true,
  }).promise;
}

export async function renderPageToCanvas(
  doc: PDFDocumentProxy,
  pageNumber: number,
  scale: number,
  canvas: HTMLCanvasElement,
  options: PdfRenderOptions = {},
): Promise<void> {
  return scheduleRender(doc, async signal => {
    const page = await doc.getPage(pageNumber);
    checkAbort(signal);
    const viewport = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    await awaitRender(page.render({ canvasContext: ctx, viewport }), signal);
    // Other crops may be rendering this same PDF page; document teardown owns cleanup.
  }, options);
}

const documentIds = new WeakMap<PDFDocumentProxy, number>();
let nextDocumentId = 0;
const cropCache = new Map<string, { blob: Blob; bytes: number }>();
type PendingCrop = { controller: AbortController; promise: Promise<Blob>; priorities: Set<PdfRenderOptions['priority']> };
const pendingCrops = new Map<string, PendingCrop>();
const CROP_CACHE_BYTES = 48 * 1024 * 1024;
let cachedBytes = 0;
function documentId(doc: PDFDocumentProxy): number {
  let id = documentIds.get(doc);
  if (id === undefined) { id = ++nextDocumentId; documentIds.set(doc, id); }
  return id;
}
function cachedCrop(key: string): Blob | undefined {
  const hit = cropCache.get(key);
  if (!hit) return;
  cropCache.delete(key);
  cropCache.set(key, hit);
  return hit.blob;
}
function rememberCrop(key: string, blob: Blob, pixels: number) {
  const bytes = blob.size + pixels * 4;
  if (bytes > CROP_CACHE_BYTES) return;
  const old = cropCache.get(key);
  if (old) { cachedBytes -= old.bytes; cropCache.delete(key); }
  while (cachedBytes + bytes > CROP_CACHE_BYTES && cropCache.size) {
    const first = cropCache.entries().next().value!;
    cachedBytes -= first[1].bytes;
    cropCache.delete(first[0]);
  }
  cropCache.set(key, { blob, bytes });
  cachedBytes += bytes;
}

/** Call before destroying a document to cancel its work and discard its cached crops. */
export function releasePdfResources(doc: PDFDocumentProxy) {
  for (const job of jobs) if (job.doc === doc) job.controller.abort();
  const id = documentIds.get(doc);
  if (id === undefined) return;
  for (const [key, entry] of cropCache) {
    if (!key.startsWith(`${id}:`)) continue;
    cachedBytes -= entry.bytes;
    cropCache.delete(key);
  }
}

/** Caller owns any ObjectURL created from this Blob and must revoke it on replacement/unmount. */
export async function cropPageRegionBlob(
  doc: PDFDocumentProxy,
  pageNumber: number,
  region: [number, number, number, number],
  scale = 2,
  options: PdfRenderOptions & { transparent?: boolean } = {},
): Promise<Blob> {
  checkAbort(options.signal);
  const transparent = options.transparent ?? false;
  if (!Number.isFinite(scale) || scale <= 0 || region.some(v => !Number.isFinite(v)) || region[2] <= region[0] || region[3] <= region[1]) {
    throw new Error('裁剪区域或缩放比例无效');
  }
  const key = `${documentId(doc)}:${pageNumber}:${region.join(',')}:${scale}:${transparent}`;
  const hit = cachedCrop(key);
  if (hit) return hit;
  let pending = pendingCrops.get(key);
  if (!pending) {
    const controller = new AbortController();
    const priorities = new Set<PdfRenderOptions['priority']>();
    const promise = scheduleRender(doc, async signal => {
    const queuedHit = cachedCrop(key);
    if (queuedHit) return queuedHit;
    const page = await doc.getPage(pageNumber);
    checkAbort(signal);
    const bounds = page.getViewport({ scale: 1 });
    const x0 = Math.max(0, region[0]);
    const y0 = Math.max(0, region[1]);
    const x1 = Math.min(bounds.width, region[2]);
    const y1 = Math.min(bounds.height, region[3]);
    if (x1 <= x0 || y1 <= y0) throw new Error('裁剪区域在页面之外');
    // Keep high-resolution previews inside the canvas memory/dimension budget.
    const boundedScale = Math.min(scale, 8192 / Math.max(x1 - x0, y1 - y0), Math.sqrt(24_000_000 / ((x1 - x0) * (y1 - y0))));
    const viewport = page.getViewport({ scale: boundedScale });
    const out = document.createElement('canvas');
    out.width = Math.ceil((x1 - x0) * boundedScale);
    out.height = Math.ceil((y1 - y0) * boundedScale);
    try {
      const context = out.getContext('2d')!;
      const scaleX = out.width / ((x1 - x0) * boundedScale);
      const scaleY = out.height / ((y1 - y0) * boundedScale);
      await awaitRender(page.render({
        canvasContext: context,
        viewport,
        transform: [scaleX, 0, 0, scaleY, -x0 * boundedScale * scaleX, -y0 * boundedScale * scaleY],
        background: transparent ? 'rgba(0,0,0,0)' : '#ffffff',
      }), signal);
      const blob = await new Promise<Blob>((resolve, reject) => out.toBlob(
        value => value ? resolve(value) : reject(new Error('图像编码失败')), 'image/png',
      ));
      checkAbort(signal);
      rememberCrop(key, blob, out.width * out.height);
      return blob;
    } finally { out.width = out.height = 0; }
    }, { signal: controller.signal, priority: () => Math.max(0, ...Array.from(priorities, priority =>
      typeof priority === 'function' ? priority() : priority ?? 0)) });
    pending = { controller, promise, priorities };
    pendingCrops.set(key, pending);
    const entry = pending;
    void promise.then(() => {
      if (pendingCrops.get(key) === entry) pendingCrops.delete(key);
    }, () => {
      if (pendingCrops.get(key) === entry) pendingCrops.delete(key);
    });
  }
  const entry = pending;
  // Separate tokens preserve equal priorities from multiple independent callers.
  const priority = () => typeof options.priority === 'function' ? options.priority() : options.priority ?? 0;
  entry.priorities.add(priority);
  return new Promise<Blob>((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      options.signal?.removeEventListener('abort', cancel);
      entry.priorities.delete(priority);
      return true;
    };
    const cancel = () => {
      if (!finish()) return;
      if (!entry.priorities.size) {
        if (pendingCrops.get(key) === entry) pendingCrops.delete(key);
        entry.controller.abort();
      }
      reject(aborted());
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    entry.promise.then(value => { if (finish()) resolve(value); }, error => { if (finish()) reject(error); });
  });
}

/** OCR transport still requires a data URL; image display uses cropPageRegionBlob instead. */
export async function cropPageRegion(
  doc: PDFDocumentProxy,
  pageNumber: number,
  region: [number, number, number, number],
  scale = 2,
  options: PdfRenderOptions & { transparent?: boolean } = {},
): Promise<string> {
  const blob = await cropPageRegionBlob(doc, pageNumber, region, scale, options);
  checkAbort(options.signal);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const cancel = () => reader.abort();
    const cleanup = () => options.signal?.removeEventListener('abort', cancel);
    reader.onload = () => { cleanup(); resolve(reader.result as string); };
    reader.onerror = () => { cleanup(); reject(reader.error ?? new Error('图像读取失败')); };
    reader.onabort = () => { cleanup(); reject(aborted()); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    reader.readAsDataURL(blob);
  });
}
