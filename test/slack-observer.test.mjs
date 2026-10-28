import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { installSlackSession } from '../extension/slack-session.mjs';
import { slackRead } from '../extension/page.mjs';
function fixture() {
  class XHR { open() {} setRequestHeader() {} send() { return 'sent'; } }
  const calls = [];
  const target = { location: { href: 'https://app.slack.com/client/T123/C456', origin: 'https://app.slack.com', pathname: '/client/T123/C456' }, XMLHttpRequest: XHR,
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, text: async () => JSON.stringify({ ok: true, team_id: 'T123', user_id: 'U123' }) }; }
  };
  installSlackSession(target);
  return { target, calls };
}
for (const transport of ['fetch-form', 'xhr-json', 'xhr-multipart', 'fetch-header']) {
  test(`Slack observes ${transport} authentication without exporting credentials`, async () => {
    const { target } = fixture();
    if (transport === 'fetch-form') await target.fetch('/api/client.boot', { body: new URLSearchParams({ token: 'xoxc-fixture', team_id: 'T123' }) });
    if (transport === 'fetch-header') await target.fetch('/api/client.boot', { headers: { Authorization: 'Bearer xoxc-fixture' } });
    if (transport.startsWith('xhr')) {
      const xhr = new target.XMLHttpRequest(); xhr.open('POST', '/api/client.boot');
      const form = new FormData(); form.set('token', 'xoxc-fixture');
      assert.equal(xhr.send(transport === 'xhr-json' ? JSON.stringify({ token: 'xoxc-fixture' }) : form), 'sent');
    }
    assert.equal(target.__agentsimSlackSession.getToken('T123'), 'xoxc-fixture');
    assert.equal(JSON.stringify(target.__agentsimSlackSession.status()).includes('xoxc'), false);
    const context = { window: target, location: target.location, localStorage: { getItem: () => '{}' }, fetch: target.fetch, URL, FormData, URLSearchParams, AbortSignal };
    const reply = await vm.runInNewContext(`(${slackRead.toString()})('/api/auth.test', {}, null)`, context);
    assert.equal(reply.ok, true); assert.equal(reply.value.data.team_id, 'T123');
    assert.equal(JSON.stringify(reply).includes('xoxc-fixture'), false);
  });
}
test('Slack observer ignores other origins, workspaces, and non-API traffic', async () => {
  const { target } = fixture();
  for (const [url, team] of [['https://example.test/api/client.boot', 'T123'], ['/api/client.boot', 'TOTHER'], ['/messages', 'T123']]) {
    await target.fetch(url, { body: JSON.stringify({ token: 'xoxc-private', team_id: team }) });
    assert.equal(target.__agentsimSlackSession.getToken('T123'), undefined);
  }
  await target.fetch('/api/client.boot', { body: 'token=xoxc-fixture' });
  target.location.pathname = '/client/TOTHER';
  assert.equal(target.__agentsimSlackSession.getToken('TOTHER'), undefined);
  assert.equal(target.__agentsimSlackSession.getToken('T123'), undefined);
});
test('Built Slack observer installs at document start without DOM or duplicate hooks', async () => {
  const { target } = fixture(); delete target.__agentsimSlackSession;
  const source = await readFile(new URL('../extension/slack-bundle.js', import.meta.url), 'utf8');
  const context = vm.createContext({ window: target, URL, Headers, URLSearchParams, FormData });
  vm.runInContext(source, context); const fetch = target.fetch;
  vm.runInContext(source, context); assert.equal(target.fetch, fetch);
});

test('Observed workspace-domain multipart routing is preserved for real-style API reads', async () => {
  const { target, calls } = fixture();
  const form = new FormData(); form.set('token', 'xoxc-fixture'); form.set('_x_sonic', 'true'); form.set('text', 'private content');
  const xhr = new target.XMLHttpRequest();
  xhr.open('POST', 'https://workspace.slack.com/api/conversations.history?slack_route=T123&_x_gantry=true&message=private');
  xhr.send(form);
  const context = { window: target, location: target.location, localStorage: { getItem: () => '{}' }, fetch: target.fetch, URL, FormData, URLSearchParams, AbortSignal };
  const reply = await vm.runInNewContext(`(${slackRead.toString()})('/api/auth.test', {}, null)`, context);
  assert.equal(reply.ok, true);
  assert.equal(calls[0].url, 'https://workspace.slack.com/api/auth.test?slack_route=T123&_x_gantry=true');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.body.get('_x_sonic'), 'true');
  assert.equal(calls[0].options.body.get('text'), null);
  assert.equal(JSON.stringify(target.__agentsimSlackSession.getTransport('T123')).includes('private'), false);
});
