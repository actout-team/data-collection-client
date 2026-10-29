import { catalog, stepBlock } from '../ui/catalog.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { driveRead } from '../extension/drive.mjs';
import { createDriveDownloads, driveFilePlan } from '../extension/drive-download.mjs';
import { collectDrive } from '../src/connectors/drive.mjs';
import { accountOwner } from '../src/account-owner.mjs';
import { getApp, allowedSite, hostPermissions } from '../extension/catalog.mjs';

const window = { start: '2026-07-18T00:00:00.000Z', end: '2026-10-17T00:00:00.000Z' };
const item = (id = 'file-1', extra = {}) => ({ id, title: 'Example שלום.txt', mimeType: 'text/plain', modifiedDateMillis: String(Date.parse(window.start)), createDateMillis: '1700000000000', fileSize: '5', ...extra });
const profile = { account: { user: { id: 'self-1', email: 'owner@example.test', shortName: 'Owner' }, metadata: { rootFolderId: 'root-1' } } };
function browser(pages = [{ items: [item()], continuationToken: 'opaque-next' }], options = {}) {
  const calls = [];
  const location = { origin: 'https://drive.google.com', pathname: '/drive/u/1/my-drive' };
  const context = vm.createContext({ location, document: { cookie: options.cookie ?? 'SAPISID=private-test-cookie' }, performance: { getEntriesByType: () => [{ name: 'https://drivefrontend-pa.clients6.google.com/v1/account?key=fixture-public-key' }] }, URL, URLSearchParams, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, AbortSignal, fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    if (options.response) return options.response(url, init);
    const data = url.pathname === '/v1/account' ? profile : pages.shift();
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  } });
  const run = vm.runInContext(`(${driveRead.toString()})`, context);
  return { run, calls, location };
}
test('Drive authenticates selected account and exposes no credentials', async () => {
  const b = browser(), result = await b.run('identity');
  assert.equal(result.ok, true); assert.equal(result.value.account, 'owner@example.test');
  assert.equal(result.value.authuser, '1'); assert.equal(result.value.authenticated, true);
  assert.ok(b.calls[0].init.headers.authorization.startsWith('SAPISIDHASH '));
  assert.equal(JSON.stringify(result).includes('private-test-cookie'), false);
  assert.deepEqual(accountOwner('googledrive', result.value).emails, ['owner@example.test']);
});
test('Drive only calls fixed reads, binds account, and sends observed date/cursor shape', async () => {
  const b = browser(), identity = (await b.run('identity')).value;
  const page = await b.run('drive-page', { ...window, cursor: 'opaque-prior', pageSize: 20 }, identity);
  assert.equal(page.value.items[0].id, 'file-1'); assert.equal(page.value.nextCursor, 'opaque-next');
  const call = b.calls.at(-1), body = JSON.parse(call.init.body);
  assert.equal(new URL(call.url).pathname, '/v1/items:list');
  assert.deepEqual(body[0][30], [[5, Date.parse(window.start) - 1], [2, Date.parse(window.end)]]);
  assert.deepEqual(body[1], [20, 'opaque-prior', [2, 5]]);
  const count = b.calls.length;
  assert.equal((await b.run('delete')).ok, false);
  b.location.pathname = '/drive/u/2/my-drive';
  assert.equal((await b.run('drive-page', window, identity)).code, 'ACCOUNT_CHANGED');
  assert.equal(b.calls.length, count);
});
test('Drive rejects malformed data, missing login and unverified account reuse', async () => {
  assert.equal((await browser([], { cookie: '' }).run('identity')).code, 'LOGIN_REQUIRED');
  for (const page of [{ unrelated: [] }, { items: 'bad' }, { items: [null] }, { items: [item('../escape')] }, { continuationToken: 4 }, { searchResponseMetadata: { incompleteSearch: 'true' } }]) {
    const b = browser([page]), identity = (await b.run('identity')).value;
    assert.equal((await b.run('drive-page', window, identity)).ok, false);
  }
  const b = browser(), identity = (await b.run('identity')).value;
  assert.equal((await b.run('drive-page', window, { ...identity, accountId: 'another' })).code, 'ACCOUNT_CHANGED');
  assert.equal((await b.run('drive-page', window)).ok, false);
});
test('Identity rate limits cannot mark Drive connected', async () => {
  const b = browser([], { response: () => new Response('', { status: 429, headers: { 'retry-after': '3' } }) });
  assert.equal((await b.run('identity')).ok, false);
});
test('Drive download plans reject arbitrary URLs and preserve native export formats', () => {
  assert.throws(() => driveFilePlan(item('../bad'), '1'));
  assert.throws(() => driveFilePlan(item(), '1&authuser=0'));
  const plan = driveFilePlan(item('slide-1', { mimeType: 'application/vnd.google-apps.presentation', alternateLink: 'https://evil.test' }), '1');
  assert.equal(plan.url, 'https://docs.google.com/presentation/d/slide-1/export/pptx?authuser=1');
  assert.equal(driveFilePlan(item('folder', { mimeType: 'application/vnd.google-apps.folder' }), '1').skip, 'folder');
  assert.equal(driveFilePlan(item('locked', { capabilities: { canDownload: false } }), '1').skip, 'download-not-permitted');
});
function fileResponse(bytes, options = {}) {
  const response = new Response(bytes, { headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment', ...options.headers }, status: options.status || 200 });
  Object.defineProperty(response, 'url', { value: options.url || 'https://drive.usercontent.google.com/download' });
  return response;
}
test('Drive streams bounded chunks and stops at the configured file limit', async () => {
  const data = new Uint8Array(700000).fill(65), downloads = createDriveDownloads({ fetchImpl: async () => fileResponse(data) });
  assert.equal((await downloads.open(1, item(), '1')).status, 'ready');
  const chunks = [];
  while (true) { const part = await downloads.chunk(1); if (part.done) { assert.equal(part.bytes, data.length); break; } assert.ok(part.base64.length <= 349528); chunks.push(Buffer.from(part.base64, 'base64')); }
  assert.equal(Buffer.concat(chunks).length, data.length);
  await assert.rejects(downloads.chunk(1), /expired/);
  const small = createDriveDownloads({ maxBytes: 2, fetchImpl: async () => fileResponse('abc') });
  await small.open(1, item('native', { mimeType: 'application/vnd.google-apps.document' }), '1');
  await assert.rejects(small.chunk(1), /limit/);
});
test('Drive rejects HTML login pages and unapproved redirects without saving content', async () => {
  for (const response of [fileResponse('login', { headers: { 'content-type': 'text/html', 'content-disposition': '' } }), fileResponse('file', { url: 'https://evil.test/download' })]) {
    const downloads = createDriveDownloads({ fetchImpl: async () => response });
    await assert.rejects(downloads.open(1, item(), '1'), /Drive/);
    await assert.rejects(downloads.chunk(1), /expired/);
  }
});

test('Compressed transfer length is not confused with decoded file length', async () => {
  const downloads = createDriveDownloads({ fetchImpl: async () => fileResponse('decoded', { headers: { 'content-length': '3', 'content-encoding': 'gzip' } }) });
  const result = await downloads.open(1, item(), '1');
  assert.equal(result.expectedBytes, null);
  await downloads.clear(1);
});
async function collectFixture(t, pages, behavior = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'actout-drive-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const written = [], ops = [], stats = { messages: 0, warnings: [] }; let offset = 0;
  const ask = async task => {
    ops.push(task);
    if (task.op === 'drive-page') return pages.shift();
    if (task.op === 'drive-file') { offset = 0; if (behavior.fail) throw Error('Drive denied download.'); return { status: 'ready', extension: 'txt', expectedBytes: (behavior.data || Buffer.from('hello')).length, contentType: 'text/plain' }; }
    if (task.op === 'drive-chunk') { const data = behavior.data || Buffer.from('hello'); return offset++ ? { done: true, bytes: data.length } : { done: false, bytes: data.length, base64: data.toString('base64') }; }
    return {};
  };
  return { dir, written, ops, stats, run: () => collectDrive({ dir, window, ask, stats, writer: { append: async (name, value) => written.push({ name, value }) }, wait: async () => {} }) };
}
test('Collector deduplicates pages, enforces exact boundaries and writes file bytes', async t => {
  const f = await collectFixture(t, [
    { status: 200, items: [item('a'), item('outside', { modifiedDateMillis: String(Date.parse(window.end)) })], nextCursor: 'next' },
    { status: 200, items: [item('a'), item('b'), item('missing', { modifiedDateMillis: null })], nextCursor: null }
  ]);
  const result = await f.run();
  assert.equal(result.status, 'partial'); assert.equal(result.downloaded, 2); assert.equal(f.stats.messages, 2);
  assert.equal(await readFile(path.join(f.dir, 'files/a.txt'), 'utf8'), 'hello');
  assert.equal(f.ops.filter(x => x.op === 'drive-page')[1].body.cursor, 'next');
  const final = f.written.at(-1).value;
  assert.equal(final.duplicates, 1); assert.equal(final.outside, 1); assert.equal(final.missingDates, 1);
});
test('Failed downloads keep metadata and never claim complete content', async t => {
  const f = await collectFixture(t, [{ status: 200, items: [item()], nextCursor: null }], { fail: true });
  const result = await f.run(); assert.equal(result.failedFiles, 1);
  assert.equal(f.written.find(x => x.name === 'files.jsonl').value.content.status, 'unavailable');
  assert.deepEqual(await readdir(f.dir), []);
});
test('Repeated cursors fail visibly and coverage does not claim a completed scan', async t => {
  const f = await collectFixture(t, [
    { status: 200, items: [item('a')], nextCursor: 'same' },
    { status: 200, items: [item('b')], nextCursor: 'same' }
  ]);
  await assert.rejects(f.run(), /repeated/);
  assert.equal(f.written.at(-1).value.scanComplete, false);
});
test('Collector retries rate limiting and propagates incomplete-search coverage', async t => {
  const f = await collectFixture(t, [{ status: 429, retryAfter: '1' }, { status: 200, items: [], nextCursor: null, incompleteSearch: true }]);
  const result = await f.run(); assert.equal(result.scanComplete, false);
  assert.equal(f.ops.filter(x => x.op === 'drive-page').length, 2);
});
test('Drive remains visible in development but cannot connect or request host access', async () => {
  assert.equal(getApp('googledrive'), undefined);
  const card = catalog.find(app => app.id === 'googledrive');
  assert.equal(card.maturity, 'pending');
  assert.equal(card.statusLabel, 'In development');
  assert.equal(stepBlock(1, { browserConnected: true, apps: { googledrive: { connected: true } } }, new Set(['googledrive'])), 'Connect selected apps.');
  assert.equal(allowedSite('googledrive', 'https://drive.google.com/drive/u/2/my-drive'), false);
  assert.equal(allowedSite('googledrive', 'https://drive.google.com.evil.test/'), false);
  assert.equal(allowedSite('googledrive', 'https://docs.google.com/'), false);
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
  for (const permission of hostPermissions) assert.ok(manifest.optional_host_permissions.includes(permission));
  for (const permission of ['https://drive.google.com/*', 'https://docs.google.com/*', 'https://drive.usercontent.google.com/*', 'https://*.googleusercontent.com/*']) {
    assert.ok(!hostPermissions.includes(permission));
    assert.ok(!manifest.optional_host_permissions.includes(permission));
  }
});

test('Captured named-JSON schema fixture is accepted without exposing session data', async () => {
  const schema = JSON.parse(await readFile(new URL('./fixtures/drive-schema.json', import.meta.url)));
  const b = browser([schema.fileListResponse]), identity = (await b.run('identity')).value;
  const page = await b.run('drive-page', window, identity);
  assert.equal(page.ok, true); assert.equal(page.value.items[0].id, 'synthetic-file');
  assert.equal(page.value.nextCursor, 'synthetic-opaque-cursor');
});

test('Collector validates and writes a full-sized bridge chunk without regex stack growth', async t => {
  const data = Buffer.alloc(256 * 1024, 65);
  const f = await collectFixture(t, [{ status: 200, items: [item()], nextCursor: null }], { data });
  assert.equal((await f.run()).downloaded, 1);
  assert.deepEqual(await readFile(path.join(f.dir, 'files/file-1.txt')), data);
});
