import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWords, words } from '../src/protection/model-tokens.mjs';
import { textWindows } from '../src/protection/neural.mjs';

const encode = text => [...Buffer.from(text)];
test('Oversized words are fully covered with bounded tokens and original offsets', () => {
  for (const value of ['qZ9_'.repeat(600), '界'.repeat(900), '𐐀'.repeat(700)]) {
    const text = `Alice Reed ${value} Michael Turner.`;
    const tokens = encodeWords(text, encode, 128);
    assert.ok(tokens.every(t => t.ids.length <= 128));
    assert.ok(tokens.every(t => t.value === text.slice(t.start, t.end) && t.value.isWellFormed()));
    assert.equal(tokens.map(t => t.value).join(''), words(text).map(t => t.value).join(''));
    const parts = tokens.filter(t => t.start >= 11 && t.end <= 11 + value.length);
    assert.equal(parts.map(t => t.value).join(''), value);
    for (let i = 1; i < parts.length; i++) assert.equal(parts[i].start, parts[i - 1].end);
    assert.equal(tokens.at(-2).value, 'Turner');
    assert.equal(tokens.at(-1).end, text.length);
  }
});
test('Normal words and punctuation keep their original tokenization', () => {
  const text = 'Alice Reed: alice.reed@example.com, +1 202 555 0198.';
  assert.deepEqual(encodeWords(text, encode, 128), words(text).map(t => ({ ...t, ids: encode(t.value) })));
});
test('Splitting re-tokenizes fragments because token counts are not additive', () => {
  const variableEncode = value => Array(value.length > 3 ? value.length * 3 : value.length).fill(1);
  const tokens = encodeWords('abcdefghij', variableEncode, 5);
  assert.ok(tokens.every(t => t.ids.length <= 5));
  assert.equal(tokens.map(t => t.value).join(''), 'abcdefghij');
});
test('Outer text chunks preserve Unicode at both edges and include the tail', () => {
  const text = '𐐀a'.repeat(3000) + 'FINAL';
  const chunks = [...textWindows(text)];
  assert.ok(chunks.every(t => t.isWellFormed() && t.length <= 2400));
  assert.ok(chunks.at(-1).endsWith('FINAL'));
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i - 1].includes(chunks[i].slice(0, 100)));
});
