import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { deflateSync } from 'node:zlib';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-chat-'));
const project = path.resolve(import.meta.dirname, '..');
const database = path.join(root, 'test.db');
const db = new DatabaseSync(database);
db.exec("PRAGMA foreign_keys=ON; CREATE TABLE papers(id TEXT PRIMARY KEY); INSERT INTO papers VALUES('paper-a'); INSERT INTO papers VALUES('paper-b');");
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const crc32 = buffer => {
  let crc = -1;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]), result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE(crc32(body), result.length - 4);
  return result;
};
const header = Buffer.alloc(13); header.writeUInt32BE(1200); header.writeUInt32BE(800, 4); header[8] = 8; header[9] = 6;
const original = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.alloc((1200 * 4 + 1) * 800))), chunk('IEND', Buffer.alloc(0))]);
const largePng = `data:image/png;base64,${original.toString('base64')}`;
const bundle = async (entry, name, plugins = []) => {
  const outfile = path.join(root, `${name}.mjs`);
  await build({ entryPoints: [path.join(project, entry)], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', plugins });
  return import(pathToFileURL(outfile).href);
};
const { createChatStore } = await bundle('electron/chat/store.ts', 'store');
const store = createChatStore(db);
const conversation = store.create('paper-a', 'codex', '');
const message = (id, role, text, status = 'complete') => ({ id, conversationId: conversation.id, role, text,
  references: [], messageReferences: [], attachments: [], status, createdAt: new Date().toISOString() });
store.saveMessage(message('u1', 'user', 'first'));
store.saveMessage(message('a1', 'assistant', 'answer'));
store.saveMessage(message('u2', 'user', 'second'));
store.setSession(conversation.id, 'native-session');
const branch = store.fork(conversation.id, 'u2');
assert.deepEqual(store.messages(branch.id).map(value => value.text), ['first', 'answer']);
assert.equal(store.session(branch.id), undefined);
assert.equal(store.messages(conversation.id).length, 3);
store.saveMessage(message('a2', 'assistant', 'partial', 'streaming'));
store.recover();
assert.equal(store.messages(conversation.id).at(-1).status, 'interrupted');

const codexFixture = path.join(root, 'codex-fixture');
await fs.writeFile(codexFixture, `#!/usr/bin/env node
const readline=require('node:readline');
const write=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line=>{
 const m=JSON.parse(line), p=m.params||{};
 if(m.method==='initialize') write({id:m.id,result:{}});
 if(m.method==='thread/start'||m.method==='thread/resume'){
   if(p.sandbox!=='read-only'||p.approvalPolicy!=='never') process.exit(21);
   if(m.method==='thread/resume'&&p.threadId!=='native-fixture') process.exit(22);
   write({id:m.id,result:{thread:{id:'native-fixture'}}});
 }
 if(m.method==='turn/start'){
   if(p.sandboxPolicy.type!=='readOnly') process.exit(23);
   write({id:m.id,result:{turn:{id:'turn-fixture'}}});
   if(p.input[0].text.includes('fixture-stop')) return;
   write({method:'item/agentMessage/delta',params:{threadId:'native-fixture',itemId:'item-one',delta:'解释'}});
   write({method:'item/agentMessage/delta',params:{threadId:'native-fixture',itemId:'item-one',delta:'完成'}});
   write({method:'item/completed',params:{threadId:'native-fixture',item:{type:'agentMessage',id:'item-one',text:'解释完成'}}});
   if(p.input[0].text.includes('fixture-multiple')) {
     write({method:'item/completed',params:{threadId:'native-fixture',item:{type:'agentMessage',id:'item-two',text:'最终回答'}}});
   }
   if(p.input[0].text.includes('fixture-permissions')) {
     write({id:777,method:'item/permissions/requestApproval',params:{threadId:'native-fixture'}});return;
   }
   write({method:'turn/completed',params:{threadId:'native-fixture',turn:{status:'completed'}}});
 }
 if(m.id===777&&!m.method) {
   if(JSON.stringify(m.result)!==JSON.stringify({permissions:{},scope:'turn'})) process.exit(41);
   write({method:'turn/completed',params:{threadId:'native-fixture',turn:{status:'completed'}}});
 }
 if(m.method==='turn/interrupt') {
   write({id:m.id,result:{}});
   setTimeout(()=>{write({method:'turn/completed',params:{threadId:'native-fixture',turn:{status:'interrupted'}}});process.exit(0);},120);
 }
});
`, { mode: 0o700 });
const { runCodex } = await bundle('electron/chat/codex.ts', 'codex');
let text = '', session;
const agentInput = { executable: codexFixture, config: {}, cwd: root, prompt: 'test', images: [], history: [], signal: new AbortController().signal,
  onText: chunk => text += chunk, onSession: value => session = value };
await runCodex(agentInput);
assert.equal(text, '解释完成'); assert.equal(session, 'native-fixture');
await runCodex({ ...agentInput, sessionId: session });
text = '';
await runCodex({ ...agentInput, prompt: 'fixture-multiple' });
assert.equal(text, '解释完成\n\n最终回答');
await runCodex({ ...agentInput, prompt: 'fixture-permissions' });
const controller = new AbortController();
let abortAt;
const stopped = runCodex({ ...agentInput, prompt: 'fixture-stop', signal: controller.signal,
  onSession: () => { setTimeout(() => { abortAt = Date.now(); controller.abort(); }, 60); },
});
await assert.rejects(stopped, /停止|退出|SIGINT/);
assert(Date.now() - abortAt >= 110, 'stop must consume the native interrupted completion before closing');

const claudeFixture = path.join(root, 'claude-fixture');
await fs.writeFile(claudeFixture, `#!/usr/bin/env node
const readline=require('node:readline');
const args=process.argv.slice(2), write=value=>process.stdout.write(JSON.stringify(value)+'\\n');
if(args.includes('--restricted')||args.includes('--bare')||!args.includes('--safe-mode')||args[args.indexOf('--tools')+1]!=='') process.exit(31);
readline.createInterface({input:process.stdin}).on('line', line=>{
 const m=JSON.parse(line);
 if(m.type!=='user'||m.message.content[0].type!=='text') process.exit(32);
 write({type:'system',session_id:'claude-native'});
 write({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Claude回答'}}});
 write({type:'assistant',message:{content:[{type:'text',text:'Claude回答'}]}});
 write({type:'result',subtype:'success',result:'Claude回答',session_id:'claude-native'});
});
`, { mode: 0o700 });
const { runClaude } = await bundle('electron/chat/claude.ts', 'claude');
text = '';
await runClaude({ ...agentInput, executable: claudeFixture, images: [{ path: '/unused', mime: 'image/png', base64: png.split(',')[1] }], onText: chunk => text += chunk });
assert.equal(text, 'Claude回答');

const { buildChatPrompt, validateReferences } = await bundle('electron/chat/context.ts', 'context');
const paper = { id: 'paper-a', title: '论文 A', authors: [], pageCount: 2 };
assert.throws(() => validateReferences([{ paperId: 'paper-b' }], paper), /引用无效/);
assert.throws(() => buildChatPrompt(paper, [{ id: 'b', text: 'x'.repeat(180001), page: 1 }], { scope: 'paper', text: '全文', conversationId: '' }, []), /上下文预算/);

const mockDb = path.join(root, 'mock-db.mjs');
await fs.writeFile(mockDb, `import {DatabaseSync} from 'node:sqlite';
export const db=new DatabaseSync(${JSON.stringify(database)}); db.exec('PRAGMA foreign_keys=ON');
export const papers={get:id=>id==='paper-a'||id==='paper-b'?{id,title:id,authors:[],pageCount:2}:null};
export const blocks={list:id=>[{id:'block-1',paperId:id,page:1,text:'论文事实。'}]};`);
const mockPaths = path.join(root, 'mock-paths.mjs');
await fs.writeFile(mockPaths, `export const paths={root:()=>${JSON.stringify(root)}};`);
const mockElectron = path.join(root, 'mock-electron.mjs');
await fs.writeFile(mockElectron, `export const nativeImage={createFromBuffer:bytes=>({isEmpty:()=>false,getSize:()=>({width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}),resize:()=>({toDataURL:()=>${JSON.stringify(png)}}),toDataURL:()=> 'data:image/png;base64,'+bytes.toString('base64')})};`);
const plugin = { name: 'chat-test-isolation', setup(b) {
  b.onResolve({ filter: /^electron$/ }, () => ({ path: mockElectron }));
  b.onResolve({ filter: /^\.\.\/db\.js$/ }, args => args.importer.endsWith('/chat/service.ts') ? { path: mockDb } : null);
  b.onResolve({ filter: /^\.\.\/paths\.js$/ }, args => args.importer.endsWith('/chat/service.ts') ? { path: mockPaths } : null);
} };
const { createChatService } = await bundle('electron/chat/service.ts', 'service', [plugin]);
const events = [];
const service = createChatService(path.join(root, 'chat'), event => events.push(event));
await service.configure('codex', { executablePath: codexFixture });
const state = await service.create({ paperId: 'paper-a', providerId: 'codex' });
await service.send({ conversationId: state.conversation.id, text: '解释这张图', attachments: [{ id: 'new', name: 'test.png', mime: 'image/png', dataUrl: largePng }] });
const waitTerminal = async id => {
  for (let n = 0; n < 100; n++) { const current = await service.get(id); if (!current.running) return current; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('fixture run did not finish');
};
let final = await waitTerminal(state.conversation.id);
assert.equal(final.messages.at(-1).status, 'complete');
assert.equal(final.messages.at(-1).text, '解释完成');
assert.equal(final.messages[0].attachments.length, 1);
const originalAttachment = final.messages[0].attachments[0];
assert.equal(originalAttachment.dataUrl, png, 'persisted message only carries a thumbnail');
const beforeImage = await service.fork(state.conversation.id, final.messages[0].id);
assert.equal(beforeImage.messages.length, 0);
await service.send({ conversationId: beforeImage.conversation.id, text: '编辑图像问题', attachments: [originalAttachment] });
const afterImage = await waitTerminal(beforeImage.conversation.id);
assert.equal(afterImage.messages[0].attachments[0].id, originalAttachment.id, 'edit fork must retain the original image ID');
const storedOriginal = await fs.readFile(path.join(root, 'chat', 'attachments', `${originalAttachment.id}.png`));
assert.equal(storedOriginal.readUInt32BE(16), 1200);
assert.equal(storedOriginal.readUInt32BE(20), 800);
assert.deepEqual(storedOriginal, original);
await service.send({ conversationId: state.conversation.id, text: '继续解释' });
final = await waitTerminal(state.conversation.id);
assert.equal(final.messages.length, 4);
const fork = await service.fork(state.conversation.id, final.messages[2].id);
assert.equal(fork.messages.length, 2);
assert.deepEqual(await service.list('paper-b'), []);
await assert.rejects(() => service.send({ conversationId: state.conversation.id, text: '问题', references: [{ paperId: 'paper-b' }] }), /引用无效/);
const beforeFiles = await fs.readdir(path.join(root, 'chat', 'attachments'));
await assert.rejects(() => service.send({ conversationId: state.conversation.id, text: '问题', attachments: [
  { id: '', name: 'valid.png', dataUrl: png }, { id: '', name: 'fake.png', dataUrl: 'data:image/png;base64,aGVsbG8=' },
] }), /格式不符/);
assert.deepEqual(await fs.readdir(path.join(root, 'chat', 'attachments')), beforeFiles, 'invalid later image must not leave earlier files');
assert(events.every(event => event.conversationId === state.conversation.id || event.conversationId === beforeImage.conversation.id));
// History management retains branch images and hides deleted records after reopening.
await service.rename(state.conversation.id, '自定义标题');
assert.equal((await service.get(state.conversation.id)).conversation.title, '自定义标题');
await assert.rejects(() => service.rename(state.conversation.id, '   '), /名称/);
await assert.rejects(() => service.rename(state.conversation.id, 'a\nb'), /名称/);
await service.delete(state.conversation.id);
await assert.rejects(() => service.get(state.conversation.id), /不存在/);
await assert.rejects(() => service.send({ conversationId: state.conversation.id, text: 'deleted' }), /不存在/);
assert(!(await service.list('paper-a')).some(item => item.id === state.conversation.id));
assert(!createChatStore(db).list('paper-a').some(item => item.id === state.conversation.id), 'deleted history remains hidden after store reload');
assert.equal((await service.get(fork.conversation.id)).messages.length, 2, 'deleting parent preserves its fork');
assert.deepEqual(await fs.readFile(path.join(root, 'chat', 'attachments', `${originalAttachment.id}.png`)), original, 'shared branch attachment stays intact');
const restored = await service.restore(state.conversation.id);
assert.equal(restored.conversation.title, '自定义标题');
assert.equal(restored.messages.length, final.messages.length);
assert.equal(events.at(-2).deleted, true);
assert.equal(events.at(-1).state.conversation.id, restored.conversation.id);

// A stopped runner may finish late; it must not overwrite a restored/new run or its session.
const pendingRuns = [], raceEvents = [];
const race = createChatService(path.join(root, 'race'), event => raceEvents.push(event), {
  codex: input => new Promise(resolve => { pendingRuns.push({ input, resolve }); }),
  claude: async () => {}, agy: async () => {},
});
await race.configure('codex', { executablePath: codexFixture });
const racing = await race.create({ paperId: 'paper-b', providerId: 'codex' });
const racingId = racing.conversation.id;
await race.send({ conversationId: racingId, text: 'first run' });
pendingRuns[0].input.onSession('old-session');
pendingRuns[0].input.onText('partial');
await race.delete(racingId);
assert(pendingRuns[0].input.signal.aborted);
const recovered = await race.restore(racingId);
assert.equal(recovered.running, false);
assert.equal(recovered.messages.at(-1).status, 'interrupted');
assert.equal(recovered.messages.at(-1).text, 'partial');
await race.send({ conversationId: racingId, text: 'second run' });
assert.equal(pendingRuns[1].input.sessionId, undefined, 'immediate undo replays in a fresh native session');
pendingRuns[1].input.onSession('new-session');
pendingRuns[0].input.onText('late text');
pendingRuns[0].input.onSession('late-session');
pendingRuns[0].resolve();
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal((await race.get(racingId)).running, true, 'old finalizer must not remove current runner');
assert.equal(store.session(racingId), 'new-session', 'late callback must not replace native session');
pendingRuns[1].input.onText('new answer');
pendingRuns[1].resolve();
await new Promise(resolve => setTimeout(resolve, 10));
const raceFinal = await race.get(racingId);
assert.equal(raceFinal.running, false);
assert.equal(raceFinal.messages[1].text, 'partial');
assert.equal(raceFinal.messages.at(-1).text, 'new answer');
assert.equal(raceFinal.messages.at(-1).status, 'complete');
// Renaming an empty conversation must survive its first message.
const named = await race.create({ paperId: 'paper-b', providerId: 'codex' });
await race.rename(named.conversation.id, '保留我的命名');
await race.send({ conversationId: named.conversation.id, text: 'different first message' });
pendingRuns[2].input.onText('done'); pendingRuns[2].resolve();
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal((await race.get(named.conversation.id)).conversation.title, '保留我的命名');
race.stopAll();
service.stopAll();
db.close();
console.log('Chat backend: history delete/undo/rename, late-run isolation, shared image retention, SQLite branching/recovery, Codex/Claude streams, stop, image persistence, context boundaries and paper isolation passed.');
await fs.rm(root, { recursive: true, force: true });
