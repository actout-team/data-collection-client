import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDetector } from '../src/protection/detect.mjs';
import { protectExport } from '../src/protection/index.mjs';

test('Model email fragments remain detected and get distinct replacements without requiring mailbox syntax', async () => {
  const d = createDetector(['emails']);
  const originals = ['mailbox-fragment', '@example.net', 'alice@', 'alice@@example.net', 'alice [at] sample [dot] net', '---', ...'abcdefghijklmnopqrstuvwxyz', ...'0123456789'];
  for (const original of originals) d.add(original, 'emails', { source: 'model', score: 0.8 });
  await d.prepare(); d.compile();
  assert.equal(d.entries.size, originals.length);
  assert.equal(new Set([...d.entries.values()].map(row => row.replacement.toLowerCase())).size, originals.length);
  for (const row of d.entries.values()) {
    assert.equal(row.category, 'emails');
    assert.equal(row.detection.source, 'model');
    assert.equal(row.generation, 'synthetic-fallback');
    assert.notEqual(row.replacement, row.original);
    assert.ok(!d.entries.has(row.replacement));
    assert.equal(d.replace(row.original, true), row.replacement);
  }
  // prepare and compile both reserve values, but fallbacks are counted once.
  assert.equal(d.generation.emailFallbackEntities, originals.length);
  assert.equal(d.generation.notes.filter(note => /email detections/.test(note)).length, 1);
});

test('Complete email replacements still preserve public providers and name correlation', async () => {
  const d = createDetector(['names', 'emails']);
  d.registerIdentity({ name: 'Alice Reed', email: 'alice.reed@gmail.com' });
  d.add('Alice Reed', 'names');
  d.add('alice.reed@gmail.com', 'emails', { source: 'model', score: 0.8 });
  await d.prepare(); d.compile();
  const row = d.entries.get('alice.reed@gmail.com');
  assert.equal(row.replacement, d.entries.get('Alice Reed').replacement.toLowerCase().replace(' ', '.') + '@gmail.com');
  assert.equal(row.generation, undefined);
  assert.equal(d.generation.emailFallbackEntities, 0);
});

test('An incomplete model email span no longer aborts export publication and is reported for review', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'email-fragment-regression-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await mkdir(source);
  const input = JSON.stringify({ 'mailbox-fragment': 'schema stays intact', body: '<p>Contact mailbox-fragment tomorrow.</p>' }) + '\n';
  await writeFile(path.join(source, 'messages.jsonl'), input);
  await writeFile(path.join(source, 'notes.txt'), 'Contact mailbox-fragment tomorrow.');
  let closed = false;
  const neural = {
    info: { runtime: 'synthetic-model-fixture' },
    discover(text, d) { if (text.includes('mailbox-fragment')) d.add('mailbox-fragment', 'emails', { source: 'model', label: 'email', score: 0.8 }); },
    close() { closed = true; }
  };
  const result = await protectExport({ source, categories: ['emails'], neural });
  const mapping = JSON.parse(await readFile(result.mapping, 'utf8'));
  const row = mapping.entries.find(row => row.original === 'mailbox-fragment');
  assert.equal(row.detection.source, 'model');
  assert.equal(row.generation, 'synthetic-fallback');
  assert.equal(row.occurrences, 2);
  const output = JSON.parse(await readFile(path.join(result.output, 'messages.jsonl'), 'utf8'));
  assert.equal(output['mailbox-fragment'], 'schema stays intact');
  assert.equal(output.body, `<p>Contact ${row.replacement} tomorrow.</p>`);
  assert.equal(await readFile(path.join(result.output, 'notes.txt'), 'utf8'), `Contact ${row.replacement} tomorrow.`);
  assert.equal(await readFile(path.join(source, 'messages.jsonl'), 'utf8'), input);
  assert.equal(result.status, 'partial');
  assert.equal(result.generation.emailFallbackEntities, 1);
  const report = JSON.parse(await readFile(result.report, 'utf8'));
  assert.ok(report.warnings.some(warning => /email detections/.test(warning.reason)));
  assert.ok(!report.warnings.some(warning => warning.reason.includes('mailbox-fragment')));
  assert.equal(closed, true);
});
