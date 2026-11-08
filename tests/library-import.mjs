/** Local library migration fixtures; never writes to the user's Zotero or ScholarLite profile. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'scholarlite-import-'));
const profile=path.join(temporary,'app');
const zotero=path.join(temporary,'zotero');
const folder=path.join(temporary,'xiaolvjing');
let target;
try {
  await fs.mkdir(path.join(profile,'library'),{recursive:true});
  await fs.mkdir(zotero);
  const fixture=new DatabaseSync(path.join(zotero,'zotero.sqlite'));
  fixture.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE items(itemID INTEGER PRIMARY KEY,itemTypeID INTEGER,key TEXT,libraryID INTEGER);
    CREATE TABLE itemTypes(itemTypeID INTEGER,typeName TEXT);
    CREATE TABLE deletedItems(itemID INTEGER);
    CREATE TABLE itemData(itemID INTEGER,fieldID INTEGER,valueID INTEGER);
    CREATE TABLE fields(fieldID INTEGER,fieldName TEXT);
    CREATE TABLE itemDataValues(valueID INTEGER,value TEXT);
    CREATE TABLE creators(creatorID INTEGER,firstName TEXT,lastName TEXT);
    CREATE TABLE itemCreators(itemID INTEGER,creatorID INTEGER,creatorTypeID INTEGER,orderIndex INTEGER);
    CREATE TABLE itemAttachments(itemID INTEGER,parentItemID INTEGER,path TEXT,contentType TEXT);
    CREATE TABLE tags(tagID INTEGER,name TEXT);
    CREATE TABLE itemTags(itemID INTEGER,tagID INTEGER);
    CREATE TABLE collections(collectionID INTEGER,collectionName TEXT,parentCollectionID INTEGER,libraryID INTEGER DEFAULT 1,key TEXT);
    CREATE TABLE collectionItems(itemID INTEGER,collectionID INTEGER);
    INSERT INTO itemTypes VALUES(1,'journalArticle'),(2,'attachment'),(3,'note');
    INSERT INTO fields VALUES(1,'title'),(2,'date'),(3,'DOI'),(4,'publicationTitle'),(5,'abstractNote');
    INSERT INTO items VALUES(1,1,'PARENT',1),(2,2,'PDFONE',1),(3,1,'NOPDF',1),(4,1,'MISSING',1),(5,2,'PDFMISSING',1),(6,1,'DELETED',1),(7,2,'PDFDELETED',1),(8,1,'CORRUPT',1),(9,2,'PDFBAD',1),(10,2,'PDFTWO',1);
    INSERT INTO itemDataValues VALUES(1,'Fixture article'),(2,'2025-02-01'),(3,'10.1234/fixture'),(4,'TCAD'),(5,'An abstract'),(6,'No PDF'),(7,'Missing local PDF'),(8,'Deleted paper'),(9,'Bad PDF');
    INSERT INTO itemData VALUES(1,1,1),(1,2,2),(1,3,3),(1,4,4),(1,5,5),(3,1,6),(4,1,7),(6,1,8),(8,1,9);
    INSERT INTO creators VALUES(1,'Ada','Lovelace'); INSERT INTO itemCreators VALUES(1,1,1,0);
    INSERT INTO tags VALUES(1,'CIM'); INSERT INTO itemTags VALUES(1,1);
    INSERT INTO collections VALUES(1,'Circuits',NULL,1,'C1'),(2,'SRAM',1,1,'C2'),(3,'Digital',2,1,'C3'),(4,'Other',NULL,1,'C4');
    INSERT INTO collectionItems VALUES(1,3),(1,4);
    INSERT INTO itemAttachments VALUES(2,1,'storage:paper.pdf','application/pdf'),(5,4,'storage:missing.pdf','application/pdf'),(7,6,'storage:deleted.pdf','application/pdf'),(9,8,'storage:bad.pdf','application/pdf'),(10,1,'storage:supplement.pdf','application/pdf');
    INSERT INTO deletedItems VALUES(6);
  `);
  for(const [key,name,content] of [['PDFONE','paper.pdf','%PDF-1.7\noriginal fixture'],['PDFTWO','supplement.pdf','%PDF-1.7\nsupplement fixture'],['PDFBAD','bad.pdf','Not a PDF']]) {
    await fs.mkdir(path.join(zotero,'storage',key),{recursive:true});
    await fs.writeFile(path.join(zotero,'storage',key,name),content);
  }
  // Keep the external WAL open while import reads its committed snapshot.
  const stubs={
    electron:`export const app={getPath:()=>${JSON.stringify(profile)},getAppPath:()=>${JSON.stringify(root)}};`,
    'node:os':`export default {homedir:()=>${JSON.stringify(path.join(temporary,'home'))}};`,
    'node:fs/promises':`import actual from 'node:fs/promises'; export default {...actual,readdir:async (...args)=>{if(globalThis.importUnreadable===args[0])throw new Error('fixture permission denied');return actual.readdir(...args);}};`,
    './pdf-metadata.js':`export const readPdfMetadata=async file=>({title:'Metadata '+file.split('/').pop(),authors:['Test Author'],year:2024});`,
  };
  const bundle=path.join(temporary,'test.mjs');
  await build({stdin:{contents:"export * from './electron/library-import.ts'; export {db,papers,collections} from './electron/db.ts';",resolveDir:root},bundle:true,platform:'node',format:'esm',outfile:bundle,
    plugins:[{name:'isolated-library-import',setup(builder){
      builder.onResolve({filter:/.*/},args=>args.namespace!=='test' && args.path in stubs?{path:args.path,namespace:'test'}:undefined);
      builder.onLoad({filter:/.*/,namespace:'test'},args=>({contents:stubs[args.path],loader:'js'}));
    }}]});
  const {importLibrary,discoverZoteroLibraries,discoverLibraries,importDiscoveredLibraries,db,papers,collections}=await import(pathToFileURL(bundle)); target=db;
  const fakeProfile=path.join(temporary,'home/Library/Application Support/Zotero/Profiles/test.default');
  await fs.mkdir(fakeProfile,{recursive:true});
  await fs.writeFile(path.join(fakeProfile,'prefs.js'),`user_pref("extensions.zotero.useDataDir", true);\nuser_pref("extensions.zotero.dataDir", ${JSON.stringify(zotero)});`);
  await fs.symlink(zotero,path.join(temporary,'home/Zotero'));
  assert.deepEqual(await discoverZoteroLibraries(),[{path:await fs.realpath(zotero),label:'Zotero',source:'zotero'}]);
  const events=[];
  const first=await importLibrary('zotero',zotero,{onProgress:p=>events.push(p)});
  assert.deepEqual([first.total,first.processed,first.imported,first.skipped,first.failed],[5,5,2,2,1]);
  assert.equal(first.cancelled,false);
  assert.equal(events.at(-1).current,'');
  assert.ok(events.some(p=>p.processed===1));
  assert.match(first.issues.join('\n'),/没有本地 PDF|文件不存在/);
  assert.match(first.issues.join('\n'),/文件内容不是 PDF/);
  assert.equal(papers.list().length,2,'each PDF is preserved, including additional attachments');
  const article=papers.list()[0];
  assert.deepEqual(article.authors,['Ada Lovelace']);
  assert.equal(article.year,2025); assert.equal(article.doi,'10.1234/fixture');
  assert.equal(article.venue,'TCAD'); assert.equal(article.abstract,'An abstract');
  assert.deepEqual(article.tags,['CIM']);
  const names=article.collectionIds.map(id=>collections.get(id).name);
  assert.deepEqual(new Set(names),new Set(['Digital','Other']));
  assert.ok(!collections.list().some(c=>c.name==='Deleted paper' || c.name==='Zotero'));
  const digital = collections.list().find(c=>c.name==='Digital');
  const sram = collections.get(digital.parentId);
  assert.equal(sram.name,'SRAM'); assert.equal(collections.get(sram.parentId).name,'Circuits');
  const originalGroups = [...article.collectionIds];
  collections.setForPaper(article.id,[]); papers.update(article.id,{tags:[]});
  const second=await importLibrary('zotero',zotero);
  assert.equal(second.imported,0); assert.equal(second.skipped,4); assert.equal(papers.list().length,2);
  assert.deepEqual(papers.get(article.id).collectionIds,[]); assert.deepEqual(papers.get(article.id).tags,[]);
  collections.setForPaper(article.id, originalGroups);
  collections.update(digital.id,{name:'My Digital',parentId:digital.parentId});
  const longA='A'.repeat(80)+'1'+'B'.repeat(80),longB='A'.repeat(80)+'2'+'B'.repeat(80);
  fixture.prepare('INSERT INTO collections VALUES(?,?,NULL,1,?)').run(5,longA,'C5');
  fixture.prepare('INSERT INTO collections VALUES(?,?,NULL,1,?)').run(6,longB,'C6');
  fixture.exec('INSERT INTO collectionItems VALUES(1,5),(1,6)');
  const longPaths=await importLibrary('zotero',zotero);
  assert.equal(longPaths.failed,1,'long classifications do not fail a valid paper');
  assert.deepEqual(papers.get(article.id).tags,[],'skipped import must not add tags or classifications');
  assert.equal(collections.get(digital.id).name,'My Digital','local rename is preserved');
  assert.equal(collections.list().length,4,'source changes do not sync during a skipped import');
  // Recreating a deleted target record or missing managed PDF remains resumable.
  await fs.unlink(path.join(profile,'library',article.fileName));
  const repair=await importLibrary('zotero',zotero);
  assert.equal(repair.imported,1); assert.equal(papers.list().length,2);
  assert.equal(papers.get(article.id).id,article.id);
  await fs.access(path.join(profile,'library',article.fileName));
  const removed=papers.list().find(p=>p.id!==article.id); papers.remove(removed.id);
  const resumed=await importLibrary('zotero',zotero);
  assert.equal(resumed.imported,1); assert.equal(papers.list().length,2);
  const shortNames=collections.list().filter(c=>c.name.includes(' …')).map(c=>c.name);
  assert.equal(shortNames.length,2); assert.notEqual(shortNames[0],shortNames[1]); assert.ok(shortNames.every(n=>n.length<=120));
  assert.equal(collections.list().filter(c=>c.name==='My Digital').length,1);
  const stableMapping=db.prepare('SELECT collection_id FROM library_import_collection_nodes WHERE source_id=? AND external_key=?').get('zotero:'+await fs.realpath(zotero),'1:C3');
  assert.equal(stableMapping.collection_id,digital.id);

  // A creation error removes only the just-copied PDF; the next item can still succeed.
  await fs.mkdir(path.join(folder,'Topics','SRAM'),{recursive:true});
  await fs.writeFile(path.join(folder,'Topics','SRAM','a.pdf'),'%PDF-1.7\na');
  await fs.writeFile(path.join(folder,'Topics','SRAM','b.PDF'),'%PDF-1.7\nb');
  db.exec(`CREATE TEMP TRIGGER reject_import BEFORE INSERT ON papers WHEN NEW.title='Metadata a.pdf' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;`);
  const before=(await fs.readdir(path.join(profile,'library'))).length;
  const partial=await importLibrary('folder',folder);
  assert.equal(partial.imported,1); assert.equal(partial.failed,1);
  assert.equal((await fs.readdir(path.join(profile,'library'))).length,before+1);
  db.exec('DROP TRIGGER reject_import');
  const retry=await importLibrary('folder',folder);
  assert.equal(retry.imported,1); assert.equal(retry.skipped,1);
  assert.ok(papers.list().some(p=>p.title==='Metadata a.pdf'&&p.year===2024));
  globalThis.importUnreadable=await fs.realpath(folder);
  await assert.rejects(importLibrary('folder',folder),/无法读取文献库文件夹/);
  globalThis.importUnreadable=await fs.realpath(path.join(folder,'Topics','SRAM'));
  const unreadableChild=await importLibrary('folder',folder);
  assert.equal(unreadableChild.failed,1);assert.equal(unreadableChild.processed,1);
  assert.match(unreadableChild.issues.join('\n'),/fixture permission denied/);
  delete globalThis.importUnreadable;
  // Cancel after the first successful import, retaining it; resume imports only the remainder.
  const cancelRoot=path.join(temporary,'cancel'); await fs.mkdir(cancelRoot);
  for(let i=0;i<3;i++) await fs.writeFile(path.join(cancelRoot,`${i}.pdf`),'%PDF-1.7\ncancel');
  const controller=new AbortController();
  const cancelled=await importLibrary('folder',cancelRoot,{signal:controller.signal,onProgress:p=>{if(p.processed===1)controller.abort();}});
  assert.equal(cancelled.cancelled,true); assert.equal(cancelled.processed,1); assert.equal(cancelled.imported,1);
  const continued=await importLibrary('folder',cancelRoot);
  assert.equal(continued.imported,2); assert.equal(continued.skipped,1);
  // The generic folder source migrates prior 小绿鲸 identities instead of copying files again.
  db.prepare('UPDATE library_import_items SET source_id=? WHERE source_id=?').run('xiaolvjing:'+folder,'folder:'+folder);
  const migrated=await importLibrary('folder',folder);
  assert.equal(migrated.imported,0); assert.equal(migrated.skipped,2);
  assert.equal(db.prepare('SELECT count(*) n FROM library_import_items WHERE source_id=?').get('xiaolvjing:'+folder).n,0);
  // Known library folders with actual PDFs are found; empty apps and generic private folders are not.
  const discoveryHome=path.join(temporary,'home');
  const documentRoot=path.join(discoveryHome,'Documents');
  await fs.mkdir(path.join(documentRoot,'Papers'),{recursive:true});
  await fs.mkdir(path.join(documentRoot,'Scholaread'),{recursive:true});
  await fs.mkdir(path.join(documentRoot,'Private'),{recursive:true});
  await fs.writeFile(path.join(documentRoot,'Papers','discovered.pdf'),'%PDF-1.7\nauto');
  await fs.writeFile(path.join(documentRoot,'Private','not-a-library.pdf'),'%PDF-1.7\nprivate');
  await fs.symlink(path.join(documentRoot,'Papers'),path.join(documentRoot,'文献库'));
  const discovery={home:discoveryHome,roots:[discoveryHome,documentRoot]};
  const found=await discoverLibraries(discovery);
  assert.equal(found.length,2); assert.equal(found.filter(x=>x.source==='zotero').length,1);
  assert.equal(found.filter(x=>x.source==='folder').length,1);
  assert(!found.some(x=>/Scholaread|Private/.test(x.path)));
  const autoEvents=[];
  const automatic=await importDiscoveredLibraries({discovery,onProgress:p=>autoEvents.push(p)});
  assert.equal(automatic.imported,1); assert.equal(automatic.sources.length,2);
  assert.equal(autoEvents[0].phase,'discovering');
  assert(autoEvents.some(p=>p.phase==='importing'));
  const again=await importDiscoveredLibraries({discovery});assert.equal(again.imported,0);
  // A PDF library may contain a complete Zotero library: retain both sources without
  // importing Zotero storage as anonymous folder PDFs or losing the parent's papers.
  const nested=path.join(documentRoot,'Papers','ZoteroDB');
  await fs.mkdir(nested);
  fixture.prepare('VACUUM INTO ?').run(path.join(nested,'zotero.sqlite'));
  await fs.cp(path.join(zotero,'storage'),path.join(nested,'storage'),{recursive:true});
  await fs.writeFile(path.join(documentRoot,'Papers','alongside.pdf'),'%PDF-1.7\nalongside');
  const nestedSources=await discoverLibraries(discovery);
  const canonicalPapers=await fs.realpath(path.join(documentRoot,'Papers'));
  const canonicalNested=await fs.realpath(nested);
  assert.equal(nestedSources.length,3);
  assert(nestedSources.some(source=>source.source==='folder' && source.path===canonicalPapers));
  assert(nestedSources.some(source=>source.source==='zotero' && source.path===canonicalNested));
  const combined=await importDiscoveredLibraries({discovery});
  assert.equal(combined.imported,3,'parent PDF and two Zotero attachments are all imported');
  const folderMappings=db.prepare('SELECT item_key FROM library_import_items WHERE source_id=?').all('folder:'+canonicalPapers);
  assert.equal(folderMappings.length,2,'folder importer skips nested Zotero storage');
  assert(folderMappings.every(row=>!row.item_key.includes('ZoteroDB')));
  assert.equal((await importDiscoveredLibraries({discovery})).imported,0);
  const cancelDiscovery=new AbortController();
  const cancelledDiscovery=await importDiscoveredLibraries({discovery,signal:cancelDiscovery.signal,onProgress:p=>{if(p.phase==='discovering')cancelDiscovery.abort();}});
  assert.equal(cancelledDiscovery.cancelled,true);assert.equal(cancelledDiscovery.imported,0);
  await assert.rejects(importLibrary('folder',profile),/自身/);
  assert.equal(await fs.readFile(path.join(zotero,'storage','PDFONE','paper.pdf'),'utf8'),'%PDF-1.7\noriginal fixture');
  assert.equal(fixture.prepare('SELECT count(*) n FROM items').get().n,10);
  fixture.close();
  await assert.rejects(importLibrary('zotero',folder),/zotero.sqlite/);
  await assert.rejects(importLibrary('bad',folder),/来源/);
  console.log('PASS Zotero WAL read-only import, metadata/tags, all PDF attachments, deep collections, missing/deleted records, stable dedup/repair, folder metadata, failure cleanup/retry, cancellation/resume, original preservation');
} finally {target?.close();await fs.rm(temporary,{recursive:true,force:true});}
