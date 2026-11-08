import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { reanchorNotes } from './reanchor.js';
import { paths } from './paths.js';
import { collectionDescendants } from '../shared/collection-tree.js';
import { assertReflowBlocks } from '../shared/reflow-validation.js';
import type {
  Block,
  Note,
  Paper,
  Progress,
  FormulaSource,
  LatexSource,
  Collection,
  ReadingStatus,
} from '../shared/types.js';

paths.ensure();

export const db = new DatabaseSync(paths.db());

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS papers (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  authors       TEXT NOT NULL DEFAULT '[]',
  year          INTEGER,
  doi           TEXT,
  arxiv_id      TEXT,
  venue         TEXT,
  abstract      TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',
  file_name     TEXT NOT NULL,
  page_count    INTEGER,
  added_at      TEXT NOT NULL,
  last_read_at  TEXT
);

CREATE TABLE IF NOT EXISTS blocks (
  id       TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  page     INTEGER NOT NULL,
  ord      INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  text     TEXT NOT NULL,
  bbox     TEXT,
  crop     TEXT
);
CREATE INDEX IF NOT EXISTS idx_blocks_paper ON blocks(paper_id, ord);

CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,
  paper_id     TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  block_id     TEXT,
  page         INTEGER,
  quote        TEXT,
  body         TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT 'yellow',
  kind         TEXT NOT NULL DEFAULT 'note',
  start_offset INTEGER,
  end_offset   INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_paper ON notes(paper_id, created_at);

CREATE TABLE IF NOT EXISTS translations (
  hash       TEXT PRIMARY KEY,
  target     TEXT NOT NULL,
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  source     TEXT NOT NULL,
  result     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_translations_content ON translations(target, source);
CREATE TABLE IF NOT EXISTS translation_choices (
  content_key TEXT PRIMARY KEY,
  translation_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS progress (
  paper_id  TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
  page      INTEGER NOT NULL DEFAULT 0,
  scroll    REAL NOT NULL DEFAULT 0,
  mode      TEXT NOT NULL DEFAULT 'reflow',
  updated_at TEXT NOT NULL
);
`);

// Collections organize shared paper records; removing a collection never removes a paper.
db.exec(`
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_name ON collections(COALESCE(parent_id, ''), name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS paper_collections (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  PRIMARY KEY(paper_id, collection_id)
);
CREATE INDEX IF NOT EXISTS idx_paper_collections_collection ON paper_collections(collection_id);
CREATE TABLE IF NOT EXISTS library_import_items (
  source_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  PRIMARY KEY(source_id, item_key)
);
CREATE TABLE IF NOT EXISTS library_import_collections (
  source_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  PRIMARY KEY(source_id, source_path)
);
CREATE TABLE IF NOT EXISTS library_import_collection_nodes (
  source_id TEXT NOT NULL,
  external_key TEXT NOT NULL,
  collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
  source_name TEXT NOT NULL,
  source_parent_key TEXT,
  PRIMARY KEY(source_id, external_key)
);
`);
if (
  !(db.prepare('PRAGMA table_info(papers)').all() as Array<{ name: string }>).some(
    (c) => c.name === 'reading_status',
  )
) {
  db.exec("ALTER TABLE papers ADD COLUMN reading_status TEXT NOT NULL DEFAULT 'unread'");
  db.exec("UPDATE papers SET reading_status = 'reading' WHERE last_read_at IS NOT NULL");
}

let transactionSerial = 0;
function transaction<T>(operation: () => T): T {
  const name = `slite_transaction_${++transactionSerial}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`);
    throw error;
  }
}

// Additive migration: keep existing blocks and notes until a complete replacement is ready.
if (
  !(db.prepare('PRAGMA table_info(blocks)').all() as Array<{ name: string }>).some(
    (c) => c.name === 'details',
  )
) {
  db.exec('ALTER TABLE blocks ADD COLUMN details TEXT');
}

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

type PaperRow = {
  id: string;
  title: string;
  authors: string;
  year: number | null;
  doi: string | null;
  arxiv_id: string | null;
  venue: string | null;
  abstract: string | null;
  tags: string;
  file_name: string;
  page_count: number | null;
  added_at: string;
  last_read_at: string | null;
  reading_status: ReadingStatus;
  collection_ids: string;
};

const toPaper = (row: PaperRow): Paper => ({
  id: row.id,
  title: row.title,
  authors: parseJson<string[]>(row.authors, []),
  year: row.year,
  doi: row.doi,
  arxivId: row.arxiv_id,
  venue: row.venue,
  abstract: row.abstract,
  tags: parseJson<string[]>(row.tags, []),
  fileName: row.file_name,
  pageCount: row.page_count,
  addedAt: row.added_at,
  lastReadAt: row.last_read_at,
  readingStatus: row.reading_status,
  collectionIds: parseJson<string[]>(row.collection_ids, []),
});

const paperSelect = `SELECT papers.*, (SELECT json_group_array(collection_id) FROM paper_collections WHERE paper_id = papers.id) AS collection_ids FROM papers`;

/** 早期版本可能把百分号编码的文件名当成标题存下来，启动时顺手修一遍 */
{
  const rows = db.prepare("SELECT id, title FROM papers WHERE title LIKE '%\%%'").all() as Array<{
    id: string;
    title: string;
  }>;
  const upd = db.prepare('UPDATE papers SET title = ? WHERE id = ?');
  for (const row of rows) {
    if (!/%[0-9A-Fa-f]{2}/.test(row.title)) continue;
    try {
      upd.run(decodeURIComponent(row.title), row.id);
    } catch {
      /* 不是合法编码就保持原样 */
    }
  }
}

export const papers = {
  list(): Paper[] {
    const rows = db
      .prepare(`${paperSelect} ORDER BY COALESCE(last_read_at, added_at) DESC`)
      .all() as unknown as PaperRow[];
    return rows.map(toPaper);
  },

  get(id: string): Paper | null {
    const row = db.prepare(`${paperSelect} WHERE id = ?`).get(id) as unknown as PaperRow | undefined;
    return row ? toPaper(row) : null;
  },

  create(input: {
    title: string;
    fileName: string;
    authors?: string[];
    year?: number | null;
    doi?: string | null;
    arxivId?: string | null;
    venue?: string | null;
    abstract?: string | null;
    tags?: string[];
    collectionIds?: string[];
    importSource?: { sourceId: string; itemKey: string };
  }): Paper {
    const id = randomUUID();
    const now = new Date().toISOString();
    const collectionIds = validCollectionIds(input.collectionIds ?? []);
    return transaction(() => {
      db.prepare(
        `INSERT INTO papers (id, title, authors, year, doi, arxiv_id, venue, abstract, tags, file_name, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.title,
        JSON.stringify(input.authors ?? []),
        input.year ?? null,
        input.doi ?? null,
        input.arxivId ?? null,
        input.venue ?? null,
        input.abstract ?? null,
        JSON.stringify(input.tags ?? []),
        input.fileName,
        now,
      );
      for (const collectionId of collectionIds)
        db.prepare('INSERT INTO paper_collections (paper_id, collection_id) VALUES (?, ?)').run(
          id,
          collectionId,
        );
      if (input.importSource)
        db.prepare('INSERT INTO library_import_items (source_id, item_key, paper_id) VALUES (?, ?, ?)').run(
          input.importSource.sourceId, input.importSource.itemKey, id,
        );
      return papers.get(id)!;
    });
  },

  update(id: string, patch: Partial<Paper>): Paper {
    const current = papers.get(id);
    if (!current) throw new Error(`paper not found: ${id}`);
    const next = { ...current, ...patch };
    assertReadingStatus(next.readingStatus);
    db.prepare(
      `UPDATE papers SET title=?, authors=?, year=?, doi=?, arxiv_id=?, venue=?, abstract=?, tags=?, page_count=?, last_read_at=?, reading_status=? WHERE id=?`,
    ).run(
      next.title,
      JSON.stringify(next.authors),
      next.year,
      next.doi,
      next.arxivId,
      next.venue,
      next.abstract,
      JSON.stringify(next.tags),
      next.pageCount,
      next.lastReadAt,
      next.readingStatus,
      id,
    );
    return papers.get(id)!;
  },

  opened(id: string): Paper {
    if (!papers.get(id)) throw new Error('文献不存在');
    db.prepare(
      "UPDATE papers SET last_read_at = ?, reading_status = CASE WHEN reading_status = 'unread' THEN 'reading' ELSE reading_status END WHERE id = ?",
    ).run(new Date().toISOString(), id);
    return papers.get(id)!;
  },

  addTags(ids: string[], tags: string[]): Paper[] {
    const paperIds = validPaperIds(ids);
    if (
      !Array.isArray(tags) ||
      tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 100)
    )
      throw new Error('标签无效');
    return transaction(() =>
      paperIds.map((id) => {
        const paper = papers.get(id)!;
        return papers.update(id, { tags: [...new Set([...paper.tags, ...tags.map((tag) => tag.trim())])] });
      }),
    );
  },

  setStatus(ids: string[], status: ReadingStatus): Paper[] {
    const paperIds = validPaperIds(ids);
    assertReadingStatus(status);
    return transaction(() => paperIds.map((id) => papers.update(id, { readingStatus: status })));
  },

  remove(id: string) {
    db.prepare(`DELETE FROM papers WHERE id = ?`).run(id);
  },
};

function assertReadingStatus(status: unknown): asserts status is ReadingStatus {
  if (!['unread', 'reading', 'read'].includes(String(status))) throw new Error('阅读状态无效');
}

function validPaperIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !papers.get(id)))
    throw new Error('选择中包含不存在的文献');
  return [...new Set(ids)];
}

function validCollectionIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !collections.get(id)))
    throw new Error('分类不存在');
  return [...new Set(ids)];
}

type CollectionRow = { id: string; name: string; parent_id: string | null; created_at: string };
const toCollection = (row: CollectionRow): Collection => ({
  id: row.id,
  name: row.name,
  parentId: row.parent_id,
  createdAt: row.created_at,
});
function validateCollection(name: string, parentId: string | null, id?: string) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120)
    throw new Error('分类名称应为 1–120 个字符');
  if (parentId !== null) {
    const parent = collections.get(parentId);
    if (!parent) throw new Error('上级分类不存在');
    const visited = new Set<string>();
    let ancestor: Collection | null = parent;
    while (ancestor) {
      if (ancestor.id === id || visited.has(ancestor.id)) throw new Error('不能将分类移入自身或其子分类');
      visited.add(ancestor.id);
      ancestor = ancestor.parentId ? collections.get(ancestor.parentId) : null;
    }
  }
  const duplicate = db
    .prepare(
      "SELECT id FROM collections WHERE COALESCE(parent_id, '') = COALESCE(?, '') AND name = ? COLLATE NOCASE AND id != ?",
    )
    .get(parentId, name.trim(), id ?? '');
  if (duplicate) throw new Error('同一层级已有同名分类');
}

export const collections = {
  list(): Collection[] {
    return (
      db
        .prepare('SELECT * FROM collections ORDER BY name COLLATE NOCASE, created_at')
        .all() as unknown as CollectionRow[]
    ).map(toCollection);
  },
  get(id: string): Collection | null {
    const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as CollectionRow | undefined;
    return row ? toCollection(row) : null;
  },
  create(name: string, parentId: string | null = null): Collection {
    validateCollection(name, parentId);
    const id = randomUUID();
    db.prepare('INSERT INTO collections (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      name.trim(),
      parentId,
      new Date().toISOString(),
    );
    return collections.get(id)!;
  },
  update(id: string, patch: { name: string; parentId: string | null }): Collection {
    if (!collections.get(id)) throw new Error('分类不存在');
    validateCollection(patch.name, patch.parentId, id);
    db.prepare('UPDATE collections SET name = ?, parent_id = ? WHERE id = ?').run(
      patch.name.trim(),
      patch.parentId,
      id,
    );
    return collections.get(id)!;
  },
  remove(id: string) {
    if (!collections.get(id)) throw new Error('分类不存在');
    db.prepare('DELETE FROM collections WHERE id = ?').run(id);
  },
  addPapers(paperIds: string[], collectionIds: string[]) {
    const ids = validPaperIds(paperIds);
    const groups = validCollectionIds(collectionIds);
    transaction(() => {
      for (const id of ids)
        for (const group of groups)
          db.prepare('INSERT OR IGNORE INTO paper_collections (paper_id, collection_id) VALUES (?, ?)').run(
            id,
            group,
          );
    });
  },
  removePapers(paperIds: string[], collectionId: string) {
    const ids = validPaperIds(paperIds);
    validCollectionIds([collectionId]);
    const groups = collectionDescendants(collectionId, collections.list());
    transaction(() => {
      for (const id of ids)
        for (const group of groups)
          db.prepare('DELETE FROM paper_collections WHERE paper_id = ? AND collection_id = ?').run(id, group);
    });
  },
  setForPaper(paperId: string, collectionIds: string[]) {
    validPaperIds([paperId]);
    const groups = validCollectionIds(collectionIds);
    transaction(() => {
      db.prepare('DELETE FROM paper_collections WHERE paper_id = ?').run(paperId);
      for (const id of groups)
        db.prepare('INSERT INTO paper_collections (paper_id, collection_id) VALUES (?, ?)').run(paperId, id);
    });
  },
};

type BlockRow = {
  id: string;
  paper_id: string;
  page: number;
  ord: number;
  kind: string;
  text: string;
  bbox: string | null;
  crop: string | null;
  details: string | null;
};

export const blocks = {
  list(paperId: string): Block[] {
    const rows = db
      .prepare(`SELECT * FROM blocks WHERE paper_id = ? ORDER BY ord ASC`)
      .all(paperId) as unknown as BlockRow[];
    return rows.map((row) => ({
      id: row.id,
      paperId: row.paper_id,
      page: row.page,
      ord: row.ord,
      kind: row.kind as Block['kind'],
      text: row.text,
      bbox: parseJson<Block['bbox']>(row.bbox, undefined),
      crop: parseJson<Block['crop']>(row.crop, undefined),
      ...parseJson<Partial<Block>>(row.details, {}),
    }));
  },

  save(paperId: string, list: Block[]) {
    assertReflowBlocks(list);
    const oldBlocks = blocks.list(paperId);
    list = list.map((block) => {
      if (block.kind !== 'math' || block.latex) return block;
      const labels = block.eqNo?.match(/\([^()]+\)/g) ?? [];
      const reviews = oldBlocks.filter(old => old.kind === 'math' && old.page === block.page).flatMap(old => [
        ...(old.formulaReviews ?? []),
        ...(old.eqNo && old.latex && (old.latexVerified || old.latexSource === 'manual')
          ? [{ eqNo: old.eqNo, latex: old.latex, latexVerified: !!old.latexVerified, latexSource: old.latexSource }] : []),
      ]);
      const matchingReviews = labels.flatMap(eqNo => {
        const candidates = reviews.filter(review => review.eqNo === eqNo);
        const unique = candidates.filter((review, index) => candidates.findIndex(other =>
          other.latex === review.latex && other.latexVerified === review.latexVerified && other.latexSource === review.latexSource) === index);
        return unique;
      });
      if (labels.length > 1 && matchingReviews.length) block = { ...block, formulaReviews: matchingReviews };
      const matches = oldBlocks.filter(
        (old) =>
          old.kind === 'math' &&
          old.latex &&
          old.page === block.page &&
          (block.eqNo ? old.eqNo === block.eqNo : JSON.stringify(old.crop) === JSON.stringify(block.crop)),
      );
      const previous = matches.length === 1 ? matches[0] : undefined;
      const restored = labels.length === 1 && matchingReviews.length === 1 ? matchingReviews[0] : undefined;
      // Keep human-reviewed/edited formulas; refresh unreviewed machine drafts from the improved parser.
      if (previous?.latexVerified || previous?.latexSource === 'manual' || restored) {
        const review = previous?.latexVerified || previous?.latexSource === 'manual' ? previous : restored!;
        return {
          ...block,
          latex: review.latex,
          latexVerified: review.latexVerified,
          latexSource: review.latexSource,
        };
      }
      if (block.nativeLatex)
        return {
          ...block,
          latex: block.nativeLatex,
          latexVerified: false,
          latexSource: 'pdf-structure' as const,
        };
      return previous
        ? {
            ...block,
            latex: previous.latex,
            latexVerified: previous.latexVerified,
            latexSource: previous.latexSource,
          }
        : block;
    });
    const anchored = reanchorNotes(oldBlocks, list, notes.list(paperId));
    const del = db.prepare(`DELETE FROM blocks WHERE paper_id = ?`);
    const ins = db.prepare(
      `INSERT INTO blocks (id, paper_id, page, ord, kind, text, bbox, crop, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN');
    try {
      del.run(paperId);
      list.forEach((b, i) => {
        ins.run(
          b.id,
          paperId,
          b.page,
          i,
          b.kind,
          b.text,
          b.bbox ? JSON.stringify(b.bbox) : null,
          b.crop ? JSON.stringify(b.crop) : null,
          JSON.stringify({
            eqNo: b.eqNo,
            eqNoInCrop: b.eqNoInCrop,
            recognitionCrop: b.recognitionCrop,
            sourceFontSize: b.sourceFontSize,
            nativeLatex: b.nativeLatex,
            structureWarnings: b.structureWarnings,
            latex: b.latex,
            latexVerified: b.latexVerified,
            formulaReviews: b.formulaReviews,
            latexSource: b.latexSource,
            source: b.source,
            confidence: b.confidence,
            analysisVersion: b.analysisVersion,
            parentBlockId: b.parentBlockId,
            figureLabel: b.figureLabel,
            textRuns: b.textRuns,
            readingRole: b.readingRole,
            sourceTextFallback: b.sourceTextFallback,
          }),
        );
      });
      const anchor = db.prepare('UPDATE notes SET block_id=?, start_offset=?, end_offset=? WHERE id=?');
      for (const n of anchored) anchor.run(n.blockId, n.startOffset, n.endOffset, n.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },

  setFormula(
    paperId: string,
    blockId: string,
    latex: string,
    verified: boolean,
    source: FormulaSource,
    origin: LatexSource = 'manual',
  ): Block {
    const block = blocks.list(paperId).find((b) => b.id === blockId && b.kind === 'math');
    if (!block) throw new Error('公式不存在，请重新打开文献');
    if (
      !source ||
      source.page !== block.page ||
      source.text !== block.text ||
      source.eqNo !== block.eqNo ||
      JSON.stringify(source.crop) !== JSON.stringify(block.crop)
    ) {
      throw new Error('公式区域已重新解析，请对当前公式重新识别。');
    }
    const row = db.prepare('SELECT details FROM blocks WHERE id=? AND paper_id=?').get(blockId, paperId) as {
      details: string | null;
    };
    const details = {
      ...parseJson<Record<string, unknown>>(row.details, {}),
      latex,
      latexVerified: verified,
      latexSource: origin,
    };
    db.prepare('UPDATE blocks SET details=? WHERE id=? AND paper_id=?').run(
      JSON.stringify(details),
      blockId,
      paperId,
    );
    return { ...block, latex, latexVerified: verified, latexSource: origin };
  },

  clear(paperId: string) {
    db.prepare(`DELETE FROM blocks WHERE paper_id = ?`).run(paperId);
  },
};

type NoteRow = {
  id: string;
  paper_id: string;
  block_id: string | null;
  page: number | null;
  quote: string | null;
  body: string;
  color: string;
  kind: string;
  start_offset: number | null;
  end_offset: number | null;
  created_at: string;
  updated_at: string;
};

const toNote = (row: NoteRow): Note => ({
  id: row.id,
  paperId: row.paper_id,
  blockId: row.block_id,
  page: row.page,
  quote: row.quote,
  body: row.body,
  color: row.color as Note['color'],
  kind: row.kind as Note['kind'],
  startOffset: row.start_offset,
  endOffset: row.end_offset,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const notes = {
  list(paperId: string): Note[] {
    const rows = db
      .prepare(`SELECT * FROM notes WHERE paper_id = ? ORDER BY created_at ASC`)
      .all(paperId) as unknown as NoteRow[];
    return rows.map(toNote);
  },

  create(input: Partial<Note> & { paperId: string }): Note {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO notes (id, paper_id, block_id, page, quote, body, color, kind, start_offset, end_offset, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.paperId,
      input.blockId ?? null,
      input.page ?? null,
      input.quote ?? null,
      input.body ?? '',
      input.color ?? 'yellow',
      input.kind ?? 'note',
      input.startOffset ?? null,
      input.endOffset ?? null,
      now,
      now,
    );
    return toNote(db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id) as unknown as NoteRow);
  },

  update(id: string, patch: Partial<Note>): Note {
    const row = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id) as unknown as NoteRow | undefined;
    if (!row) throw new Error(`note not found: ${id}`);
    const next = { ...toNote(row), ...patch };
    db.prepare(
      `UPDATE notes SET body=?, color=?, quote=?, kind=?, start_offset=?, end_offset=?, updated_at=? WHERE id=?`,
    ).run(
      next.body,
      next.color,
      next.quote,
      next.kind,
      next.startOffset,
      next.endOffset,
      new Date().toISOString(),
      id,
    );
    return toNote(db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id) as unknown as NoteRow);
  },

  remove(id: string) {
    db.prepare(`DELETE FROM notes WHERE id = ?`).run(id);
  },
};

export const translations = {
  candidates(contentKey: string, target: string, source: string): { hash: string; result: string; provider: string; model: string }[] {
    return db.prepare(`SELECT hash, result, provider, model FROM translations
      WHERE target = ? AND source = ? AND provider != 'echo'
      ORDER BY (hash = COALESCE((SELECT translation_hash FROM translation_choices WHERE content_key = ?), '')) DESC,
        created_at DESC, hash ASC`).all(target, source, contentKey) as unknown as { hash: string; result: string; provider: string; model: string }[];
  },
  choose(contentKey: string, hash: string) {
    db.prepare(`INSERT INTO translation_choices (content_key, translation_hash) VALUES (?, ?)
      ON CONFLICT(content_key) DO UPDATE SET translation_hash = excluded.translation_hash`).run(contentKey, hash);
  },
  set(hash: string, target: string, provider: string, model: string, source: string, result: string) {
    db.prepare(
      `INSERT OR REPLACE INTO translations (hash, target, provider, model, source, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(hash, target, provider, model, source, result, new Date().toISOString());
  },
};

export const progress = {
  get(paperId: string): Progress | null {
    const row = db
      .prepare(`SELECT page, scroll, mode FROM progress WHERE paper_id = ?`)
      .get(paperId) as unknown as Progress | undefined;
    return row ?? null;
  },
  set(paperId: string, p: Progress) {
    db.prepare(
      `INSERT INTO progress (paper_id, page, scroll, mode, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(paper_id) DO UPDATE SET page=excluded.page, scroll=excluded.scroll, mode=excluded.mode, updated_at=excluded.updated_at`,
    ).run(paperId, p.page ?? 0, p.scroll ?? 0, p.mode ?? 'reflow', new Date().toISOString());
  },
};
