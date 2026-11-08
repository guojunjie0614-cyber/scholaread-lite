import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scholar-visuals-'));
try {
  const out = path.join(root, 'visuals.mjs');
  await build({ entryPoints: ['shared/chat-visuals.ts'], outfile: out, bundle: true, platform: 'node', format: 'esm' });
  const { splitVisualAnswer } = await import(pathToFileURL(out).href);
  const text = '说明\n\n```openui\nroot = Col([Text("数值")]);\n```\n\n结论';
  const parts = splitVisualAnswer(text);
  assert.deepEqual(parts.map(p => p.kind), ['markdown', 'openui', 'markdown']);
  assert.equal(parts[1].complete, true);
  assert.equal(parts[1].text, 'root = Col([Text("数值")]);');
  assert.equal(splitVisualAnswer('```openui\nroot = Col([')[0].complete, false);
  assert.equal(splitVisualAnswer('```openui')[0].text, '');
  assert.equal(splitVisualAnswer('````text\n```openui\nexample\n```\n````')[0].kind, 'markdown');
  assert.equal(splitVisualAnswer('~~~openui\nroot = Col([]);\n~~~')[0].complete, true);
  assert.equal(splitVisualAnswer('普通历史\n\n- 项目')[0].text, '普通历史\n\n- 项目');
  assert.equal(splitVisualAnswer('```python\nprint(1)\n```')[0].kind, 'markdown');
  for (let i = text.indexOf('```openui') + 9; i < text.indexOf('\n```\n\n结论'); i++) {
    const streamed = splitVisualAnswer(text.slice(0, i));
    assert.equal(streamed.at(-1).kind, 'openui');
    assert.equal(streamed.at(-1).complete, false);
  }
  console.log('chat visual framing: passed');
} finally { await fs.rm(root, { recursive: true, force: true }); }
