import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  protocol,
  session,
  shell,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { stopFormulaOcr } from './formula-ocr.js';
import { stopChatAgents } from './chat/service.js';
import { papers } from './db.js';
import { registerIpc } from './ipc.js';
import { resolvePaperFile } from './paths.js';
import { settings } from './settings.js';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const appIcon = path.join(app.getAppPath(), 'assets/app-icon.png');
app.setName('ScholarLite');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'slite',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

let mainWindow: BrowserWindow | null = null;

function windowAppearance() {
  return { platform: process.platform, nativeVibrancy: process.platform === 'darwin',
    reducedTransparency: nativeTheme.prefersReducedTransparency || nativeTheme.shouldUseHighContrastColors };
}

ipcMain.handle('app:appearance', windowAppearance);
nativeTheme.on('updated', () => {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (process.platform === 'darwin') window.setVibrancy(windowAppearance().reducedTransparency ? null : 'menu');
  window.webContents.send('app:appearance-changed', windowAppearance());
});

function servePaper(request: Request): Response {
  const url = new URL(request.url);
  const id = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const paper = papers.get(id);
  if (!paper) return new Response('not found', { status: 404 });
  const file = resolvePaperFile(paper.fileName);
  if (!file) return new Response('file missing', { status: 404 });

  const stat = fs.statSync(file);
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(stat.size),
      'cache-control': 'no-store',
    },
  });
}

function hardenSession() {
  const ses = session.defaultSession;

  if (isDev) {
    // Vite 的 HMR 客户端与 React Refresh 需要内联脚本和 ws 连接
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self' 'unsafe-inline' data: blob: slite:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ws://localhost:5273 http://localhost:5273 slite: data: blob:; worker-src 'self' blob:; img-src 'self' data: blob: slite:",
          ],
        },
      });
    });
  }

  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about', label: '关于 ScholarLite' },
              { type: 'separator' },
              { role: 'hide', label: '隐藏' },
              { role: 'hideOthers', label: '隐藏其它' },
              { type: 'separator' },
              { role: 'quit', label: '退出' },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        ...(isDev ? ([{ role: 'toggleDevTools', label: '开发者工具' }] as Electron.MenuItemConstructorOptions[]) : []),
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    { role: 'windowMenu', label: '窗口' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'ScholarLite',
    icon: appIcon,
    width: 1480,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#f6f6f4',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    ...(process.platform === 'darwin' ? { vibrancy: windowAppearance().reducedTransparency ? undefined : 'menu' as const, visualEffectState: 'active' as const } : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.webContents.on('console-message', (...args: any[]) => {
    const details = args[1];
    if (details && typeof details === 'object' && 'message' in details) {
      console.log(`[renderer:${details.level}] ${details.message}`);
    } else {
      console.log(`[renderer] ${args[2]}`);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[renderer] did-fail-load ${code} ${desc}`);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(process.env.VITE_DEV_SERVER_URL!) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  if (isDev) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.on('before-quit', stopFormulaOcr);
app.on('before-quit', () => stopChatAgents());

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // Use the bundle icon on macOS so the system applies its native icon mask.
    // dock.setIcon(PNG) bypasses that presentation and exposes square corners.
    nativeTheme.themeSource = settings.get().theme === 'auto' ? 'system' : settings.get().theme as 'light' | 'dark';
    app.setAboutPanelOptions({
      applicationName: 'ScholarLite',
      applicationVersion: app.getVersion(),
      ...(process.platform === 'darwin' ? {} : { iconPath: appIcon }),
      credits: '开源论文阅读器 · 重排 / 翻译 / 笔记',
    });

    hardenSession();
    protocol.handle('slite', servePaper);
    registerIpc();
    buildMenu();
    await createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

process.on('uncaughtException', (err) => {
  console.error('[main] uncaught', err);
  dialog.showErrorBox('ScholarLite 出错', String(err?.stack ?? err));
});
