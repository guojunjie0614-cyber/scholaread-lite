import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const nativeFetch = globalThis.fetch;
let electronModule: any | null | undefined;
let nodeProxyInitialized = false;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isDirectHost(hostname: string): boolean {
  const clean = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(clean) || clean.endsWith('.localhost') || clean.endsWith('.local') || clean.endsWith('.invalid');
}

function getElectron(): any | null {
  if (electronModule !== undefined) return electronModule;
  if (!process.versions?.electron) {
    electronModule = null;
    return null;
  }
  try {
    const base = typeof __filename === 'string' ? pathToFileURL(__filename).href : import.meta.url;
    const req = createRequire(base);
    const modName = 'electron';
    electronModule = req(modName);
  } catch {
    electronModule = null;
  }
  return electronModule;
}

/** Parse `scutil --proxy` output into HTTP/HTTPS proxy URLs when enabled on macOS. */
export function parseScutilProxy(raw: string): { httpProxy?: string; httpsProxy?: string } {
  const field = (name: string) => raw.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'm'))?.[1]?.trim();
  const httpEnable = field('HTTPEnable') === '1';
  const httpHost = field('HTTPProxy');
  const httpPort = field('HTTPPort');
  const httpsEnable = field('HTTPSEnable') === '1';
  const httpsHost = field('HTTPSProxy');
  const httpsPort = field('HTTPSPort');
  const httpProxy = httpEnable && httpHost && httpPort ? `http://${httpHost}:${httpPort}` : undefined;
  const httpsProxy = httpsEnable && httpsHost && httpsPort ? `http://${httpsHost}:${httpsPort}` : httpProxy;
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
  };
}

function ensureNodeSystemProxy(): void {
  if (nodeProxyInitialized) return;
  nodeProxyInitialized = true;
  try {
    let httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
    let httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (!httpProxy && !httpsProxy && process.platform === 'darwin') {
      const raw = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500 });
      const parsed = parseScutilProxy(raw);
      httpProxy = parsed.httpProxy;
      httpsProxy = parsed.httpsProxy;
      if (httpProxy && !process.env.HTTP_PROXY && !process.env.http_proxy) {
        process.env.HTTP_PROXY = httpProxy;
      }
      if (httpsProxy && !process.env.HTTPS_PROXY && !process.env.https_proxy) {
        process.env.HTTPS_PROXY = httpsProxy;
      }
    }
    if (httpProxy || httpsProxy) {
      if (!process.env.NO_PROXY && !process.env.no_proxy) {
        process.env.NO_PROXY = 'localhost,127.0.0.1,::1,.local,.invalid';
      }
      const setGlobalProxyFromEnv = (http as unknown as { setGlobalProxyFromEnv?: (env?: NodeJS.ProcessEnv) => void }).setGlobalProxyFromEnv;
      setGlobalProxyFromEnv?.(process.env);
    }
  } catch {
    /* Fall back to direct connection when scutil or proxy setup is unavailable. */
  }
}

/**
 * Proxy-aware fetch for Electron main process and Node CLI/tests:
 * - Loopback/test hosts (`127.0.0.1`, `localhost`, `::1`, `.invalid`) always connect directly.
 * - Custom test `globalThis.fetch` stubs are respected without interference.
 * - In Electron (`app.isReady()`), uses `electron.net.fetch` to follow macOS `scutil --proxy` and PAC rules.
 * - In Node on macOS, falls back to `scutil --proxy` + `http.setGlobalProxyFromEnv`.
 */
export function appFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  if (globalThis.fetch !== nativeFetch) {
    return globalThis.fetch(input, init);
  }
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = input instanceof URL ? input : new URL(String(input));
  } catch {
    return globalThis.fetch(input, init);
  }
  if (isDirectHost(parsedUrl.hostname)) {
    return globalThis.fetch(input, init);
  }
  const electron = getElectron();
  if (electron?.app?.isReady?.() && typeof electron?.net?.fetch === 'function') {
    return electron.net.fetch(String(input), init);
  }
  ensureNodeSystemProxy();
  return globalThis.fetch(input, init);
}
