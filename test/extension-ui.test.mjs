import { observers, createObserverRegistration } from '../extension/observers.mjs';
import { hostPermissions } from '../extension/catalog.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function popupDom(elements) { return { querySelector: selector => elements[selector] }; }
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const popup = (await readFile(new URL('../extension/popup.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
test('Pairing UI is a persistent tab and completes on the first permission grant', async () => {
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.options_ui.open_in_tab, true);
  const elements = { '#pair': {}, '#status': {}, '#version': {} }, events = [];
  vm.runInNewContext(popup, {
    document: popupDom(elements), hostPermissions,
    chrome: {
      permissions: { request: async () => { events.push('permission'); return true; } },
      runtime: { getManifest: () => manifest, sendMessage: async message => {
        events.push(message.type); assert.equal(elements['#pair'].disabled, true); return { ok: true };
      } }
    }
  });
  await elements['#pair'].onclick();
  assert.deepEqual(events, ['permission', 'pair']);
  assert.match(elements['#status'].textContent, /^Paired\./);
  assert.equal(elements['#pair'].disabled, false);
});
test('Denied website permission does not send a pairing request', async () => {
  const elements = { '#pair': {}, '#status': {}, '#version': {} };
  vm.runInNewContext(popup, {
    document: popupDom(elements), hostPermissions,
    chrome: { permissions: { request: async () => false }, runtime: { getManifest: () => manifest, sendMessage: () => assert.fail('must not pair') } }
  });
  await elements['#pair'].onclick();
  assert.match(elements['#status'].textContent, /Website access was not granted/);
  assert.equal(elements['#pair'].disabled, false);
});

test('Worker startup and first pairing share document-start API registration', async () => {
  let listener, registrations = [], saved, reply;
  const chrome = {
    permissions: { contains: async () => true },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async scripts => {
      registrations.push(scripts[0].id); assert.equal(scripts[0].world, 'MAIN'); assert.equal(scripts[0].runAt, 'document_start');
    } },
    action: { onClicked: { addListener() {} } },
    runtime: { id: 'fixture', getURL: () => 'chrome-extension://fixture/', onMessage: { addListener(fn) { listener = fn; } } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    storage: { local: { get: async () => saved ? { token: saved } : {}, set: async data => { if (data.token) saved = data.token; } } }
  };
  const source = (await readFile(new URL('../extension/background.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  const context = vm.createContext({ observers, createObserverRegistration, chrome, console, AbortSignal, fetch: async (url, options) => {
    if (url.endsWith('/pair')) return { ok: true, json: async () => ({ token: 'local-pairing-fixture' }) };
    if (url.endsWith('/status')) { assert.equal(options.headers.Authorization, 'Bearer local-pairing-fixture'); return { ok: true, json: async () => ({ ok: true }) }; }
    throw Error('fixture polling stopped');
  } });
  vm.runInContext(source, context);
  await new Promise(resolve => listener({ type: 'pair' }, { id: 'fixture' }, value => { reply = value; resolve(); }));
  assert.equal(reply.ok, true); assert.deepEqual(registrations.sort(), ['gmail-api', 'outlook-session', 'slack-session']);
});

test('Pairing requests supported site permissions once without a second app selection', async () => {
  const elements = { '#pair': {}, '#status': {}, '#version': {} };
  let origins;
  vm.runInNewContext(popup, { document: popupDom(elements), hostPermissions, chrome: {
    permissions: { request: async value => { origins = value.origins; return true; } },
    runtime: { getManifest: () => manifest, sendMessage: async () => ({ ok: true }) }
  } });
  await elements['#pair'].onclick();
  assert.deepEqual([...origins].sort(), [...new Set(hostPermissions)].sort());
  assert.equal(origins.some(h => h.includes('trello')), false);
  const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  assert.equal(html.includes('capture-apps'), false);
});
