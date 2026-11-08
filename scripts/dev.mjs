import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import process from 'node:process';

const VITE_PORT = 5273;
const devUrl = `http://localhost:${VITE_PORT}`;

const vite = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], {
  stdio: 'inherit',
  env: { ...process.env, FORCE_COLOR: '1' },
});

function waitForPort(port, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error('vite 启动超时'));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

let electron;

async function main() {
  await waitForPort(VITE_PORT);
  const childEnv = { ...process.env, VITE_DEV_SERVER_URL: devUrl, NODE_ENV: 'development' };
  // 某些环境（含沙箱/CI）会预设 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成纯 Node，
  // 必须剔除，否则主进程拿不到 app/BrowserWindow。
  delete childEnv.ELECTRON_RUN_AS_NODE;

  electron = spawn('npx', ['electron', '.'], { stdio: 'inherit', env: childEnv });
  electron.on('exit', () => {
    vite.kill('SIGTERM');
    process.exit(0);
  });
}

const shutdown = () => {
  electron?.kill('SIGTERM');
  vite.kill('SIGTERM');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error(err);
  shutdown();
});
