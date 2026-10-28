import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetector } from '../src/protection/detect.mjs';
import { createOwnerPolicy } from '../src/protection/account-owners.mjs';
import { jsonText } from '../src/protection/formats.mjs';
import { htmlText } from '../src/protection/structured.mjs';

test('Contextual detections do not become global substitutions in unrelated prose', () => {
  const d = createDetector(['names', 'secrets']);
  const privateText = 'Ask Rose to call tomorrow.', publicText = 'Rose is a flower.';
  d.add('Rose', 'names', { source: 'model' }, privateText);
  d.compile();
  assert.notEqual(d.replace(privateText), privateText);
  assert.equal(d.replace(publicText), publicText);
  const other = 'Rose called again.';
  d.add('Rose', 'names', { source: 'model' }, other);
  assert.ok(d.replace(other).includes(d.entries.get('Rose').replacement));
});

test('Verified mailbox links preserve late-discovered owner names without exempting secrets or aliases', () => {
  const policy = createOwnerPolicy([{ app: 'gmail', accountKey: 'owner@example.com', verified: true, source: 'authenticated-self-profile', emails: ['owner@example.com'] }]);
  const d = createDetector(['names', 'emails', 'secrets'], { ownerPolicy: policy });
  d.add('Alice Reed', 'names');
  d.registerIdentity({ name: 'Alice Reed', email: 'OWNER@example.com' });
  d.registerIdentity({ name: 'Bob Green', email: 'owner+other@example.com' });
  const input = JSON.stringify({ password: 'Alice Reed' });
  jsonText(input, d, 'discover'); d.compile();
  assert.equal(d.replace('Contact Alice Reed.'), 'Contact Alice Reed.');
  assert.notEqual(d.replace('Bob Green'), 'Bob Green');
  assert.notEqual(JSON.parse(jsonText(input, d, 'replace')).password, 'Alice Reed');
  assert.equal(policy.info.linkedNames, 1);
});

test('Explicit service profiles retain identity fields while secrets and human profiles remain protected', () => {
  const d = createDetector(['names', 'secrets']);
  const bot = { id: 'B1', is_bot: true, name: 'Orbit Helper', profile: { first_name: 'Orbit', last_name: 'Helper', display_name: 'Orbit Helper' }, password: 'CopperRiver47!' };
  const person = { id: 'U1', is_bot: false, profile: { first_name: 'Orbit', last_name: 'Helper' } };
  const inputs = [bot, person].map(JSON.stringify);
  for (const input of inputs) jsonText(input, d, 'discover', 'slack/users.jsonl');
  d.compile();
  const [out, human] = inputs.map(input => JSON.parse(jsonText(input, d, 'replace', 'slack/users.jsonl')));
  assert.deepEqual(out.profile, bot.profile);
  assert.equal(out.name, bot.name);
  assert.notEqual(out.password, bot.password);
  assert.notEqual(human.profile.first_name, person.profile.first_name);
  assert.equal(jsonText('null', d, 'replace', 'slack/users.jsonl'), 'null');
});

test('Gmail relationships survive value collisions without exempting message content or embedded records', () => {
  const d = createDetector(['secrets']);
  d.add('CopperRiver47!', 'secrets'); d.compile();
  const record = { id: 'CopperRiver47!', thread_id: 'CopperRiver47!', labels: ['CopperRiver47!'], file: 'CopperRiver47!', body: 'CopperRiver47!', nested: JSON.stringify({ id: 'CopperRiver47!' }) };
  const out = JSON.parse(jsonText(JSON.stringify(record), d, 'replace', 'gmail/messages.jsonl'));
  for (const key of ['id', 'thread_id', 'labels', 'file']) assert.deepEqual(out[key], record[key]);
  assert.notEqual(out.body, record.body);
  assert.notEqual(JSON.parse(out.nested).id, record.id);
});

test('HTML model decisions can use document context and still edit exact local nodes', () => {
  const seen = [], d = createDetector(['secrets'], { observe: value => seen.push(value) });
  const input = '<p>Use this to sign in.</p><p><b>827</b>439</p><script>hidden</script>';
  htmlText(input, d, 'discover');
  const whole = seen.find(value => value.includes('sign in') && value.includes('827439'));
  assert.ok(whole);
  assert.ok(seen.includes('827439'));
  assert.ok(seen.every(value => !value.includes('hidden')));
  d.add('827439', 'secrets', { source: 'model' }, whole); d.compile();
  const output = htmlText(input, d, 'replace');
  assert.notEqual(output, input);
  assert.equal(output.replace(/<[^>]+>/g, ''), 'Use this to sign in.' + d.entries.get('827439').replacement + 'hidden');
});
