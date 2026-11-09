import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, blocks, notes, papers, progress, collections } from './db.js';
import { guessFromFileName, lookupMeta } from './metadata.js';
import { readPdfMetadata } from './pdf-metadata.js';
import { createMetadataBackfill } from './metadata-backfill.js';
import { resolvePaperFile, storePdf } from './paths.js';
import { settings } from './settings.js';
import { magpieModels, providerModels } from './magpie.js';
import { recognizeFormula } from './formula-ocr.js';
import { recognizeText } from './ocr.js';
import { registerTranslationIpc } from './translation-ipc.js';
import { refreshTranslationQueue } from './translate.js';
import { registerLibraryImportIpc } from './library-import-ipc.js';
import { registerChatIpc } from './chat/ipc.js';
import { stopChatAgents } from './chat/service.js';
import type {
  Block,
  Note,
  Paper,
  Progress,
  FormulaSource,
  LatexSource,
  ReadingStatus,
} from '../shared/types.js';

/** 从 Finder 拖进来的文件名可能是百分号编码的，先还原成可读文本 */
function decodeFileName(name: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(name)) return name;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

const assertPaper = (id: unknown): string => {
  if (typeof id !== 'string' || !papers.get(id)) throw new Error(`文献不存在：${String(id)}`);
  return id;
};

export function registerIpc() {
  registerChatIpc();
  registerLibraryImportIpc();
  ipcMain.handle('formula:recognize', (_e, dataUrl: string) =>
    recognizeFormula(dataUrl, { projectDir: app.getAppPath() }),
  );
  ipcMain.handle('ocr:recognize', (_e, dataUrl: string) =>
    recognizeText(dataUrl, {
      cacheDir: path.join(app.getPath('userData'), 'ocr-cache'),
      sourcePath: path.join(app.getAppPath(), 'scripts/native-ocr.swift'),
    }),
  );
  // ── 文献 ──────────────────────────────────────────────
  const inspectPdf = (filePath: string) => readPdfMetadata(filePath, app.getAppPath());
  const metadataBackfill = createMetadataBackfill({ db, store: papers, resolveFile: resolvePaperFile, inspect: inspectPdf,
    onChange: change => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.webContents.send('papers:metadata-changed', change);
    },
  });
  ipcMain.handle('papers:list', () => {
    void metadataBackfill.run().catch(error => console.warn('文献元数据补全失败：', error));
    return papers.list();
  });
  ipcMain.handle('papers:get', (_e, id: string) => papers.get(id));

  const importFromPath = async (source: string, collectionIds: string[] = []): Promise<Paper> => {
    if (
      !Array.isArray(collectionIds) ||
      collectionIds.some((id) => typeof id !== 'string' || !collections.get(id))
    )
      throw new Error('导入分类不存在');
    if (!/\.pdf$/i.test(source)) throw new Error('只支持 PDF 文件');
    const guess = guessFromFileName(decodeFileName(path.basename(source)));

    let pdfMeta = null as Awaited<ReturnType<typeof readPdfMetadata>> | null;
    try {
      pdfMeta = await inspectPdf(source);
    } catch (error) {
      console.warn('PDF 元数据读取失败：', error instanceof Error ? error.message : error);
    }

    let meta = null as Awaited<ReturnType<typeof lookupMeta>>;
    try {
      if (!pdfMeta?.title || !pdfMeta.year || !pdfMeta.authors?.length)
        meta = await lookupMeta({ doi: pdfMeta?.doi ?? guess.doi, arxivId: guess.arxivId });
    } catch {
      meta = null; // 元数据拿不到不影响导入
    }

    const id = randomUUID();
    const fileName = storePdf(source, id);
    try {
      return papers.create({
        collectionIds,
        title: pdfMeta?.title || meta?.title || guess.title,
        fileName,
        authors: pdfMeta?.authors?.length ? pdfMeta.authors : meta?.authors ?? [],
        year: pdfMeta?.year ?? meta?.year ?? null,
        doi: pdfMeta?.doi ?? meta?.doi ?? guess.doi ?? null,
        arxivId: meta?.arxivId ?? guess.arxivId ?? null,
        venue: pdfMeta?.venue ?? meta?.venue ?? null,
        abstract: meta?.abstract ?? null,
      });
    } catch (error) {
      const copied = resolvePaperFile(fileName);
      if (copied) fs.rmSync(copied);
      throw error;
    }
  };

  ipcMain.handle('papers:import', async (event, collectionIds?: string[]) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const picked = await dialog.showOpenDialog(win!, {
      title: '导入 PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return null;
    return importFromPath(picked.filePaths[0], collectionIds);
  });

  ipcMain.handle('papers:importPath', (_e, source: string, collectionIds?: string[]) => {
    if (typeof source !== 'string' || !source) throw new Error('路径无效');
    return importFromPath(source, collectionIds);
  });

  ipcMain.handle('papers:update', (_e, id: string, patch: Partial<Paper>) =>
    papers.update(assertPaper(id), patch),
  );

  ipcMain.handle('papers:remove', (_e, id: string) => {
    const paper = papers.get(assertPaper(id));
    stopChatAgents(id);
    if (paper) {
      const file = resolvePaperFile(paper.fileName);
      if (file) fs.rmSync(file, { force: true });
    }
    papers.remove(id);
  });

  ipcMain.handle('papers:opened', (_e, id: string) => papers.opened(assertPaper(id)));
  ipcMain.handle('papers:addTags', (_e, ids: string[], tags: string[]) => papers.addTags(ids, tags));
  ipcMain.handle('papers:setStatus', (_e, ids: string[], status: ReadingStatus) =>
    papers.setStatus(ids, status),
  );

  ipcMain.handle('collections:list', () => collections.list());
  ipcMain.handle('collections:create', (_e, name: string, parentId?: string | null) =>
    collections.create(name, parentId ?? null),
  );
  ipcMain.handle('collections:update', (_e, id: string, patch: { name: string; parentId: string | null }) =>
    collections.update(id, patch),
  );
  ipcMain.handle('collections:remove', (_e, id: string) => collections.remove(id));
  ipcMain.handle('collections:addPapers', (_e, paperIds: string[], collectionIds: string[]) =>
    collections.addPapers(paperIds, collectionIds),
  );
  ipcMain.handle('collections:removePapers', (_e, paperIds: string[], collectionId: string) =>
    collections.removePapers(paperIds, collectionId),
  );
  ipcMain.handle('collections:setForPaper', (_e, paperId: string, collectionIds: string[]) =>
    collections.setForPaper(paperId, collectionIds),
  );

  ipcMain.handle('meta:lookup', (_e, q: { doi?: string; arxivId?: string; title?: string }) => lookupMeta(q));

  // ── 重排块 ────────────────────────────────────────────
  ipcMain.handle('blocks:list', (_e, paperId: string) => blocks.list(assertPaper(paperId)));

  ipcMain.handle('blocks:save', (_e, paperId: string, list: Block[]) => {
    blocks.save(assertPaper(paperId), list);
  });

  ipcMain.handle(
    'blocks:setFormula',
    (
      _e,
      paperId: string,
      blockId: string,
      latex: string,
      verified: boolean,
      source: FormulaSource,
      origin?: LatexSource,
    ) => {
      if (typeof latex !== 'string' || latex.length > 16000 || typeof verified !== 'boolean')
        throw new Error('公式内容无效');
      if (origin !== undefined && !['pdf-structure', 'pix2tex', 'manual'].includes(origin))
        throw new Error('公式来源无效');
      return blocks.setFormula(assertPaper(paperId), blockId, latex, verified, source, origin);
    },
  );

  ipcMain.handle('blocks:clear', (_e, paperId: string) => {
    blocks.clear(assertPaper(paperId));
  });

  // ── 笔记 ──────────────────────────────────────────────
  ipcMain.handle('notes:list', (_e, paperId: string) => notes.list(assertPaper(paperId)));
  ipcMain.handle('notes:create', (_e, input: Partial<Note> & { paperId: string }) =>
    notes.create({ ...input, paperId: assertPaper(input.paperId) }),
  );
  ipcMain.handle('notes:update', (_e, id: string, patch: Partial<Note>) => notes.update(id, patch));
  ipcMain.handle('notes:remove', (_e, id: string) => notes.remove(id));

  ipcMain.handle('notes:exportMarkdown', async (event, paperId: string, targetPath?: string) => {
    const paper = papers.get(assertPaper(paperId))!;
    const list = notes.list(paperId);
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const safe = paper.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    let filePath = typeof targetPath === 'string' && targetPath ? targetPath : '';
    if (!filePath) {
      const picked = await dialog.showSaveDialog(win!, {
        title: '导出笔记',
        defaultPath: `${safe}-notes.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (picked.canceled || !picked.filePath) return null;
      filePath = picked.filePath;
    }

    const lines: string[] = [
      `# ${paper.title}`,
      '',
      paper.authors.length ? `**作者**：${paper.authors.join(', ')}` : '',
      paper.year ? `**年份**：${paper.year}` : '',
      paper.doi ? `**DOI**：${paper.doi}` : '',
      paper.venue ? `**来源**：${paper.venue}` : '',
      '',
      `共 ${list.length} 条笔记，导出于 ${new Date().toLocaleString('zh-CN')}`,
      '',
      '---',
      '',
    ].filter(Boolean);

    for (const n of list) {
      if (n.quote) lines.push(`> ${n.quote.replace(/\n/g, '\n> ')}`, '');
      if (n.body.trim()) lines.push(n.body.trim(), '');
      const where = [n.page != null ? `p.${n.page}` : null, n.kind === 'highlight' ? '高亮' : '笔记']
        .filter(Boolean)
        .join(' · ');
      lines.push(`<sub>${where} · ${n.createdAt.slice(0, 10)}</sub>`, '', '---', '');
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    return filePath;
  });

  // ── 阅读进度 ──────────────────────────────────────────
  ipcMain.handle('progress:get', (_e, paperId: string) => progress.get(assertPaper(paperId)));
  ipcMain.handle('progress:set', (_e, paperId: string, p: Progress) => {
    progress.set(assertPaper(paperId), p);
  });

  // ── 设置 ──────────────────────────────────────────────
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const saved = settings.set(patch);
    refreshTranslationQueue();
    nativeTheme.themeSource = saved.theme === 'auto' ? 'system' : saved.theme;
    return saved;
  });
  ipcMain.handle('settings:providers', () => settings.providers());
  ipcMain.handle('settings:magpieModels', (_e, baseUrl: string) => {
    if (typeof baseUrl !== 'string') throw new Error('Magpie 网关地址必须是文本');
    return magpieModels(baseUrl);
  });
  ipcMain.handle('settings:providerModels', (_e, provider: string, config: { baseUrl?: string; apiKey?: string }) => {
    if (typeof provider !== 'string' || !provider) throw new Error('服务提供方无效');
    return providerModels(provider, config ?? {});
  });

  // ── 翻译 ──────────────────────────────────────────────
  registerTranslationIpc(ipcMain);

  // ── 杂项 ──────────────────────────────────────────────
  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http(s) 链接');
    await shell.openExternal(url);
  });

  ipcMain.handle('app:reveal', (_e, paperId: string) => {
    const paper = papers.get(assertPaper(paperId));
    const file = paper ? resolvePaperFile(paper.fileName) : null;
    if (file) shell.showItemInFolder(file);
  });

  ipcMain.handle('app:platform', () => process.platform);
}
