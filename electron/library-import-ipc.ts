import { BrowserWindow, dialog, ipcMain } from 'electron';
import { discoverLibraries, importDiscoveredLibraries, importLibrary } from './library-import.js';
import type { LibraryImportSource } from '../shared/types.js';

const assertSource = (source: unknown): LibraryImportSource => {
  if (source !== 'zotero' && source !== 'folder') throw new Error('不支持的文献库来源');
  return source;
};

export function registerLibraryImportIpc(services = { discoverLibraries, importDiscoveredLibraries, importLibrary }) {
  let running: { senderId: number; controller: AbortController } | undefined;
  ipcMain.handle('libraryImport:discover', () => services.discoverLibraries());
  ipcMain.handle('libraryImport:choose', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: '选择文献库或 PDF 文件夹',
      properties: ['openDirectory'],
    };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return picked.canceled ? null : picked.filePaths[0] ?? null;
  });
  const run = async (event: Electron.IpcMainInvokeEvent, operation: (options: Parameters<typeof importLibrary>[2]) => ReturnType<typeof importLibrary>) => {
    if (running) throw new Error('已有文献库正在导入，请等待完成或先停止');
    const controller = new AbortController();
    running = { senderId: event.sender.id, controller };
    const abort = () => controller.abort();
    const navigate = (_event: unknown, _url: string, _inPlace: boolean, main: boolean) => { if (main) abort(); };
    event.sender.once('destroyed', abort);
    event.sender.once('render-process-gone', abort);
    event.sender.on('did-start-navigation', navigate);
    try {
      return await operation({
        signal: controller.signal,
        onProgress: value => { if (!event.sender.isDestroyed()) event.sender.send('libraryImport:progress', value); },
      });
    } finally {
      event.sender.removeListener('destroyed', abort);
      event.sender.removeListener('render-process-gone', abort);
      event.sender.removeListener('did-start-navigation', navigate);
      running = undefined;
    }
  };
  ipcMain.handle('libraryImport:auto', event => run(event, options => services.importDiscoveredLibraries(options)));
  ipcMain.handle('libraryImport:start', async (event, input: unknown, inputPath: unknown) => {
    const source = assertSource(input);
    if (typeof inputPath !== 'string' || !inputPath.trim()) throw new Error('请选择文献库目录');
    return run(event, options => services.importLibrary(source, inputPath, options));
  });
  ipcMain.handle('libraryImport:cancel', event => {
    if (running?.senderId === event.sender.id) running.controller.abort();
  });
}
