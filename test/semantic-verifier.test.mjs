import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticVerifier } from '../src/protection/semantic-verifier.mjs';
import { verificationRequest, isOrdinary, recoverInnerIdentity, needsBoundaryReview } from '../src/protection/semantic-prompt.mjs';
import { VERIFIER_MODEL } from '../src/protection/generator-assets.mjs';
import { createDetector } from '../src/protection/detect.mjs';

const span = (value, text = value) => ({ start: text.indexOf(value), end: text.indexOf(value) + value.length, category: 'names' });
test('Only a complete ordinary-text decision can suppress protection', () => {
  assert.ok(isOrdinary(' ordinary\n'));
  for (const answer of ['person', 'organization', 'uncertain', '', null, 'not ordinary', 'ordinary or a person', '{"decision":"ordinary"}']) assert.equal(isOrdinary(answer), false);
});
test('Boundary recovery requires an exact inner name with complete word boundaries', () => {
  const response = value => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
  assert.ok(needsBoundaryReview('companies', 'The Linden Group supplies'));
  assert.equal(needsBoundaryReview('secrets', 'The Linden Group'), false);
  assert.equal(needsBoundaryReview('names', 'Linden'), false);
  assert.ok(recoverInnerIdentity(response(['Linden Group']), 'Linden Group supplies'));
  assert.equal(recoverInnerIdentity(response(['Linden']), 'Lindens supplies'), false);
  assert.equal(recoverInnerIdentity(response(['Linden Group']), 'Linden Group'), false);
  assert.equal(recoverInnerIdentity(response([]), 'server connection'), false);
  for (const value of [null, {}, ['invented'], [42], ['']]) assert.ok(recoverInnerIdentity(response(value), 'server connection'));
  assert.ok(recoverInnerIdentity({ choices: [{ finish_reason: 'length', message: { content: '[]' } }] }, 'server connection'));
});
test('Boundary review preserves original spans and its cache distinguishes categories', async () => {
  let calls = 0;
  const verifier = createSemanticVerifier({ ensure: async () => ({}), start: async () => ({ close: async () => {}, generate: async body => {
    calls++; return { choices: [{ finish_reason: 'stop', message: { content: body.grammar ? '["Linden Group"]' : 'ordinary' } }] };
  } }) });
  const text = 'Linden Group supplies', candidate = { ...span(text), category: 'companies' }, before = { ...candidate };
  assert.equal(await verifier.keep(candidate, text), true);
  assert.deepEqual(candidate, before);
  assert.equal(await verifier.keep({ ...candidate, category: 'secrets' }, text), false);
  assert.equal(await verifier.keep(candidate, text), true);
  assert.equal(calls, 5); assert.equal(verifier.info.boundaryRetained, 1);
  await verifier.close();
});
test('Truncated ordinary output cannot suppress a candidate', async () => {
  const verifier = createSemanticVerifier({ ensure: async () => ({}), start: async () => ({ close: async () => {}, generate: async () => ({ choices: [{ finish_reason: 'length', message: { content: 'ordinary' } }] }) }) });
  assert.equal(await verifier.keep(span('Mira'), 'Mira'), true);
  await verifier.close();
});
test('Verifier requests preserve connected context and leave numeric and long values untouched', () => {
  const text = 'Ask the supplier Lumen Grove for an invoice.';
  assert.deepEqual(verificationRequest(span('Lumen Grove', text), text), { passage: text, candidate: 'Lumen Grove' });
  for (const value of ['1234', '12.50', 'x'.repeat(257)]) assert.equal(verificationRequest(span(value), value), null);
  const long = ' '.repeat(1000) + text + ' '.repeat(1000);
  const request = verificationRequest(span('Lumen Grove', long), long);
  assert.ok(request.passage.length <= 256 + request.candidate.length);
  const multibyte = '界'.repeat(512);
  assert.equal(verificationRequest({ start: 128, end: 384 }, multibyte), null);
});
test('The verifier is local, starts lazily, caches by context, and closes once', async () => {
  let setups = 0, closes = 0; const calls = [];
  const verifier = createSemanticVerifier({ directory: '/tmp/verifier-fixture', preference: 'cpu',
    ensure: async (_directory, options) => { setups++; assert.equal(options.modelAsset, VERIFIER_MODEL); return {}; },
    start: async () => ({ info: { backend: 'cpu' }, close: async () => { closes++; }, generate: async body => {
      calls.push(body); const request = JSON.parse(body.messages[1].content);
      return { choices: [{ finish_reason: 'stop', message: { content: request.passage.startsWith('The contact') ? 'person' : 'ordinary' } }] };
    } })
  });
  assert.equal(await verifier.keep(span('42'), '42'), true); assert.equal(setups, 0);
  const person = 'The contact is Joy.', ordinary = 'We felt Joy.';
  assert.equal(await verifier.keep(span('Joy', person), person), true);
  assert.equal(await verifier.keep(span('Joy', ordinary), ordinary), false);
  assert.equal(await verifier.keep(span('Joy', person), person), true);
  assert.equal(setups, 1); assert.equal(calls.length, 3); assert.equal(verifier.info.cacheHits, 1);
  assert.equal(calls[0].temperature, 0); assert.equal(calls[0].max_tokens, 12);
  await verifier.close(); await verifier.close(); assert.equal(closes, 1);
  await assert.rejects(verifier.keep(span('Joy'), 'Joy'), /closed/);
});
test('Disagreement between semantic checks retains a candidate', async () => {
  let calls = 0;
  const verifier = createSemanticVerifier({ ensure: async () => ({}), start: async () => ({
    close: async () => {}, generate: async () => ({ choices: [{ finish_reason: 'stop', message: { content: ++calls === 1 ? 'ordinary' : 'protect' } }] })
  }) });
  assert.equal(await verifier.keep(span('New Harbor'), 'New Harbor'), true);
  assert.equal(calls, 2); assert.equal(verifier.info.rejected, 0);
  await verifier.close();
});
test('Inference failure propagates; malformed output retains protection', async () => {
  let fail = false;
  const verifier = createSemanticVerifier({ ensure: async () => ({}), start: async () => ({
    close: async () => {}, generate: async () => { if (fail) throw Error('runtime failed'); return { choices: [] }; }
  }) });
  assert.equal(await verifier.keep(span('Arlen'), 'Arlen'), true);
  fail = true; await assert.rejects(verifier.keep(span('Mira'), 'Mira'), /runtime failed/);
  await verifier.close();
});
test('Cancellation cannot start downloads or accept a pending rejection', async () => {
  const controller = new AbortController(); let setups = 0;
  const verifier = createSemanticVerifier({ signal: controller.signal, ensure: async () => { setups++; return {}; }, start: async () => ({
    close: async () => {}, generate: async () => { controller.abort(Error('cancelled')); return { choices: [{ finish_reason: 'stop', message: { content: 'ordinary' } }] }; }
  }) });
  await assert.rejects(verifier.keep(span('Arlen'), 'Arlen'), /cancelled/);
  await assert.rejects(verifier.keep(span('Mira'), 'Mira'), /cancelled/); assert.equal(setups, 1);
  await verifier.close();
});
test('An ordinary model decision cannot remove an explicit weak credential', async () => {
  const detector = createDetector(['secrets']); detector.discover('password: petal');
  const verifier = createSemanticVerifier({ ensure: async () => ({}), start: async () => ({ close: async () => {}, generate: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'ordinary' } }] }) }) });
  assert.equal(await verifier.keep({ ...span('petal'), category: 'secrets' }, 'petal'), false);
  detector.compile(); assert.ok(detector.entries.has('petal')); assert.notEqual(detector.replace('password: petal'), 'password: petal');
  await verifier.close();
});
