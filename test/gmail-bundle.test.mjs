import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

test('Built classic content script installs once at document start without page DOM', async () => {
  const result = spawnSync(process.execPath, ['scripts/build-extension.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const source = await readFile(new URL('../extension/gmail-bundle.js', import.meta.url), 'utf8');
  class XHR { open() {} setRequestHeader() {} }
  const window = { XMLHttpRequest: XHR, location: { pathname: '/mail/u/0/' }, fetch: async () => {} };
  const context = vm.createContext({ window, URL, Headers, TextDecoder, AbortSignal });
  vm.runInContext(source, context);
  assert.equal(typeof window.__actoutGmailApi.search, 'function');
  const api = window.__actoutGmailApi, fetch = window.fetch;
  vm.runInContext(source, context);
  assert.equal(window.__actoutGmailApi, api); assert.equal(window.fetch, fetch);
  assert.equal(window.__actoutGmailError, null);
});
