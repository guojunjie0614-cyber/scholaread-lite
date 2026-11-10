import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

app.setName('ScholarLite');
app.setPath('userData', path.join(app.getPath('appData'), 'ScholarLite'));

const root = () => app.getPath('userData');

export const paths = {
  root,
  library: () => path.join(root(), 'library'),
  config: () => path.join(root(), 'config.json'),
  db: () => path.join(root(), 'library.db'),
  ensure() {
    for (const dir of [paths.library()]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  },
};

/** 把导入的 PDF 复制进书库目录，返回安全文件名 */
export function storePdf(sourcePath: string, paperId: string): string {
  const ext = path.extname(sourcePath).toLowerCase() || '.pdf';
  const fileName = `${paperId}${ext}`;
  const dest = path.join(paths.library(), fileName);
  fs.copyFileSync(sourcePath, dest);
  return fileName;
}

export function resolvePaperFile(fileName: string): string | null {
  const base = path.resolve(paths.library());
  const full = path.resolve(base, fileName);
  if (!full.startsWith(base + path.sep)) return null;
  return fs.existsSync(full) ? full : null;
}
