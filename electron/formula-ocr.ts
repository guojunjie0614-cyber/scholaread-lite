import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

export interface FormulaOcrOptions {
  /** Trusted application root, never a renderer-supplied executable or directory. */
  projectDir: string;
}

export interface FormulaOcrResult {
  latex: string;
  engine: 'pix2tex';
}

type Pending = {
  id: number;
  resolve: (result: FormulaOcrResult) => void;
  reject: (error: Error) => void;
};
type Worker = {
  process: ChildProcessWithoutNullStreams;
  projectDir: string;
  pending: Pending | null;
  ready: Promise<void>;
  diagnostics: string;
  cancelLoading: (error: Error) => void;
};

let worker: Worker | null = null;
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;
let generation = 0;
const MAX_BYTES = 12 * 1024 * 1024;

function locations(options: FormulaOcrOptions) {
  return {
    python: path.join(options.projectDir, '.venv-formula-ocr', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    script: path.join(options.projectDir, 'scripts/formula-ocr.py'),
    models: path.join(options.projectDir, '.models/formula-ocr'),
  };
}

export async function getFormulaOcrAvailability(options: FormulaOcrOptions): Promise<{ available: boolean; reason?: string }> {
  const files = locations(options);
  try {
    await fs.access(files.python, fs.constants.X_OK);
    await fs.access(files.script, fs.constants.R_OK);
    for (const name of ['weights.pth', 'image_resizer.pth']) {
      if ((await fs.stat(path.join(files.models, name))).size < 1_000_000) throw new Error('Incomplete model');
    }
    return { available: true };
  } catch {
    return { available: false, reason: '本地公式模型尚未安装，请运行 sh scripts/setup-formula-ocr.sh。' };
  }
}

function pngPayload(dataUrl: string): string {
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) throw new Error('公式识别需要 PNG 图片。');
  const encoded = dataUrl.slice(prefix.length);
  if (!encoded.length || encoded.length > Math.ceil(MAX_BYTES / 3) * 4 ||
      encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('公式图片编码无效或超过 12 MB。');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('公式图片不是有效的 PNG。');
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > 12_000_000 || width > 16384 || height > 16384) {
    throw new Error('公式图片尺寸无效或超过 1200 万像素。');
  }
  return encoded;
}

function terminate(target: Worker, error: Error) {
  if (worker === target) worker = null;
  target.cancelLoading(error);
  target.pending?.reject(error);
  target.pending = null;
  target.process.kill('SIGKILL');
}

async function getWorker(options: FormulaOcrOptions): Promise<Worker> {
  if (worker?.projectDir === options.projectDir) {
    await worker.ready;
    return worker;
  }
  if (worker) terminate(worker, new Error('公式识别环境已切换。'));
  const status = await getFormulaOcrAvailability(options);
  if (!status.available) throw new Error(status.reason);
  const files = locations(options);
  const child = spawn(files.python, ['-u', files.script], {
    cwd: options.projectDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1', TOKENIZERS_PARALLELISM: 'false', HF_HUB_OFFLINE: '1' },
  });
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const current: Worker = {
    process: child, projectDir: options.projectDir, pending: null, ready, diagnostics: '',
    cancelLoading: (error) => { clearTimeout(startTimer); readyReject(error); },
  };
  worker = current;
  const startTimer = setTimeout(() => {
    const error = new Error('公式模型加载超过 120 秒，请重试。');
    readyReject(error);
    terminate(current, error);
  }, 120_000);
  const fail = (error: Error) => {
    clearTimeout(startTimer);
    readyReject(error);
    terminate(current, error);
  };
  child.stderr.on('data', (chunk: Buffer) => {
    current.diagnostics = (current.diagnostics + chunk.toString()).slice(-4000);
  });
  child.on('error', (error) => fail(new Error(`无法启动公式识别：${error.message}`)));
  child.on('exit', (code, signal) => {
    const detail = current.diagnostics.trim().split('\n').slice(-3).join(' ').slice(0, 500);
    fail(new Error(`公式识别进程退出（${code ?? signal}）${detail ? `：${detail}` : ''}`));
  });
  child.stdin.on('error', (error) => fail(new Error(`公式请求发送失败：${error.message}`)));
  const lines = createInterface({ input: child.stdout });
  child.on('close', () => lines.close());
  lines.on('line', (line) => {
    try {
      const result = JSON.parse(line);
      if (result.ready === true) {
        clearTimeout(startTimer);
        readyResolve();
        return;
      }
      const pending = current.pending;
      if (!pending || result.id !== pending.id) throw new Error('公式识别响应与请求不匹配');
      current.pending = null;
      if (typeof result.error === 'string') pending.reject(new Error(result.error));
      else if (typeof result.latex === 'string' && result.latex.trim() && result.latex.length <= 40_000) {
        pending.resolve({ latex: result.latex, engine: 'pix2tex' });
      } else pending.reject(new Error('公式模型没有返回有效的 LaTeX。'));
    } catch (error) {
      fail(new Error(`公式识别通信失败：${error instanceof Error ? error.message : String(error)}`));
    }
  });
  await ready;
  return current;
}

/** Requests share one model process and execute serially to bound memory usage. */
export function recognizeFormula(dataUrl: string, options: FormulaOcrOptions): Promise<FormulaOcrResult> {
  let png: string;
  try { png = pngPayload(dataUrl); } catch (error) { return Promise.reject(error); }
  const requestedGeneration = generation;
  const task = queue.then(async () => {
    if (requestedGeneration !== generation) throw new Error('公式识别已取消。');
    const current = await getWorker(options);
    if (requestedGeneration !== generation) {
      terminate(current, new Error('公式识别已取消。'));
      throw new Error('公式识别已取消。');
    }
    return new Promise<FormulaOcrResult>((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => terminate(current, new Error('公式识别超过 120 秒，请缩小区域或重试。')), 120_000);
      current.pending = {
        id,
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      current.process.stdin.write(JSON.stringify({ id, png }) + '\n');
    });
  });
  queue = task.catch(() => {});
  return task;
}

export function stopFormulaOcr(): void {
  generation++;
  if (worker) terminate(worker, new Error('公式识别已停止。'));
}
