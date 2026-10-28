import test from 'node:test';
import assert from 'node:assert/strict';
import { collectHubspot, hubspotTimes } from '../src/connectors/hubspot.mjs';
const window = { start: '2026-10-12T12:00:00Z', end: '2026-10-15T12:00:00Z' };
const start = Date.parse(window.start), end = Date.parse(window.end);
function fixture(ask, audit = async () => ({ records: [], hasMore: false, total: 0 })) {
  const writes = [], stats = { messages: 0, warnings: [] };
  return { writes, stats, options: { ask: task => task.body.scope === 'all' ? audit(task) : ask(task), window, stats, writer: { append: async (name, record) => writes.push({ name, record }) }, wait: async () => {} } };
}
const row = (id, timestamp) => ({ id: String(id), properties: { lastmodifieddate: { value: String(timestamp) }, custom_field: 'retained' } });
const empty = { records: [], hasMore: false };
test('HubSpot scans all pages with exact boundaries, deduplication and original record structure', async () => {
  const calls = [];
  const f = fixture(async task => {
    calls.push(task);
    if (task.body.type !== 'contacts') return empty;
    if (task.body.cursor === 0) return { records: [row(1, start), row(2, start - 1)], hasMore: true, nextCursor: 'next' };
    return { records: [row(1, start), row(3, end - 1), row(4, end), { id: '5' }], hasMore: false };
  });
  const result = await collectHubspot(f.options);
  assert.equal(result.windowApplied, true); assert.equal(result.scanComplete, true); assert.equal(result.status, 'partial');
  assert.deepEqual(f.writes.filter(w => w.name === 'contacts.jsonl').map(w => w.record), [row(1, start), row(3, end - 1)]);
  assert.equal(f.stats.messages, 2); assert.equal(calls.length, 4);
  assert.deepEqual(calls[1].body, { type: 'contacts', window, cursor: 'next' });
  const counts = f.writes.at(-1).record.types.contacts;
  assert.equal(counts.duplicates, 1); assert.equal(counts.outsideWindow, 2); assert.equal(counts.missingTimestamp, 1);
});
test('HubSpot supports ISO and millisecond properties including recently modified older records', () => {
  assert.deepEqual(hubspotTimes({ createdAt: '2020-01-01T00:00:00Z', properties: { hs_lastmodifieddate: String(start) } }), [Date.parse('2020-01-01T00:00:00Z'), start]);
  assert.deepEqual(hubspotTimes({ properties: { createdate: { value: 'not a date' } } }), []);
});
test('Missing/repeated cursors and repeated pages are reported without infinite loops', async () => {
  for (const mode of ['missing', 'same-cursor', 'same-page']) {
    let n = 0;
    const f = fixture(async ({ body }) => body.type !== 'contacts' ? empty : ({ records: [row(mode === 'same-page' ? 1 : ++n, start)], hasMore: true, nextCursor: mode === 'missing' ? undefined : mode === 'same-cursor' ? 'same' : String(++n) }));
    const result = await collectHubspot(f.options);
    assert.equal(result.scanComplete, false); assert.ok(f.stats.warnings.some(w => /continuation|repeated a page/.test(w))); assert.ok(f.stats.messages <= 2);
  }
});
test('Forbidden record types can be skipped, but account changes and cancellation stop immediately', async () => {
  const f = fixture(async ({ body }) => { if (body.type === 'contacts') throw Object.assign(Error('Forbidden'), { code: 'FORBIDDEN' }); return empty; });
  assert.equal((await collectHubspot(f.options)).scanComplete, false);
  for (const code of ['ACCOUNT_CHANGED', 'LOGIN_REQUIRED']) {
    let calls = 0;
    const f = fixture(async () => { calls++; throw Object.assign(Error(code), { code }); });
    await assert.rejects(collectHubspot(f.options), new RegExp(code)); assert.equal(calls, 1); assert.equal(f.writes.at(-1).name, 'coverage.jsonl');
  }
  const f2 = fixture(async () => { throw Error('must not request'); });
  await assert.rejects(collectHubspot({ ...f2.options, signal: AbortSignal.abort(Error('cancelled')) }), /cancelled/);
});
test('Rate limiting retries the same cursor and stops after bounded attempts', async () => {
  let n = 0; const waits = [];
  const f = fixture(async () => ++n <= 2 ? { status: 429, retryAfter: 3 } : empty);
  await collectHubspot({ ...f.options, wait: async ms => waits.push(ms) });
  assert.deepEqual(waits, [3000, 3000]); assert.equal(f.stats.messages, 0);
});
test('Malformed pages do not masquerade as an empty completed scan', async () => {
  const f = fixture(async () => ({ records: [], hasMore: 'false' }));
  await assert.rejects(collectHubspot(f.options), /could not read/);
  assert.ok(Object.values(f.writes.at(-1).record.types).every(v => v.scanComplete === false));
});
test('Large searches split into contiguous half-open ranges and deduplicate across partitions', async () => {
  const ranges = [];
  const f = fixture(async ({ body }) => {
    if (body.type !== 'contacts') return empty;
    ranges.push(body.window);
    if (ranges.length === 1) return { splitRequired: true };
    return { records: [row(1, start), row(ranges.length, Date.parse(body.window.start))], hasMore: false, total: 2 };
  });
  assert.equal((await collectHubspot(f.options)).scanComplete, true);
  assert.equal(ranges.length, 3); assert.equal(Date.parse(ranges[1].start), start); assert.equal(ranges[1].end, ranges[2].start); assert.equal(Date.parse(ranges[2].end), end);
  assert.equal(f.stats.messages, 3); assert.equal(f.writes.at(-1).record.types.contacts.duplicates, 1);
});
test('Dense timestamps and early pagination termination are reported as incomplete', async () => {
  const f = fixture(async ({ body }) => body.type === 'contacts' ? { splitRequired: true } : empty);
  const outcome = await collectHubspot({ ...f.options, window: { start: new Date(start).toISOString(), end: new Date(start + 1).toISOString() } });
  assert.equal(outcome.scanComplete, false); assert.match(f.stats.warnings[0], /smallest date range/);
  const f2 = fixture(async ({ body }) => body.type === 'contacts' ? { records: [row(1, start)], total: 2, hasMore: false } : empty);
  assert.equal((await collectHubspot(f2.options)).scanComplete, false); assert.equal(f2.stats.messages, 1);
  assert.match(f2.stats.warnings[0], /reported total/);
});
test('Invalid client parameters stop once instead of repeating the same error for every record type', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw Object.assign(Error('Invalid HubSpot cursor'), { code: 'INVALID_REQUEST' }); });
  await assert.rejects(collectHubspot(f.options), /Invalid HubSpot cursor/);
  assert.equal(calls, 1); assert.equal(f.writes.at(-1).name, 'coverage.jsonl');
});

test('Unfiltered audit recovers omitted eligible records, keeps original values and diagnoses date exclusions', async () => {
  const recovered = row(2, end - 1);
  const all = [row(1, start), recovered, row(3, start - 1), row(4, end), { id: '5' }, row(6, 1e20)];
  const f = fixture(async ({ body }) => body.type === 'contacts' ? { records: [all[0]], total: 1, hasMore: false } : empty,
    async ({ body }) => body.type === 'contacts' ? { records: all, total: all.length, hasMore: false } : { ...empty, total: 0 });
  await collectHubspot(f.options);
  assert.deepEqual(f.writes.filter(w => w.name === 'contacts.jsonl').map(w => w.record), [all[0], recovered]);
  const audit = f.writes.at(-1).record.types.contacts.audit;
  assert.equal(audit.status, 'full'); assert.equal(audit.recovered, 1); assert.equal(audit.absentFromFiltered, 1);
  assert.equal(audit.dates.beforeStart, 1); assert.equal(audit.dates.atOrAfterEnd, 1); assert.equal(audit.dates.missing, 2); assert.equal(audit.dates.invalidFields, 1);
  assert.ok(f.stats.warnings.some(w => /recovered 1/.test(w)));
  assert.ok(f.writes.some(w => w.name === 'diagnostics.jsonl' && /audit full/.test(w.record.message)));
});
test('Small audits paginate, deduplicate and report changed totals as unstable', async () => {
  const f = fixture(async () => empty, async ({ body }) => body.type !== 'contacts' ? { ...empty, total: 0 } : body.cursor === 0
    ? { records: [row(1, start)], total: 2, hasMore: true, nextCursor: 1 }
    : { records: [row(1, start), row(2, start), row(3, start)], total: 3, hasMore: false });
  await collectHubspot(f.options);
  const audit = f.writes.at(-1).record.types.contacts.audit;
  assert.equal(audit.status, 'unstable'); assert.equal(audit.pages, 2); assert.equal(audit.totalChanges, 1); assert.equal(audit.unique, 3); assert.equal(audit.duplicates, 1); assert.equal(f.stats.messages, 3);
});
test('Large audits use one bounded page and explicitly leave the remainder unverified', async () => {
  let calls = 0;
  const f = fixture(async () => empty, async ({ body }) => {
    if (body.type !== 'contacts') return { ...empty, total: 0 };
    calls++; return { records: [row(1, start)], total: 15000, hasMore: true, nextCursor: 100 };
  });
  await collectHubspot(f.options);
  const coverage = f.writes.at(-1).record;
  assert.equal(calls, 1); assert.equal(coverage.types.contacts.audit.status, 'sampled'); assert.equal(coverage.complete, false);
  assert.ok(f.writes.some(w => /Remainder not audited/.test(w.record.message || '')));
});
test('Falling filtered totals cannot conceal truncated pagination; failed audits retain saved records', async () => {
  const f = fixture(async ({ body }) => body.type !== 'contacts' ? empty : body.cursor === 0
    ? { records: [row(1, start)], total: 3, hasMore: true, nextCursor: 1 }
    : { records: [row(2, start)], total: 2, hasMore: false });
  assert.equal((await collectHubspot(f.options)).scanComplete, false);
  assert.equal(f.writes.at(-1).record.types.contacts.ranges[0].totalMax, 3);
  assert.equal(f.writes.at(-1).record.types.contacts.audit.status, 'skipped');
  const f2 = fixture(async ({ body }) => body.type === 'contacts' ? { records: [row(1, start)], total: 1, hasMore: false } : empty,
    async () => { throw Object.assign(Error('Forbidden'), { code: 'FORBIDDEN' }); });
  await collectHubspot(f2.options);
  assert.equal(f2.stats.messages, 1); assert.equal(f2.writes.at(-1).record.types.contacts.audit.status, 'failed');
});
test('Account changes or cancellation during audit abort before saving audit records', async () => {
  for (const mode of ['account', 'cancel']) {
    const controller = new AbortController();
    const f = fixture(async () => empty, async () => {
      if (mode === 'account') throw Object.assign(Error('Account changed'), { code: 'ACCOUNT_CHANGED' });
      controller.abort(Error('cancelled')); return { records: [row(1, start)], total: 1, hasMore: false };
    });
    await assert.rejects(collectHubspot({ ...f.options, signal: controller.signal }), /Account changed|cancelled/);
    assert.equal(f.stats.messages, 0); assert.equal(f.writes.at(-1).name, 'coverage.jsonl');
  }
});
test('Persisted diagnostics redact secrets and do not log opaque cursors or record content', async () => {
  const f = fixture(async ({ body }) => body.type !== 'contacts' ? empty : body.cursor === 0
    ? { records: [row(1, start)], hasMore: true, nextCursor: 'PRIVATE_CURSOR', diagnostics: ['Authorization: Bearer PRIVATE_TOKEN'] }
    : { records: [row(2, start)], hasMore: false });
  await collectHubspot(f.options);
  const logs = JSON.stringify(f.writes.filter(w => w.name === 'diagnostics.jsonl'));
  assert.doesNotMatch(logs, /PRIVATE_CURSOR|PRIVATE_TOKEN|custom_field|retained/);
  assert.match(logs, /opaque-string/);
});
