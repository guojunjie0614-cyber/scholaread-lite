import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-claude-protocol-'));
try {
  const fixture = path.join(root, 'claude-fixture');
  await fs.writeFile(fixture, `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
fs.writeFileSync(${JSON.stringify(path.join(root, 'args.json'))},JSON.stringify(process.argv.slice(2)));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.type!=='user') process.exit(2);
 const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
 emit({type:'system',session_id:'native-claude'});
 emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'使用本机配置'}}});
 emit({type:'result',subtype:'success',result:'使用本机配置'});
});`, { mode: 0o700 });
  const outfile = path.join(root, 'claude.mjs');
  await build({ entryPoints: [path.resolve(import.meta.dirname, '../electron/chat/claude.ts')], outfile, bundle: true, platform: 'node', format: 'esm' });
  const { runClaude } = await import(pathToFileURL(outfile).href);
  let text = '';
  const input = { executable: fixture, cwd: root, config: {}, prompt: '解释论文', images: [], history: [], signal: new AbortController().signal,
    onText: value => text += value, onSession: () => {} };
  await runClaude(input);
  let args = JSON.parse(await fs.readFile(path.join(root, 'args.json'), 'utf8'));
  assert.equal(text, '使用本机配置');
  for (const flag of ['--restricted', '--bare', '--setting-sources', '--model', '--effort']) assert(!args.includes(flag), `default connection must not override ${flag}`);
  assert(args.includes('--safe-mode'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  await runClaude({ ...input, sessionId: 'native-claude', config: { model: 'chosen-model', effort: 'high' } });
  args = JSON.parse(await fs.readFile(path.join(root, 'args.json'), 'utf8'));
  assert.equal(args[args.indexOf('--resume') + 1], 'native-claude');
  assert.equal(args[args.indexOf('--model') + 1], 'chosen-model');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  console.log('Claude CLI: native auth/model settings preserved, tools disabled, explicit model/effort/resume passed.');
} finally { await fs.rm(root, { recursive: true, force: true }); }
