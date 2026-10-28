import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoAdvance } from '../ui/auto-advance.mjs';

function fixture() {
  const timers = new Map(), jumps = [];
  let id = 0;
  const update = createAutoAdvance(step => jumps.push(step), {
    schedule: (callback, delay) => { assert.equal(delay, 900); timers.set(++id, callback); return id; },
    cancel: key => timers.delete(key)
  });
  return { update, timers, jumps, tick() { for (const [key, callback] of [...timers]) { timers.delete(key); callback(); } } };
}
test('Browser success stays visible before advancing exactly once despite state updates', () => {
  const f = fixture();
  f.update({ step: 0, ready: false });
  f.update({ step: 0, ready: true });
  f.update({ step: 0, ready: true });
  assert.deepEqual(f.jumps, []); assert.equal(f.timers.size, 1);
  f.tick(); assert.deepEqual(f.jumps, [1]);
  f.update({ step: 0, ready: true }); f.tick(); assert.deepEqual(f.jumps, [1]);
});
test('An already paired browser advances on startup', () => {
  const f = fixture(); f.update({ step: 0, ready: true });
  f.tick(); assert.deepEqual(f.jumps, [1]);
});
test('Disconnect or navigation cancels pending advancement and Previous does not bounce forward', () => {
  const f = fixture(); f.update({ step: 0, ready: true });
  f.update({ step: 0, ready: false }); f.tick(); assert.deepEqual(f.jumps, []);
  f.update({ step: 0, ready: true }); f.update({ step: 1, ready: false });
  f.tick(); assert.deepEqual(f.jumps, []);
  f.update({ step: 0, ready: true }); f.tick(); assert.deepEqual(f.jumps, []);
});
test('App and download completion advance but entering an already ready page does not', () => {
  const f = fixture();
  for (const step of [1, 2]) {
    f.update({ step, ready: true }); f.tick();
    assert.equal(f.jumps.length, step - 1);
    f.update({ step, ready: false }); f.update({ step, ready: true });
    f.tick(); assert.equal(f.jumps.at(-1), step + 1);
  }
  f.update({ step: 3, ready: false }); f.tick(); assert.deepEqual(f.jumps, [2, 3]);
});
