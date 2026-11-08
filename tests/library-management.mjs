/** Exercise the real IPC handlers against a temporary library, never the user's data. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-library-'));
const library = path.join(temporary, 'library');
const source = path.join(temporary, 'Original paper.pdf');
let database;
globalThis.libraryHandlers = new Map();
try {
  await fs.mkdir(library);
  await fs.writeFile(source, '%PDF-1.4\n% local test fixture');
  const stubs = {
    electron: `export const ipcMain = {handle: (name, handler) => globalThis.libraryHandlers.set(name, handler)};
      export const app = {getPath: () => ${JSON.stringify(temporary)}, getAppPath: () => ${JSON.stringify(root)}};
      export const BrowserWindow = {fromWebContents: () => null,getAllWindows:()=>[]}; export const dialog = {}; export const nativeTheme = {};
      export const shell = {showItemInFolder: file => {globalThis.revealedFile = file;}};`,
    './paths.js': `import fs from 'node:fs'; import path from 'node:path';
      export const paths = {ensure() {}, db: () => ${JSON.stringify(path.join(temporary, 'library.db'))}};
      export const storePdf = (source,id) => {const name=id+'.pdf';fs.copyFileSync(source,path.join(${JSON.stringify(library)},name));return name;};
      export const resolvePaperFile = name => {const file=path.join(${JSON.stringify(library)},name);return fs.existsSync(file)?file:null;};`,
    './metadata.js': `export const guessFromFileName = () => ({title:'Original paper'}); export const lookupMeta = async () => null;`,
    './settings.js': 'export const settings = {};',
    './chat/ipc.js': 'export const registerChatIpc=()=>{};',
    './chat/service.js': 'export const stopChatAgents=()=>{};',
    './library-import-ipc.js': 'export const registerLibraryImportIpc=()=>{};',
    './formula-ocr.js': 'export const recognizeFormula = () => {};',
    './ocr.js': 'export const recognizeText = () => {};',
    './translate.js': 'export const translateBatch = () => {}; export const refreshTranslationQueue=()=>{}; export const readCachedTranslations=()=>[]; export class TranslationBatchFailure extends Error {}',
  };
  await build({
    stdin: {
      contents:
        "export { registerIpc } from './electron/ipc.ts'; export { db, papers, blocks, notes, progress } from './electron/db.ts';",
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: path.join(temporary, 'test.mjs'),
    plugins: [
      {
        name: 'isolated-library',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) =>
            args.path in stubs ? { path: args.path, namespace: 'test' } : undefined,
          );
          builder.onLoad({ filter: /.*/, namespace: 'test' }, (args) => ({
            contents: stubs[args.path],
            loader: 'js',
          }));
        },
      },
    ],
  });
  const { registerIpc, db, papers, blocks, notes, progress } = await import(
    pathToFileURL(path.join(temporary, 'test.mjs'))
  );
  database = db;
  registerIpc();
  const invoke = (name, ...args) => globalThis.libraryHandlers.get(name)({}, ...args);
  const paper = await invoke('papers:importPath', source);
  const copied = path.join(library, paper.fileName);
  assert.equal(await fs.readFile(copied, 'utf8'), await fs.readFile(source, 'utf8'));
  const updated = invoke('papers:update', paper.id, {
    title: 'Renamed paper',
    authors: ['A. Author', 'B. Author'],
    year: 2025,
    venue: 'ISSCC',
    tags: ['CIM', '待读'],
  });
  assert.equal(updated.title, 'Renamed paper');
  assert.deepEqual(updated.tags, ['CIM', '待读']);
  assert.deepEqual(papers.get(paper.id).authors, ['A. Author', 'B. Author']);
  blocks.save(paper.id, [
    { id: 'sample-block', paperId: paper.id, page: 1, ord: 0, kind: 'p', text: 'Sample paragraph' },
  ]);
  notes.create({
    paperId: paper.id,
    blockId: 'sample-block',
    body: 'Keep until deletion',
    quote: 'Sample paragraph',
    page: 1,
  });
  progress.set(paper.id, { page: 1, scroll: 20, mode: 'reflow' });
  invoke('app:reveal', paper.id);
  assert.equal(globalThis.revealedFile, copied);
  const exported = path.join(temporary, 'notes.md');
  await invoke('notes:exportMarkdown', paper.id, exported);
  assert.match(await fs.readFile(exported, 'utf8'), /Keep until deletion/);
  invoke('papers:remove', paper.id);
  assert.equal(papers.get(paper.id), null);
  assert.equal(notes.list(paper.id).length, 0);
  assert.equal(blocks.list(paper.id).length, 0);
  assert.equal(progress.get(paper.id), null);
  await assert.rejects(fs.access(copied));
  assert.match(await fs.readFile(source, 'utf8'), /%PDF-1.4/);
  assert.throws(() => invoke('papers:remove', paper.id), /文献不存在/);
  // Real IPC collection operations preserve a single shared paper record.
  const a = await invoke('papers:importPath', source);
  const b = await invoke('papers:importPath', source);
  const parent = invoke('collections:create', 'Circuits');
  const child = invoke('collections:create', 'SRAM', parent.id);
  const other = invoke('collections:create', 'GNSS');
  assert.throws(() => invoke('collections:create', 'sram', parent.id), /同名/);
  const grandchild = invoke('collections:create', 'Digital', child.id);
  const leaf = invoke('collections:create', 'Low power', grandchild.id);
  assert.throws(
    () => invoke('collections:update', parent.id, { name: 'Circuits', parentId: child.id }),
    /自身或其子分类/,
  );
  invoke('collections:update', child.id, { name: 'Digital SRAM', parentId: parent.id });
  invoke('collections:addPapers', [a.id, b.id], [child.id, other.id]);
  assert.deepEqual(new Set(papers.get(a.id).collectionIds), new Set([child.id, other.id]));
  assert.equal(papers.get(a.id).fileName, a.fileName);
  const c = await invoke('papers:importPath', source, [parent.id]);
  assert.deepEqual(c.collectionIds, [parent.id]);
  await assert.rejects(invoke('papers:importPath', source, ['missing']), /分类不存在/);
  invoke('collections:removePapers', [a.id], child.id);
  assert.deepEqual(papers.get(a.id).collectionIds, [other.id]);
  assert.throws(() => invoke('collections:addPapers', [a.id, 'missing'], [parent.id]), /不存在/);
  assert.deepEqual(papers.get(a.id).collectionIds, [other.id]);
  assert.throws(() => invoke('collections:setForPaper', a.id, ['missing']), /分类不存在/);
  assert.deepEqual(papers.get(a.id).collectionIds, [other.id]);
  db.exec(`CREATE TEMP TRIGGER reject_second_collection BEFORE INSERT ON paper_collections
    WHEN NEW.paper_id = '${b.id}' AND NEW.collection_id = '${parent.id}'
    BEGIN SELECT RAISE(ABORT, 'test collection write failure'); END;`);
  assert.throws(
    () => invoke('collections:addPapers', [a.id, b.id], [parent.id]),
    /test collection write failure/,
  );
  assert.deepEqual(
    papers.get(a.id).collectionIds,
    [other.id],
    'a failure during the second write rolls back the first',
  );
  db.exec('DROP TRIGGER reject_second_collection');
  invoke('collections:addPapers', [a.id], [child.id, parent.id]);
  invoke('collections:addPapers', [a.id], [grandchild.id, leaf.id]);
  invoke('collections:removePapers', [a.id], parent.id);
  assert.deepEqual(
    papers.get(a.id).collectionIds,
    [other.id],
    'removing a parent scope includes descendants but retains unrelated classification',
  );
  invoke('collections:setForPaper', a.id, [child.id]);
  assert.deepEqual(papers.get(a.id).collectionIds, [child.id]);
  const keep = notes.create({ paperId: a.id, body: 'Keep note after collection removal' });
  invoke('collections:remove', parent.id);
  assert.equal(
    invoke('collections:list').some((item) => item.id === child.id),
    false,
  );
  assert.equal(invoke('collections:list').some(item => item.id === grandchild.id || item.id === leaf.id), false);
  assert.deepEqual(papers.get(a.id).collectionIds, []);
  assert.equal(notes.list(a.id)[0].id, keep.id);
  await fs.access(path.join(library, a.fileName));
  assert.deepEqual(papers.get(b.id).collectionIds, [other.id]);
  invoke('papers:addTags', [a.id, b.id], ['SRAM', '待读']);
  assert.deepEqual(papers.get(a.id).tags, ['SRAM', '待读']);
  assert.throws(() => invoke('papers:addTags', [a.id, 'missing'], ['must-not-save']), /不存在/);
  assert.deepEqual(papers.get(a.id).tags, ['SRAM', '待读']);
  invoke('papers:setStatus', [a.id, b.id], 'read');
  assert.equal(papers.get(a.id).readingStatus, 'read');
  assert.throws(() => invoke('papers:setStatus', [a.id], 'invalid'), /无效/);
  assert.equal(papers.get(c.id).lastReadAt, null);
  invoke('progress:set', c.id, { page: 1, scroll: 0, mode: 'reflow' });
  assert.equal(papers.get(c.id).lastReadAt, null, 'saving progress is not an open event');
  invoke('papers:opened', c.id);
  assert.equal(papers.get(c.id).readingStatus, 'reading');
  assert.ok(papers.get(c.id).lastReadAt);
  invoke('papers:opened', a.id);
  assert.equal(papers.get(a.id).readingStatus, 'read', 'reopening preserves explicit read status');
  await build({
    entryPoints: [path.join(root, 'renderer/src/lib/library.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: path.join(temporary, 'library-view.mjs'),
  });
  const { recentPapers } = await import(pathToFileURL(path.join(temporary, 'library-view.mjs')));
  const opened = Array.from({ length: 14 }, (_, i) => ({
    ...a,
    id: 'recent-' + i,
    lastReadAt: new Date(2026, 0, 1, i).toISOString(),
  }));
  const recents = recentPapers([...opened, { ...c, lastReadAt: null }]);
  assert.equal(recents.length, 10);
  assert.equal(recents[0].id, 'recent-13');
  assert.equal(recents.at(-1).id, 'recent-4');
  opened[0].lastReadAt = new Date(2026, 1, 1).toISOString();
  assert.equal(recentPapers(opened)[0].id, 'recent-0');
  invoke('papers:remove', b.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_collections WHERE paper_id = ?').get(b.id).n, 0);
  console.log(
    'PASS collection hierarchy, multi-membership, import destination, atomic batch validation, classification removal preserving papers and notes, batch tags/status, recent 10',
  );
  console.log(
    'PASS import copy, metadata/tags, Finder target, note export, cascading deletion, original-file preservation',
  );
} finally {
  database?.close();
  delete globalThis.libraryHandlers;
  delete globalThis.revealedFile;
  await fs.rm(temporary, { recursive: true, force: true });
}
