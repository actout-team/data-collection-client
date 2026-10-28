import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDetector } from '../src/protection/detect.mjs';
import { jsonText, emailText } from '../src/protection/formats.mjs';
import { valueText } from '../src/protection/content.mjs';
import { xmlText, csvText, htmlText } from '../src/protection/structured.mjs';
import { protectExport } from '../src/protection/index.mjs';
// Synthetic platform-shaped regressions, not captures or proof of API coverage.
const email = 'alice@example.com', keyOnly = 'schema-only@example.com';
const platforms = {
  gmail: { payload: { headers: [{ name: keyOnly, value: email }, { name: 'From', value: 'Alice <alice@example.com>' }] } },
  slack: { type: 'message', user: 'U0123', profile: { real_name: 'Alice', email }, text: 'Alice says hello' },
  hubspot: { id: '123', properties: [{ name: keyOnly, value: email }, { name: 'firstname', value: 'Alice' }] },
  salesforce: { records: [{ attributes: { type: 'Contact' }, FirstName: 'Alice', Email: email }] },
  quickbooks: { QueryResponse: { Customer: [{ GivenName: 'Alice', PrimaryEmailAddr: { Address: email } }] } },
  xero: { Contacts: [{ Name: 'Alice', EmailAddress: email, ContactStatus: 'ACTIVE' }] },
  gusto: { employees: [{ first_name: 'Alice', email, custom_fields: [{ name: keyOnly, value: email }] }] },
  deel: { data: [{ person: { first_name: 'Alice', email }, custom_fields: [{ key: keyOnly, value: email }] }] },
  notion: { recordMap: { user: { 'id-1': { value: { name: 'Alice', email } } }, collection: { 'id-2': { value: { schema: { title: { name: keyOnly, type: 'title' } } } } } } },
  asana: { data: [{ gid: '123', assignee: { name: 'Alice', email }, custom_fields: [{ name: keyOnly, text_value: email }] }] },
};
function detector() {
  const observed = [], d = createDetector(['names', 'emails'], { observe: value => observed.push(value) });
  return { d, observed };
}
const shape = value => Array.isArray(value) ? value.map(shape) : value && typeof value === 'object' ? Object.entries(value).map(([key, child]) => [key, shape(child)]) : typeof value;
for (const [platform, record] of Object.entries(platforms)) test(`${platform}: key/value collisions and embedded structures preserve schema in both passes`, () => {
  const payload = { ...record, [keyOnly]: email, Alice: 'Alice', neutral: 'ordinary status', nested: JSON.stringify({ Alice: 'Alice', [keyOnly]: email }), markup: '<Alice Alice="Alice">Alice</Alice>' };
  const source = JSON.stringify(payload, null, 2), { d, observed } = detector();
  jsonText(source, d, 'discover', platform);
  assert.ok(!d.entries.has(keyOnly)); assert.ok(!observed.includes(keyOnly));
  d.add('Alice', 'names'); d.add(keyOnly, 'emails'); d.compile();
  const output = jsonText(source, d, 'replace', platform), parsed = JSON.parse(output);
  assert.deepEqual(shape(parsed), shape(payload));
  assert.equal(parsed.neutral, payload.neutral); assert.notEqual(parsed.Alice, 'Alice');
  assert.ok(Object.hasOwn(parsed, keyOnly));
  const nested = JSON.parse(parsed.nested); assert.deepEqual(Object.keys(nested), ['Alice', keyOnly]); assert.notEqual(nested.Alice, 'Alice');
  assert.ok(parsed.markup.startsWith('<Alice Alice="')); assert.ok(parsed.markup.endsWith('</Alice>'));
  assert.equal((output.match(/schema-only@example\.com/g) || []).length, (source.match(/schema-only@example\.com/g) || []).length);
});
test('Shared format layer excludes keys from model input even when the same word is a mapped value', () => {
  const { d, observed } = detector();
  const fixtures = [
    [jsonText, '{"schema-only@example.com":"Alice","pair":{"name":"schema-only@example.com","value":"Alice"}}'],
    [xmlText, '<Alice xmlns:x="urn:Alice"><field name="schema-only@example.com">Alice</field><entry><key>schema-only@example.com</key><value>Alice</value></entry></Alice>'],
    [csvText, 'schema-only@example.com,name\r\nAlice,Alice\r\n'],
    [htmlText, '<Alice schema-only@example.com="Alice"><p>Alice</p></Alice>'],
    [emailText, 'schema-only@example.com: Alice\r\nSubject: Alice\r\nContent-Type: text/plain\r\n\r\nschema-only@example.com: Alice'],
    [valueText, 'schema-only@example.com: Alice\nAlice=Alice'],
  ];
  for (const [fn, source] of fixtures) fn(source, d, 'discover');
  assert.ok(!observed.includes(keyOnly)); assert.ok(!d.entries.has(keyOnly));
  d.add('Alice', 'names'); d.add(keyOnly, 'emails'); d.compile();
  for (const [fn, source] of fixtures) {
    const output = fn(source, d, 'replace');
    assert.equal((output.match(/schema-only@example\.com/g) || []).length, (source.match(/schema-only@example\.com/g) || []).length);
    assert.ok(output.includes(d.entries.get('Alice').replacement));
  }
});
test('Serialized JSON inside CSV, XML CDATA, escaped XML text and MIME protects only leaf values', () => {
  const { d } = detector(); d.add('Alice', 'names'); d.compile(); const replacement = d.entries.get('Alice').replacement;
  const inner = '{"Alice":"Alice"}';
  assert.equal(csvText('payload\n"{ ""Alice"": ""Alice"" }"\n', d, 'replace'), `payload\n"{ ""Alice"": ""${replacement}"" }"\n`);
  assert.equal(xmlText(`<root><![CDATA[${inner}]]></root>`, d, 'replace'), `<root><![CDATA[{"Alice":"${replacement}"}]]></root>`);
  assert.equal(xmlText('<root>{&quot;Alice&quot;:&quot;Alice&quot;}</root>', d, 'replace'), `<root>{&quot;Alice&quot;:&quot;${replacement}&quot;}</root>`);
  const mime = 'Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from(inner).toString('base64');
  const output = emailText(mime, d, 'replace');
  assert.equal(Buffer.from(output.split('\r\n\r\n')[1], 'base64').toString(), `{"Alice":"${replacement}"}`);
});
test('Future connector uses the shared guard; unsupported syntax is unchanged and reported', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'schema-guard-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await mkdir(path.join(source, 'future-connector'), { recursive: true });
  const input = '{ "Alice": "Alice", "nested": "{\\"Alice\\":\\"Alice\\"}" }\r\n';
  await writeFile(path.join(source, 'future-connector', 'records.jsonl'), input);
  await writeFile(path.join(source, 'future-connector', 'config.yaml'), 'Alice: Alice\n');
  const neural = { discover(value, d) { if (value === 'Alice') d.add(value, 'names', { source: 'model' }); }, close() {} };
  const result = await protectExport({ source, categories: ['names'], neural });
  const out = await readFile(path.join(result.output, 'future-connector', 'records.jsonl'), 'utf8');
  const record = JSON.parse(out); assert.deepEqual(Object.keys(record), ['Alice', 'nested']); assert.notEqual(record.Alice, 'Alice');
  assert.deepEqual(Object.keys(JSON.parse(record.nested)), ['Alice']);
  assert.equal(await readFile(path.join(result.output, 'future-connector', 'config.yaml'), 'utf8'), 'Alice: Alice\n');
  assert.equal(await readFile(path.join(source, 'future-connector', 'records.jsonl'), 'utf8'), input);
  assert.equal(result.status, 'partial'); assert.ok(result.reviewItems > 0);
});
test('Malformed nested structures and fenced source code never fall through to global substitution', () => {
  const { d } = detector(); d.add('Alice', 'names'); d.compile();
  for (const source of ['{"Alice": broken}', '<Alice>unclosed', '```js\nconst Alice = "Alice";\n```']) {
    const warnings = [];
    assert.equal(valueText(source, d, 'replace', '', '', reason => warnings.push(reason)), source);
    assert.ok(warnings.length);
  }
});
test('Camel-case field descriptors stay exact without exempting ordinary secret key values', () => {
  const { d, observed } = detector();
  const source = JSON.stringify({ fieldName: keyOnly, propertyName: keyOnly, column_name: keyOnly, key: email, schema: { custom: { name: keyOnly } }, profile: { name: 'Alice' } });
  jsonText(source, d, 'discover');
  assert.ok(!observed.includes(keyOnly)); assert.ok(d.entries.has(email));
  d.add(keyOnly, 'emails'); d.add('Alice', 'names'); d.compile();
  const parsed = JSON.parse(jsonText(source, d, 'replace'));
  assert.equal(parsed.fieldName, keyOnly); assert.equal(parsed.propertyName, keyOnly); assert.equal(parsed.column_name, keyOnly); assert.equal(parsed.schema.custom.name, keyOnly);
  assert.notEqual(parsed.key, email); assert.notEqual(parsed.profile.name, 'Alice');
});
