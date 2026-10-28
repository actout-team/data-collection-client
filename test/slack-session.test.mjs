import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { slackRead } from '../extension/page.mjs';

async function run({ boot, legacy, config = {}, authTeam = 'T123', expected = null } = {}) {
  const calls = [];
  const context = { window: { TS: { boot_data: boot }, boot_data: legacy },
    localStorage: { getItem: () => JSON.stringify(config) }, location: { pathname: '/client/T123/C456', origin: 'https://app.slack.com' },
    URL, FormData, URLSearchParams, AbortSignal, expected,
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, text: async () => JSON.stringify({ ok: true, team_id: authTeam, user_id: 'U123', messages: [] }) }; }
  };
  const result = await vm.runInNewContext(`(${slackRead.toString()})('/api/conversations.history', {}, expected)`, context);
  return { result, calls };
}
for (const source of ['boot', 'legacy', 'config']) {
  test(`Slack connects with ${source} session data and keeps credentials in the tab`, async () => {
    const options = source === 'config' ? { config: { teams: { T123: { token: 'fixture-secret' } } } } : { [source]: { api_token: 'fixture-secret', team_id: 'T123' } };
    const { result, calls } = await run(options);
    assert.equal(result.ok, true); assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://app.slack.com/api/auth.test');
    assert.equal(calls[1].options.body.get('token'), 'fixture-secret');
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  });
}
test('Slack verifies workspace before reading history, even without a prior identity', async () => {
  const { result, calls } = await run({ boot: { api_token: 'fixture-secret' }, authTeam: 'TOTHER' });
  assert.equal(result.code, 'ACCOUNT_CHANGED'); assert.equal(calls.length, 1);
});
test('Slack does not use another workspace session or retry missing sessions indefinitely', async () => {
  const { result, calls } = await run({ boot: { api_token: 'fixture-secret', team_id: 'TOTHER' } });
  assert.equal(result.code, 'SESSION_UNAVAILABLE'); assert.equal(calls.length, 0);
  assert.doesNotMatch(result.error, /fixture-secret/);
});
