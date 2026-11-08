import { app } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { db, papers } from './db.js';
import { importClassification, type ImportCollectionNode } from './import-classification.js';
import { paths, resolvePaperFile } from './paths.js';
import { readPdfMetadata } from './pdf-metadata.js';
import type { LibraryImportLocation, LibraryImportProgress, LibraryImportResult, LibraryImportSource, PaperMeta } from '../shared/types.js';

export interface ImportCandidate {
  key: string;
  title: string;
  file?: string;
  metadata: PaperMeta;
  tags: string[];
  groups: string[];
  reason?: string;
  failure?: string;
}
export interface LibrarySnapshot { candidates: ImportCandidate[]; collections: ImportCollectionNode[] }
interface ImportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: LibraryImportProgress) => void;
  excludeDirectories?: string[];
}
interface DiscoveryOptions { signal?: AbortSignal; onIssue?: (message: string) => void; home?: string; roots?: string[] }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function exists(file: string) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

/** Read only the location preferences, never credentials from the Zotero profile. */
async function zoteroPreferences(home: string) {
  const profiles = path.join(home, 'Library/Application Support/Zotero/Profiles');
  const result: Array<{ dataDir?: string; attachmentBase?: string }> = [];
  let entries;
  try { entries = await fs.readdir(profiles, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const text = await fs.readFile(path.join(profiles, entry.name, 'prefs.js'), 'utf8');
      const values: Record<string, string | boolean> = {};
      const pattern = /user_pref\("extensions\.zotero\.(dataDir|useDataDir|baseAttachmentPath)",\s*("(?:[^"\\]|\\.)*"|true|false)\);/g;
      for (const match of text.matchAll(pattern)) values[match[1]] = JSON.parse(match[2]);
      result.push({
        dataDir: values.useDataDir === true && typeof values.dataDir === 'string' ? values.dataDir : path.join(home, 'Zotero'),
        attachmentBase: typeof values.baseAttachmentPath === 'string' ? values.baseAttachmentPath : undefined,
      });
    } catch { /* A profile without readable preferences cannot supply a custom location. */ }
  }
  return result;
}

export async function discoverZoteroLibraries(options: DiscoveryOptions = {}): Promise<LibraryImportLocation[]> {
  const home = options.home ?? os.homedir();
  const preferences = await zoteroPreferences(home);
  const candidates = [...preferences.map(item => item.dataDir).filter((value): value is string => !!value), path.join(home, 'Zotero')];
  const found: LibraryImportLocation[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (options.signal?.aborted) break;
    if (!await exists(path.join(candidate, 'zotero.sqlite'))) continue;
    const canonical = await fs.realpath(candidate);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    found.push({ path: canonical, label: 'Zotero', source: 'zotero' });
  }
  return found;
}

const LIBRARY_NAMES = /^(?:zotero|scholaread|papers|readcube(?: papers)?|mendeley(?: desktop| reference manager)?|endnote|xiaolvjing|小绿鲸|文献库|文献|论文库|论文|paper library|research papers|literature)$/i;
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

/** Search library locations, not every PDF on the computer. Empty app caches are not libraries. */
export async function discoverLibraries(options: DiscoveryOptions = {}): Promise<LibraryImportLocation[]> {
  const found = await discoverZoteroLibraries(options);
  const home = options.home ?? os.homedir();
  const own = await fs.realpath(paths.root()).catch(() => path.resolve(paths.root()));
  const candidates = new Set<string>();
  const roots = options.roots ? [...options.roots] : [home, path.join(home, 'Documents'), path.join(home, 'Desktop'), path.join(home, 'Downloads')];
  if (!options.roots && process.platform === 'darwin') {
    const volumes = await fs.readdir('/Volumes', { withFileTypes: true }).catch(() => []);
    for (const volume of volumes) if (volume.isDirectory()) {
      roots.push(path.join('/Volumes', volume.name), path.join('/Volumes', volume.name, 'LiveData'));
    }
  }
  for (const root of roots) {
    if (options.signal?.aborted) return found;
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => {
      if (error.code !== 'ENOENT') options.onIssue?.(`无法查找 ${root}：${message(error)}`);
      return [];
    });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (LIBRARY_NAMES.test(entry.name)) candidates.add(path.join(root, entry.name));
      else if (/\.Data$/i.test(entry.name) && await exists(path.join(root, entry.name.replace(/\.Data$/i, '.enl'))))
        candidates.add(path.join(root, entry.name, 'PDF'));
    }
  }
  for (const candidate of candidates) {
    if (options.signal?.aborted) break;
    const canonical = await fs.realpath(candidate).catch(() => null);
    if (!canonical || inside(canonical, own) || found.some(location => inside(canonical, location.path))) continue;
    if (await exists(path.join(canonical, 'zotero.sqlite'))) {
      found.push({ path: canonical, label: 'Zotero', source: 'zotero' });
      continue;
    }
    const inspected = await inspectLibraryFolder(canonical, own, options);
    found.push(...inspected.databases.map(database => ({ path: database, label: 'Zotero', source: 'zotero' as const })));
    if (inspected.hasPdf) found.push({ path: canonical, label: path.basename(candidate), source: 'folder' });
  }
  // A database source takes precedence over its storage folder; a parent PDF library
  // covers nested discoveries. Canonical paths also remove aliases and external-volume links.
  return found.filter((location, index) => !found.some((other, otherIndex) => otherIndex !== index &&
    (location.path === other.path ? otherIndex < index : location.source === 'folder' && inside(location.path, other.path))));
}

async function inspectLibraryFolder(root: string, own: string, options: DiscoveryOptions): Promise<{ hasPdf: boolean; databases: string[] }> {
  let visited = 0;
  const result = { hasPdf: false, databases: [] as string[] };
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (options.signal?.aborted || inside(directory, own) || depth > 8 || ++visited > 4000) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { options.onIssue?.(`无法读取 ${directory}：${message(error)}`); return; }
    if (entries.some(entry => entry.isFile() && entry.name === 'zotero.sqlite')) { result.databases.push(directory); return; }
    if (entries.some(entry => entry.isFile() && /\.pdf$/i.test(entry.name))) result.hasPdf = true;
    for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.') &&
      !['node_modules', 'Cache', 'Code Cache', 'GPUCache', 'Trash'].includes(entry.name)) {
      await walk(path.join(directory, entry.name), depth + 1);
    }
  };
  await walk(root, 0); return result;
}

export async function importDiscoveredLibraries(options: ImportOptions & { discovery?: Pick<DiscoveryOptions, 'home' | 'roots'> } = {}): Promise<LibraryImportResult> {
  const result: LibraryImportResult = { total: 0, processed: 0, imported: 0, skipped: 0, failed: 0,
    current: '', cancelled: false, issues: [], sources: [], phase: 'discovering' };
  options.onProgress?.({ ...result });
  const sources = await discoverLibraries({ ...options.discovery, signal: options.signal, onIssue: issue => result.issues.push(issue) });
  result.sources = sources;
  result.phase = 'importing';
  for (const location of sources) {
    if (options.signal?.aborted) break;
    const before = { total: result.total, processed: result.processed, imported: result.imported, skipped: result.skipped, failed: result.failed };
    result.sourceLabel = location.label;
    try {
      const imported = await importLibrary(location.source, location.path, { signal: options.signal,
        excludeDirectories: sources.filter(source => source.source === 'zotero').map(source => source.path),
        onProgress: progress => options.onProgress?.({ ...progress, phase: 'importing', sourceLabel: location.label,
          total: before.total + progress.total, processed: before.processed + progress.processed,
          imported: before.imported + progress.imported, skipped: before.skipped + progress.skipped, failed: before.failed + progress.failed }) });
      for (const key of ['total', 'processed', 'imported', 'skipped', 'failed'] as const) result[key] += imported[key];
      result.issues.push(...imported.issues.map(issue => `${location.label}：${issue}`));
    } catch (error) { result.failed++; result.issues.push(`${location.label}：${message(error)}`); }
  }
  result.cancelled = options.signal?.aborted ?? false;
  result.current = ''; result.sourceLabel = undefined;
  options.onProgress?.({ ...result });
  return result;
}

function stringValue(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }

async function readZotero(root: string, signal?: AbortSignal): Promise<LibrarySnapshot> {
  const databasePath = path.join(root, 'zotero.sqlite');
  if (!await exists(databasePath)) throw new Error('所选文件夹没有 zotero.sqlite，请选择 Zotero 数据目录。');
  const prefs = await zoteroPreferences(os.homedir());
  const attachmentBases = new Set<string>();
  for (const pref of prefs) {
    const canonical = await fs.realpath(pref.dataDir ?? path.join(os.homedir(), 'Zotero')).catch(() => null);
    if (canonical === root && pref.attachmentBase) attachmentBases.add(await fs.realpath(pref.attachmentBase).catch(() => path.resolve(pref.attachmentBase!)));
  }
  const attachmentBase = attachmentBases.size === 1 ? [...attachmentBases][0] : undefined;
  const attachmentIssue = attachmentBases.size > 1 ? '多个 Zotero 配置指向不同附件基础目录，无法确定链接文件位置' : '链接附件未配置可用的 Zotero 附件基础目录';
  const source = new DatabaseSync(databasePath, { readOnly: true });
  const result: ImportCandidate[] = [];
  let collectionNodes: ImportCollectionNode[] = [];
  try {
    // A normal read transaction includes committed WAL content and keeps one consistent snapshot.
    source.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2000; BEGIN;');
    const items = source.prepare(`SELECT i.itemID, i.key, i.libraryID, t.typeName FROM items i
      JOIN itemTypes t ON t.itemTypeID=i.itemTypeID
      WHERE NOT EXISTS (SELECT 1 FROM deletedItems d WHERE d.itemID=i.itemID)`).all() as Array<{ itemID: number; key: string; libraryID: number; typeName: string }>;
    const available = new Map(items.map(item => [item.itemID, item]));
    const values = new Map<number, Record<string, string>>();
    for (const row of source.prepare(`SELECT d.itemID, f.fieldName, v.value FROM itemData d
      JOIN fields f ON f.fieldID=d.fieldID JOIN itemDataValues v ON v.valueID=d.valueID`).all() as Array<{itemID:number;fieldName:string;value:string}>) {
      const data = values.get(row.itemID) ?? {};
      data[row.fieldName] = stringValue(row.value); values.set(row.itemID, data);
    }
    const authors = new Map<number, string[]>();
    for (const row of source.prepare(`SELECT ic.itemID,c.firstName,c.lastName FROM itemCreators ic
      JOIN creators c ON c.creatorID=ic.creatorID WHERE ic.creatorTypeID=1 ORDER BY ic.orderIndex`).all() as Array<{itemID:number;firstName:string;lastName:string}>) {
      const list = authors.get(row.itemID) ?? [];
      const name = [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
      if (name) list.push(name); authors.set(row.itemID,list);
    }
    const tags = new Map<number,string[]>();
    for (const row of source.prepare('SELECT it.itemID,t.name FROM itemTags it JOIN tags t ON t.tagID=it.tagID').all() as Array<{itemID:number;name:string}>) {
      const list = tags.get(row.itemID) ?? []; list.push(row.name); tags.set(row.itemID,list);
    }
    const hasDeletedCollections = source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deletedCollections'").get();
    const allGroups = source.prepare('SELECT collectionID,collectionName,parentCollectionID,libraryID,key FROM collections')
      .all() as Array<{collectionID:number;collectionName:string;parentCollectionID:number|null;libraryID:number;key:string}>;
    const deletedGroups = new Set(hasDeletedCollections
      ? (source.prepare('SELECT collectionID FROM deletedCollections').all() as Array<{ collectionID: number }>).map(row => row.collectionID) : []);
    const allGroupMap = new Map(allGroups.map(group => [group.collectionID, group]));
    const groups = allGroups.filter(group => {
      const seen = new Set<number>();
      let current: typeof group | undefined = group;
      while (current) {
        if (deletedGroups.has(current.collectionID)) return false;
        if (seen.has(current.collectionID)) throw new Error('Zotero 分类关系存在循环');
        seen.add(current.collectionID);
        if (current.parentCollectionID === null) return true;
        current = allGroupMap.get(current.parentCollectionID);
        if (!current) throw new Error('Zotero 上级分类不存在');
      }
      return true;
    });
    const groupMap = new Map(groups.map(group => [group.collectionID, group]));
    const externalKey = (group: typeof groups[number]) => `${group.libraryID}:${group.key}`;
    collectionNodes = groups.map(group => ({ key: externalKey(group), name: group.collectionName,
      parentKey: group.parentCollectionID === null ? null : groupMap.has(group.parentCollectionID) ? externalKey(groupMap.get(group.parentCollectionID)!) : null }));
    const memberships = new Map<number,string[]>();
    for (const row of source.prepare('SELECT itemID,collectionID FROM collectionItems').all() as Array<{itemID:number;collectionID:number}>) {
      const group = groupMap.get(row.collectionID);
      if (!group) continue;
      const list=memberships.get(row.itemID) ?? []; list.push(externalKey(group)); memberships.set(row.itemID,list);
    }
    const attachments = source.prepare(`SELECT a.itemID,a.parentItemID,a.path,i.key,i.libraryID FROM itemAttachments a
      JOIN items i ON i.itemID=a.itemID WHERE (a.contentType='application/pdf' OR lower(a.path) LIKE '%.pdf') ORDER BY a.itemID`).all() as Array<{itemID:number;parentItemID:number|null;path:string|null;key:string;libraryID:number}>;
    const parentsWithPdf = new Set<number>();
    for (const attachment of attachments) {
      if (signal?.aborted) break;
      if (!available.has(attachment.itemID) || (attachment.parentItemID !== null && !available.has(attachment.parentItemID))) continue;
      const parentId = attachment.parentItemID ?? attachment.itemID;
      parentsWithPdf.add(parentId);
      const data = values.get(parentId) ?? {};
      const title = data.title || values.get(attachment.itemID)?.title || attachment.key;
      const stored = attachment.path ?? '';
      let file: string | undefined;
      if (stored.startsWith('storage:')) {
        const base=path.resolve(root,'storage',attachment.key);
        const resolved=path.resolve(base,stored.slice(8));
        if (resolved.startsWith(base+path.sep)) file=resolved;
      } else if (stored.startsWith('attachments:')) {
        if (attachmentBase) {
          const base=path.resolve(attachmentBase); const resolved=path.resolve(base,stored.slice(12));
          if (resolved.startsWith(base+path.sep)) file=resolved;
        }
      } else if (path.isAbsolute(stored)) file=stored;
      const year=data.date?.match(/\b(?:19|20)\d{2}\b/)?.[0];
      result.push({
        key: `${attachment.libraryID}:${attachment.key}`, title, file,
        metadata: {title,authors:authors.get(parentId) ?? [],year:year ? Number(year) : null,
          doi:data.DOI || undefined,venue:data.publicationTitle || data.proceedingsTitle || data.conferenceName || undefined,
          abstract:data.abstractNote || undefined},
        tags:[...new Set([...(tags.get(parentId) ?? []),...(tags.get(attachment.itemID) ?? [])])],
        groups:[...(memberships.get(parentId) ?? []),...(memberships.get(attachment.itemID) ?? [])],
        reason: !file ? stored.startsWith('attachments:') ? attachmentIssue : '没有可读取的本地 PDF 路径' : undefined,
      });
    }
    for (const item of items) {
      if (item.typeName === 'attachment' || item.typeName === 'note' || item.typeName === 'annotation' || parentsWithPdf.has(item.itemID)) continue;
      result.push({key:`${item.libraryID}:${item.key}`,title:values.get(item.itemID)?.title || item.key,metadata:{},tags:[],groups:[],reason:'文献没有本地 PDF 附件'});
    }
    source.exec('COMMIT');
  } finally { source.close(); }
  return { candidates: result, collections: collectionNodes };
}

async function readFolder(root:string, signal:AbortSignal|undefined, excluded: string[]):Promise<LibrarySnapshot> {
  const result:ImportCandidate[]=[];
  const nodes = new Map<string, ImportCollectionNode>();
  const walk=async(directory:string) => {
    if (signal?.aborted || directory !== root && excluded.some(exclusion => inside(directory, exclusion))) return;
    let entries;
    try { entries=await fs.readdir(directory,{withFileTypes:true}); }
    catch(error) {
      if(directory===root) throw new Error(`无法读取文献库文件夹：${message(error)}`);
      result.push({key:path.relative(root,directory),title:directory,metadata:{},tags:[],groups:[],failure:`无法读取文件夹：${message(error)}`});
      return;
    }
    entries.sort((a,b)=>a.name.localeCompare(b.name));
    for(const entry of entries) {
      if(signal?.aborted) break;
      const full=path.join(directory,entry.name);
      if(entry.isDirectory()) await walk(full);
      else if(entry.isFile() && path.extname(entry.name).toLowerCase()==='.pdf') {
        const relative=path.relative(root,full);
        const folders=path.dirname(relative)==='.' ? [] : path.dirname(relative).split(path.sep);
        let parentKey: string | null = null;
        for (let index = 0; index < folders.length; index++) {
          const key = JSON.stringify(folders.slice(0, index + 1));
          nodes.set(key, { key, name: folders[index], parentKey }); parentKey = key;
        }
        result.push({key:relative,title:path.basename(entry.name,path.extname(entry.name)),file:full,metadata:{},tags:[],groups:parentKey ? [parentKey] : []});
      }
    }
  };
  await walk(root); return { candidates: result, collections: [...nodes.values()] };
}

/** Shared by import and the explicit legacy-tree migration; all source reads are read-only. */
export async function readLibrarySnapshot(source: LibraryImportSource, root: string, signal?: AbortSignal, excluded: string[] = []): Promise<LibrarySnapshot> {
  return source === 'zotero' ? readZotero(root, signal) : readFolder(root, signal, excluded);
}

export async function importLibrary(source:LibraryImportSource, selectedPath:string, options:ImportOptions={}):Promise<LibraryImportResult> {
  if(source!=='zotero' && source!=='folder') throw new Error('不支持的文献库来源');
  if(typeof selectedPath!=='string' || !path.isAbsolute(selectedPath)) throw new Error('请选择有效的文献库文件夹');
  const root=await fs.realpath(selectedPath);
  if(!(await fs.stat(root)).isDirectory()) throw new Error('请选择文献库文件夹');
  const own = await fs.realpath(paths.root()).catch(() => path.resolve(paths.root()));
  if (inside(root, own)) throw new Error('请选择外部文献库，不能导入 ScholarLite 自身的数据目录。');
  if (await exists(path.join(root, 'zotero.sqlite'))) source = 'zotero';
  const issues:string[]=[];
  const snapshot = await readLibrarySnapshot(source, root, options.signal, [own,...options.excludeDirectories ?? []]);
  const { candidates } = snapshot;
  const result:LibraryImportResult={total:candidates.length,processed:0,imported:0,skipped:0,failed:0,current:'',cancelled:false,issues};
  const sourceId=`${source}:${root}`;
  // The old folder importer used a product name as its identity. Migrate those
  // records once so choosing the same folder through the generic entry skips it.
  if (source === 'folder') {
    const legacyId = `xiaolvjing:${root}`;
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT OR IGNORE INTO library_import_items(source_id,item_key,paper_id)
        SELECT ?,item_key,paper_id FROM library_import_items WHERE source_id=?`).run(sourceId, legacyId);
      db.prepare('DELETE FROM library_import_items WHERE source_id=?').run(legacyId);
      db.prepare(`INSERT OR IGNORE INTO library_import_collections(source_id,source_path,collection_id)
        SELECT ?,source_path,collection_id FROM library_import_collections WHERE source_id=?`).run(sourceId, legacyId);
      db.prepare('DELETE FROM library_import_collections WHERE source_id=?').run(legacyId);
      db.prepare(`INSERT OR IGNORE INTO library_import_collection_nodes(source_id,external_key,collection_id,source_name,source_parent_key)
        SELECT ?,external_key,collection_id,source_name,source_parent_key FROM library_import_collection_nodes WHERE source_id=?`).run(sourceId, legacyId);
      db.prepare('DELETE FROM library_import_collection_nodes WHERE source_id=?').run(legacyId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const notify=() => options.onProgress?.({total:result.total,processed:result.processed,imported:result.imported,skipped:result.skipped,failed:result.failed,current:result.current});
  notify();
  for(const candidate of candidates) {
    await setImmediate();
    if(options.signal?.aborted) { result.cancelled=true; break; }
    result.current=candidate.title;
    let copied:string|undefined;
    try {
      if(candidate.failure) throw new Error(candidate.failure);
      const mapped=db.prepare('SELECT paper_id FROM library_import_items WHERE source_id=? AND item_key=?').get(sourceId,candidate.key) as {paper_id:string}|undefined;
      const existing=mapped ? papers.get(mapped.paper_id) : null;
      if(existing && resolvePaperFile(existing.fileName)) {
        result.skipped++;
      } else if(candidate.reason || !candidate.file || !await exists(candidate.file)) {
        result.skipped++; result.issues.push(`${candidate.title}：${candidate.reason || 'PDF 附件未下载或文件不存在'}${candidate.file ? `（${candidate.file}）` : ''}`);
      } else {
        const handle=await fs.open(candidate.file,'r');
        try {
          const header=Buffer.alloc(1024); const {bytesRead}=await handle.read(header,0,header.length,0);
          if(!header.subarray(0,bytesRead).includes(Buffer.from('%PDF-'))) throw new Error('文件内容不是 PDF');
        } finally { await handle.close(); }
        let meta=candidate.metadata;
        if(source==='folder') {
          try { meta=await readPdfMetadata(candidate.file,app.getAppPath()); }
          catch(error) { result.issues.push(`${candidate.title}：PDF 元数据读取失败，已使用文件名（${message(error)}）`); }
        }
        if(options.signal?.aborted) { result.cancelled=true; break; }
        if(existing) {
          // Repair an imported record whose managed PDF was removed; preserve edits and notes.
          copied=path.join(paths.library(),existing.fileName);
          await fs.copyFile(candidate.file,copied);
        } else {
          const fileName=`${randomUUID()}.pdf`; copied=path.join(paths.library(),fileName);
          await fs.copyFile(candidate.file,copied);
          // Creating a new paper and its source mapping is one unit; a failed PDF does not leave empty categories.
          db.exec('SAVEPOINT import_paper');
          try {
            const ids = importClassification(candidate.groups, snapshot.collections, sourceId);
            papers.create({...meta,title:meta.title || candidate.title,fileName,tags:candidate.tags,collectionIds:ids,importSource:{sourceId,itemKey:candidate.key}});
            db.exec('RELEASE import_paper');
          } catch (error) { db.exec('ROLLBACK TO import_paper'); db.exec('RELEASE import_paper'); throw error; }
        }
        copied=undefined; result.imported++;
      }
    } catch(error) {
      if(copied) await fs.unlink(copied).catch(()=>{});
      result.failed++; result.issues.push(`${candidate.title}：${message(error)}`);
    }
    result.processed++; notify();
  }
  result.cancelled ||= options.signal?.aborted ?? false;
  result.current=''; notify();
  return result;
}
