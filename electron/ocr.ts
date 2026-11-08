import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_PNG_BYTES = 24 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;

export interface OcrTextBox {
  text: string;
  /** Vision's line-candidate confidence; words inherit their line's confidence. */
  confidence: number;
  /** Normalized image coordinates, origin at the top left. */
  bbox: [number, number, number, number];
}

export interface OcrResult {
  engine: 'apple-vision';
  width: number;
  height: number;
  lines: Array<OcrTextBox & { words: OcrTextBox[] }>;
}

export interface OcrOptions {
  /** An application-owned cache directory, never a path supplied by the renderer. */
  cacheDir: string;
  /** Absolute path to the bundled scripts/native-ocr.swift source. */
  sourcePath: string;
}

export async function getOcrAvailability(): Promise<{ available: boolean; reason?: string }> {
  if (process.platform !== 'darwin') {
    return { available: false, reason: '本地文字 OCR 目前需要 macOS。' };
  }
  try {
    await run('/usr/bin/xcrun', ['--find', 'swiftc'], { timeout: 10_000, maxBuffer: 32_768 });
    return { available: true };
  } catch {
    return { available: false, reason: '本地 OCR 首次运行需要 Apple Command Line Tools 中的 Swift 编译器。' };
  }
}

function decodePng(dataUrl: string): Buffer {
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
    throw new Error('OCR 输入必须是 PNG 图片。');
  }
  const encoded = dataUrl.slice(prefix.length);
  if (!encoded.length || encoded.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('OCR 图片编码无效或超过 24 MB。');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('OCR 图片不是有效的 PNG。');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width * height > MAX_PIXELS || width > 16_384 || height > 16_384) {
    throw new Error('OCR 图片尺寸无效或超过 2400 万像素，请降低渲染分辨率。');
  }
  return bytes;
}

async function ensureHelper(options: OcrOptions): Promise<string> {
  const directory = path.join(options.cacheDir, `vision-${process.arch}`);
  const executable = path.join(directory, 'native-ocr');
  const sourceFile = path.join(directory, 'native-ocr.swift');
  const source = await fs.readFile(options.sourcePath, 'utf8');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    if (await fs.readFile(sourceFile, 'utf8') === source) {
      await fs.access(executable, fs.constants.X_OK);
      return executable;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const availability = await getOcrAvailability();
  if (!availability.available) throw new Error(availability.reason);
  // Compile from a private temporary directory: packaged source may live inside app.asar.
  const buildDir = await fs.mkdtemp(path.join(directory, 'build-'));
  try {
    const buildSource = path.join(buildDir, 'native-ocr.swift');
    const buildExecutable = path.join(buildDir, 'native-ocr');
    await fs.writeFile(buildSource, source, { mode: 0o600 });
    await run('/usr/bin/xcrun', ['swiftc', '-O', buildSource, '-o', buildExecutable], {
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    });
    await fs.rename(buildExecutable, executable);
    await fs.writeFile(sourceFile, source, { mode: 0o600 });
  } catch (error) {
    throw new Error(`本地 OCR 编译失败：${processError(error)}`);
  } finally {
    await fs.rm(buildDir, { recursive: true, force: true });
  }
  return executable;
}

function processError(error: unknown): string {
  const detail = error as Error & { stderr?: string; killed?: boolean };
  if (detail.killed) return '处理超时，请降低图片分辨率后重试。';
  return detail.stderr?.trim() || detail.message || String(error);
}

// A single Vision job at a time bounds memory when several scanned pages are queued.
let queue: Promise<unknown> = Promise.resolve();

export async function recognizeText(dataUrl: string, options: OcrOptions): Promise<OcrResult> {
  if (process.platform !== 'darwin') throw new Error('本地文字 OCR 目前需要 macOS。');
  const bytes = decodePng(dataUrl);
  const task = queue.then(async () => {
    const executable = await ensureHelper(options);
    const directory = await fs.mkdtemp(path.join(options.cacheDir, 'ocr-page-'));
    try {
      const imagePath = path.join(directory, 'page.png');
      await fs.writeFile(imagePath, bytes, { mode: 0o600 });
      const { stdout } = await run(executable, [imagePath], {
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      });
      return JSON.parse(stdout) as OcrResult;
    } catch (error) {
      throw new Error(`本地 OCR 识别失败：${processError(error)}`);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  queue = task.catch(() => {});
  return task;
}
