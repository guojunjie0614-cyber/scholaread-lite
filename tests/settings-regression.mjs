/** Exercise real filesystem failures without touching the user's settings. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'scholarlite-settings-test-'));
const config = path.join(temporary, 'config.json');
const staging = `${config}.tmp`;
const bundlePath = path.join(temporary, 'settings.mjs');

try {
  await fs.writeFile(config, JSON.stringify({ theme: 'auto', translate: { activeProvider: 'echo' } }));
  await build({
    entryPoints: [path.join(root, 'electron/settings.ts')], bundle: true,
    platform: 'node', format: 'esm', target: 'node22', outfile: bundlePath,
    plugins: [{ name: 'isolated-settings-path', setup(builder) {
      builder.onResolve({ filter: /^\.\/paths\.js$/ }, () => ({ path: 'test-paths', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: `export const paths = { config: () => ${JSON.stringify(config)} };`, loader: 'js',
      }));
    } }],
  });
  const { settings } = await import(pathToFileURL(bundlePath));
  assert.equal(settings.get().translate.concurrency, 4, 'old settings inherit the default concurrency');
  const saved = structuredClone(settings.set({ theme: 'light', translate: { activeProvider: 'echo' } }));
  const originalFile = await fs.readFile(config, 'utf8');
  for (const concurrency of [0, -1, 17, 1.5, '4', null]) {
    assert.throws(() => settings.set({ translate: { concurrency } }), /1–16/);
    assert.deepEqual(settings.get(), saved, 'invalid concurrency must preserve active settings');
    assert.equal(await fs.readFile(config, 'utf8'), originalFile, 'invalid concurrency must not touch disk');
  }
  for (const reasoningEffort of ['turbo', '', 1, null]) {
    assert.throws(() => settings.set({ translate: { providers: { openai: { reasoningEffort } } } }), /思考程度无效/);
    assert.deepEqual(settings.get(), saved, 'invalid thinking level must preserve active settings');
    assert.equal(await fs.readFile(config, 'utf8'), originalFile);
  }
  const candidate = { theme: 'dark', translate: { activeProvider: 'deepl', providers: {
    deepl: { endpoint: 'https://api.deepl.com/v2/translate' },
  } } };

  // A directory at the staging path produces a real write failure even when run as root.
  await fs.mkdir(staging);
  assert.throws(() => settings.set(candidate), { code: 'EISDIR' });
  assert.deepEqual(settings.get(), saved, 'write failure must preserve the active settings');
  assert.equal(await fs.readFile(config, 'utf8'), originalFile, 'write failure must preserve the saved file');
  await fs.rmdir(staging);

  // A directory at the final path lets the write succeed but rejects the atomic rename.
  const backup = path.join(temporary, 'previous-config.json');
  await fs.rename(config, backup);
  await fs.mkdir(config);
  assert.throws(() => settings.set(candidate), error => ['EISDIR', 'EEXIST', 'ENOTEMPTY'].includes(error.code));
  assert.deepEqual(settings.get(), saved, 'rename failure must preserve the active settings');
  assert.equal(await fs.readFile(backup, 'utf8'), originalFile, 'rename failure must preserve the previous contents');
  assert.equal(JSON.parse(await fs.readFile(staging, 'utf8')).translate.activeProvider, 'deepl',
    'the rename failure must occur after the candidate has been written');
  await fs.rmdir(config);
  await fs.rename(backup, config);

  const recovered = settings.set(candidate);
  assert.equal(recovered.theme, 'dark');
  assert.equal(recovered.translate.activeProvider, 'deepl');
  assert.equal(recovered.translate.providers.deepl.endpoint, 'https://api.deepl.com/v2/translate');
  assert.deepEqual(recovered.reading, saved.reading, 'saving a partial patch must retain other settings');
  assert.deepEqual(settings.get(), recovered);
  assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')), recovered);
  await assert.rejects(fs.access(staging), { code: 'ENOENT' });
  const reloaded = await import(`${pathToFileURL(bundlePath).href}?reload`);
  assert.deepEqual(reloaded.settings.get(), recovered, 'a fresh instance must load the successful save');
  for (const reasoningEffort of ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(settings.set({ translate: { providers: { openai: { reasoningEffort } } } }).translate.providers.openai.reasoningEffort, reasoningEffort);
  }
  for (const concurrency of [1, 16]) {
    assert.equal(settings.set({ translate: { concurrency } }).translate.concurrency, concurrency);
  }
  assert.equal(
    settings.set({ translate: { providers: { openai: { baseUrl: 'https://api.openai.com/v1/models' } } } }).translate.providers.openai.baseUrl,
    'https://api.openai.com/v1',
  );
  assert.equal(
    settings.set({ translate: { providers: { deepseek: { baseUrl: 'https://api.deepseek.com/chat/completions' } } } }).translate.providers.deepseek.baseUrl,
    'https://api.deepseek.com/v1',
  );
  assert.equal(
    settings.set({ translate: { providers: { openai: { baseUrl: 'http://localhost:8000' } } } }).translate.providers.openai.baseUrl,
    'http://localhost:8000',
  );
  console.log('PASS settings defaults, concurrency/thinking validation, atomic write and rename failure, recovery and readback');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
