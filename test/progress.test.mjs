import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgress } from '../src/progress.mjs';
import { etaText } from '../ui/progress.mjs';

const end = Date.parse('2026-10-14T12:00:00Z'), day = 86400000;
const window = { start: new Date(end - 90 * day).toISOString(), end: new Date(end).toISOString() };
function setup(ids = ['gmail'], history = {}) {
  let clock = 0;
  const meter = createProgress(ids, window, history, () => clock);
  return { meter, advance: ms => { clock += ms; } };
}
test('First-run ETA is unknown, then uses timestamp density and time per record', () => {
  const { meter, advance } = setup(); meter.begin('gmail');
  assert.equal(meter.snapshot().eta, null);
  for (let i = 1; i <= 10; i++) { advance(1000); meter.update('gmail', { timestamp: end - i * day }); }
  const app = meter.snapshot().apps[0];
  assert.equal(app.secondsPerRecord, 1);
  assert.equal(app.eta, 80);
  assert.equal(app.percent, 11);
});
test('Same timestamp bursts do not fabricate a density estimate', () => {
  const { meter, advance } = setup(); meter.begin('gmail'); advance(10000);
  for (let i = 0; i < 20; i++) meter.update('gmail', { timestamp: end - day });
  assert.equal(meter.snapshot().eta, null);
});
test('API waits increase ETA rather than allowing a false completion countdown', () => {
  const { meter, advance } = setup(); meter.begin('gmail');
  for (let i = 1; i <= 10; i++) { advance(1000); meter.update('gmail', { timestamp: end - i * day }); }
  const first = meter.snapshot().eta; advance(60000);
  assert.ok(meter.snapshot().eta > first);
  assert.ok(meter.snapshot().percent < 100);
});
test('Slack includes remaining channels even after one channel spans the whole date range', () => {
  const { meter, advance } = setup(['slack']); meter.begin('slack'); meter.update('slack', { units: 10 });
  for (let i = 1; i <= 10; i++) { advance(1000); meter.update('slack', { timestamp: end - i * 8 * day }); }
  assert.ok(meter.snapshot().percent < 10);
  meter.update('slack', { unitDone: true });
  assert.equal(meter.snapshot().percent, 10);
  assert.equal(meter.snapshot().eta, 90);
});
test('An unsampled queued app keeps total ETA unknown while active-app ETA is visible', () => {
  const { meter, advance } = setup(['gmail', 'slack']); meter.begin('gmail');
  for (let i = 1; i <= 10; i++) { advance(1000); meter.update('gmail', { timestamp: end - i * day }); }
  assert.ok(meter.snapshot().apps[0].eta > 0);
  assert.equal(meter.snapshot().eta, null);
});
test('Previous app timings seed queued estimates and completed scans refresh them', () => {
  const { meter, advance } = setup(['gmail', 'slack'], { gmail: { secondsPerDay: 2 }, slack: { secondsPerDay: 1 } });
  assert.equal(meter.snapshot().eta, 270);
  meter.begin('gmail'); advance(90000); meter.finish('gmail', 'partial', true);
  assert.equal(meter.snapshot().apps[0].percent, 100);
  assert.equal(meter.snapshot().eta, 90);
  assert.equal(meter.history.gmail.secondsPerDay, 1);
});
test('Cancellation and failed partial downloads never become 100% or train timings', () => {
  for (const status of ['cancelled', 'failed', 'partial']) {
    const { meter, advance } = setup(); meter.begin('gmail'); advance(1000);
    meter.update('gmail', { timestamp: end - day }); meter.finish('gmail', status, false);
    assert.equal(meter.snapshot().complete, false);
    assert.ok(meter.snapshot().percent < 100);
    assert.equal(meter.snapshot().eta, null);
    assert.equal(meter.history.gmail, undefined);
  }
});
test('Zero-record completed scans finish cleanly and ETAs have readable units', () => {
  const { meter } = setup(); meter.begin('gmail'); meter.finish('gmail', 'finished', true);
  assert.equal(meter.snapshot().percent, 100); assert.equal(meter.snapshot().eta, 0);
  assert.equal(etaText(null), 'Estimating…'); assert.equal(etaText(12), 'Less than a minute');
  assert.equal(etaText(90), 'About 2 min'); assert.equal(etaText(3660), 'About 1 hr 1 min');
});
