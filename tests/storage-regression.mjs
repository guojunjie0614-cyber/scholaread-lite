import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-storage-test-'));
const databasePath = path.join(temporary, 'library.db');
let db;
try {
  // A real legacy database, without the new details column, not the user's library.
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE papers (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL DEFAULT '[]',
      year INTEGER, doi TEXT, arxiv_id TEXT, venue TEXT, abstract TEXT,
      tags TEXT NOT NULL DEFAULT '[]', file_name TEXT NOT NULL, page_count INTEGER,
      added_at TEXT NOT NULL, last_read_at TEXT
    );
    CREATE TABLE blocks (
      id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      page INTEGER NOT NULL, ord INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
      bbox TEXT, crop TEXT
    );
    INSERT INTO papers (id,title,file_name,added_at) VALUES ('paper','Legacy paper','paper.pdf','2026-01-01');
    INSERT INTO blocks VALUES ('old','paper',1,0,'p','Before selected phrase after.',NULL,NULL);
  `);
  legacy.close();
  const bundle = await build({
    entryPoints: [path.join(root, 'electron/db.ts')], bundle: true, write: false,
    platform: 'node', format: 'esm', target: 'node22',
    plugins: [{ name: 'isolated-database-path', setup(builder) {
      builder.onResolve({ filter: /^\.\/paths\.js$/ }, () => ({ path: 'test-paths', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: `export const paths = { ensure() {}, db: () => ${JSON.stringify(databasePath)} };`, loader: 'js',
      }));
    } }],
  });
  const module = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  ({ db } = module);
  const { blocks, notes } = module;
  assert.ok(db.prepare('PRAGMA table_info(blocks)').all().some((column) => column.name === 'details'));
  assert.equal(blocks.list('paper')[0].text, 'Before selected phrase after.');
  const note = notes.create({ paperId: 'paper', blockId: 'old', page: 1, quote: 'selected phrase',
    body: 'Keep this note', kind: 'highlight', startOffset: 7, endOffset: 22 });
  const block = (id, text, extra = {}) => ({ id, paperId: 'paper', page: 1, ord: 0, kind: 'p', text, ...extra });
  const details = { kind: 'math', eqNo: '(12)', eqNoInCrop: true, sourceFontSize: 10,
    latex: 'x^{2}', latexVerified: true, source: 'ocr', confidence: 0.91, analysisVersion: 2,
    nativeLatex: 'x^{2}', latexSource: 'pdf-structure', structureWarnings: [],
    bbox: [20, 50, 140, 80], crop: [18, 48, 142, 82], recognitionCrop: [18, 48, 125, 82] };
  blocks.save('paper', [block('first', 'Before'), block('selected', 'selected phrase after.'), block('formula', 'x2', details)]);
  const saved = blocks.list('paper');
  for (const [key, value] of Object.entries(details)) assert.deepEqual(saved[2][key], value, `persist ${key}`);
  const reanchored = notes.list('paper').find((entry) => entry.id === note.id);
  assert.equal(reanchored.blockId, 'selected');
  assert.equal(reanchored.startOffset, 0);
  assert.equal(reanchored.endOffset, 15);
  assert.equal(reanchored.quote, 'selected phrase');

  // A failing insert occurs after DELETE: rollback must preserve both blocks and note anchors.
  const beforeNotes = notes.list('paper');
  assert.throws(() => blocks.save('paper', [block('duplicate', 'a'), block('duplicate', 'b')]), /UNIQUE/);
  assert.deepEqual(blocks.list('paper'), saved);
  assert.deepEqual(notes.list('paper'), beforeNotes);

  // Invalid parser geometry/text must never replace the last readable snapshot.
  for (const extra of [
    { kind: 'math', crop: [20, 110, 150, 109] },
    { kind: 'math', crop: [20, 110, NaN, 140] },
    { recognitionCrop: [20, 110, 20, 140] },
    { textRuns: [{ text: 'not the canonical text' }] },
    { textRuns: [{ text: 'candidate', mathPosition: { group: 'x', x: 0, y: 0, width: 1, size: 0 } }] },
    { textRuns: [{ text: 'can', mathPosition: { group: 'x', x: 0, y: 0, width: 1, size: 1 } },
      { text: 'di' }, { text: 'date', mathPosition: { group: 'x', x: 1, y: .2, width: 1, size: .7 } }] },
  ]) {
    assert.throws(() => blocks.save('paper', [block('bad', 'candidate', extra)]), /重排结果无效/);
    assert.deepEqual(blocks.list('paper'), saved);
    assert.deepEqual(notes.list('paper'), beforeNotes);
  }

  // Also fail after new blocks were inserted, while the transaction updates note anchors.
  db.exec(`CREATE TEMP TRIGGER fail_anchor BEFORE UPDATE ON notes BEGIN SELECT RAISE(ABORT, 'anchor failure'); END;`);
  assert.throws(() => blocks.save('paper', [block('replacement', 'selected phrase after.')]), /anchor failure/);
  assert.deepEqual(blocks.list('paper'), saved);
  assert.deepEqual(notes.list('paper'), beforeNotes);
  db.exec('DROP TRIGGER fail_anchor');

  blocks.save('paper', [block('one', 'a selected phrase'), block('two', 'b selected phrase')]);
  const ambiguous = notes.list('paper').find((entry) => entry.id === note.id);
  assert.equal(ambiguous.blockId, null);
  assert.equal(ambiguous.startOffset, null);
  assert.equal(ambiguous.endOffset, null);
  assert.equal(ambiguous.quote, 'selected phrase');
  assert.equal(ambiguous.body, 'Keep this note');

  // Multiple occurrences inside one paragraph are still ambiguity, even if another has one.
  notes.create({ paperId: 'paper', blockId: 'one', page: 1, quote: 'selected phrase',
    startOffset: 2, endOffset: 17, body: 'Repeated quote', kind: 'highlight' });
  blocks.save('paper', [block('repeat', 'selected phrase and selected phrase'), block('single', 'selected phrase elsewhere')]);
  assert.equal(notes.list('paper').find((entry) => entry.body === 'Repeated quote').blockId, null,
    'repeated quote occurrences must not be discarded while counting candidates');

  // Reparse changes IDs and may improve crop boundaries, but must keep reviewed formulas.
  blocks.save('paper', [block('reviewed-numbered', 'x2', details),
    block('reviewed-unnumbered', 'a/b', { kind: 'math', crop: [30, 100, 150, 130], latex: '\\frac{a}{b}', latexVerified: true })]);
  blocks.save('paper', [block('new-numbered', 'x2', { kind: 'math', eqNo: '(12)', crop: [15, 45, 145, 85] }),
    block('new-unnumbered', 'a/b', { kind: 'math', crop: [30, 100, 150, 130] })]);
  const reparsed = blocks.list('paper');
  assert.equal(reparsed[0].latex, 'x^{2}');
  assert.equal(reparsed[0].latexVerified, true);
  assert.equal(reparsed[1].latex, '\\frac{a}{b}');
  assert.equal(reparsed[1].latexVerified, true);
  blocks.save('paper', [block('edited-numbered', 'x3', { kind: 'math', eqNo: '(12)', latex: 'x^3', latexVerified: false })]);
  assert.equal(blocks.list('paper')[0].latex, 'x^3', 'explicit new LaTeX takes precedence');
  assert.equal(blocks.list('paper')[0].latexVerified, false);
  const expectedSource = blocks.list('paper')[0];
  const updatedFormula = blocks.setFormula('paper', expectedSource.id, 'x^4', true, expectedSource);
  assert.equal(updatedFormula.latex, 'x^4');
  blocks.save('paper', [block(expectedSource.id, 'another formula', { kind: 'math', crop: [5, 5, 90, 30] })]);
  assert.throws(() => blocks.setFormula('paper', expectedSource.id, 'STALE', true, expectedSource), /重新解析/);
  assert.equal(blocks.list('paper')[0].latex, undefined, 'late OCR must not write to a reused block ID');
  blocks.save('paper', [block('draft', 'z2', {kind:'math', eqNo:'(20)', latex:'wrong', latexVerified:false, latexSource:'pix2tex'})]);
  blocks.save('paper', [block('draft-new', 'z2', {kind:'math', eqNo:'(20)', nativeLatex:'z^2'})]);
  assert.equal(blocks.list('paper')[0].latex, 'z^2', 'refresh unreviewed OCR from native structure');
  assert.equal(blocks.list('paper')[0].latexVerified, false);
  blocks.save('paper', [block('table','', {kind:'table', crop:[0,0,100,100]}), block('table-note','PFA = 10−3', {
    kind:'table-note', parentBlockId:'table', crop:[0,100,100,110],
    textRuns:[{text:'P'},{text:'FA',script:'sub'},{text:' = 10'},{text:'−3',script:'sup'}],
  })]);
  const tableNote = blocks.list('paper')[1];
  assert.equal(tableNote.parentBlockId, 'table');
  assert.equal(tableNote.textRuns.map(run=>run.text).join(''), tableNote.text);
  notes.create({paperId:'paper', blockId:'table-note', page:1, quote:'PFA', startOffset:0, endOffset:3, body:'table annotation'});
  blocks.save('paper', [block('note-new', tableNote.text, {...tableNote, id:'note-new'})]);
  assert.equal(notes.list('paper').find(n=>n.body==='table annotation').blockId,'note-new', 'cropped text notes remain anchorable');
  blocks.save('paper', [block('panel', '', {kind:'figure', figureLabel:'14.5.1', crop:[20,20,290,240]}),
    block('panel-caption', 'Figure 14.5.1: Complete panel.', {kind:'caption', figureLabel:'14.5.1', parentBlockId:'panel'})]);
  const panel = blocks.list('paper');
  assert.equal(panel[0].figureLabel, '14.5.1');
  assert.equal(panel[1].parentBlockId, panel[0].id);
  assert.equal(panel[1].figureLabel, panel[0].figureLabel);
  blocks.save('paper', [block('author', 'Author1', { readingRole: 'authors', analysisVersion: 9,
    textRuns: [{ text: 'Author', italic: true, bold: true }, { text: '1', script: 'sup' }] })]);
  const author = blocks.list('paper')[0];
  assert.equal(author.readingRole, 'authors');
  assert.equal(author.analysisVersion, 9);
  assert.deepEqual(author.textRuns, [{ text: 'Author', italic: true, bold: true }, { text: '1', script: 'sup' }]);
  blocks.save('paper', [block('unmapped', 'Unmapped \u0004', { sourceTextFallback: true, crop: [10, 20, 200, 80] }),
    block('bio', 'Author received the Ph.D. degree.', { readingRole: 'biography' })]);
  assert.equal(blocks.list('paper')[0].sourceTextFallback, true);
  assert.equal(blocks.list('paper')[1].readingRole, 'biography');
  const positioned = [{ text: 'r', italic: true, mathPosition: { group: 'g', x: 0, y: 0, width: .5, size: 1 } },
    { text: 'i', script: 'sub', mathPosition: { group: 'g', x: .5, y: .2, width: .3, size: .7 } },
    { text: 't', script: 'sup', mathPosition: { group: 'g', x: .5, y: -.4, width: .3, size: .7 } }];
  blocks.save('paper', [block('positioned', 'rit', { textRuns: positioned })]);
  assert.deepEqual(blocks.list('paper')[0].textRuns, positioned, 'source math geometry round-trips with canonical text');
  blocks.save('paper', [block('review-a', 'x', { kind: 'math', eqNo: '(8)', latex: 'x=1', latexVerified: true }),
    block('review-b', 'y', { kind: 'math', eqNo: '(9)', latex: 'y=2', latexVerified: false, latexSource: 'manual' })]);
  blocks.save('paper', [block('compound', 'xy', { kind: 'math', eqNo: '(8), (9)', crop: [10, 20, 200, 100] })]);
  const compound = blocks.list('paper')[0];
  assert.equal(compound.latex, undefined, 'a reviewed part is not a verified whole equation group');
  assert.deepEqual(compound.formulaReviews.map(review => review.latex), ['x=1', 'y=2']);
  blocks.save('paper', [block('compound-again', 'xy', { kind: 'math', eqNo: '(8), (9)', crop: [10, 20, 200, 100] })]);
  assert.equal(blocks.list('paper')[0].formulaReviews.length, 2, 'repeat parse retains reviews without duplicating them');
  blocks.save('paper', [block('split-a', 'x', { kind: 'math', eqNo: '(8)' }), block('split-b', 'y', { kind: 'math', eqNo: '(9)' })]);
  assert.equal(blocks.list('paper')[0].latex, 'x=1');
  assert.equal(blocks.list('paper')[0].latexVerified, true);
  assert.equal(blocks.list('paper')[1].latex, 'y=2');
  assert.equal(blocks.list('paper')[1].latexSource, 'manual');
  console.log('PASS legacy migration, metadata, rollback, unique/ambiguous reanchor, reviewed-formula preservation');
} finally {
  db?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
