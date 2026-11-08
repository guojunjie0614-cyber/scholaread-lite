type ProxyResolver = (url: string) => Promise<string>;
const explicitProxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

async function resolveNativeProxy(url: string): Promise<string> {
  // Node-based protocol fixtures have no Chromium session; the desktop host resolves OS settings.
  if (!process.versions.electron) return 'DIRECT';
  const { session } = await import('electron');
  return session.defaultSession.resolveProxy(url);
}

function proxyUrl(result: string): string | undefined {
  const first = result.split(';')[0].trim();
  if (first === 'DIRECT') return undefined;
  const match = /^(PROXY|HTTPS|SOCKS5)\s+(\S+)$/i.exec(first);
  if (!match) throw new Error('系统代理类型暂不支持，请为本机 CLI 指定 HTTP_PROXY 或 HTTPS_PROXY');
  const scheme = match[1].toUpperCase();
  return `${scheme === 'HTTPS' ? 'https' : scheme.startsWith('SOCKS') ? 'socks5' : 'http'}://${match[2]}`;
}

/** Go's HTTP transport reads proxy environment variables, rather than macOS proxy preferences. */
export async function agyEnvironment(resolveProxy: ProxyResolver = resolveNativeProxy, inherited: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const env = { ...inherited };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDECODE;
  // An explicit value (including an empty one) belongs to the user's CLI setup.
  if (explicitProxyKeys.some(key => Object.hasOwn(env, key))) return env;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      Promise.all(['http', 'https'].map(scheme => resolveProxy(`${scheme}://cloudcode-pa.googleapis.com`))),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('读取系统代理超时，请检查本机网络设置后重试')), 2000); }),
    ]);
    const http = proxyUrl(results[0]), https = proxyUrl(results[1]);
    if (http) env.HTTP_PROXY = http;
    if (https) env.HTTPS_PROXY = https;
    return env;
  } finally { if (timer) clearTimeout(timer); }
}
