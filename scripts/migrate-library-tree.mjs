/** Preview by default. Apply only while ScholarLite is closed; an independent SQLite backup is saved first. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const project = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const profileIndex = args.indexOf('--profile');
if (profileIndex < 0 || !args[profileIndex + 1]) throw new Error('Usage: node scripts/migrate-library-tree.mjs --profile /absolute/profile [--apply]');
const profile = path.resolve(args[profileIndex + 1]), apply = args.includes('--apply');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-tree-migration-'));
let module;
try {
  const original = path.join(profile, 'library.db');
  const target = apply ? profile : path.join(work, 'profile');
  await fs.mkdir(target, { recursive: true });
  const backupFile = apply ? path.join(profile, `library-before-tree-${Date.now()}.db`) : path.join(target, 'library.db');
  const readonly = new DatabaseSync(original, { readOnly: true });
  try { await backup(readonly, backupFile); } finally { readonly.close(); }
  const outfile = path.join(work, 'migration.mjs');
  await build({ stdin: { contents: "export {db} from './electron/db.ts'; export {migrateLegacyImportCollections} from './electron/library-import-migration.ts';", resolveDir: project },
    bundle: true, platform: 'node', format: 'esm', outfile, plugins: [{ name: 'profile', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'profile' }));
      builder.onLoad({ filter: /.*/, namespace: 'profile' }, () => ({ loader: 'js',
        contents: `export const app={getPath:()=>${JSON.stringify(target)},getAppPath:()=>${JSON.stringify(project)}};` }));
    } }] });
  module = await import(pathToFileURL(outfile));
  const tables = ['papers', 'notes', 'blocks', 'progress', 'chat_conversations', 'chat_messages'];
  const snapshot = () => Object.fromEntries(tables.filter(table => module.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
    .map(table => [table, module.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const before = snapshot();
  const result = await module.migrateLegacyImportCollections({ dryRun: !apply });
  const unchanged = JSON.stringify(before) === JSON.stringify(snapshot());
  if (!unchanged) throw new Error('迁移改变了文献或阅读数据，请从备份恢复');
  console.log(JSON.stringify({ ...result, preserved: Object.fromEntries(Object.entries(before).map(([table, rows]) => [table, rows.length])),
    recordsUnchanged: unchanged, ...(apply ? { backup: backupFile } : {}) }, null, 2));
} finally { module?.db.close(); await fs.rm(work, { recursive: true, force: true }); }
