import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-models-'));
const project = path.resolve(import.meta.dirname, '..');
const bundle = async (entry, name, plugins = []) => {
  const outfile = path.join(root, `${name}.mjs`);
  await build({ entryPoints: [path.join(project, entry)], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', plugins });
  return import(pathToFileURL(outfile).href);
};
try {
  const { codexModels, claudeModels, agyModels, createModelCatalog, normalizeAgySelection } = await bundle('electron/chat/catalog.ts', 'catalog');
  const codexRows = [
    { model: 'model-a', displayName: 'Model A', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low', inputModalities: ['text', 'image'], isDefault: true },
    { model: 'model-b', supportedReasoningEfforts: [], inputModalities: ['text'] },
    { model: 'hidden-model', hidden: true },
  ];
  const claudeRows = [
    { value: 'default', displayName: 'native default', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
    { value: 'haiku', displayName: 'Haiku', supportsEffort: false },
  ];
  assert.deepEqual(codexModels(codexRows).map(model => model.reasoningLevels), [['low', 'high'], []]);
  assert.equal(codexModels(codexRows)[1].images, false);
  assert.deepEqual(claudeModels(claudeRows).map(model => model.reasoningLevels), [['low', 'medium', 'high'], []]);
  assert.equal(claudeModels(claudeRows)[0].model, '');
  assert.throws(() => agyModels('Fetching models...'), /格式/);
  assert.throws(() => agyModels('fetching available models...'), /格式/);
  const agyText = agyModels('gemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-4-argon-high\tGemini 4 Argon (High)\n');
  assert.deepEqual(agyText.map(model => model.model), ['gemini-4-argon']);
  assert.deepEqual(agyText.map(model => model.label), ['Gemini 4 Argon']);
  assert.deepEqual(agyText[0].reasoningLevels, ['medium', 'high']);
  assert.deepEqual(agyText[0].reasoningVariants, { medium: 'gemini-4-argon-medium', high: 'gemini-4-argon-high' });
  assert.equal(agyText[0].defaultReasoningEffort, 'medium');
  assert.equal(normalizeAgySelection(agyText, 'gemini-4-argon-high', '').model, 'gemini-4-argon');
  assert.equal(normalizeAgySelection(agyText, 'gemini-4-argon-high', '').effort, 'high');
  assert.equal(normalizeAgySelection(agyText, 'gemini-4-argon', '').effort, 'medium');
  assert.throws(() => agyModels('gemini-4-argon-high\tGemini 4 Argon (High)\nWarning: response truncated'), /格式/);
  assert.deepEqual(agyModels(JSON.stringify({ models: [{ id: 'structured-model', supportedEffortLevels: ['low', 'high'] }] }))[0].reasoningLevels, ['low', 'high']);

  const fixture = async (name, body) => {
    const file = path.join(root, name);
    await fs.writeFile(file, '#!/usr/bin/env node\n' + body, { mode: 0o700 });
    return file;
  };
  const codex = await fixture('codex', `const write=x=>process.stdout.write(JSON.stringify(x)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize') write({id:m.id,result:{}});
else if(m.method==='model/list') write({id:m.id,result:{data:${JSON.stringify(codexRows)}}});
else if(m.method!=='initialized') process.exit(21);});`);
  const claude = await fixture('claude', `const write=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(!process.argv.includes('--safe-mode')) process.exit(22);
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.type!=='control_request'||m.request.subtype!=='initialize') process.exit(23);
write({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:${JSON.stringify(claudeRows)},account:{secret:'DO-NOT-EXPOSE'},commands:[{description:'DO-NOT-EXPOSE'}]}}});});`);
  const agy = await fixture('agy', `if(process.argv[2]!=='models') process.exit(24);process.exit(1);`);
  const provider = (id, executablePath, config = {}) => ({ id, label: id, executablePath, config, available: true, images: true });
  const getCatalog = createModelCatalog(root, () => [provider('codex', codex), provider('claude', claude), provider('agy', agy, { model: 'configured-agy' })]);
  const catalog = await getCatalog();
  assert.equal(catalog.models.length, 7);
  assert.deepEqual(catalog.models.find(model => model.id === 'codex:default').reasoningLevels, ['low', 'high']);
  assert(!JSON.stringify(catalog).includes('DO-NOT-EXPOSE'));
  assert.equal(catalog.models.at(-1).source, 'configured');
  assert.deepEqual(catalog.models.at(-1).reasoningLevels, []);
  assert.equal(catalog.errors[0].providerId, 'agy');
  const agyListing = await fixture('agy-listing', "process.stdout.write('gemini-4-argon-high\\tGemini 4 Argon (High)\\n');");
  const listed = await createModelCatalog(root, () => [provider('agy', agyListing)])();
  assert.equal(listed.errors, undefined);
  assert.equal(listed.models.find(model => model.model === 'gemini-4-argon').label, 'Gemini 4 Argon');
  assert.equal(listed.models.find(model => model.model === 'gemini-4-argon').defaultReasoningEffort, 'high', 'without medium, select the lowest listed effort');
  assert.equal(await getCatalog(), catalog, 'same runtime/config reuses its bounded directory cache');
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 5 * 60 * 1000;
    assert.equal(await getCatalog(), catalog, 'sending after a minute must not refresh unrelated runtime directories');
  } finally { Date.now = realNow; }
  assert.notEqual(await getCatalog(true), catalog, 'explicit refresh rereads native directories');
  await assert.rejects(() => getCatalog('yes'), /刷新参数/);
  const absentCatalog = await createModelCatalog(root, () => [{ ...provider('codex', null, { model: 'kept-model' }), available: false }])();
  assert.equal(absentCatalog.models[0].model, 'kept-model');
  assert.equal(absentCatalog.errors.length, 1);
  let available = true;
  const availabilityCatalog = createModelCatalog(root, () => [{ ...provider('agy', agyListing), available, unavailableReason: available ? undefined : 'integration paused' }]);
  const beforeGate = await availabilityCatalog();
  available = false;
  const afterGate = await availabilityCatalog();
  assert.notEqual(afterGate, beforeGate, 'availability/reason changes invalidate the directory cache');
  assert.equal(afterGate.models.length, 0);
  assert.equal(afterGate.errors[0].message, 'integration paused');

  const database = path.join(root, 'test.db');
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE papers(id TEXT PRIMARY KEY); INSERT INTO papers VALUES('paper');
CREATE TABLE chat_conversations(id TEXT PRIMARY KEY,paper_id TEXT NOT NULL,title TEXT NOT NULL,provider_id TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',session_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
INSERT INTO chat_conversations VALUES('before-migration','paper','old conversation','codex','model-a','old-native','2026-01-01','2026-01-01');`);
  const { createChatStore } = await bundle('electron/chat/store.ts', 'store');
  const store = createChatStore(db);
  assert(db.prepare('PRAGMA table_info(chat_conversations)').all().some(column => column.name === 'effort'));
  assert.equal(store.get('before-migration').contextMode, 'paper', 'existing conversations remain in paper mode after additive migration');
  assert.equal(store.session('before-migration'), 'old-native');
  const old = store.create('paper', 'codex', 'model-a', 'existing', 'high');
  assert.equal(old.contextMode, 'paper');
  store.setSession(old.id, 'native-old');
  store.selectModel(old.id, 'codex', 'model-b', '');
  assert.equal(store.session(old.id), 'native-old');
  store.selectModel(old.id, 'claude', '', 'medium');
  assert.equal(store.session(old.id), undefined);
  db.close();

  const mockDb = path.join(root, 'mock-db.mjs');
  await fs.writeFile(mockDb, `import {DatabaseSync} from 'node:sqlite';export const db=new DatabaseSync(${JSON.stringify(database)});export const papers={get:id=>id==='paper'?{id,title:'PRIVATE_PAPER_TITLE',authors:['PRIVATE_AUTHOR'],pageCount:2}:null};export const blocks={list:()=>{globalThis.__modelBlockReads=(globalThis.__modelBlockReads??0)+1;return [{id:'paper-body',page:1,text:'PRIVATE_PAPER_BODY'}];}};`);
  const mockPaths = path.join(root, 'mock-paths.mjs');
  await fs.writeFile(mockPaths, `export const paths={root:()=>${JSON.stringify(root)}};`);
  const mockElectron = path.join(root, 'mock-electron.mjs');
  await fs.writeFile(mockElectron, 'export const nativeImage={};');
  const plugin = { name: 'isolated-models', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: mockElectron }));
    b.onResolve({ filter: /^\.\.\/db\.js$/ }, args => args.importer.endsWith('/chat/service.ts') ? { path: mockDb } : null);
    b.onResolve({ filter: /^\.\.\/paths\.js$/ }, args => args.importer.endsWith('/chat/service.ts') ? { path: mockPaths } : null);
  } };
  // Adapter routing remains testable through explicit fixture providers while production stays gated.
  const fixtureProviders = path.join(root, 'fixture-providers.mjs');
  await fs.writeFile(fixtureProviders, `import {createProviderSettings as actual,isAgentId} from ${JSON.stringify(path.join(project, 'electron/chat/providers.ts'))};export {isAgentId};
export function createProviderSettings(root){const settings=actual(root);const list=()=>settings.list().map(provider=>provider.id==='agy'?{...provider,available:Boolean(provider.executablePath),unavailableReason:undefined}:provider);return {...settings,list,get:id=>list().find(provider=>provider.id===id)};}`);
  const fixtureProviderPlugin = { name: 'fixture-runtime-availability', setup(b) {
    b.onResolve({ filter: /^\.\/providers\.js$/ }, args => args.importer.endsWith('/chat/service.ts') ? { path: fixtureProviders } : null);
  } };
  const { createChatService } = await bundle('electron/chat/service.ts', 'service', [plugin, fixtureProviderPlugin]);
  const runs = [];
  const runner = id => async input => {
    runs.push({ id, ...input });
    input.onSession(`${id}-session`);
    await new Promise(resolve => setTimeout(resolve, 10));
    input.onText(`${id} answer`);
  };
  const service = createChatService(path.join(root, 'service'), () => {}, { codex: runner('codex'), claude: runner('claude'), agy: runner('agy') });
  await service.configure('codex', { executablePath: codex, model: 'model-a', effort: 'low' });
  await service.configure('claude', { executablePath: claude });
  await service.configure('agy', { executablePath: agy });
  const state = await service.create({ paperId: 'paper', providerId: 'codex' });
  const id = state.conversation.id;
  assert.equal(state.conversation.effort, 'low');
  const wait = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await service.get(id);
      if (!result.running) return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('fake turn did not complete');
  };
  await service.send({ conversationId: id, text: 'first', model: 'model-a', effort: 'high' });
  await wait();
  assert.equal(runs[0].config.effort, 'high');
  assert.equal(runs[0].sessionId, undefined);
  await service.send({ conversationId: id, text: 'switch model', model: 'model-b', effort: '' });
  let result = await wait();
  assert.equal(runs[1].sessionId, undefined, 'clearing an override restores native defaults in a fresh session');
  assert.equal(runs[1].history.length, 2, 'clearing an override keeps application conversation history');
  assert.equal(runs[1].config.model, 'model-b');
  assert.equal(runs[1].config.effort, undefined, 'explicit default clears previous/provider effort');
  assert.equal(result.messages[1].model, 'model-a');
  assert.equal(result.messages[1].effort, 'high');
  await assert.rejects(() => service.send({ conversationId: id, text: 'bad effort', model: 'model-b', effort: 'high' }), /未提供/);
  assert.equal((await service.get(id)).messages.length, 4);
  await assert.rejects(() => service.send({ conversationId: id, text: 'bad ref', providerId: 'claude', references: [{ paperId: 'other' }] }), /引用无效/);
  assert.equal((await service.get(id)).conversation.providerId, 'codex');
  await service.send({ conversationId: id, text: 'switch runtime', providerId: 'claude', model: '', effort: 'medium' });
  result = await wait();
  assert.equal(runs[2].sessionId, undefined);
  assert.equal(runs[2].history.length, 4);
  assert(runs[2].prompt.includes('first'));
  assert.equal(result.messages.length, 6);
  assert.equal(result.conversation.providerId, 'claude');
  assert.equal(result.messages.at(-1).providerId, 'claude');
  assert.equal(result.messages.at(-1).effort, 'medium');
  const submissions = await Promise.allSettled([
    service.send({ conversationId: id, text: 'one submission', providerId: 'codex', model: 'model-a', effort: 'low' }),
    service.send({ conversationId: id, text: 'duplicate submission', providerId: 'codex', model: 'model-a', effort: 'high' }),
  ]);
  assert.deepEqual(submissions.map(submission => submission.status), ['fulfilled', 'rejected']);
  result = await wait();
  assert.equal(runs[3].sessionId, undefined);
  assert.equal(runs[3].history.length, 6);
  assert.equal(result.messages.length, 8);
  const pendingSend = service.send({ conversationId: id, text: 'cancel preparation', model: 'model-a', effort: 'high' });
  const cancelled = assert.rejects(pendingSend, /取消发送/);
  await service.stop(id);
  await cancelled;
  assert.equal((await service.get(id)).messages.length, 8, 'stopping preparation must not save or execute the pending question');
  await service.send({ conversationId: id, text: 'default model with supported effort', model: '', effort: 'high' });
  result = await wait();
  assert.equal(result.conversation.model, '');
  assert.equal(runs[4].config.model, undefined);
  assert.equal(runs[4].config.effort, 'high');
  assert.equal(runs[4].history.length, 8);
  await assert.rejects(() => service.create({ paperId: 'paper', providerId: 'codex', contextMode: 'unknown' }), /上下文模式/);
  const general = await service.create({ paperId: 'paper', providerId: 'codex', contextMode: 'general' });
  const waitFor = async (conversationId, target = service) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await target.get(conversationId);
      if (!result.running) return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('fake conversation did not complete');
  };
  assert.equal(general.conversation.contextMode, 'general');
  const beforeReads = globalThis.__modelBlockReads;
  await service.send({ conversationId: general.conversation.id, text: 'ordinary question', scope: 'paper' });
  const firstGeneral = await waitFor(general.conversation.id);
  const generalRun = runs.at(-1);
  assert.equal(generalRun.contextMode, 'general');
  assert.equal(generalRun.sessionId, undefined, 'a general conversation starts its own native session');
  assert.equal(globalThis.__modelBlockReads, beforeReads, 'general scope must never load paper body');
  assert(!/PRIVATE_PAPER|PRIVATE_AUTHOR|论文阅读助手|论文资料|论文信息/.test(generalRun.prompt));
  assert(generalRun.prompt.includes('ordinary question'));
  const reference = { id: 'general-reference', paperId: 'paper', title: 'ignored title', page: 1, blockIds: ['paper-body'], quote: 'explicit excerpt' };
  await service.send({ conversationId: general.conversation.id, text: 'explain attached reference', scope: 'paper', references: [reference] });
  const referencedGeneral = await waitFor(general.conversation.id);
  assert.equal(runs.at(-1).sessionId, 'codex-session');
  assert(runs.at(-1).prompt.includes('explicit excerpt'));
  assert(!runs.at(-1).prompt.includes('PRIVATE_PAPER_BODY'));
  assert.equal(globalThis.__modelBlockReads, beforeReads);
  const generalBranch = await service.fork(general.conversation.id, referencedGeneral.messages[2].id);
  assert.equal(generalBranch.conversation.contextMode, 'general');
  assert.equal(generalBranch.messages.length, firstGeneral.messages.length);
  await service.send({ conversationId: generalBranch.conversation.id, text: 'continue general branch', scope: 'paper' });
  await waitFor(generalBranch.conversation.id);
  assert.equal(runs.at(-1).history.length, 2);
  assert(!/PRIVATE_PAPER|PRIVATE_AUTHOR|论文阅读助手|论文资料|论文信息/.test(runs.at(-1).prompt));
  await service.configure('agy', { executablePath: agyListing, model: 'gemini-4-argon-high' });
  const legacyAgy = await service.create({ paperId: 'paper', providerId: 'agy', contextMode: 'general' });
  assert.equal(legacyAgy.conversation.model, 'gemini-4-argon');
  assert.equal(legacyAgy.conversation.effort, 'high');
  await service.send({ conversationId: legacyAgy.conversation.id, text: 'agy family selection', model: 'gemini-4-argon', effort: 'high' });
  const agyDone = await waitFor(legacyAgy.conversation.id);
  assert.equal(runs.at(-1).config.model, 'gemini-4-argon-high');
  assert.equal(runs.at(-1).config.effort, undefined, 'AGY receives the actual variant slug, never an effort override');
  assert.equal(agyDone.messages.at(-1).model, 'gemini-4-argon');
  assert.equal(agyDone.messages.at(-1).effort, 'high');
  await assert.rejects(() => service.send({ conversationId: legacyAgy.conversation.id, text: 'unlisted effort', model: 'gemini-4-argon', effort: 'low' }), /未提供/);
  const bothAgyListing = await fixture('agy-family-listing', "process.stdout.write('gemini-4-argon-high\\tGemini 4 Argon (High)\\ngemini-4-argon-medium\\tGemini 4 Argon (Medium)\\ngemini-4-argon-low\\tGemini 4 Argon (Low)\\n');");
  await service.configure('agy', { executablePath: bothAgyListing });
  const savedDb = new DatabaseSync(database), savedStore = createChatStore(savedDb);
  const savedVariant = savedStore.create('paper', 'agy', 'gemini-4-argon-high', 'legacy saved', '', 'general');
  savedStore.setSession(savedVariant.id, 'legacy-agy-native');
  await service.send({ conversationId: savedVariant.id, text: 'continue legacy saved variant' });
  let savedResult = await waitFor(savedVariant.id);
  assert.equal(savedResult.conversation.model, 'gemini-4-argon');
  assert.equal(savedResult.conversation.effort, 'high');
  assert.equal(runs.at(-1).sessionId, 'legacy-agy-native');
  assert.equal(runs.at(-1).config.model, 'gemini-4-argon-high');
  await service.send({ conversationId: savedVariant.id, text: 'lower effort', model: 'gemini-4-argon', effort: 'low' });
  savedResult = await waitFor(savedVariant.id);
  assert.equal(runs.at(-1).sessionId, 'agy-session');
  assert.equal(runs.at(-1).config.model, 'gemini-4-argon-low');
  assert.equal(runs.at(-1).config.effort, undefined);
  assert.equal(savedResult.messages[1].effort, 'high', 'later family effort changes must not relabel prior responses');
  await service.send({ conversationId: savedVariant.id, text: 'family default', model: 'gemini-4-argon', effort: '' });
  savedResult = await waitFor(savedVariant.id);
  assert.equal(savedResult.conversation.effort, 'medium');
  assert.equal(runs.at(-1).config.model, 'gemini-4-argon-medium');
  savedDb.close();
  // A custom model has no discovered capability list; an empty fallback is not a refusal.
  await service.configure('codex', { executablePath: codex, model: 'custom-model', effort: 'high' });
  const custom = await service.create({ paperId: 'paper', providerId: 'codex', contextMode: 'general' });
  await service.send({ conversationId: custom.conversation.id, text: 'custom configured effort', model: 'custom-model', effort: 'high' });
  await waitFor(custom.conversation.id);
  assert.equal(runs.at(-1).config.model, 'custom-model');
  assert.equal(runs.at(-1).config.effort, 'high');
  const unavailableListing = await fixture('codex-list-unavailable', 'process.exit(1);');
  await service.configure('codex', { executablePath: unavailableListing });
  const failedCatalog = await service.catalog(true);
  assert(failedCatalog.errors.some(error => error.providerId === 'codex'));
  await service.send({ conversationId: custom.conversation.id, text: 'catalog unavailable retains saved choice', model: 'custom-model', effort: 'high' });
  await waitFor(custom.conversation.id);
  assert.equal(runs.at(-1).sessionId, 'codex-session');
  assert.equal(runs.at(-1).config.effort, 'high', 'directory outage must not silently drop an existing override');
  await service.send({ conversationId: custom.conversation.id, text: 'recover via Default', model: 'custom-model', effort: '' });
  const defaultRecovery = await waitFor(custom.conversation.id);
  assert.equal(runs.at(-1).config.effort, undefined);
  assert.equal(runs.at(-1).sessionId, undefined, 'Default must clear the native session override, not merely change its label');
  assert.equal(runs.at(-1).history.length, 4);
  assert.equal(defaultRecovery.conversation.effort, '');
  await service.configure('codex', { executablePath: codex });
  await service.catalog(true);
  const beforeRejected = (await service.get(custom.conversation.id)).messages.length;
  await assert.rejects(() => service.send({ conversationId: custom.conversation.id, text: 'known incapable model', model: 'model-b', effort: 'high' }), /未提供/);
  assert.equal((await service.get(custom.conversation.id)).messages.length, beforeRejected, 'an explicit runtime refusal still prevents submitting a turn');
  const productionGateModule = await bundle('electron/chat/service.ts', 'production-gate-service', [plugin]);
  const gated = productionGateModule.createChatService(path.join(root, 'gated-service'), () => {}, { codex: runner('codex'), claude: runner('claude'), agy: runner('agy') });
  await gated.configure('codex', { executablePath: codex });
  await gated.configure('claude', { executablePath: claude });
  const marker = path.join(root, 'agy-should-not-start');
  const blockedExecutable = await fixture('blocked-agy', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');process.exit(1);`);
  const gatedProviders = await gated.configure('agy', { executablePath: blockedExecutable, model: 'kept-model' });
  const paused = gatedProviders.find(provider => provider.id === 'agy');
  assert.equal(paused.available, false);
  assert(paused.unavailableReason.includes('暂缓'));
  const gatedCatalog = await gated.catalog();
  assert.equal(gatedCatalog.errors.find(error => error.providerId === 'agy').message, paused.unavailableReason);
  const preserved = await gated.create({ paperId: 'paper', providerId: 'agy', contextMode: 'general' });
  await assert.rejects(() => gated.send({ conversationId: preserved.conversation.id, text: 'do not run' }), error => error.message === paused.unavailableReason);
  assert.equal((await gated.get(preserved.conversation.id)).messages.length, 0);
  await assert.rejects(() => fs.access(marker), /ENOENT/);
  const oldPaused = await gated.get(savedVariant.id);
  await assert.rejects(() => gated.send({ conversationId: savedVariant.id, text: 'still paused' }), error => error.message === paused.unavailableReason);
  assert.deepEqual((await gated.get(savedVariant.id)).messages, oldPaused.messages, 'pausing a connection preserves all existing messages');
  await gated.send({ conversationId: savedVariant.id, text: 'continue through available model', providerId: 'codex', model: 'model-a', effort: 'low' });
  const switchedFromPaused = await waitFor(savedVariant.id, gated);
  assert.equal(switchedFromPaused.conversation.providerId, 'codex');
  assert.equal(switchedFromPaused.messages.length, oldPaused.messages.length + 2);
  assert.deepEqual(switchedFromPaused.messages.slice(0, oldPaused.messages.length), oldPaused.messages);
  assert.equal(runs.at(-1).history.length, oldPaused.messages.length);
  service.stopAll();
  console.log('Model catalog: native capability parsing, configuration fallback, safe initialization, migration, model/effort routing, preserved cross-runtime history and concurrent-send protection passed.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
