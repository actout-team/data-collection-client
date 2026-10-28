import test from 'node:test';
import assert from 'node:assert/strict';
import { createLog, safeLogText } from '../src/log.mjs';

test('diagnostics redact credentials and URL query strings', () => {
  for (const input of [
    'Bearer sample-credential', 'Cookie: SID=sample-credential; d=another-secret',
    'token=sample-credential', 'password: sample-credential', 'xoxc-sample-credential',
    'https://user:sample-credential@example.test/api?token=another-secret#private'
  ]) {
    const result = safeLogText(input);
    assert.doesNotMatch(result, /sample-credential|another-secret|#private/);
  }
});
test('diagnostics are bounded, merge repeats, and copy readable source labels', () => {
  const log = createLog(2);
  log.add('info', 'app', 'Starting');
  log.add('error', 'extension', 'Probe failed'); log.add('error', 'extension', 'Probe failed');
  assert.equal(log.entries.length, 2); assert.equal(log.entries[1].count, 2);
  log.add('info', 'gmail', 'Connected');
  assert.equal(log.entries.length, 2); assert.equal(log.entries[0].source, 'extension');
  assert.match(log.text(), /\[ERROR\] extension: Probe failed \(×2\)/);
});
