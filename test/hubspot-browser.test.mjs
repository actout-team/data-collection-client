import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { hubspotRead } from '../extension/hubspot.mjs';
import { collectHubspot } from '../src/connectors/hubspot.mjs';
import { getApp, accountPath } from '../extension/catalog.mjs';
const window = { start: '2026-10-12T12:00:00Z', end: '2026-10-15T12:00:00Z' };
const origin = 'https://app-eu1.hubspot.com';
const session = { portal: { portal_id: 123 }, user: { user_id: 456 }, errors: [] };
const expected = { origin, portalId: '123', userId: '456' };
const body = { type: 'contacts', window, cursor: null };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const record = (id, timestamp) => ({ id: String(id), properties: [{ name: 'createdate', value: String(timestamp) }, { name: 'custom_field', value: 'unchanged' }] });
const result = (records = [], rest = {}) => [{ data: { crmObjectsSearch: { results: records, total: records.length, hasMore: false, offset: 0, validationErrors: [], ...rest } } }];
function browser(handler = () => json(result())) {
  const requests = [], location = { href: origin + '/contacts/123/objects/0-1/views/all/list' }, document = { cookie: 'other=abc; csrf.app=local%2Btoken; last=x' };
  const context = vm.createContext({ location, document, URL, AbortSignal, Uint8Array, TextDecoder, fetch: async (url, options) => {
    const call = { url: new URL(url), ...options, data: options.body ? JSON.parse(options.body) : undefined };
    requests.push(call);
    return await handler(call, requests) || json(session);
  } });
  const read = vm.runInContext(`(${hubspotRead.toString()})`, context);
  return { requests, document, location, context, read: async (op = 'hubspot-page', args = body, account = expected) => JSON.parse(JSON.stringify(await read(op, args, account))) };
}
const pageBrowser = callback => browser(call => call.method === 'POST' ? callback(call) : undefined);
test('HubSpot identity verifies user and portal without exposing cookies or raw session', async () => {
  const b = browser(() => undefined);
  const reply = await b.read('identity', {}, null);
  assert.equal(reply.ok, true); assert.equal(reply.value.authenticated, true);
  assert.deepEqual(reply.value, { ...expected, mode: 'website-api', authenticated: true, ownerProfile: {}, account: 'HubSpot portal 123 · user 456' });
  assert.equal(JSON.stringify(reply).includes('token'), false);
  assert.equal(b.requests[0].url.pathname, '/api/login-verify/hub-user-info');
  assert.equal(getApp('hubspot').mode, 'website-api');
  assert.equal(accountPath('hubspot', origin + '/user-guide/123'), '123');
});
test('Website query uses fixed same-origin reads, CSRF, date OR groups and server offsets', async () => {
  const row = record(7, Date.parse(window.start));
  const b = pageBrowser(() => json(result([row], { total: 2, hasMore: true, offset: 100 })));
  const reply = await b.read();
  assert.deepEqual(reply, { ok: true, value: { records: [row], hasMore: true, nextCursor: 100, total: 2 } });
  const call = b.requests[1], operation = call.data[0];
  assert.equal(call.url.origin, origin); assert.equal(call.url.pathname, '/api/graphql/crm'); assert.equal(call.url.searchParams.get('portalId'), '123');
  assert.equal(call.headers['X-HubSpot-CSRF-hubspotapi'], 'local+token');
  assert.equal(call.credentials, 'include'); assert.equal(call.redirect, 'error');
  assert.equal(operation.operationName, 'CollectHubspotRecords'); assert.match(operation.query, /^query /); assert.doesNotMatch(operation.query, /mutation/);
  assert.equal(operation.variables.count, 100); assert.equal(operation.variables.offset, 0); assert.equal(operation.variables.objectTypeId, '0-1');
  assert.deepEqual(operation.variables.filterGroups.map(g => g.filters), ['createdate', 'lastmodifieddate'].map(property => [
    { property, operator: 'GTE', value: String(Date.parse(window.start)) }, { property, operator: 'LT', value: String(Date.parse(window.end)) },
  ]));
  await b.read('hubspot-page', { ...body, type: 'companies', cursor: 100 });
  assert.equal(b.requests[3].data[0].variables.offset, 100);
  assert.equal(b.requests[3].data[0].variables.filterGroups[1].filters[0].property, 'hs_lastmodifieddate');
});
test('Unknown operations, types, offsets and invalid windows cannot issue requests', async () => {
  for (const [op, args, account] of [['delete', body, expected], ['hubspot-page', { ...body, type: 'constructor' }, expected], ['hubspot-page', { ...body, cursor: '1.5' }, expected], ['hubspot-page', { ...body, cursor: -1 }, expected], ['hubspot-page', { ...body, window: { start: window.end, end: window.start } }, expected], ['hubspot-page', body, null]]) {
    const b = pageBrowser(() => json(result()));
    assert.equal((await b.read(op, args, account)).ok, false); assert.equal(b.requests.length, 0);
  }
});
test('Expired login, missing CSRF, account changes and portal navigation stop before returning CRM records', async () => {
  const changedUser = browser(() => json({ ...session, user: { user_id: 999 } }));
  assert.equal((await changedUser.read()).code, 'ACCOUNT_CHANGED'); assert.equal(changedUser.requests.length, 1);
  const changedPortal = browser(() => json({ ...session, portal: { portal_id: 999 } }));
  assert.equal((await changedPortal.read()).code, 'ACCOUNT_CHANGED');
  const expired = browser(() => json({}, 401)); assert.equal((await expired.read()).code, 'LOGIN_REQUIRED');
  const missing = pageBrowser(() => json(result())); missing.document.cookie = '';
  assert.equal((await missing.read()).code, 'LOGIN_REQUIRED'); assert.equal(missing.requests.length, 1);
  const moved = pageBrowser(() => { moved.location.href = origin + '/contacts/999'; return json(result()); });
  assert.equal((await moved.read()).code, 'ACCOUNT_CHANGED');
  const external = pageBrowser(() => json(result())); external.location.href = 'https://app-eu1.hubspot.com.evil.test/contacts/123';
  assert.equal((await external.read()).ok, false); assert.equal(external.requests.length, 0);
});
test('Rate limits from session or CRM are retryable; malformed and truncated results fail explicitly', async () => {
  for (const duringIdentity of [true, false]) {
    const b = browser(call => duringIdentity || call.method === 'POST' ? json({}, 429, { 'retry-after': '8' }) : undefined);
    assert.deepEqual(await b.read(), { ok: true, value: { status: 429, retryAfter: 8 } });
  }
  for (const data of [{}, [], [{ errors: [{ message: 'private error text' }] }], result([], { hasMore: 'false' }), result([record(1, 1)], { hasMore: true, offset: 0 }), result([], { validationErrors: [{ message: 'private error text' }] })]) {
    const reply = await pageBrowser(() => json(data)).read(); assert.equal(reply.ok, false); assert.doesNotMatch(JSON.stringify(reply), /private error text/);
  }
  assert.deepEqual(await pageBrowser(() => json(result([], { total: 10000 }))).read(), { ok: true, value: { splitRequired: true } });
  const oversized = await pageBrowser(() => json({ value: 'a'.repeat(8 * 1024 * 1024) })).read(); assert.equal(oversized.code, 'RESPONSE_LIMIT');
});
test('Collector and serialized browser reader export all record types and preserve original properties', async () => {
  const b = pageBrowser(call => {
    const { objectTypeId, offset } = call.data[0].variables;
    const rows = objectTypeId === '0-1' ? [record(offset ? 2 : 1, Date.parse(offset ? window.end : window.start) - (offset ? 1 : 0))] : [record(3, Date.parse(window.start))];
    return json(result(rows, { total: objectTypeId === '0-1' ? 2 : 1, hasMore: objectTypeId === '0-1' && !offset, offset: offset ? 0 : 1 }));
  });
  const saved = [], stats = { messages: 0, warnings: [] };
  const outcome = await collectHubspot({ window, stats, writer: { append: async (file, row) => saved.push({ file, row }) }, ask: async task => {
    const reply = await b.read(task.op, task.body); if (!reply.ok) throw Object.assign(Error(reply.error), { code: reply.code }); return reply.value;
  } });
  assert.equal(outcome.scanComplete, true); assert.equal(stats.messages, 4); assert.deepEqual(stats.warnings, []);
  assert.equal(saved.filter(s => s.file === 'contacts.jsonl').length, 2);
  assert.deepEqual(saved[0].row, record(1, Date.parse(window.start)));
  assert.equal(saved.at(-1).row.scanComplete, true);
});
test('Extension dispatch routes HubSpot pages to its reader and rejects capture/write operations', async () => {
  const { readFile } = await import('node:fs/promises');
  const { allowedSite } = await import('../extension/catalog.mjs');
  const source = await readFile(new URL('../extension/background.mjs', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('async function run('), source.indexOf('async function poll('));
  let injection;
  const helper = () => {};
  const chrome = {
    storage: { session: { get: async () => ({ 'session-hubspot': { tabId: 1, origin, path: '123' } }) } },
    tabs: { get: async () => ({ url: origin + '/contacts/123/objects/0-1', id: 1 }) },
    scripting: { executeScript: async options => { injection = options; return [{ result: { ok: true, value: { records: [], hasMore: false } } }]; } },
  };
  const context = vm.createContext({ chrome, getApp, allowedSite, accountPath, hubspotRead: helper, URL });
  const run = vm.runInContext(handler + '\nrun', context);
  const task = { app: 'hubspot', op: 'hubspot-page', body, expected };
  await run(task);
  assert.equal(injection.func, helper); assert.equal(injection.world, 'ISOLATED'); assert.equal(injection.args[0], 'hubspot-page');
  assert.deepEqual(JSON.parse(JSON.stringify(injection.args[1])), { ...body, diagnostics: true }); assert.equal(injection.args[2], expected);
  for (const op of ['capture-snapshot', 'request', 'delete']) await assert.rejects(run({ ...task, op }), /Unsupported HubSpot operation/);
});
test('First-page cursor forms and the reported five-day window survive browser validation', async () => {
  for (const cursor of [undefined, null, 0, '0']) {
    const b = pageBrowser(() => json(result()));
    // Model a host page replacing Date.parse. The reader uses native constructor
    // parsing and production dispatch also isolates it from host-page globals.
    vm.runInContext('Date.parse = () => NaN', b.context);
    const reply = await b.read('hubspot-page', { ...body, cursor, window: { start: '2026-10-11T08:49:39.260Z', end: '2026-10-16T08:49:39.260Z' } });
    assert.equal(reply.ok, true); assert.equal(b.requests[1].data[0].variables.offset, 0);
    assert.equal(b.requests[1].data[0].variables.filterGroups[0].filters[0].value, '1791708579260');
  }
});
test('Diagnostics expose endpoints and schema counts without tokens, record contents or arbitrary errors', async () => {
  const b = pageBrowser(() => json(result([{ id: '7', properties: [{ name: 'password', value: 'PRIVATE_RECORD_VALUE' }] }])));
  const reply = await b.read('hubspot-page', { ...body, diagnostics: true });
  const logs = reply.diagnostics.join('\n');
  assert.match(logs, /GET \/api\/login-verify\/hub-user-info/); assert.match(logs, /POST \/api\/graphql\/crm/);
  assert.match(logs, /HTTP 200, content-type=application\/json/); assert.match(logs, /bytes=\d+, elapsed=\d+ms/);
  assert.match(logs, /batch=array\(1\)/); assert.match(logs, /results=array\(1\), total=1/);
  assert.doesNotMatch(logs, /PRIVATE_RECORD_VALUE|password|local\+token|portalId=123|userId=456/);
  const bad = pageBrowser(() => json([{ errors: [{ message: 'Cannot query field "hasMore" on type "SearchResult".' }, { message: 'Customer PRIVATE_RECORD_VALUE cannot be read' }] }]));
  const failure = await bad.read('hubspot-page', { ...body, diagnostics: true });
  assert.equal(failure.ok, false); assert.match(failure.diagnostics.join('\n'), /Cannot query field "hasMore"/);
  assert.doesNotMatch(failure.diagnostics.join('\n'), /PRIVATE_RECORD_VALUE/);
  const invalid = await b.read('hubspot-page', { ...body, diagnostics: true, window: { end: window.end } });
  assert.equal(invalid.code, 'INVALID_REQUEST'); assert.match(invalid.error, /start=undefined\/invalid/);
  assert.match(invalid.diagnostics.join('\n'), /Failure: INVALID_REQUEST/);
  assert.ok(invalid.diagnostics.length <= 16);
});
test('Actual HTTP bridge preserves HubSpot request parameters, isolated injection and batched diagnostics', async t => {
  const { createBridge } = await import('../src/bridge.mjs');
  const { readFile } = await import('node:fs/promises');
  const { allowedSite } = await import('../extension/catalog.mjs');
  const extensionOrigin = 'chrome-extension://' + 'a'.repeat(32), token = 'test-pairing-token';
  const events = [];
  let bridge;
  try { bridge = await createBridge({ port: 0, pairing: { origin: extensionOrigin, token }, onEvent: (...args) => events.push(args) }); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Loopback is unavailable in this environment.'); return; } throw error; }
  t.after(() => bridge.close());
  const headers = { 'X-Extension-Origin': extensionOrigin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const local = async (path, options) => {
    const response = await fetch(`http://127.0.0.1:${bridge.port}${path}`, { ...options, headers });
    assert.equal(response.status, 200); return response.json();
  };
  const b = pageBrowser(call => json(result([record(call.data[0].variables.objectTypeId.slice(-1), Date.parse(window.start))])));
  const chrome = {
    storage: { session: { get: async () => ({ 'session-hubspot': { tabId: 1, origin, path: '123' } }) } },
    tabs: { get: async () => ({ url: origin + '/contacts/123/objects/0-1', id: 1 }) },
    scripting: { executeScript: async options => {
      assert.equal(options.world, 'ISOLATED');
      return [{ result: await b.read(...JSON.parse(JSON.stringify(options.args))) }];
    } },
  };
  const source = await readFile(new URL('../extension/background.mjs', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('async function run('), source.indexOf('async function poll('));
  const run = vm.runInContext(handler + '\nrun', vm.createContext({ chrome, getApp, allowedSite, accountPath, hubspotRead, local, URL }));
  const tasks = [], saved = [], stats = { messages: 0, warnings: [] };
  const worker = (async () => {
    for (let i = 0; i < 6; i++) {
      const task = await local('/next'); tasks.push(task);
      let response;
      try { response = { data: await run(task) }; } catch (error) { response = { error: error.message, code: error.code }; }
      await local('/result', { method: 'POST', body: JSON.stringify({ id: task.id, ...response }) });
    }
  })().catch(error => { bridge.close(); throw error; });
  const outcome = await collectHubspot({ window, stats, writer: { append: async (file, row) => saved.push({ file, row }) }, ask: task => bridge.ask({ ...task, app: 'hubspot', expected }) });
  await worker;
  assert.equal(outcome.scanComplete, true); assert.equal(stats.messages, 3);
  assert.ok(tasks.every(task => task.body.cursor === 0 && task.body.window.start === window.start));
  assert.ok(events.some(([level, source, message]) => level === 'info' && source === 'hubspot' && message.includes('Search structure:')));
  assert.ok(saved.some(row => row.file === 'companies.jsonl'));
});

test('Unfiltered audit uses fixed recent-modification sorting, bypasses date splitting and persists safe diagnostics', async () => {
  const b = pageBrowser(() => json(result([record(1, Date.parse(window.start))], { total: 15000, hasMore: true, offset: 100 })));
  const reply = await b.read('hubspot-page', { ...body, type: 'companies', scope: 'all', diagnostics: true });
  assert.equal(reply.ok, true); assert.equal(reply.value.total, 15000); assert.equal(reply.value.splitRequired, undefined);
  assert.deepEqual(b.requests[1].data[0].variables.filterGroups, []);
  assert.deepEqual(b.requests[1].data[0].variables.sorts, [{ property: 'hs_lastmodifieddate', order: 'DESC' }, { property: 'hs_object_id', order: 'ASC' }]);
  assert.deepEqual(reply.value.diagnostics, reply.diagnostics);
  assert.match(reply.value.diagnostics.join('\n'), /scope=all filters=0/);
  const invalid = pageBrowser(() => json(result()));
  assert.equal((await invalid.read('hubspot-page', { ...body, scope: 'arbitrary' })).code, 'INVALID_REQUEST');
  assert.equal(invalid.requests.length, 0);
});

test('HubSpot owner profile includes only self-contact fields after account verification', async () => {
 const b=browser(()=>json({...session,user:{user_id:456,email:'owner@private.test',first_name:'Alice',last_name:'Reed',phone:'+1 202 555 0187',password:'must-not-export',token:'must-not-export'}}));
 const reply=await b.read('identity',{},null);
 assert.deepEqual(reply.value.ownerProfile,{email:'owner@private.test',first_name:'Alice',last_name:'Reed',phone:'+1 202 555 0187'});
 assert.ok(!JSON.stringify(reply).includes('must-not-export'));
});
