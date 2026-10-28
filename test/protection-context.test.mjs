import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment } from 'parse5';
import { createDetector } from '../src/protection/detect.mjs';
import { valueText } from '../src/protection/content.mjs';
import { xmlText } from '../src/protection/structured.mjs';
import { jsonText } from '../src/protection/formats.mjs';

test('Model observes complete prose before colons and around supplementary credential rules', () => {
  for (const text of [
    'Contact details for Alice Reed: she moved to 12 rue des Lilas, Paris.',
    'Alice Reed wrote her password: sunshine before leaving for Paris.'
  ]) {
    const observed = [], d = createDetector(['names', 'addresses', 'secrets'], { observe: text => observed.push(text) });
    valueText(text, d, 'discover');
    assert.deepEqual(observed, [text]);
  }
});

test('Model sees joined inline DOM content while scripts, attribute names and JSON keys remain excluded', () => {
  const observed = [], d = createDetector(['names'], { observe: text => observed.push(text) });
  const html = '<p id="schema-only">Contact <b>Alice</b> Reed: send a message.</p><script>excluded-code</script><p>Other block.</p>';
  jsonText(JSON.stringify({ 'schema-only': html }), d, 'discover');
  assert.equal(observed.length, 3);
  assert.equal(observed[0].trim(), 'Contact Alice Reed: send a message.\n\nOther block.');
  assert.deepEqual(observed.slice(1), ['Contact Alice Reed: send a message.', 'Other block.']);
});

test('Model entities spanning inline DOM nodes replace correctly through nested JSON escapes', () => {
  const d = createDetector(['names', 'addresses']);
  d.add('Alice Reed', 'names', { source: 'model', score: 0.9 });
  d.add('12 rue des Lilas, Paris', 'addresses', { source: 'model', score: 0.9 });
  d.compile();
  const html = '<p id="Alice Reed">Contact <b>Al&#105;ce</b> Reed: deliver to <i>12 rue des</i> Lilas, Paris.</p>';
  const output = JSON.parse(jsonText(JSON.stringify({ html }), d, 'replace')).html;
  const tree = parseFragment(output);
  const text = node => node.nodeName === '#text' ? node.value : (node.childNodes || []).map(text).join('');
  assert.equal(text(tree), `Contact ${d.entries.get('Alice Reed').replacement}: deliver to ${d.entries.get('12 rue des Lilas, Paris').replacement}.`);
  assert.ok(output.includes('id="Alice Reed"'));
  assert.ok(output.includes('<b>') && output.includes('</b>') && output.includes('<i>') && output.includes('</i>'));
  for (const row of d.entries.values()) assert.equal(row.occurrences, 1);
});

test('XML prose and compact assignments keep their respective content and schema boundaries', () => {
  const observed = [], d = createDetector(['names'], { observe: text => observed.push(text) });
  xmlText('<message>Contact details for Alice Reed: please reply.</message>', d, 'discover');
  valueText('schema-only@example.com: Alice Reed', d, 'discover');
  assert.deepEqual(observed, ['Contact details for Alice Reed: please reply.', 'Alice Reed']);
  d.add('Alice Reed', 'names', { source: 'model', score: 0.9 }); d.compile();
  assert.equal(valueText('schema-only@example.com: Alice Reed', d, 'replace'), `schema-only@example.com: ${d.entries.get('Alice Reed').replacement}`);
});
