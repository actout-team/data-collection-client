// Synthetic regressions with actual local inference. These exercise routing and
// acceptance, not a representative accuracy benchmark or a guarantee of recall.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFragment } from 'parse5';
import { createNeural } from '../src/protection/neural.mjs';
import { createDetector } from '../src/protection/detect.mjs';
import { protectExport } from '../src/protection/index.mjs';

const categories = ['names', 'companies', 'emails', 'phones', 'addresses', 'secrets', 'identifiers'];
const cases = [
  { text: 'Enter sunshine when the login screen asks for the secret.', value: 'sunshine', category: 'secrets' },
  { text: 'Set the Authorization header to 7c9e2a4f5b6d0e8a for every request to our API.', value: '7c9e2a4f5b6d0e8a', category: 'secrets' },
  { text: 'Please send the package to 12 rue des Lilas, 75019 Paris, France.', value: '12 rue des Lilas, 75019 Paris, France', category: 'addresses' },
  { text: 'Deliver it to 10 Herzl, Tel Aviv, Israel.', value: '10 Herzl, Tel Aviv, Israel', category: 'addresses' },
  { text: 'Book the ticket using A12345678, the number on my passport.', value: 'A12345678', category: 'identifiers' },
  { text: 'Contact details for Alice Reed: please reply.', value: 'Alice Reed', category: 'names' },
  { text: 'Alice Reed works at Cedar Valley Analytics.', value: 'Cedar Valley Analytics', category: 'companies' }
];
const directory = process.env.AGENTSIM_TEST_MODEL_CACHE || path.join(tmpdir(), 'agentsim-neural-cache');
const neural = await createNeural({ directory, categories, preference: process.env.AGENTSIM_TEST_BACKEND || 'cpu' });
const temporary = await mkdtemp(path.join(tmpdir(), 'agentsim-contextual-pii-'));
try {
  // No field lookup, credential regex, or deterministic discovery is invoked.
  for (const fixture of cases) {
    const d = createDetector(categories);
    d.discover = () => { throw Error('Rule-based discovery must not run in the model-only regression.'); };
    await neural.discover(fixture.text, d);
    const row = d.entries.get(fixture.value);
    assert.equal(row?.category, fixture.category, `Missed synthetic ${fixture.category}`);
    assert.equal(row.detection.source, 'model');
  }
  const negative = createDetector(categories);
  await neural.discover('The meeting starts at 10 tomorrow and the agenda has 6 topics.', negative);
  assert.equal(negative.entries.size, 0);
  // Use fresh text to avoid the per-export inference cache from the checks above.
  const source = path.join(temporary, 'source'); await mkdir(source);
  const html = '<p id="Alice Reed">Contact details for <b>Al&#105;ce</b> Reed: please reply today.</p>'
    + '<p>Enter <strong>sunshine</strong> when the login screen asks for the secret, please.</p>'
    + '<p>Please deliver it to <i>10 Herzl</i>, Tel Aviv, Israel.</p>'
    + '<script>const original = "Alice Reed";</script>';
  const input = JSON.stringify({ 'schema-only@example.com': html });
  await writeFile(path.join(source, 'message.jsonl'), input + '\n');
  await writeFile(path.join(source, 'notes.txt'), 'Book my ticket using A12345678, the number on my passport.');
  const result = await protectExport({ source, categories, neural });
  const mapping = JSON.parse(await readFile(result.mapping, 'utf8'));
  for (const value of ['Alice Reed', 'sunshine', '10 Herzl, Tel Aviv, Israel', 'A12345678']) {
    const row = mapping.entries.find(row => row.original === value);
    assert.equal(row?.detection.source, 'model', `Synthetic value must be model-detected: ${value}`);
    assert.ok(row.occurrences > 0);
  }
  const output = JSON.parse(await readFile(path.join(result.output, 'message.jsonl'), 'utf8'))['schema-only@example.com'];
  const tree = parseFragment(output);
  const visible = node => node.tagName === 'script' ? '' : node.nodeName === '#text' ? node.value : (node.childNodes || []).map(visible).join('');
  for (const value of ['Alice Reed', 'sunshine', '10 Herzl, Tel Aviv, Israel']) assert.ok(!visible(tree).includes(value));
  assert.ok(output.includes('id="Alice Reed"'));
  assert.ok(output.includes('<script>const original = "Alice Reed";</script>'));
  assert.equal(await readFile(path.join(source, 'message.jsonl'), 'utf8'), input + '\n');
  console.log(`Real model (${result.detection.backendLabel}): ${cases.length} model-only contextual cases, ordinary-text negative, and JSON/HTML/plain-text mapping and replacement passed.`);
} finally {
  await neural.close();
  await rm(temporary, { recursive: true, force: true });
}
