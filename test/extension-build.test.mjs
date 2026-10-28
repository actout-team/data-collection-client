import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { observers, createObserverRegistration } from '../extension/observers.mjs';

// Use a different version and working directory to catch copied version literals.
test('A fresh build stamps all executable helpers and the manifest from package.json', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'collect-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, 'extension'));
  const files = ['scripts/build-extension.mjs', 'extension/observers.mjs', 'extension/manifest.json',
    ...Object.values(observers).map(observer => `extension/${observer.source}`)];
  for (const file of files) await copyFile(new URL(`../${file}`, import.meta.url), path.join(root, file));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '7.8.9' }));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/build-extension.mjs')], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(path.join(root, 'extension/manifest.json'))).version, '7.8.9');
  for (const [id, observer] of Object.entries(observers)) {
    class XHR { open() {} setRequestHeader() {} send() {} }
    const url = { gmail: 'https://mail.google.com/mail/u/0/', slack: 'https://app.slack.com/client/T123', outlook: 'https://outlook.live.com/mail/' }[id];
    const window = { location: new URL(url), XMLHttpRequest: XHR, fetch: async () => {}, setTimeout };
    const context = vm.createContext({ window, URL, Headers, URLSearchParams, FormData, TextDecoder, AbortSignal });
    const bundle = await readFile(path.join(root, 'extension', observer.bundle), 'utf8');
    vm.runInContext(bundle, context);
    assert.equal(window[observer.property]?.version, '7.8.9', id);
    const helper = window[observer.property], fetch = window.fetch;
    vm.runInContext(bundle, context);
    assert.equal(window[observer.property], helper);
    assert.equal(window.fetch, fetch, 'Repeated injection must not stack hooks.');
  }
});

test('Failed observer registration can retry; simultaneous callers share it', async () => {
  let calls = 0;
  const chrome = {
    permissions: { contains: async () => true },
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => { if (++calls === 1) throw Error('Temporary failure'); }
    }
  };
  const register = createObserverRegistration(chrome);
  await assert.rejects(register('gmail'), /Temporary failure/);
  await Promise.all([register('gmail'), register('gmail')]);
  assert.equal(calls, 2);
});
