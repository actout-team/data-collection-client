import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectSlack } from '../src/connectors/slack.mjs';
import { collectGmail } from '../src/connectors/gmail.mjs';
import { createWriter, downloadStatus, daysBackWindow } from '../src/export.mjs';
import { allowedSite, readRequest, accountPath } from '../extension/catalog.mjs';

const window = { start: '2026-07-14T12:00:00.000Z', end: '2026-10-14T12:00:00.000Z' };
const oldest = Date.parse(window.start) / 1000, latest = Date.parse(window.end) / 1000;
const stats = () => ({ messages: 0, channels: 0, warnings: [] });
const signal = () => new AbortController().signal;

test('read policy rejects writes, deceptive hosts, cross-origin and encoded paths', () => {
  assert.equal(allowedSite('slack', 'https://app.slack.com/client/T123'), true);
  for (const url of ['https://slack.com.evil.test', 'http://app.slack.com', 'https://user:pass@app.slack.com', 'https://app.slack.com:444']) assert.equal(allowedSite('slack', url), false);
  for (const method of ['chat.postMessage', 'conversations.archive', '../api/auth.test', '%61uth.test']) assert.equal(readRequest('slack', 'https://app.slack.com', `/api/${method}`, 'POST'), false);
  assert.equal(readRequest('slack', 'https://app.slack.com', '/api/conversations.history', 'POST'), true);
  assert.notEqual(accountPath('gmail', 'https://mail.google.com/mail/u/0/'), accountPath('gmail', 'https://mail.google.com/mail/u/1/'));
});
test('Days back defaults to exactly 90 days and accepts custom windows', () => {
  const end = new Date('2026-10-14T14:46:17.442Z');
  assert.equal(daysBackWindow(undefined, end).start, '2026-07-16T14:46:17.442Z');
  assert.equal(daysBackWindow(1, end).start, '2026-10-13T14:46:17.442Z');
  assert.equal(daysBackWindow(365, end).start, '2025-10-14T14:46:17.442Z');
  assert.equal(end.toISOString(), '2026-10-14T14:46:17.442Z');
});
test('Days back rejects invalid IPC input and stays exact across leap days', () => {
  for (const days of [0, -1, 1.5, NaN, Infinity, '90', null, 36501]) assert.throws(() => daysBackWindow(days), /whole number/);
  assert.equal(daysBackWindow(1, new Date('2024-03-01T10:00:00Z')).start, '2024-02-29T10:00:00.000Z');
});
test('Slack scans older thread roots, paginates and deduplicates replies', async () => {
  const records = [], calls = [], samples = [], s = stats();
  const ask = async task => {
    calls.push(task); let data = { ok: true };
    const method = task.path.split('/').pop(), cursor = task.body.cursor;
    if (method === 'users.list') data.members = [{ id: 'U1' }];
    if (method === 'conversations.list') data.channels = [{ id: 'C123', name: 'work' }];
    if (method === 'conversations.history') {
      assert.equal(task.body.oldest, undefined);
      data.messages = cursor ? [{ ts: String(oldest - 99999), reply_count: 1, latest_reply: String(oldest + 10) }] : [{ ts: String(oldest), reply_count: 0 }];
      if (!cursor) data.response_metadata = { next_cursor: 'next' };
    }
    if (method === 'conversations.replies') data.messages = [{ ts: String(oldest - 99999) }, { ts: String(oldest + 10) }, { ts: String(oldest + 10) }, { ts: String(latest) }];
    return { data };
  };
  const result = await collectSlack({ ask, window, writer: { append: async (name, data) => records.push({ name, data }) }, signal: signal(), stats: s, meter: event => samples.push(event), progress() {} });
  assert.deepEqual(samples, [{ units: 1 }, { timestamp: oldest * 1000 }, { timestamp: (oldest + 10) * 1000 }, { unitDone: true }]);
  assert.equal(result.status, 'finished'); assert.equal(s.messages, 2); assert.equal(s.channels, 1);
  assert.equal(calls.filter(t => t.path.endsWith('conversations.history')).length, 2);
  assert.equal(records.filter(r => r.name === 'messages.jsonl').length, 2);
});
test('Slack preserves a per-channel error and continues', async () => {
  const s = stats();
  const ask = async task => ({ data: task.path.endsWith('users.list') ? { ok: true, members: [] } : task.path.endsWith('conversations.list') ? { ok: true, channels: [{ id: 'C123' }, { id: 'C456' }] } : task.body.channel === 'C123' ? { ok: false, error: 'not_in_channel' } : { ok: true, messages: [] } });
  const result = await collectSlack({ ask, window, writer: { append: async () => {} }, signal: signal(), stats: s, progress() {} });
  assert.equal(result.status, 'partial'); assert.equal(s.channels, 2); assert.match(s.warnings[0], /not_in_channel/);
});
test('Slack refuses a truncated pagination response', async () => {
  const s = stats();
  const ask = async task => ({ data: task.path.endsWith('users.list') ? { ok: true, members: [] } : { ok: true, channels: [], has_more: true } });
  await assert.rejects(collectSlack({ ask, window, writer: { append: async () => {} }, signal: signal(), stats: s, progress() {} }), /no cursor/);
});
for (const kind of ['old-only', 'mixed', 'empty', 'invalid']) {
  test(`Slack explains ${kind} history in the reported 14-day window`, async () => {
    const selected = daysBackWindow(14, new Date('2026-10-14T21:44:38.961Z'));
    const start = Date.parse(selected.start) / 1000, end = Date.parse(selected.end) / 1000;
    const ts = seconds => ({ ts: String(seconds) });
    const messages = kind === 'old-only' ? [ts(start - 1), ts(start - 86400)]
      : kind === 'mixed' ? [ts(start - 1), ts(start), ts(start), ts(end - 0.001), ts(end)]
      : kind === 'invalid' ? [{ ts: 'broken' }, { ts: null }, {}, { ts: '9'.repeat(400) }] : [];
    const s = stats(), records = [], logs = [];
    const ask = async task => ({ data: task.path.endsWith('users.list') ? { ok: true, members: [] }
      : task.path.endsWith('conversations.list') ? { ok: true, channels: [{ id: 'D123' }] }
      : { ok: true, messages } });
    const result = await collectSlack({ ask, window: selected, stats: s, progress() {}, diagnostic: line => logs.push(line),
      writer: { append: async (name, data) => records.push({ name, data }) } });
    const coverage = records.find(r => r.name === 'coverage.jsonl').data;
    assert.deepEqual(coverage.filter, s.filter);
    assert.equal(s.filter.received, messages.length);
    assert.equal(s.messages, kind === 'mixed' ? 2 : 0);
    assert.equal(result.status, kind === 'invalid' ? 'partial' : 'finished');
    assert.equal(records.filter(r => r.name === 'channels.jsonl').length, 1);
    assert.equal(s.filter.received, s.messages + s.filter.beforeWindow + s.filter.atOrAfterEnd + s.filter.duplicates + s.filter.invalidTimestamp);
    assert.ok(logs.some(line => line.includes(selected.start) && line.includes(selected.end)));
    if (kind === 'old-only') {
      assert.equal(s.filter.beforeWindow, 2);
      assert.equal(s.filter.newestReceived, new Date((start - 1) * 1000).toISOString());
      assert.ok(logs.some(line => /No messages were saved/.test(line)));
    }
    if (kind === 'mixed') {
      assert.equal(s.filter.atOrAfterEnd, 1);
      assert.equal(s.filter.duplicates, 1);
      assert.equal(s.filter.beforeWindow, 1);
    }
    if (kind === 'invalid') {
      assert.equal(s.filter.invalidTimestamp, 4);
      assert.equal(s.filter.newestReceived, null);
      assert.match(s.warnings[0], /invalid timestamps/);
    }
    if (kind === 'empty') assert.equal(s.filter.oldestReceived, null);
  });
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'actout-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const mail = id => ({ id: `msg-f:${id}`, timestamp: oldest * 1000, content_status: 'readable', content_html: '<p>שלום</p>' });
function apiFixture(messages) {
  return async task => {
    if (task.op === 'gmail-page') return task.body.offset ? { threads: [], done: true } : { threads: [{ id: 'thread-f:1', messageIds: [messages[0].id] }], done: false, nextOffset: 1, signature: 'first' };
    if (task.op === 'gmail-thread') return { messages, allIds: messages.map(m => m.id) };
    return { ok: true };
  };
}
test('Gmail saves bodies and metadata without downloading attachment bytes, filtering dates and duplicates', async t => {
  const dir = await fixture(t), writer = await createWriter(dir), s = stats();
  const samples = [];
  const messages = [mail('123'), mail('123'), { ...mail('456'), timestamp: latest * 1000 }, { ...mail('bad'), id: '../../escape' }];
  const result = await collectGmail({ ask: apiFixture(messages), window, dir, writer, signal: signal(), stats: s, meter: event => samples.push(event), progress() {} }); await writer.close();
  assert.deepEqual(samples, [{ timestamp: oldest * 1000 }]);
  assert.equal(result.status, 'partial'); assert.equal(s.messages, 1);
  assert.deepEqual(await readdir(dir), ['messages.jsonl']);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'messages.jsonl'), 'utf8')).content_html, '<p>שלום</p>');
  assert.equal(JSON.parse(await readFile(path.join(dir, 'messages.jsonl'), 'utf8')).attachmentContentStatus, 'not-collected');
});
test('Gmail never requests original MIME even when an attachment is listed or the body is unavailable', async t => {
  const dir = await fixture(t), writer = await createWriter(dir), s = stats();
  const messages = [{ ...mail('1'), attachments: [{ name: 'private.pdf', mimeType: 'application/pdf' }] }, { ...mail('2'), content_status: 'unavailable', content_html: null }];
  const base = apiFixture(messages);
  const ask = task => {
    assert.ok(!['gmail-source', 'gmail-chunk'].includes(task.op), 'Attachment-bearing original must not be requested.');
    return base(task);
  };
  await collectGmail({ ask, window, dir, writer, stats: s, progress() {} }); await writer.close();
  const rows = (await readFile(path.join(dir, 'messages.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].attachments[0].name, 'private.pdf');
  assert.equal(rows[1].content_html, null);
  assert.equal(s.warnings.length, 1);
  assert.deepEqual(await readdir(dir), ['messages.jsonl']);
});
test('Gmail cancellation happens before requesting data', async t => {
  const dir = await fixture(t), controller = new AbortController(); controller.abort(Error('cancelled'));
  await assert.rejects(collectGmail({ ask: () => assert.fail('must not request'), window, dir, writer: {}, signal: controller.signal, stats: stats(), progress() {} }), /cancelled/);
});

test('Download outcomes distinguish failed extraction, empty searches, saved data and cancellation', () => {
  assert.equal(downloadStatus({ gmail: { status: 'failed', messages: 0 } }), 'failed');
  assert.equal(downloadStatus({ gmail: { status: 'partial', messages: 0 } }), 'partial');
  assert.equal(downloadStatus({ gmail: { status: 'failed', messages: 0 }, slack: { status: 'finished', messages: 2 } }), 'partial');
  assert.equal(downloadStatus({ slack: { status: 'finished', messages: 0 } }), 'finished');
  assert.equal(downloadStatus({ gmail: { status: 'failed', messages: 0 } }, true), 'cancelled');
});

test('Gmail API scans short pages until an empty page and updates saved counts between messages', async t => {
  const dir = await fixture(t), writer = await createWriter(dir), s = stats(), updates = [], offsets = [];
  const ask = async task => {
    if (task.op === 'gmail-page') {
      const offset = task.body.offset; offsets.push(offset);
      if (offset === 1) assert.ok(updates.some(text => /2 saved/.test(text)));
      return offset === 2 ? { done: true, threads: [] } : { done: false, signature: `page-${offset}`, nextOffset: offset + 1, threads: [{ id: `thread-f:${offset}`, messageIds: [offset ? 'msg-f:3' : 'msg-f:1'] }] };
    }
    if (task.op === 'gmail-thread') return { allIds: ['msg-f:1', 'msg-f:2', 'msg-f:3'], messages: task.body.id === 'thread-f:0' ? [mail('1'), mail('2')] : [mail('2'), mail('3')] };
    return { ok: true };
  };
  await collectGmail({ ask, window, dir, writer, signal: signal(), stats: s, progress: text => updates.push(text) }); await writer.close();
  assert.deepEqual(offsets, [0, 1, 2]); assert.equal(s.messages, 3); assert.equal(s.discovered, 3);
  assert.ok(updates.some(text => /1 saved/.test(text)));
  assert.equal((await readFile(path.join(dir, 'messages.jsonl'), 'utf8')).trim().split('\n').length, 3);
});
test('Gmail refuses a thread response that omits search result messages', async t => {
  const dir = await fixture(t);
  const ask = async task => task.op === 'gmail-page' ? { threads: [{ id: 'thread-f:1', messageIds: ['msg-f:1'] }], done: false, signature: 'one', nextOffset: 1 } : { messages: [], allIds: [] };
  await assert.rejects(collectGmail({ ask, window, dir, writer: {}, signal: signal(), stats: stats(), progress() {} }), /omitted messages/);
});

test('Gmail remains independent of the unavailable original download service', async t => {
  const dir = await fixture(t), writer = await createWriter(dir), s = stats();
  const normal = apiFixture([mail('1'), mail('2')]);
  const ask = task => task.op === 'gmail-source' ? Promise.reject(Error('Gmail source returned HTTP 503.')) : normal(task);
  await collectGmail({ ask, window, dir, writer, stats: s, progress() {} }); await writer.close();
  const records = (await readFile(path.join(dir, 'messages.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(s.messages, 2); assert.equal(records.length, 2);
  assert.equal(records[0].original_status, 'not-collected'); assert.equal(records[1].content_html, '<p>שלום</p>');
  assert.equal(s.warnings.length, 0);
});


for (const continuation of ['omitted', 'repeated']) {
  test(`Gmail handles ${continuation} continuation pages without silently truncating`, async t => {
    const { parseSearch } = await import('../extension/gmail-api.mjs');
    const dir = await fixture(t), writer = await createWriter(dir), s = stats(), logs = [];
    // Include an email exactly at the first split boundary, plus an empty interval.
    const midpoint = Math.floor((oldest + latest) / 2);
    const messages = Array.from({ length: 301 }, (_, i) => ({ ...mail(String(i)),
      timestamp: (i === 0 ? midpoint : oldest + i * 1000) * 1000 }));
    let calls = 0;
    const ask = async task => {
      if (task.op === 'gmail-page') {
        calls++;
        const { start, end, offset } = task.body;
        const matching = messages.filter(m => m.timestamp >= start * 1000 && m.timestamp < end * 1000).slice(0, 50);
        const descriptors = matching.map(m => ({ 1: { 4: m.id.replace('msg-', 'thread-'), 5: [{ 1: m.id }] } }));
        const raw = offset && continuation === 'omitted' || !matching.length ? { 1: 0 } : { 1: 0, 3: descriptors };
        return parseSearch(JSON.stringify(raw), offset);
      }
      if (task.op === 'gmail-thread') {
        const message = messages.find(m => m.id === task.body.id.replace('thread-', 'msg-'));
        return { allIds: [message.id], messages: [message] };
      }
      return { ok: true };
    };
    // Repeated pages cannot prove completion in a nonempty one-second range.
    if (continuation === 'repeated') {
      await assert.rejects(collectGmail({ ask, window, dir, writer, stats: s, progress() {}, diagnostic: line => logs.push(line) }), /one-second interval/);
    } else {
      await collectGmail({ ask, window, dir, writer, stats: s, progress() {}, diagnostic: line => logs.push(line) });
      assert.equal(s.messages, 301);
      const rows = (await readFile(path.join(dir, 'messages.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(new Set(rows.map(m => m.id)).size, 301);
    }
    await writer.close();
    assert.ok(calls > 2); assert.ok(logs.some(line => /Splitting date range/.test(line)));
  });
}


test('Slack scans every conversation type across list pages and continues after a thread failure', async () => {
  const s = stats(), records = [], histories = [];
  const ask = async task => {
    const body = task.body;
    if (task.path.endsWith('users.list')) return { data: { ok: false, error: 'missing_scope' } };
    if (task.path.endsWith('conversations.list')) {
      assert.equal(body.types, 'public_channel,private_channel,im,mpim');
      assert.equal(body.exclude_archived, false);
      return { data: { ok: true, channels: body.cursor ? [{ id: 'D123' }, { id: 'G456' }, { id: 'C123' }] : [{ id: 'C123', is_archived: true }, { id: 'G123', is_private: true }], response_metadata: { next_cursor: body.cursor ? '' : 'next' } } };
    }
    if (task.path.endsWith('conversations.history')) {
      histories.push(body.channel);
      return { data: { ok: true, messages: [{ ts: String(oldest - 10), reply_count: 1 }, { ts: String(oldest + 20) }] } };
    }
    return { data: { ok: false, error: 'thread_not_found' } };
  };
  const result = await collectSlack({ ask, window, stats: s, progress() {}, writer: { append: async (file, row) => records.push({ file, row }) } });
  assert.deepEqual(histories, ['C123', 'G123', 'D123', 'G456']);
  assert.equal(s.messages, 4); assert.equal(s.channelsPartial, 4); assert.equal(result.status, 'partial');
  assert.equal(records.filter(r => r.file === 'coverage.jsonl').length, 4);
});
