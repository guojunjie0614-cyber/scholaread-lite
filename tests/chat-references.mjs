import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-chat-references-'));
const project = path.resolve(import.meta.dirname, '..');
const bundle = async (entry, name, plugins = []) => {
  const outfile = path.join(root, `${name}.mjs`);
  await build({ entryPoints: [path.join(project, entry)], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', plugins });
  return import(pathToFileURL(outfile).href);
};
try {
  const { containsChatQuote, markdownVisibleText } = await bundle('shared/chat-text.ts', 'text');
  const formatted = '**核心思想**：利用权重';
  assert(containsChatQuote(formatted, '核心思想：利用权重'));
  assert(containsChatQuote('## 方法\n\n- **降低**功耗\n- 使用 `a * b`', '方法\n降低功耗\n使用 a * b'));
  assert(containsChatQuote('阅读 [**官方文档**](https://example.com/docs) 了解细节', '阅读 官方文档 了解细节'));
  assert.equal(markdownVisibleText('```text\na * b **原样**\n```'), 'a * b **原样**');
  assert(containsChatQuote('```text\na * b **原样**\n```', 'a * b **原样**'));
  assert(!containsChatQuote('```text\na * b **原样**\n```', 'a b 原样'));
  assert(!containsChatQuote('公式 $x-y$ 与 $x+y$', '公式 xy 与 xy'));
  assert(!containsChatQuote(formatted, '核心思想：任意伪造'));
  assert(!containsChatQuote(formatted, '   '));
  assert(containsChatQuote('| **项** | 值 |\n| --- | --- |\n| 功耗 | 3 W |', '项\t值\n功耗\t3 W'));

  const database = path.join(root, 'test.db'), mockDb = path.join(root, 'mock-db.mjs');
  await fs.writeFile(mockDb, `import { DatabaseSync } from 'node:sqlite';
export const db=new DatabaseSync(${JSON.stringify(database)});
db.exec("PRAGMA foreign_keys=ON; CREATE TABLE papers(id TEXT PRIMARY KEY); INSERT INTO papers VALUES('paper-a');");
export const papers={get:id=>id==='paper-a'?{id,title:'论文 A',authors:[],pageCount:2}:null};
export const blocks={list:id=>[{id:'block-1',paperId:id,page:1,text:'论文事实'}]};`);
  const mockPaths = path.join(root, 'mock-paths.mjs'), mockElectron = path.join(root, 'mock-electron.mjs');
  await fs.writeFile(mockPaths, `export const paths={root:()=>${JSON.stringify(root)}};`);
  await fs.writeFile(mockElectron, 'export const nativeImage={};');
  const plugin = { name: 'reference-test-isolation', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: mockElectron }));
    b.onResolve({ filter: /^\.\.\/db\.js$/ }, args => args.importer.endsWith('/chat/service.ts') ? { path: mockDb } : null);
    b.onResolve({ filter: /^\.\.\/paths\.js$/ }, args => args.importer.endsWith('/chat/service.ts') ? { path: mockPaths } : null);
  } };
  const { createChatService } = await bundle('electron/chat/service.ts', 'service', [plugin]);
  let native = 0;
  const run = async input => { input.onSession(`native-${native++}`); input.onText(formatted); };
  const service = createChatService(path.join(root, 'chat'), () => {}, { codex: run, claude: run, agy: run });
  await service.configure('codex', { executablePath: process.execPath });
  const initial = await service.create({ paperId: 'paper-a', providerId: 'codex' });
  const wait = async id => {
    for (let n = 0; n < 20; n++) {
      const state = await service.get(id); if (!state.running) return state;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('mock turn did not finish');
  };
  await service.send({ conversationId: initial.conversation.id, text: '解释方法' });
  const first = await wait(initial.conversation.id), source = first.messages[1];
  const references = [{ id: 'quote-original', messageId: source.id, quote: '核心思想：利用权重' }];
  await service.send({ conversationId: initial.conversation.id, text: '继续解释', messageReferences: references });
  const second = await wait(initial.conversation.id), quotedUser = second.messages[2];
  assert.equal(quotedUser.messageReferences[0].messageId, source.id);
  await assert.rejects(() => service.send({ conversationId: initial.conversation.id, text: '伪造引用',
    messageReferences: [{ id: 'forged', messageId: source.id, quote: '核心思想：任意伪造' }] }), /引用的对话片段不存在/);

  const edited = await service.fork(initial.conversation.id, quotedUser.id);
  const editedSource = edited.messages[1];
  assert.notEqual(editedSource.id, source.id);
  assert.deepEqual(editedSource.originIds, [source.id]);
  await service.send({ conversationId: edited.conversation.id, text: '编辑引用问题', messageReferences: references });
  const editedComplete = await wait(edited.conversation.id), editedUser = editedComplete.messages[2];
  assert.equal(editedUser.messageReferences[0].messageId, editedSource.id, 'old source ID resolves to this branch source');

  const grandchild = await service.fork(edited.conversation.id, editedUser.id);
  const grandchildSource = grandchild.messages[1];
  assert(grandchildSource.originIds.includes(source.id));
  assert(grandchildSource.originIds.includes(editedSource.id));
  await service.send({ conversationId: grandchild.conversation.id, text: '再次编辑引用问题', messageReferences: references });
  const grandchildComplete = await wait(grandchild.conversation.id);
  assert.equal(grandchildComplete.messages[2].messageReferences[0].messageId, grandchildSource.id, 'ancestor-of-ancestor resolves to newest source');

  // Copy a user which already quotes another copied message, then check its stored link.
  await service.send({ conversationId: initial.conversation.id, text: '第三问' });
  const third = await wait(initial.conversation.id);
  const copied = await service.fork(initial.conversation.id, third.messages[4].id);
  assert.equal(copied.messages[2].messageReferences[0].messageId, copied.messages[1].id);
  await assert.rejects(() => service.send({ conversationId: copied.conversation.id, text: '其他分支伪造来源',
    messageReferences: [{ id: 'foreign', messageId: grandchildComplete.messages[3].id, quote: '核心思想：利用权重' }] }), /引用的对话片段不存在/);
  service.stopAll();
  console.log('Chat references: rendered Markdown selection validation, preserved code/math, edited references, fork-of-fork ancestry and source isolation passed.');
} finally { await fs.rm(root, { recursive: true, force: true }); }
