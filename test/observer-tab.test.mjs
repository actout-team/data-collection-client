import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareObserverTab } from '../extension/observers.mjs';

function fixture(helperVersion) {
  const stored = {}, reloads = [];
  const chrome = {
    runtime: { getManifest: () => ({ version: '0.3.7' }) },
    scripting: { executeScript: async () => [{ result: helperVersion }] },
    storage: { session: {
      get: async () => stored, set: async value => Object.assign(stored, value),
      remove: async key => { delete stored[key]; }
    } },
    tabs: { reload: async id => { reloads.push(id); } }
  };
  return { chrome, stored, reloads };
}
for (const id of ['slack', 'outlook']) {
const prepare = (chrome, tab) => prepareObserverTab(chrome, tab, id);
for (const stale of [null, '0.3.5', '0.3.6']) {
  test(`${id} refreshes a missing or stale helper (${stale}) once, then connects`, async () => {
    const { chrome, stored, reloads } = fixture(stale);
    assert.equal(await prepare(chrome, { id: 7 }), false);
    assert.deepEqual(reloads, [7]);
    chrome.scripting.executeScript = async () => [{ result: '0.3.7' }];
    assert.equal(await prepare(chrome, { id: 7 }), true);
    assert.deepEqual(stored, {});
    assert.deepEqual(reloads, [7]);
  });
}
test(`${id} reports failed startup injection instead of repeatedly refreshing`, async () => {
  const { chrome, reloads } = fixture(null);
  await prepare(chrome, { id: 7 });
  await assert.rejects(prepare(chrome, { id: 7 }), /did not load after refresh/);
  assert.deepEqual(reloads, [7]);
});
test(`${id} preserves a current helper and scopes refresh state to each tab`, async () => {
  const { chrome, reloads } = fixture('0.3.7');
  assert.equal(await prepare(chrome, { id: 7 }), true);
  assert.deepEqual(reloads, []);
  chrome.scripting.executeScript = async () => [{ result: null }];
  await prepare(chrome, { id: 7 });
  await prepare(chrome, { id: 8 });
  assert.deepEqual(reloads, [7, 8]);
});
}
