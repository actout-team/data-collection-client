import { observers, createObserverRegistration } from '../extension/observers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('Extension continues past 100 commands without waiting for a recovery alarm', async () => {
  let requests = 0, finish;
  const stopped = new Promise(resolve => { finish = resolve; });
  const chrome = {
    permissions: { contains: async () => false },
    action: { onClicked: { addListener() {} } },
    runtime: { getURL: () => 'chrome-extension://fixture/', onMessage: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    storage: { local: {
      get: async key => key === 'token' ? { token: 'fixture' } : {},
      set: async value => { assert.match(value.lastBridgeError, /fixture finished/); finish(); }
    } }
  };
  const source = (await readFile(new URL('../extension/background.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  vm.runInNewContext(source, { observers, createObserverRegistration, chrome, console, AbortSignal, fetch: async () => {
    if (++requests === 105) throw Error('fixture finished');
    return { ok: true, json: async () => ({}) };
  } });
  let timer;
  try {
    await Promise.race([stopped, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Polling stopped after ${requests} requests`)), 1000); })]);
  } finally { clearTimeout(timer); }
  assert.equal(requests, 105);
});
