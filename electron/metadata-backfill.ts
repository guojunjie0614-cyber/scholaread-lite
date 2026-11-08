import { stat } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { Paper, PaperMeta, PaperMetadataChange } from '../shared/types.js';

const METADATA_VERSION = 1;
const RETRY_DELAY = 5 * 60 * 1000;
type Store = Pick<typeof import('./db.js').papers, 'list' | 'get' | 'update'>;

/** Enrichment never gates opening the library, and an unchanged PDF is only parsed once. */
export function createMetadataBackfill({ db, store, resolveFile, inspect, onChange, onError = console.warn, now = Date.now }: {
  db: DatabaseSync;
  store: Store;
  resolveFile: (name: string) => string | null;
  inspect: (file: string) => Promise<PaperMeta>;
  onChange: (change: PaperMetadataChange) => void;
  onError?: (message: string) => void;
  now?: () => number;
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS paper_metadata_attempts (
    paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
    file_signature TEXT NOT NULL, version INTEGER NOT NULL,
    outcome TEXT NOT NULL, retry_after INTEGER NOT NULL DEFAULT 0
  )`);
  const record = db.prepare(`INSERT INTO paper_metadata_attempts(paper_id,file_signature,version,outcome,retry_after)
    VALUES(?,?,?,?,?) ON CONFLICT(paper_id) DO UPDATE SET file_signature=excluded.file_signature,
    version=excluded.version,outcome=excluded.outcome,retry_after=excluded.retry_after`);
  let running: Promise<void> | undefined;
  const enrich = async () => {
    await setImmediate();
    for (const paper of store.list()) {
      if (paper.year !== null && paper.venue?.trim()) continue;
      const file = resolveFile(paper.fileName);
      let signature = JSON.stringify([paper.fileName, 'missing']);
      let fileError: unknown;
      try {
        if (file) {
          const info = await stat(file);
          signature = JSON.stringify([paper.fileName, info.size, info.mtimeMs]);
        }
      } catch (error) { fileError = error; }
      const previous = db.prepare('SELECT * FROM paper_metadata_attempts WHERE paper_id=?').get(paper.id);
      if (previous?.file_signature === signature && previous.version === METADATA_VERSION &&
        (previous.outcome !== 'error' || Number(previous.retry_after) > now())) continue;
      try {
        if (fileError) throw fileError;
        if (!file) throw new Error('PDF 文件不存在');
        const metadata = await inspect(file);
        const current = store.get(paper.id);
        if (!current || current.fileName !== paper.fileName) continue;
        const patch: Partial<Pick<Paper, 'year' | 'venue'>> = {};
        // A user may have edited metadata while the parser was running.
        if (metadata.year && current.year === null) patch.year = metadata.year;
        if (metadata.venue && !current.venue?.trim()) patch.venue = metadata.venue;
        if (Object.keys(patch).length) {
          store.update(paper.id, patch);
          onChange({ id: paper.id, patch });
        }
        record.run(paper.id, signature, METADATA_VERSION, Object.keys(patch).length ? 'updated' : 'no-result', 0);
      } catch (error) {
        if (store.get(paper.id)) record.run(paper.id, signature, METADATA_VERSION, 'error', now() + RETRY_DELAY);
        onError(`无法补全文献元数据（${paper.id}）：${error instanceof Error ? error.message : String(error)}`);
      }
      await setImmediate();
    }
  };
  return {
    run(): Promise<void> {
      return running ??= enrich().finally(() => { running = undefined; });
    },
  };
}
