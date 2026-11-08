import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface JsonProcess {
  child: ChildProcessWithoutNullStreams;
  send(value: unknown): void;
  close(): void;
  done: Promise<void>;
  stderr(): string;
}

export function jsonProcess(executable: string, args: string[], cwd: string, onMessage: (message: any) => void, environment: NodeJS.ProcessEnv = process.env): JsonProcess {
  const env = { ...environment };
  // An Electron-launched app must not accidentally turn a child Electron wrapper into Node.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDECODE;
  const child = spawn(executable, args, { cwd, env, stdio: 'pipe', windowsHide: true });
  let stderr = '';
  let parsingError: Error | undefined;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-6000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (!line.trim()) return;
    try { onMessage(JSON.parse(line)); }
    catch (error) { parsingError = error instanceof Error ? error : new Error(String(error)); child.kill('SIGTERM'); }
  });
  // A closed stdin is reported through done rather than becoming an uncaught app error.
  child.stdin.on('error', () => {});
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      lines.close();
      if (parsingError) reject(parsingError);
      else if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Agent 进程退出（${signal ?? code}）`));
    });
  });
  return {
    child, done, stderr: () => stderr,
    send(value) { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`); },
    close() { child.stdin.end(); terminateChild(child, 'SIGTERM'); },
  };
}

export function abortError(): Error { return new Error('回答已停止'); }

/** Terminal cleanup is bounded and only affects the child owned by this turn. */
export function terminateChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = 'SIGINT') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}
