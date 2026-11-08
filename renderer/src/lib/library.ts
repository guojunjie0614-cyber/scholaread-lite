import type { Collection, Paper, ReadingStatus } from '@shared/types';
import { collectionAncestors, collectionDescendants, collectionTreeOrder } from '@shared/collection-tree';
export { collectionAncestors, collectionDescendants } from '@shared/collection-tree';
export type LibraryScope = 'all' | 'unfiled' | string;
export const PAPER_DRAG_TYPE = 'application/x-scholarlite-papers';
export const statusLabels: Record<ReadingStatus, string> = {
  unread: '未读',
  reading: '阅读中',
  read: '已读',
};
export function collectionLabel(id: string, collections: Collection[]): string {
  return collectionAncestors(id, collections).map(item => item.name).join(' / ');
}
export function scopePaper(paper: Paper, scope: LibraryScope, collections: Collection[]): boolean {
  if (scope === 'all') return true;
  if (scope === 'unfiled') return paper.collectionIds.length === 0;
  const ids = collectionDescendants(scope, collections);
  return paper.collectionIds.some((id) => ids.has(id));
}
export const recentPapers = (papers: Paper[]) =>
  papers
    .filter((p) => p.lastReadAt !== null)
    .sort((a, b) => b.lastReadAt!.localeCompare(a.lastReadAt!))
    .slice(0, 10);

/** Keep navigation targets stationary while retaining the ten most recently read papers. */
export function stableRecentPapers(papers: Paper[], previousIds: readonly string[]): Paper[] {
  const latest = recentPapers(papers);
  const byId = new Map(latest.map((paper) => [paper.id, paper]));
  const previous = new Set(previousIds);
  return [
    ...latest.filter((paper) => !previous.has(paper.id)),
    ...previousIds.flatMap((id) => {
      const paper = byId.get(id);
      return paper ? [paper] : [];
    }),
  ];
}
export function collectionOptions(collections: Collection[]) {
  return collectionTreeOrder(collections);
}
