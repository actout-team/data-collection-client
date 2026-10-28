import test from 'node:test';
import assert from 'node:assert/strict';
import { admitModelSpan, credentialAssignments } from '../src/protection/entity-quality.mjs';
import { createDetector } from '../src/protection/detect.mjs';
import { createReplacements } from '../src/protection/replacements.mjs';
import { createLocalProposer } from '../src/protection/local-proposer.mjs';
import { replacementGrammar } from '../src/protection/replacement-grammar.mjs';
import { decode } from '../src/protection/model-runtime.mjs';
const span = (text, category, score = 0.99) => ({ start: 0, end: text.length, category, score });
test('Model admission checks confidence and valid spans, not semantic regex matches', () => {
  for (const category of ['names', 'companies', 'emails', 'phones', 'addresses', 'secrets', 'identifiers']) {
    assert.equal(admitModelSpan(span('an unseen value', category, 0.8), 'an unseen value'), true);
    assert.equal(admitModelSpan(span('an unseen value', category, 0.39), 'an unseen value'), false);
  }
  for (const invalid of [
    { start: -1 }, { end: 100 }, { start: 0.5 }, { end: 0 },
    { score: NaN }, { score: Infinity }, { score: undefined }, { category: 'unknown' }
  ]) assert.equal(admitModelSpan({ ...span('value', 'secrets'), ...invalid }, 'value'), false);
  assert.equal(admitModelSpan(span('   ', 'secrets'), '   '), false);
});
test('Explicit weak passwords and recognizable credentials remain protected; descriptive prose stays unchanged', () => {
  const d = createDetector(['secrets']);
  d.discover('Reset your password. Your password is expired. password: required. API key: missing');
  assert.equal(d.entries.size, 0);
  for (const text of ['password: sunshine', 'password is OrangeMoon99!', 'api_key="abc123xy"', 'Bearer abcdef123456', 'sk-abcdefghijklmnop123456']) d.discover(text);
  for (const value of ['sunshine', 'OrangeMoon99!', 'abc123xy', 'abcdef123456', 'sk-abcdefghijklmnop123456']) assert.ok(d.entries.has(value), value);
  d.discover('anotherweakword', 'password'); assert.ok(d.entries.has('anotherweakword'));
  d.discover('wordpiece', 'token'); assert.ok(!d.entries.has('wordpiece'));
  assert.equal(credentialAssignments('password is reset').length, 0);
});
test('Contextual model secrets, identifiers and international addresses require no label or shape rules', () => {
  for (const [text, value, category] of [
    ['Enter sunshine when the login screen asks for the secret.', 'sunshine', 'secrets'],
    ['Book using A12345678, the number on my passport.', 'A12345678', 'identifiers'],
    ['Deliver to 10 Herzl, Tel Aviv, Israel.', '10 Herzl, Tel Aviv, Israel', 'addresses'],
    ['Send it to 12 rue des Lilas, 75019 Paris, France.', '12 rue des Lilas, 75019 Paris, France', 'addresses']
  ]) {
    const start = text.indexOf(value);
    assert.equal(admitModelSpan({ start, end: start + value.length, category, score: 0.65 }, text), true);
  }
});
test('Boundary confidence is retained instead of reporting only high inside scores', () => {
  const logits = { dims: [1, 1, 1, 3], data: Float32Array.from([0, 5, 5]) };
  const tokens = [{ start: 0, end: 5 }];
  assert.equal(decode(logits, tokens, ['person name'], 0, 'Alice')[0].score, 0.5);
});
test('Custom domains are varied and realistic without placeholder suffixes or random hex tags', async () => {
  const d = createDetector(['emails']);
  for (const address of ['sales@brightwave.co.uk', 'help@brightwave.co.uk', 'info@otherbrand.org', 'alice@gmail.com', 'info@thirdbrand.io']) d.add(address, 'emails');
  await d.prepare(); d.compile();
  const mapped = v => d.entries.get(v).replacement;
  assert.equal(mapped('sales@brightwave.co.uk').split('@')[1], mapped('help@brightwave.co.uk').split('@')[1]);
  assert.match(mapped('sales@brightwave.co.uk'), /^sales@[a-z]+\.co\.uk$/);
  assert.match(mapped('info@otherbrand.org'), /^info@[a-z]+\.org$/);
  assert.match(mapped('alice@gmail.com'), /^[a-z]+@gmail\.com$/);
  assert.equal(new Set([...d.entries.values()].map(x => x.replacement)).size, 5);
  for (const row of d.entries.values()) { assert.ok(!row.replacement.includes('.invalid')); assert.notEqual(row.original, row.replacement); }
});
test('Address replacements preserve state codes, directionals, suite markers, proper ordinals and natural casing', () => {
  const g = createReplacements();
  const value = g.generate('addresses', '42 N McLean Drive, Ste 20, 3rd Floor, CA 90210 USA');
  assert.match(value, /^\d+ N [A-Z][a-z]+ Drive, Ste \d+, \d+(?:st|nd|rd|th) Floor, CA \d{5} USA$/);
  const [, digits, suffix] = / (\d+)(st|nd|rd|th) Floor/.exec(value), n = Number(digits);
  assert.equal(suffix, n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
  const hex = g.generate('secrets', 'a1b2c3d4-1234-5678-abcd-0123456789ef');
  assert.match(hex, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
});
test('Generation is given bounded avoidance examples and validators reject collisions', async () => {
  const d = createDetector(['names']); d.add('Alice Reed', 'names'); d.add('David Kent', 'names');
  const seen = []; let n = 0;
  await d.prepare({ proposer: async input => { seen.push(input); return n++ ? ['Maya', 'Brooks'] : ['Nora', 'Walsh']; } }); d.compile();
  assert.ok(seen[0].avoid.includes('alice')); assert.ok(seen[1].avoid.includes('nora')); assert.ok(seen.every(x => x.avoid.length <= 64));
  const calls = [];
  const p = await createLocalProposer({ ensure: async () => ({}), start: async () => ({ close: async () => {}, generate: async body => { calls.push(body); return { choices: [{ finish_reason: 'stop', message: { content: '{"replacements":["Nora"]}' } }] }; } }) });
  await p({ category: 'names', original: 'Alice', tokens: ['Alice'], known: [null], namePreference: 'en', avoid: ['Emma', 'David'] });
  const input = JSON.parse(calls[0].messages[1].content.split('Input data: ')[1]);
  assert.deepEqual(input.avoid, ['Emma', 'David']); assert.match(calls[0].messages[0].content, /natural real-world/);
});

test('Available name shortlists constrain decoding to natural names with the requested role', () => {
  const grammar = replacementGrammar(['יעל', 'כהן'], [null, null], 'names', [['מיכל', 'נועה'], ['רוזן', 'שפירא']]);
  assert.ok(grammar.includes('רוזן')); assert.ok(grammar.includes('מיכל')); assert.ok(!grammar.includes('prefix'));
  const fallback = replacementGrammar(['Alice'], [null], 'names', [[]]); assert.ok(fallback.includes('prefix'));
});
