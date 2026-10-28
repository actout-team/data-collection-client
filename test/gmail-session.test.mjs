import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { gmailRead } from '../extension/gmail.mjs';
import { slackRead } from '../extension/page.mjs';

async function check({ email = null, title = 'Inbox - person@example.test - Gmail', main = true, helper = true, expected = null, fetchError = null, redirect = false, accountLabel = '' } = {}) {
  let probes = 0;
  const context = {
    window: { GLOBALS: [,,,,,,,,,, email], __agentsimGmailApi: helper ? { ready: async () => {} } : null, __agentsimGmailError: helper ? null : 'Gmail helper could not initialize: fixture error' },
    document: { title, querySelector: selector => selector === '[role="main"]' && main ? {} : accountLabel && selector.includes('SignOutOptions') ? { getAttribute: () => accountLabel } : null },
    location: { origin: 'https://mail.google.com', pathname: '/mail/u/1/' }, URL, AbortSignal, expected,
    fetch: async () => { probes++; if (fetchError) throw Error(fetchError); return { ok: true, url: redirect ? 'https://accounts.google.com/login' : 'https://mail.google.com/mail/u/1/', body: { cancel: async () => {} } }; }
  };
  // Chrome serializes the function into another world. This also catches accidental closures/imports.
  const reply = await vm.runInNewContext(`(${gmailRead.toString()})('identity', {}, expected)`, context);
  return { reply: JSON.parse(JSON.stringify(reply)), probes };
}
test('Gmail connects using the selected mailbox title when account globals are unavailable', async () => {
  const { reply, probes } = await check();
  assert.deepEqual(reply, { ok: true, value: { account: 'person@example.test', helperVersion: 'unknown' } }); assert.equal(probes, 1);
});
test('Gmail returns a serializable helper failure instead of an empty injection result', async () => {
  const { reply, probes } = await check({ helper: false });
  assert.equal(reply.ok, false); assert.equal(reply.code, 'HELPER_FAILED'); assert.match(reply.error, /fixture error/); assert.equal(probes, 0);
});
test('Gmail waits only when the mailbox UI is not loaded', async () => {
  const { reply, probes } = await check({ main: false });
  assert.equal(reply.code, 'LOGIN_REQUIRED'); assert.equal(probes, 0);
});
test('Gmail refuses account changes before making a read request', async () => {
  const { reply, probes } = await check({ expected: { account: 'someone-else@example.test' } });
  assert.equal(reply.code, 'ACCOUNT_CHANGED'); assert.equal(probes, 0);
});
test('Gmail surfaces a rejected session probe as an actionable error', async () => {
  const { reply } = await check({ fetchError: 'Failed to fetch' });
  assert.equal(reply.code, 'PROBE_FAILED'); assert.match(reply.error, /Failed to fetch/);
});
test('Gmail rejects login redirects and unknown identity rather than claiming connected', async () => {
  assert.equal((await check({ redirect: true })).reply.code, 'SESSION_EXPIRED');
  const { reply, probes } = await check({ title: 'Message from unrelated@example.test' });
  assert.equal(reply.code, 'ACCOUNT_UNAVAILABLE'); assert.equal(probes, 0);
});
test('Slack page failures also survive serialization across the browser boundary', async () => {
  const result = await vm.runInNewContext(`(${slackRead.toString()})('/api/auth.test', {}, null)`, {
    window: {}, localStorage: { getItem: () => '{}' }, location: { pathname: '/client/T123' }
  });
  assert.equal(result.ok, false); assert.equal(result.code, 'SESSION_UNAVAILABLE'); assert.match(result.error, /teams=0/);
});

test('Gmail format details survive serialized tab errors without leaking response values', async () => {
  const { parseSearch } = await import('../extension/gmail-api.mjs');
  const raw = JSON.stringify([0, null, { 'private@example.test': 'private-message-body' }]);
  const context = { window: { GLOBALS: [,,,,,,,,,, 'person@example.test'], __agentsimGmailApi: {
    search: () => parseSearch(raw, 50)
  } }, document: { querySelector: () => ({}) } };
  const reply = await vm.runInNewContext(`(${gmailRead.toString()})('gmail-page', {}, null)`, context);
  assert.equal(reply.code, 'GMAIL_FORMAT');
  assert.match(reply.error, /bv offset=50/);
  assert.match(reply.error, /field 3: expected array, got object/);
  assert.match(reply.error, /root=array\(3\)/);
  assert.ok(reply.error.length <= 300);
  assert.doesNotMatch(reply.error, /private@example|private-message-body/);
});

test('Gmail owner name comes only from the verified selected account control', async () => {
 const {reply}=await check({accountLabel:'Google Account: Alice Reed (person@example.test)'});
 assert.deepEqual(reply.value.ownerProfile,{full_name:'Alice Reed'});
 const other=await check({accountLabel:'Google Account: Other Person (other@example.test)'});
 assert.equal(other.reply.value.ownerProfile,undefined);
});

test('Retired Gmail MIME and attachment operations fail without making requests', async () => {
  for (const op of ['gmail-source', 'gmail-chunk', 'gmail-clear']) {
    const context = {
      window: { GLOBALS: [,,,,,,,,,, 'person@example.test'], __agentsimGmailApi: {} },
      document: { querySelector: () => ({}) },
      fetch: () => assert.fail('Retired operations must not fetch attachment content.')
    };
    const reply = await vm.runInNewContext(`(${gmailRead.toString()})(${JSON.stringify(op)}, {}, null)`, context);
    assert.equal(reply.ok, false);
    assert.match(reply.error, /Unknown Gmail read operation/);
  }
});
