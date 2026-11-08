import fs from 'node:fs/promises';
import path from 'node:path';
import { db, collections, papers } from './db.js';
import { collectionDescendants } from '../shared/collection-tree.js';
import { importClassification, sourceCollectionPath } from './import-classification.js';
import { readLibrarySnapshot, type LibrarySnapshot } from './library-import.js';

interface MigrationPaper { paperId: string; keys: string[]; previous: string[] }
interface MigrationSource {
  sourceId: string; rootId: string; removableRoot: boolean; snapshot: LibrarySnapshot; papers: MigrationPaper[];
}
export interface LibraryTreeMigrationResult {
  dryRun: boolean; migratedPapers: number; skippedPapers: number; removedCollections: number;
  sources: Array<{ sourceId: string; papers: number; paths: string[] }>;
  issues: string[];
}
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(id => b.includes(id));

/** Explicit migration, never part of ordinary repeat import. The caller backs up the target first. */
export async function migrateLegacyImportCollections(options: { dryRun?: boolean; sourceIds?: string[] } = {}): Promise<LibraryTreeMigrationResult> {
  const result: LibraryTreeMigrationResult = { dryRun: options.dryRun !== false, migratedPapers: 0, skippedPapers: 0,
    removedCollections: 0, sources: [], issues: [] };
  const sourceIds = options.sourceIds ?? (db.prepare('SELECT DISTINCT source_id FROM library_import_items').all() as Array<{ source_id: string }>).map(row => row.source_id);
  const plans: MigrationSource[] = [];
  for (const sourceId of sourceIds) {
    const match = /^(zotero|folder|xiaolvjing):(.+)$/.exec(sourceId);
    if (!match) continue;
    const source = match[1] === 'zotero' ? 'zotero' : 'folder';
    const sourceLabel = source === 'zotero' ? 'Zotero' : path.basename(match[2]);
    const target = collections.list();
    const oldRoot = target.find(item => item.parentId === null && item.name === sourceLabel);
    if (!oldRoot) continue;
    let snapshot: LibrarySnapshot;
    try { snapshot = await readLibrarySnapshot(source, await fs.realpath(match[2])); }
    catch (error) { result.issues.push(`${sourceLabel}：无法读取源分类，保留现有整理（${error instanceof Error ? error.message : error}）`); continue; }
    const imported = db.prepare(`SELECT i.item_key,i.paper_id,p.added_at FROM library_import_items i JOIN papers p ON p.id=i.paper_id WHERE i.source_id=?`)
      .all(sourceId) as Array<{ item_key: string; paper_id: string; added_at: string }>;
    const byKey = new Map(snapshot.candidates.map(candidate => [candidate.key, candidate]));
    const paths = new Map(snapshot.collections.map(node => [node.key, sourceCollectionPath(node.key, snapshot.collections).map(item => item.name).join(' / ')]));
    const owners = new Map<string, string[]>();
    for (const [key, fullPath] of paths) owners.set(fullPath, [...owners.get(fullPath) ?? [], key]);
    const oldByKey = new Map<string, string>();
    for (const [key, fullPath] of paths) {
      // Compare against an authoritative path; never split an existing display name into guessed nodes.
      if (owners.get(fullPath)!.length !== 1) continue;
      const mapped = db.prepare('SELECT collection_id FROM library_import_collections WHERE source_id=? AND source_path=?')
        .get(sourceId, fullPath) as { collection_id: string } | undefined;
      const old = mapped ? target.find(item => item.id === mapped.collection_id) : target.find(item => item.parentId === oldRoot.id && item.name === fullPath);
      if (old?.parentId === oldRoot.id) oldByKey.set(key, old.id);
    }
    const subtree = collectionDescendants(oldRoot.id, target);
    const plan: MigrationSource = { sourceId, rootId: oldRoot.id, snapshot, papers: [],
      // The old importer creates its root immediately before the first paper. An older local folder is not ours to remove.
      removableRoot: imported.some(item => Math.abs(Date.parse(item.added_at) - Date.parse(oldRoot.createdAt)) < 10_000) };
    for (const importedPaper of imported) {
      const candidate = byKey.get(importedPaper.item_key), paper = papers.get(importedPaper.paper_id)!;
      const previous = paper.collectionIds.filter(id => subtree.has(id));
      if (!previous.length) continue; // The user already moved it out; do not restore source memberships.
      const keys = [...new Set(candidate?.groups ?? [])];
      const expected = [...new Set([oldRoot.id, ...keys.flatMap(key => oldByKey.has(key) ? [oldByKey.get(key)!] : [])])];
      const deletedMappedNode = keys.some(key => sourceCollectionPath(key, snapshot.collections).some(node => {
        const mapping = db.prepare('SELECT collection_id FROM library_import_collection_nodes WHERE source_id=? AND external_key=?')
          .get(sourceId, node.key) as { collection_id: string | null } | undefined;
        return mapping?.collection_id === null;
      }));
      if (!candidate || keys.some(key => !oldByKey.has(key)) || !sameSet(previous, expected) || deletedMappedNode) {
        result.skippedPapers++;
        result.issues.push(`保留本地分类：${paper.title}（源分类或本地整理已变化）`);
        continue;
      }
      plan.papers.push({ paperId: paper.id, keys, previous });
    }
    if (!plan.papers.length) continue;
    plans.push(plan);
    result.migratedPapers += plan.papers.length;
    result.sources.push({ sourceId, papers: plan.papers.length,
      paths: [...new Set(plan.papers.flatMap(paper => paper.keys.map(key => paths.get(key)!)))] });
  }
  if (result.dryRun || !plans.length) return result;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const plan of plans) {
      const subtree = collectionDescendants(plan.rootId, collections.list());
      const oldIds = new Set<string>();
      for (const item of plan.papers) {
        const current = papers.get(item.paperId);
        if (!current || !sameSet(current.collectionIds.filter(id => subtree.has(id)), item.previous))
          throw new Error('预览后分类已变化，请重新检查迁移');
        const ids = importClassification(item.keys, plan.snapshot.collections, plan.sourceId);
        for (const id of ids) db.prepare('INSERT OR IGNORE INTO paper_collections(paper_id,collection_id) VALUES(?,?)').run(item.paperId, id);
        for (const id of item.previous) {
          db.prepare('DELETE FROM paper_collections WHERE paper_id=? AND collection_id=?').run(item.paperId, id);
          if (id !== plan.rootId) oldIds.add(id);
        }
      }
      // Only prune emptied legacy nodes that actually participated. Unknown/renamed/manual nodes survive.
      for (const id of oldIds) {
        if (db.prepare('SELECT 1 FROM paper_collections WHERE collection_id=? LIMIT 1').get(id) ||
          db.prepare('SELECT 1 FROM collections WHERE parent_id=? LIMIT 1').get(id) ||
          db.prepare('SELECT 1 FROM library_import_collection_nodes WHERE collection_id=? LIMIT 1').get(id)) continue;
        db.prepare('DELETE FROM collections WHERE id=?').run(id); result.removedCollections++;
      }
      if (plan.removableRoot && !db.prepare('SELECT 1 FROM collections WHERE parent_id=? LIMIT 1').get(plan.rootId) &&
        !db.prepare('SELECT 1 FROM paper_collections WHERE collection_id=? LIMIT 1').get(plan.rootId)) {
        db.prepare('DELETE FROM collections WHERE id=?').run(plan.rootId); result.removedCollections++;
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return result;
}
