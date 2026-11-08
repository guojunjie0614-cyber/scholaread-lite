import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-agy-test-'));
try {
  const modulePath = path.join(directory, 'agy.mjs');
  await build({ entryPoints: ['electron/chat/agy.ts'], bundle: true, platform: 'node', format: 'esm', outfile: modulePath });
  const { runAgy } = await import(pathToFileURL(modulePath).href);
  const fixture = path.join(directory, 'fake-agy.mjs');
  await fs.writeFile(fixture, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const argv = process.argv.slice(2);
if (argv.includes('--effort')) throw Error('AGY must receive the resolved model slug without effort');
const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
if (!settings.permissions.deny.includes('command(*)')) throw Error('command permission missing');
if (argv.includes('--dangerously-skip-permissions')) throw Error('unrestricted invocation');
const emit = object => process.stdout.write(JSON.stringify(object)+'\\n');
let initialized=false;
const badInit=argv[argv.indexOf('--model')+1]==='bad-init';
if(badInit)process.on('SIGTERM',()=>{emit({event:'result',result:{status:'ERROR',error:'stream input cancelled: context canceled'}});process.exit(1);});
setTimeout(()=>{initialized=true;emit({event:'init', conversation_id:'native-agy-session', init:{tools:badInit?['view_file','run_command']:['view_file']}});},25);
for await (const line of readline.createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  if (input.event !== 'user' || typeof input.message.content !== 'string') throw Error('input format');
  if(badInit)throw Error('user message must not be sent when tool configuration is unconfirmed');
  if(!initialized){emit({event:'result',result:{status:'ERROR',error:'failed to send message: not_found: trajectory not found'}});process.exit(1);}
  const text = input.message.content;
  if (text.startsWith('eof-race')) {
    let completed=false;
    process.stdin.once('end',()=>{if(!completed){emit({event:'result',result:{status:'ERROR',error:'failed to send message: run state not found'}});process.exit(1);}});
    setTimeout(()=>{completed=true;emit({event:'step_update',step_update:{step_type:'agent_response',text_delta:'解释\\n'}});emit({event:'result',result:{conversation_id:'native-agy-session',status:'SUCCESS',response:'解释\\n'}});},80);
    continue;
  }
  if (text.startsWith('error')) { emit({event:'result',result:{status:'ERROR',error:'fixture authentication required'}}); process.exitCode=1; continue; }
  if (text.startsWith('missing')) process.exit(0);
  if (text.startsWith('badtool')) { emit({event:'init',init:{tools:['run_command']}}); continue; }
  if (text.startsWith('stop')) { emit({event:'step_update',step_update:{step_type:'agent_response',text_delta:'partial'}}); setInterval(()=>{},1000); continue; }
  if (text.startsWith('resume') && argv[argv.indexOf('--conversation')+1] !== 'expected-session') throw Error('resume ID not supplied');
  emit({event:'step_update',step_update:{step_type:'agent_response',state:'ACTIVE',text_delta:'解'}});
  const marker = '[Image attachment manifest]';
  if (text.includes(marker) && !text.startsWith('unread')) {
    const files = text.split('\\n').filter(part=>part.startsWith('"')).map(part=>JSON.parse(part));
    for (const file of files) {
      if (fs.readFileSync(file).toString() !== 'image fixture') throw Error('image not persisted');
      emit({event:'step_update',step_update:{step_type:'tool',state:'DONE',tool_name:'view_file',tool_info:{parameters:{AbsolutePath:file},output:'image viewed'}}});
    }
  }
  emit({event:'step_update',step_update:{step_type:'agent_response',state:'DONE',text_delta:'释\\n'}});
  emit({event:'result',result:{conversation_id:'native-agy-session',status:'SUCCESS',response:'解释\\n'}});
}
`, { mode: 0o700 });
  const run = async (prompt, extra = {}) => {
    const cwd = await fs.mkdtemp(path.join(directory, 'session-'));
    const text = [];
    const sessions = [];
    await runAgy({ executable: fixture, cwd, config: {}, prompt, images: [], history: [], signal: new AbortController().signal,
      onText: chunk => text.push(chunk), onSession: id => sessions.push(id), ...extra });
    return { text, sessions, cwd };
  };
  const plain = await run('resume test', { sessionId: 'expected-session' });
  const deferred = await run('eof-race');
  assert.equal(deferred.text.join(''), '解释\n', 'stdin must remain open until the asynchronous native run finishes');
  assert.equal(plain.text.join(''), '解释\n');
  assert.ok(plain.text.length > 1, 'text must stream');
  assert.equal(plain.sessions.at(-1), 'native-agy-session');
  assert.match(await fs.readFile(path.join(plain.cwd, '.agents/agents/scholarlite-reader.md'), 'utf8'), /tools: \[view_file\]/);
  const general = await run('general question', { contextMode: 'general', config: { model: 'resolved-high', effort: 'high' } });
  const generalAgent = await fs.readFile(path.join(general.cwd, '.agents/agents/scholarlite-reader.md'), 'utf8');
  assert(!/scientific|paper/i.test(generalAgent), 'general mode must not install a paper reading role');

  const imagePath = path.join(directory, 'source.png');
  await fs.writeFile(imagePath, 'image fixture');
  const image = { path: imagePath, mime: 'image/png', base64: '' };
  const visual = await run('image test', { images: [image] });
  assert.equal(visual.text.join(''), '解释\n', 'buffered pre-image deltas must not repeat');
  let withheld = '';
  await assert.rejects(() => run('unread image', { images: [image], onText: chunk => { withheld += chunk; } }), /未成功读取全部图片/);
  assert.equal(withheld, '', 'unviewed images must not produce a claimed answer');
  await assert.rejects(() => run('error'), /fixture authentication required/);
  await assert.rejects(() => run('missing result'), /未返回完成状态/);
  await assert.rejects(() => run('badtool'), /只读工具配置/);
  const rejectedSessions=[];
  await assert.rejects(() => run('configuration failure', { config: { model: 'bad-init' }, onSession: value => rejectedSessions.push(value) }), /无法确认只读工具配置已生效/);
  assert.deepEqual(rejectedSessions, [], 'an unconfirmed initialization must not replace the saved native session');

  const controller = new AbortController();
  await assert.rejects(() => run('stop', { signal: controller.signal, onText: () => controller.abort() }), /回答已停止/);
  console.log('agy protocol: streaming, resume, visual reads, failure, missing result, tool restriction and stop passed');
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
