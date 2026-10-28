import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, secretMatches } from '../src/bridge.mjs';

const origin = 'chrome-extension://' + 'a'.repeat(32);
async function start(t, options) {
  try { return await createBridge(options); }
  catch (error) { if (error.code === 'EPERM') { t.skip('This environment forbids listening on loopback. Run on a local Mac.'); return null; } throw error; }
}
const headers = { 'X-Extension-Origin': origin, 'Content-Type': 'application/json' };
test('pairing secret comparison requires exact values', () => {
  assert.equal(secretMatches('a', 'a'), true); assert.equal(secretMatches('a', 'b'), false); assert.equal(secretMatches(undefined, 'a'), false);
});
test('bridge blocks web origins and unpaired reads, and requires explicit pairing approval', async t => {
  const bridge = await start(t, { port: 0, approve: async () => false }); if (!bridge) return; t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.port}`;
  assert.equal((await fetch(url + '/next')).status, 403);
  assert.equal((await fetch(url + '/pair', { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await fetch(url + '/next', { headers })).status, 401);
  assert.equal((await fetch(url + '/status', { headers })).status, 401);
  assert.equal((await fetch(url + '/pair', { method: 'POST', headers })).status, 403);
});
test('paired bridge delivers only to authenticated extension and resolves one result', async t => {
  let saved;
  const bridge = await start(t, { port: 0, approve: async () => true, savePairing: async p => { saved = p; } }); if (!bridge) return; t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.port}`;
  const pair = await (await fetch(url + '/pair', { method: 'POST', headers })).json();
  assert.equal(pair.token.length, 64); assert.equal(saved.token, pair.token);
  const auth = { ...headers, Authorization: `Bearer ${pair.token}` };
  assert.deepEqual(await (await fetch(url + '/status', { headers: auth })).json(), { ok: true });
  assert.equal(bridge.connected(), true);
  assert.equal((await fetch(url + '/next', { headers: { ...auth, 'X-Extension-Origin': 'chrome-extension://' + 'b'.repeat(32) } })).status, 401);
  const answer = bridge.ask({ app: 'slack', op: 'request' });
  const task = await (await fetch(url + '/next', { headers: auth })).json();
  assert.equal(task.app, 'slack'); assert.ok(task.id);
  await fetch(url + '/result', { method: 'POST', headers: auth, body: JSON.stringify({ id: task.id, data: { ok: true } }) });
  assert.deepEqual(await answer, { ok: true });
  const abort = new AbortController(), pending = bridge.ask({ app: 'gmail' }, abort.signal);
  abort.abort(Error('cancelled')); await assert.rejects(pending, /cancelled/);
});
