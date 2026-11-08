import type { Collection } from './types.js';

/** Includes the selected node; a paper assigned at several depths is still counted once. */
export function collectionDescendants(id: string, collections: readonly Collection[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const item of collections) if (item.parentId) {
    const siblings = children.get(item.parentId) ?? [];
    siblings.push(item.id); children.set(item.parentId, siblings);
  }
  const result = new Set<string>(), pending = [id];
  while (pending.length) {
    const current = pending.pop()!;
    if (result.has(current)) continue;
    result.add(current); pending.push(...children.get(current) ?? []);
  }
  return result;
}

export function collectionAncestors(id: string, collections: readonly Collection[]): Collection[] {
  const byId = new Map(collections.map(item => [item.id, item]));
  const result: Collection[] = [], seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id); result.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return result;
}

/** Stable preorder for menus and pickers, preserving the store's sibling ordering. */
export function collectionTreeOrder(collections: readonly Collection[]): Collection[] {
  const children = new Map<string | null, Collection[]>();
  for (const item of collections) {
    const siblings = children.get(item.parentId) ?? [];
    siblings.push(item); children.set(item.parentId, siblings);
  }
  const result: Collection[] = [], seen = new Set<string>();
  const pending = [...children.get(null) ?? []].reverse();
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current.id)) continue;
    seen.add(current.id); result.push(current);
    pending.push(...[...children.get(current.id) ?? []].reverse());
  }
  return result;
}
