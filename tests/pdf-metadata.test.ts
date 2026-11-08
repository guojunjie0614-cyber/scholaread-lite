import test from 'node:test';
import assert from 'node:assert/strict';
import { inferPdfMetadata, type PdfMetadataSource } from '../electron/pdf-metadata.js';
import { canonicalVenue, displayVenue } from '../shared/venue.js';
import { createMetadataBackfill } from '../electron/metadata-backfill.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Paper, PaperMetadataChange } from '../shared/types.js';

const source = (patch: Partial<PdfMetadataSource> = {}): PdfMetadataSource => ({
  info: {}, xmp: {}, headers: [], firstPage: [], ...patch,
});

test('printed issue year wins over online-first, copyright and DOI years', () => {
  const metadata = inferPdfMetadata(source({
    info: { Subject: 'IEEE Transactions on Computer-Aided Design;2026;45;1;10.1109/TCAD.2025.3580335' },
    xmp: { 'prism:publicationdate': '2025-06-01', 'prism:coverdisplaydate': 'Jan. 2026' },
    headers: ['246 IEEE TRANSACTIONS ON COMPUTER-AIDED DESIGN, VOL. 45, NO. 1, JANUARY 2026'],
    firstPage: ['Date of publication 10 June 2025;', '©2025 IEEE', '[1] Other paper, 2024.'],
  }));
  assert.equal(metadata.year, 2026);
  assert.equal(metadata.doi, '10.1109/TCAD.2025.3580335');
  assert.equal(displayVenue(metadata.venue), 'TCAD');
});

test('structured publisher metadata works without selectable header text', () => {
  assert.equal(inferPdfMetadata(source({
    info: { Subject: 'IEEE Transactions on Circuits and Systems;2026;45;1;10.1109/example' },
  })).year, 2026);
});

test('ISSCC conference year ignores the PDF download year', () => {
  assert.equal(inferPdfMetadata(source({
    headers: ['ISSCC 2025 / SESSION 14 / COMPUTE-IN-MEMORY / 14.5'],
    firstPage: ['Authorized licensed use limited to institution. Downloaded on July 28,2026.'],
    info: { CreationDate: 'D:20260202153425' },
  })).year, 2025);
});

test('references, funding numbers, DOI years and creation dates cannot date an unpublished manuscript', () => {
  const metadata = inferPdfMetadata(source({
    info: { Title: 'GNSS manuscript', CreationDate: 'D:20261007050029', ModDate: 'D:20261008000000' },
    headers: ['IEEE INTERNET OF THINGS JOURNAL 1'],
    firstPage: ['Funded by Grant 2025ABC123.', '[1] IEEE Transactions, vol. 6, no. 1, January 2024.', 'Digital Object Identifier 10.1109/TIOT.2025.12345'],
  }));
  assert.equal(metadata.year, null);
  assert.equal(metadata.venue, 'IEEE Internet of Things Journal');
  assert.equal(displayVenue(metadata.venue), 'IoT J.');
});

test('explicit publication and publisher copyright dates are available as fallbacks', () => {
  assert.equal(inferPdfMetadata(source({ firstPage: ['Date of publication 10 Jan. 2023; date of current version 2024.'] })).year, 2023);
  assert.equal(inferPdfMetadata(source({ firstPage: ['©2022 IEEE. Personal use is permitted.'] })).year, 2022);
});

test('extracts the embedded title and authors for new imports', () => {
  const metadata = inferPdfMetadata(source({
    info: { Title: 'Filename fallback', Author: 'First Author, Second Author' },
    xmp: { 'dc:title': 'The Actual Paper Title', 'dc:creator': ['Alice', 'Bob'], 'prism:doi': '10.1109/EXAMPLE.2025.123', 'prism:publicationname': 'IEEE Journal' },
  }));
  assert.equal(metadata.title, 'The Actual Paper Title');
  assert.deepEqual(metadata.authors, ['Alice', 'Bob']);
  assert.equal(metadata.venue, 'IEEE Journal');
});

test('conference headers and structured descriptions identify venues without guessing from titles', () => {
  assert.equal(displayVenue(inferPdfMetadata(source({ headers: ['ISSCC 2025 / SESSION 14 / COMPUTE-IN-MEMORY / 14.5'] })).venue), 'ISSCC');
  assert.equal(inferPdfMetadata(source({ info: { Subject: '2025 IEEE International Solid-State Circuits Conference (ISSCC);2025;68; ;10.1109/example' } })).venue,
    'IEEE International Solid-State Circuits Conference');
  assert.equal(inferPdfMetadata(source({ info: { Title: 'IoTJ Manuscript' }, firstPage: ['[1] IEEE Internet of Things Journal, 2025.'] })).venue, undefined);
  assert.equal(inferPdfMetadata(source({ headers: ['DUAN et al.: A JOURNAL ARTICLE TITLE 247'] })).venue, undefined);
  assert.equal(inferPdfMetadata(source({ headers: ['IEEE TRANSACTIONS ON'] })).venue, undefined);
});

test('journal header strips page and issue information while unknown names remain intact', () => {
  assert.equal(inferPdfMetadata(source({ headers: ['246 IEEE TRANSACTIONS ON COMPUTER-AIDED DESIGN OF INTEGRATED CIRCUITS AND SYSTEMS, VOL. 45, NO. 1, JANUARY 2026'] })).venue,
    'IEEE Transactions on Computer-Aided Design of Integrated Circuits and Systems');
  assert.equal(displayVenue('2025 IEEE International Solid-State Circuits Conference (ISSCC)'), 'ISSCC');
  assert.equal(displayVenue('IEEE Trans. Comput.-Aided Des. Integr. Circuits Syst.'), 'TCAD');
  assert.equal(displayVenue('An Unfamiliar Scientific Journal'), 'An Unfamiliar Scientific Journal');
  assert.equal(displayVenue(null), '');
  assert.equal(canonicalVenue('IoTJ'), 'IEEE Internet of Things Journal');
});

async function backfillFixture(ids: string[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'metadata-backfill-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE papers(id TEXT PRIMARY KEY);');
  const rows = new Map<string, Paper>();
  for (const id of ids) {
    db.prepare('INSERT INTO papers VALUES(?)').run(id);
    rows.set(id, { id, fileName: `${id}.pdf`, year: null, venue: null, title: 'Local title', authors: ['Local author'] } as Paper);
    await writeFile(path.join(directory, `${id}.pdf`), 'fixture');
  }
  const changes: PaperMetadataChange[] = [], errors: string[] = [];
  const options = { db,
    store: { list: () => [...rows.values()], get: (id: string) => rows.get(id) ?? null,
      update: (id: string, patch: Partial<Paper>) => Object.assign(rows.get(id)!, patch) },
    resolveFile: (name: string) => path.join(directory, name),
    onChange: (change: PaperMetadataChange) => { changes.push(change); },
    onError: (message: string) => { errors.push(message); },
  };
  return { directory, rows, changes, errors, options, close: async () => { db.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('library can return before parsing completes; concurrent edits survive and callers share a run', async () => {
  const fixture = await backfillFixture(['empty', 'edited', 'deleted']);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entering = new Promise<void>(resolve => { started = resolve; });
  const inspected: string[] = [];
  const job = createMetadataBackfill({ ...fixture.options, inspect: async file => {
    const id = path.basename(file, '.pdf'); inspected.push(id);
    if (id === 'empty') { started(); await gate; }
    if (id === 'edited') Object.assign(fixture.rows.get(id)!, { year: 2021, venue: 'Manual venue' });
    if (id === 'deleted') { fixture.rows.delete(id); fixture.options.db.prepare('DELETE FROM papers WHERE id=?').run(id); }
    return { year: 2026, venue: 'PDF venue', title: 'Do not replace local title' };
  } });
  try {
    const first = job.run();
    assert.equal(job.run(), first);
    assert.equal(fixture.options.store.list().length, 3);
    assert.equal(fixture.rows.get('empty')!.year, null);
    await entering;
    release(); await first;
    assert.deepEqual(inspected, ['empty', 'edited', 'deleted']);
    assert.deepEqual(fixture.changes, [{ id: 'empty', patch: { year: 2026, venue: 'PDF venue' } }]);
    assert.equal(fixture.rows.get('edited')!.year, 2021);
    assert.equal(fixture.rows.get('empty')!.title, 'Local title');
  } finally { release(); await fixture.close(); }
});

test('no-result attempts persist across workers, retry after file/version changes, and never invent a year', async () => {
  const fixture = await backfillFixture(['unknown']);
  let calls = 0;
  const inspect = async () => { calls++; return { year: null }; };
  try {
    await createMetadataBackfill({ ...fixture.options, inspect }).run();
    await createMetadataBackfill({ ...fixture.options, inspect }).run();
    assert.equal(calls, 1);
    await writeFile(path.join(fixture.directory, 'unknown.pdf'), 'changed fixture contents');
    await createMetadataBackfill({ ...fixture.options, inspect }).run();
    assert.equal(calls, 2);
    fixture.options.db.exec('UPDATE paper_metadata_attempts SET version=0');
    await createMetadataBackfill({ ...fixture.options, inspect }).run();
    assert.equal(calls, 3);
    assert.equal(fixture.rows.get('unknown')!.year, null);
  } finally { await fixture.close(); }
});

test('unreadable documents do not block later papers, are not retried per list call, and can recover', async () => {
  const fixture = await backfillFixture(['broken', 'valid']);
  let time = 1_000, calls = 0, repaired = false;
  const job = createMetadataBackfill({ ...fixture.options, now: () => time, inspect: async file => {
    if (file.endsWith('broken.pdf')) { calls++; if (!repaired) throw new Error('Invalid PDF'); }
    return { year: 2025, venue: 'Known venue' };
  } });
  try {
    await job.run(); await job.run();
    assert.equal(calls, 1); assert.equal(fixture.errors.length, 1);
    assert.equal(fixture.rows.get('valid')!.year, 2025);
    repaired = true; time += 5 * 60 * 1000;
    await job.run();
    assert.equal(calls, 2); assert.equal(fixture.rows.get('broken')!.year, 2025);
  } finally { await fixture.close(); }
});

