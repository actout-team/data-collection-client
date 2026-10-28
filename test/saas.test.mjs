import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { saasRead } from '../extension/saas.mjs';
import { saasApps } from '../extension/saas-catalog.mjs';
import { allowedSite, accountPath } from '../extension/catalog.mjs';
import { collectSaas } from '../src/connectors/saas.mjs';

function browser(id = 'hubspot') {
  const app = saasApps.find(a => a.id === id);
  const origin = id === 'hubspot' ? 'https://app-eu1.hubspot.com' : id === 'notion' ? 'https://www.notion.so' : `https://${app.hosts.find(h => !h.startsWith('*')) || 'demo.lightning.force.com'}`;
  const location = { origin, pathname: id === 'hubspot' ? '/contacts/123/objects/0-1' : '/workspace', href: origin + '/workspace' };
  let calls = 0;
  const window = { fetch: async () => { calls++; return new Response(JSON.stringify({ id: '1', name: 'Example', access_token: 'PRIVATE', nested: { password: 'PRIVATE' } }), { headers: { 'content-type': 'application/json' } }); } };
  const context = vm.createContext({ window, location, URL, TextDecoder, Uint8Array, crypto: webcrypto });
  const run = vm.runInContext(`(${saasRead.toString()})`, context);
  const config = { ...app, version: 'test' };
  const identity = run('identity', config).value;
  return { run: (op, extra = {}, expected = identity) => run(op, { ...config, ...extra }, expected), config, identity, window, location, calls: () => calls };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('All seven capture adapters arm without making a request or claiming authentication', () => {
  assert.equal(saasApps.filter(app => app.mode === 'capture').length, 7);
  for (const app of saasApps.filter(app => app.mode === 'capture')) {
    const b = browser(app.id);
    assert.equal(b.identity.mode, 'capture');
    assert.equal(b.identity.authenticated, false);
    assert.equal(b.calls(), 0);
    assert.equal(b.run('capture-snapshot').value.count, 0);
  }
});
test('Only eligible same-origin reads are retained, with credential fields removed', async () => {
  const b = browser();
  const path = '/api/inbounddb-objects/v1/crm-objects/0-1/batch';
  await b.window.fetch(b.location.origin + path);
  await b.window.fetch('https://outside.example' + path);
  await b.window.fetch(b.location.origin + path, { method: 'DELETE' });
  await b.window.fetch(b.location.origin + '/api/login-verify/hub-user-info');
  await settle();
  assert.equal(b.run('capture-snapshot').value.count, 1);
  const record = b.run('capture-record', { index: 0 }).value;
  assert.equal(record.data.name, 'Example');
  assert.equal(record.data.access_token, undefined);
  assert.equal(record.data.nested.password, undefined);
  assert.equal(record.path, path);
  assert.equal(JSON.stringify(record).includes('PRIVATE'), false);
});
test('GraphQL captures explicit queries only, never mutations or unknown persisted operations', async () => {
  const b = browser();
  for (const query of ['query Contacts { contacts { id } }', 'mutation Delete { deleteContact }', null]) {
    await b.window.fetch(b.location.origin + '/api/graphql/crm', { method: 'POST', body: JSON.stringify({ query }) });
  }
  await settle();
  assert.equal(b.run('capture-snapshot').value.count, 1);
});
test('Notion captures known read POSTs without saving request bodies', async () => {
  const b = browser('notion');
  await b.window.fetch('/api/v3/search', { method: 'POST', body: '{"query":"PRIVATE QUERY"}' });
  await b.window.fetch('/api/v3/saveTransactions', { method: 'POST', body: '{}' });
  await settle();
  assert.equal(b.run('capture-snapshot').value.count, 1);
  assert.equal(JSON.stringify(b.run('capture-record', { index: 0 })).includes('PRIVATE QUERY'), false);
});
test('Tenant changes and stale capture identities are rejected', () => {
  const b = browser();
  assert.equal(b.run('capture-snapshot', {}, { ...b.identity, nonce: 'stale' }).code, 'ACCOUNT_CHANGED');
  b.location.pathname = '/contacts/999/objects/0-1';
  assert.equal(b.run('capture-snapshot').code, 'ACCOUNT_CHANGED');
});
test('Stopping capture freezes the snapshot and clearing drops retained records', async () => {
  const b = browser();
  const path = '/api/inbounddb-objects/v1/crm-objects/0-1/batch';
  await b.window.fetch(path); await settle();
  assert.equal(b.run('capture-snapshot').value.count, 1);
  await b.window.fetch(path); await settle();
  assert.equal(b.run('capture-snapshot').value.count, 1);
  b.run('capture-clear');
  assert.equal(b.run('capture-snapshot').value.count, 0);
});
test('Oversized response is discarded before JSON parsing', async () => {
  const b = browser();
  // A separate mocked page is needed because the wrapper holds its original fetch.
  const window = { fetch: async () => new Response(JSON.stringify({ text: 'x'.repeat(600000) }), { headers: { 'content-type': 'application/json' } }) };
  const context = vm.createContext({ window, location: b.location, URL, TextDecoder, Uint8Array, crypto: webcrypto });
  const run = vm.runInContext(`(${saasRead.toString()})`, context);
  const identity = run('identity', b.config).value;
  await window.fetch('/api/inbounddb-objects/v1/crm-objects/0-1/batch'); await settle();
  const snapshot = run('capture-snapshot', b.config, identity).value;
  assert.equal(snapshot.count, 0); assert.equal(snapshot.skipped, 1);
});
test('Catalog recognizes regional HubSpot and Salesforce tenants but rejects lookalikes', () => {
  assert.equal(allowedSite('hubspot', 'https://app-eu1.hubspot.com/contacts/123'), true);
  assert.equal(accountPath('hubspot', 'https://app-eu1.hubspot.com/contacts/123'), '123');
  assert.equal(allowedSite('hubspot', 'https://app-eu1.hubspot.com.evil.test/'), false);
  assert.equal(allowedSite('salesforce', 'https://demo.lightning.force.com/'), true);
  assert.equal(allowedSite('salesforce', 'https://evillightning.force.com/'), false);
});
test('Collector exports partial responses without claiming historical completeness', async () => {
  const written = [], ops = [], stats = { messages: 0, warnings: [] };
  const result = await collectSaas({ ask: async task => { ops.push(task.op); return task.op === 'capture-snapshot' ? { count: 2, skipped: 1 } : { data: { id: task.index } }; }, writer: { append: async (name, value) => written.push({ name, value }) }, stats, progress() {} });
  assert.equal(result.status, 'partial'); assert.equal(result.scanComplete, false);
  assert.equal(result.windowApplied, false); assert.equal(stats.messages, 2);
  assert.match(stats.warnings.join(' '), /Days back is NOT applied/);
  assert.equal(written.filter(r => r.name === 'responses.jsonl').length, 2);
  assert.equal(ops.at(-1), 'capture-clear');
});
test('No captured responses fails explicitly, and cancelled capture keeps partial files', async () => {
  const args = { ask: async () => ({ count: 0 }), writer: {}, stats: { messages: 0, warnings: [] }, progress() {} };
  await assert.rejects(collectSaas(args), /No eligible/);
  await assert.rejects(collectSaas({ ...args, ask: async () => ({ count: 1 }), signal: AbortSignal.abort(Error('cancelled')) }), /cancelled/);
});
