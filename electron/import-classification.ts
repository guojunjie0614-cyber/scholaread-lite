import { db, collections } from './db.js';

export interface ImportCollectionNode { key: string; name: string; parentKey: string | null }

export function sourceCollectionPath(key: string, nodes: readonly ImportCollectionNode[]): ImportCollectionNode[] {
  const byKey = new Map(nodes.map(node => [node.key, node]));
  const result: ImportCollectionNode[] = [], seen = new Set<string>();
  let current: string | null = key;
  while (current !== null) {
    if (seen.has(current)) throw new Error('源文献库的分类关系存在循环');
    seen.add(current);
    const node = byKey.get(current);
    if (!node) throw new Error('源文献库的上级分类不存在');
    result.unshift(node); current = node.parentKey;
  }
  return result;
}

function uniqueName(sourceName: string, parentId: string | null): string {
  const base = sourceName.trim();
  if (!base) throw new Error('源文献库的分类名称为空');
  const short = base.length <= 120 ? base : `${base.slice(0, 116)} …`;
  const siblings = collections.list().filter(item => item.parentId === parentId);
  let name = short, suffix = 1;
  while (siblings.some(item => item.name.toLowerCase() === name.toLowerCase())) {
    const ending = ` (${++suffix})`;
    name = short.slice(0, 120 - ending.length) + ending;
  }
  return name;
}

/** Mapping owns identity; names may be edited locally and different sources never merge by name. */
export function importClassification(keys: readonly string[], nodes: readonly ImportCollectionNode[], sourceId: string): string[] {
  const ids: string[] = [];
  for (const key of new Set(keys)) {
    let parentId: string | null = null;
    for (const node of sourceCollectionPath(key, nodes)) {
      const mapped = db.prepare('SELECT collection_id FROM library_import_collection_nodes WHERE source_id=? AND external_key=?')
        .get(sourceId, node.key) as { collection_id: string | null } | undefined;
      if (mapped) {
        // ON DELETE SET NULL is an intentional local deletion, not a missing mapping to recreate.
        if (mapped.collection_id === null) { parentId = null; break; }
        parentId = mapped.collection_id;
        continue;
      }
      const created = collections.create(uniqueName(node.name, parentId), parentId);
      db.prepare(`INSERT INTO library_import_collection_nodes(source_id,external_key,collection_id,source_name,source_parent_key)
        VALUES(?,?,?,?,?)`).run(sourceId, node.key, created.id, node.name, node.parentKey);
      parentId = created.id;
    }
    if (parentId) ids.push(parentId);
  }
  return [...new Set(ids)];
}
