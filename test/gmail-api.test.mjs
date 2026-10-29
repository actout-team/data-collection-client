import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearch, parseThread, installGmailApi } from '../extension/gmail-api.mjs';

// Protobuf JSON field layout, matching the public Gmail.js/InboxSDK fixtures.
const search = { 1: 0, 3: [{ 1: { 1: 'Subject', 4: 'thread-f:1', 5: [{ 1: 'msg-f:1' }] } }] };
const thread = { 1: 0, 2: [{ 1: 'thread-f:1', 2: { 2: [{ 1: 'msg-f:1', 2: { 2: 'from@example.test', 3: 'Sender' }, 4: ['^i'] }] },
  3: [{ 1: 'msg-f:1', 2: { 1: [{ 2: 'to@example.test', 3: 'Recipient' }], 5: 'שלום 📨', 6: { 2: [{ 3: { 2: '<p>שלום 📨</p>' } }] }, 8: '<message@example.test>', 17: '1791970000000' } }] }] };
const arrayFormat = value => Array.isArray(value) ? value.map(arrayFormat) : value && typeof value === 'object' ? Object.entries(value).reduce((out, [key, child]) => { out[Number(key) - 1] = arrayFormat(child); return out; }, []) : value;
for (const [format, convert] of [['object', value => value], ['array', arrayFormat]]) {
  test(`Gmail ${format} API decodes threads, recipients and Unicode HTML`, () => {
    const page = parseSearch(JSON.stringify(convert(search)), 50);
    assert.equal(page.nextOffset, 51); assert.equal(page.done, false);
    assert.deepEqual(page.threads[0], { id: 'thread-f:1', messageIds: ['msg-f:1'] });
    const result = parseThread(JSON.stringify(convert(thread)), 'thread-f:1');
    assert.equal(result.messages[0].content_html, '<p>שלום 📨</p>');
    assert.equal(result.messages[0].to[0].address, 'to@example.test');
    assert.equal(result.messages[0].content_status, 'readable');
  });
}
test('Gmail strips the JSON protection prefix but rejects errors, HTML, and unknown schemas', () => {
  assert.equal(parseSearch(")]}'\n" + JSON.stringify(arrayFormat(search)), 0).threads.length, 1);
  for (const raw of ['<html>login</html>', '{}', '[1, null, []]' ]) assert.throws(() => parseSearch(raw, 0));
  assert.equal(parseSearch('[0,null,[]]', 0).done, true);
  for (const raw of ['[0]', '[0,null,null]', '{"1":0}']) {
    assert.equal(parseSearch(raw, 50).ambiguous, true);
  }
});
test('Gmail excludes Spam and Trash messages inside otherwise matching threads', () => {
  for (const label of ['^s', '^k']) {
    const input = structuredClone(thread); input[2][0][2][2][0][4] = [label];
    const result = parseThread(JSON.stringify(input), 'thread-f:1');
    assert.equal(result.messages.length, 0); assert.deepEqual(result.allIds, ['msg-f:1']);
  }
});
test('Missing body is explicitly unavailable, never claimed decrypted', () => {
  const input = structuredClone(thread); delete input[2][0][3][0][2][6];
  const result = parseThread(JSON.stringify(input), 'thread-f:1');
  assert.equal(result.messages[0].content_html, null); assert.equal(result.messages[0].content_status, 'unavailable');
  assert.throws(() => parseThread(JSON.stringify(thread), 'thread-f:another'), /unexpected thread/);
});
function targetFixture(response = JSON.stringify(arrayFormat(search))) {
  const calls = [];
  class XHR { open() {} setRequestHeader() {} }
  const target = {
    XMLHttpRequest: XHR, location: { origin: 'https://mail.google.com', href: 'https://mail.google.com/mail/u/1/#inbox', pathname: '/mail/u/1/' },
    setTimeout: callback => callback(),
    fetch: async (url, options) => {
      calls.push({ url, options });
      const bytes = new TextEncoder().encode(response);
      return new Response(new ReadableStream({ start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      } }));
    }
  };
  const api = installGmailApi(target);
  const capture = (path = '/sync/u/1/i/bv') => {
    const xhr = new target.XMLHttpRequest(); xhr.open('POST', path);
    xhr.setRequestHeader('X-Framework-Xsrf-Token', 'fixture-xsrf'); xhr.setRequestHeader('X-Gmail-BTAI', 'fixture-btai');
  };
  return { target, api, calls, capture };
}
test('API uses captured same-account headers and explicit offsets without UI navigation', async () => {
  const { target, api, calls, capture } = targetFixture(); capture();
  await api.search({ start: 1784026632, end: 1791975433, offset: 50 });
  const { url, options } = calls[0];
  assert.equal(url, '/sync/u/1/i/bv?rt=r&pt=ji');
  assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'error');
  assert.equal(options.headers['x-framework-xsrf-token'], 'fixture-xsrf');
  const body = JSON.parse(options.body); assert.equal(body[0][9], 50); assert.equal(body[0][3], 'after:2026/07/13 before:2026/10/15');
  await api.search({ start: 1784026632, end: 1791975433, offset: 0, precise: true });
  assert.equal(JSON.parse(calls[1].options.body)[0][3], 'after:1784026631 before:1791975433');
  assert.equal(target.location.href, 'https://mail.google.com/mail/u/1/#inbox');
  assert.equal(JSON.stringify(api).includes('fixture-xsrf'), false);
});
test('Other origins and accounts cannot seed session headers', async () => {
  for (const url of ['/sync/u/0/i/bv', 'https://example.test/sync/u/1/i/bv']) {
    const { api, calls, capture } = targetFixture(); capture(url);
    await assert.rejects(api.search({ start: 1, end: 2, offset: 0 }), /headers are not ready/);
    assert.equal(calls.length, 0);
  }
});
test('Thread request decodes UTF-8 across streamed byte boundaries', async () => {
  const { api, capture } = targetFixture(JSON.stringify(arrayFormat(thread))); capture();
  assert.equal((await api.thread({ id: 'thread-f:1' })).messages[0].subject, 'שלום 📨');
  await assert.rejects(api.thread({ id: '../send' }), /Invalid Gmail thread/);
});

test('Full serialized tab-to-disk flow collects two API pages and readable bodies without navigation', async t => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const vm = await import('node:vm');
  const { gmailRead } = await import('../extension/gmail.mjs');
  const { collectGmail } = await import('../src/connectors/gmail.mjs');
  const { createWriter } = await import('../src/export.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'actout-api-e2e-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const offsets = [], methods = [];
  class XHR { open() {} setRequestHeader() {} }
  const location = { origin: 'https://mail.google.com', href: 'https://mail.google.com/mail/u/1/#inbox', pathname: '/mail/u/1/' };
  const target = { location, XMLHttpRequest: XHR, GLOBALS: [,,,,,,,,,, 'person@example.test'], setTimeout,
    fetch: async (input, options = {}) => {
      const url = new URL(input, location.href); methods.push(options.method || 'GET');
      if (url.pathname.endsWith('/bv')) {
        const offset = JSON.parse(options.body)[0][9]; offsets.push(offset);
        const data = offset === 2 ? { 1: 0, 3: [] } : JSON.parse(JSON.stringify(search).replaceAll('thread-f:1', `thread-f:${offset + 1}`).replaceAll('msg-f:1', `msg-f:${offset + 1}`));
        return new Response(JSON.stringify(arrayFormat(data)));
      }
      if (url.pathname.endsWith('/fd')) {
        const id = JSON.parse(options.body)[0][0][0].split(':')[1];
        const data = JSON.parse(JSON.stringify(thread).replaceAll('thread-f:1', `thread-f:${id}`).replaceAll('msg-f:1', `msg-f:${id}`));
        return new Response(JSON.stringify(arrayFormat(data)));
      }
      assert.equal(url.searchParams.get('view'), 'att');
      return new Response('From: test@example.test\r\nSubject: original\r\n\r\nBody');
    }
  };
  installGmailApi(target);
  const xhr = new target.XMLHttpRequest(); xhr.open('POST', '/sync/u/1/i/bv');
  xhr.setRequestHeader('X-Framework-Xsrf-Token', 'fixture'); xhr.setRequestHeader('X-Gmail-BTAI', 'fixture');
  t.after(() => clearTimeout(target.__actoutSourceTimer));
  const context = vm.createContext({ window: target, document: { querySelector: () => ({}) }, location, fetch: target.fetch,
    URL, URLSearchParams, AbortSignal, TextDecoder, Uint8Array, setTimeout, clearTimeout, btoa });
  const ask = async task => {
    context.op = task.op; context.args = task.body || {};
    const reply = await vm.runInContext(`(${gmailRead.toString()})(op, args, {account:'person@example.test'})`, context);
    if (!reply.ok) throw Error(reply.error);
    return JSON.parse(JSON.stringify(reply.value));
  };
  const writer = await createWriter(dir), stats = { messages: 0, warnings: [] };
  try {
    await collectGmail({ ask, window: { start: '2026-07-14T00:00:00Z', end: '2026-10-15T00:00:00Z' }, dir, writer, stats, progress() {} });
  } finally { await writer.close(); }
  assert.deepEqual(offsets, [0, 1, 2]); assert.equal(stats.messages, 2);
  const records = (await readFile(path.join(dir, 'messages.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records[1].content_html, '<p>שלום 📨</p>');
  assert.equal(records[1].original_status, 'not-collected');
  assert.equal(records[1].file, undefined);
  assert.equal(records[1].attachmentContentStatus, 'not-collected');
  assert.equal(location.href, 'https://mail.google.com/mail/u/1/#inbox');
  assert.ok(methods.every(method => ['GET', 'POST'].includes(method)));
  assert.equal(JSON.stringify(records).includes('fixture'), false);
});

test('Thread schema diagnostics identify the failed field without exposing content', () => {
  assert.throws(() => parseThread('[0,"private body"]', 'thread-f:1'), error => {
    assert.equal(error.code, 'GMAIL_FORMAT');
    assert.match(error.message, /fd: thread response field 2: expected array, got string/);
    assert.doesNotMatch(error.message, /private body/);
    return true;
  });
});
