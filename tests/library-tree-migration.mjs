/** Classification contract and legacy migration: isolated databases and source files only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const project=process.cwd(), tmp=await fs.mkdtemp(path.join(os.tmpdir(),'scholarlite-tree-'));
const profile=path.join(tmp,'app'), home=path.join(tmp,'home'), sourceRoot=path.join(home,'Zotero');
let db,source;
try {
  await fs.mkdir(sourceRoot,{recursive:true}); await fs.mkdir(path.join(profile,'library'),{recursive:true});
  source=new DatabaseSync(path.join(sourceRoot,'zotero.sqlite'));
  source.exec(`CREATE TABLE items(itemID INTEGER PRIMARY KEY,itemTypeID INTEGER,key TEXT,libraryID INTEGER);
    CREATE TABLE itemTypes(itemTypeID INTEGER,typeName TEXT); INSERT INTO itemTypes VALUES(1,'journalArticle'),(2,'attachment');
    CREATE TABLE deletedItems(itemID INTEGER); CREATE TABLE itemData(itemID INTEGER,fieldID INTEGER,valueID INTEGER);
    CREATE TABLE fields(fieldID INTEGER,fieldName TEXT); CREATE TABLE itemDataValues(valueID INTEGER,value TEXT);
    CREATE TABLE creators(creatorID INTEGER,firstName TEXT,lastName TEXT); CREATE TABLE itemCreators(itemID INTEGER,creatorID INTEGER,creatorTypeID INTEGER,orderIndex INTEGER);
    CREATE TABLE tags(tagID INTEGER,name TEXT); CREATE TABLE itemTags(itemID INTEGER,tagID INTEGER);
    CREATE TABLE collections(collectionID INTEGER,collectionName TEXT,parentCollectionID INTEGER,libraryID INTEGER,key TEXT);
    CREATE TABLE deletedCollections(collectionID INTEGER); CREATE TABLE collectionItems(itemID INTEGER,collectionID INTEGER);
    CREATE TABLE itemAttachments(itemID INTEGER,parentItemID INTEGER,path TEXT,contentType TEXT);
    INSERT INTO items VALUES(1,1,'PARENT',1),(2,2,'A',1),(3,2,'B',1),(4,2,'C',1);
    INSERT INTO fields VALUES(1,'title'); INSERT INTO itemDataValues VALUES(1,'Source article'); INSERT INTO itemData VALUES(1,1,1);
    INSERT INTO collections VALUES(1,'Topics',NULL,1,'TOP'),(2,'A / B',1,1,'CHILD'),(3,'Methods',2,1,'LEAF'),(4,'Deleted',NULL,1,'DELETED'),(5,'Deleted child',4,1,'DELETEDCHILD');
    INSERT INTO deletedCollections VALUES(4); INSERT INTO collectionItems VALUES(1,3),(1,4),(1,5);
    INSERT INTO itemAttachments VALUES(2,1,'storage:paper.pdf','application/pdf'),(3,1,'storage:paper.pdf','application/pdf'),(4,1,'storage:paper.pdf','application/pdf');`);
  for(const key of ['A','B','C']) { await fs.mkdir(path.join(sourceRoot,'storage',key),{recursive:true}); await fs.writeFile(path.join(sourceRoot,'storage',key,'paper.pdf'),'%PDF-1.7\nfixture'); }
  const fakeProfile=path.join(home,'Library/Application Support/Zotero/Profiles/default'); await fs.mkdir(fakeProfile,{recursive:true});
  await fs.writeFile(path.join(fakeProfile,'prefs.js'),`user_pref("extensions.zotero.useDataDir", false);\nuser_pref("extensions.zotero.baseAttachmentPath", ${JSON.stringify(path.join(sourceRoot,'storage','A'))});`);
  const outfile=path.join(tmp,'bundle.mjs');
  await build({stdin:{contents:"export {db,papers,collections,notes,progress} from './electron/db.ts'; export * from './electron/library-import.ts'; export * from './electron/library-import-migration.ts'; export * from './renderer/src/lib/library.ts';",resolveDir:project},bundle:true,platform:'node',format:'esm',outfile,plugins:[{name:'isolated',setup(b){
    b.onResolve({filter:/^(electron|node:os)$/},args=>({path:args.path,namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path==='electron'?`export const app={getPath:()=>${JSON.stringify(profile)},getAppPath:()=>${JSON.stringify(project)}};`:`export default {homedir:()=>${JSON.stringify(home)}};`}));
  }}]});
  const m=await import(pathToFileURL(outfile)); ({db}=m);
  const sourceId='zotero:'+await fs.realpath(sourceRoot);
  const legacyRoot=m.collections.create('Zotero');
  const flat=m.collections.create('Topics / A / B / Methods',legacyRoot.id);
  const local=m.collections.create('My local category');
  const renamed=m.collections.create('Locally renamed',legacyRoot.id);
  const create=key=>m.papers.create({title:'Imported '+key,fileName:key+'.pdf',collectionIds:[legacyRoot.id,flat.id],importSource:{sourceId,itemKey:'1:'+key}});
  const a=create('A'),b=create('B'),c=create('C');
  m.collections.addPapers([a.id],[local.id]); m.collections.setForPaper(b.id,[legacyRoot.id,renamed.id]); m.collections.setForPaper(c.id,[local.id]);
  m.notes.create({paperId:a.id,body:'Keep my note'}); m.progress.set(a.id,{page:3,scroll:.2,mode:'reflow'});
  const stable=m.papers.list().map(p=>({id:p.id,file:p.fileName,title:p.title}));
  const preview=await m.migrateLegacyImportCollections();
  assert.equal(preview.migratedPapers,1); assert.equal(preview.skippedPapers,1);
  assert.equal(m.collections.list().length,4,'dry run changes nothing');
  db.exec("CREATE TEMP TRIGGER fail_migration BEFORE INSERT ON paper_collections WHEN NEW.paper_id='"+a.id+"' BEGIN SELECT RAISE(ABORT,'migration rollback'); END;");
  await assert.rejects(m.migrateLegacyImportCollections({dryRun:false}),/migration rollback/);
  assert.equal(m.collections.list().length,4); assert.equal(db.prepare('SELECT COUNT(*) n FROM library_import_collection_nodes').get().n,0);
  db.exec('DROP TRIGGER fail_migration');
  const migrated=await m.migrateLegacyImportCollections({dryRun:false});
  assert.equal(migrated.migratedPapers,1);
  assert.deepEqual(m.papers.list().map(p=>({id:p.id,file:p.fileName,title:p.title})),stable);
  assert.equal(m.notes.list(a.id)[0].body,'Keep my note'); assert.equal(m.progress.get(a.id).page,3);
  const tree=m.collections.list(); const top=tree.find(n=>n.name==='Topics'),child=tree.find(n=>n.name==='A / B'),leaf=tree.find(n=>n.name==='Methods');
  assert.equal(top.parentId,null); assert.equal(child.parentId,top.id); assert.equal(leaf.parentId,child.id);
  assert.equal(m.collectionLabel(leaf.id,tree),'Topics / A / B / Methods');
  assert.equal(m.collectionOptions(tree).filter(n=>[top.id,child.id,leaf.id].includes(n.id)).map(n=>n.id).join(','),[top.id,child.id,leaf.id].join(','));
  assert(m.scopePaper(m.papers.get(a.id),top.id,tree));
  assert.deepEqual(new Set(m.papers.get(a.id).collectionIds),new Set([local.id,leaf.id]));
  assert.deepEqual(new Set(m.papers.get(b.id).collectionIds),new Set([legacyRoot.id,renamed.id]));
  assert.deepEqual(m.papers.get(c.id).collectionIds,[local.id]);
  assert.equal((await m.migrateLegacyImportCollections({dryRun:false})).migratedPapers,0);
  assert.throws(()=>m.collections.update(top.id,{name:'Topics',parentId:leaf.id}),/自身或其子分类/);
  m.collections.update(child.id,{name:'User name',parentId:local.id});
  assert.equal(m.collectionLabel(leaf.id,m.collections.list()),'My local category / User name / Methods');
  m.collections.removePapers([a.id],local.id); assert.deepEqual(m.papers.get(a.id).collectionIds,[]);
  // Repair a missing file without restoring any source classifications.
  const repair=await m.importLibrary('zotero',sourceRoot); assert.equal(repair.imported,3);
  assert.deepEqual(m.papers.get(a.id).collectionIds,[]); assert.deepEqual(m.papers.get(c.id).collectionIds,[local.id]);
  // The default data directory uses its profile's linked-attachment base path.
  source.exec("INSERT INTO items VALUES(5,2,'LINK',1); INSERT INTO itemAttachments VALUES(5,1,'attachments:paper.pdf','application/pdf');");
  const linked=await m.importLibrary('zotero',sourceRoot); assert.equal(linked.imported,1); assert.equal(linked.failed,0);
  assert(!linked.issues.some(text=>text.includes('基础目录')));
  assert.equal(m.collections.list().filter(n=>n.name==='User name').length,1,'source rename does not undo local rename');
  // A user-deleted imported tree is a tombstone for later new items from that source.
  m.collections.remove(child.id);
  source.exec("INSERT INTO items VALUES(6,2,'LINK2',1); INSERT INTO itemAttachments VALUES(6,1,'attachments:paper.pdf','application/pdf');");
  await m.importLibrary('zotero',sourceRoot);
  assert(!m.collections.list().some(n=>n.name==='A / B'||n.name==='Methods'));
  const last=db.prepare('SELECT paper_id FROM library_import_items WHERE source_id=? AND item_key=?').get(sourceId,'1:LINK2');
  assert.deepEqual(m.papers.get(last.paper_id).collectionIds,[]);
  assert(!m.collections.list().some(n=>n.name==='Deleted'||n.name==='Deleted child'));
  // Distinct external sources with equal display names must not share classification identity.
  const otherRoot=path.join(tmp,'OtherZotero');
  await fs.mkdir(otherRoot); source.prepare('VACUUM INTO ?').run(path.join(otherRoot,'zotero.sqlite'));
  await fs.cp(path.join(sourceRoot,'storage'),path.join(otherRoot,'storage'),{recursive:true});
  const otherImport=await m.importLibrary('zotero',otherRoot);
  assert.equal(otherImport.imported,3);
  const duplicateTop=m.collections.list().find(n=>n.name==='Topics (2)');
  assert(duplicateTop); assert.equal(duplicateTop.parentId,null);
  assert(m.collections.list().some(n=>n.name==='A / B'&&n.parentId===duplicateTop.id));
  assert.equal(db.prepare('SELECT collection_id FROM library_import_collection_nodes WHERE source_id=? AND external_key=?').get(sourceId,'1:CHILD').collection_id,null);
  console.log('PASS true multilevel tree, slash-in-name identity, parent scope/move/cycle/removal, dry-run and atomic migration, local edits/notes/progress, default linked attachments, deletion tombstones');
} finally { source?.close(); db?.close(); await fs.rm(tmp,{recursive:true,force:true}); }
