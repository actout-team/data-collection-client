import { observers, createObserverRegistration } from '../extension/observers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { getApp, allowedSite, accountPath } from '../extension/catalog.mjs';

async function locate(tabs, hint) {
  const stored = {}, version = '0.3.4';
  const chrome = {
    runtime: { getManifest: () => ({ version }), onMessage: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
    permissions: { contains: async () => false },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    cookies: { getAll: async () => [] },
    scripting: { executeScript: async () => [] },
    tabs: { query: async () => tabs },
    storage: { local: { get: async () => ({}) }, session: {
      get: async () => stored, set: async value => Object.assign(stored, value)
    } }
  };
  const source = (await readFile(new URL('../extension/background.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  const context = vm.createContext({ observers, createObserverRegistration, chrome, getApp, allowedSite, accountPath, console, URL, hint, prepareObserverTab: async () => true });
  vm.runInContext(source, context);
  const found = await vm.runInContext("run({app:'slack', op:'locate', hint})", context);
  return { found, stored };
}
const tab = { id: 1, url: 'https://app.slack.com/client/T123/C456', title: 'Workspace', status: 'complete' };
test('A single Slack tab is offered for explicit selection with extension version', async () => {
  const { found, stored } = await locate([tab]);
  assert.equal(found.choices.length, 1); assert.equal(found.choices[0].url, tab.url);
  assert.equal(found.version, '0.3.4'); assert.equal(stored['session-slack'], undefined);
});
test('Selected Slack tab connects rather than reopening the chooser', async () => {
  const { found, stored } = await locate([tab], tab.url);
  assert.equal(found.ready, true); assert.equal(found.version, '0.3.4');
  assert.equal(stored['session-slack'].tabId, 1);
});
test('Multiple Slack tabs remain selectable', async () => {
  const { found } = await locate([tab, { ...tab, id: 2, url: 'https://app.slack.com/client/T789/C456' }]);
  assert.equal(found.choices.length, 2);
});
