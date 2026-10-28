import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { protectExport } from '../src/protection/index.mjs';
import { createDetector } from '../src/protection/detect.mjs';
import { jsonText, emailText } from '../src/protection/formats.mjs';
import { protectionOptions, protectionMatches } from '../ui/protection-options.mjs';
const all = protectionOptions.map(o => o.id);
async function fixture(t, files) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'agentsim-protection-')), source = path.join(parent, 'download');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(source);
  for (const [name, value] of Object.entries(files)) { await mkdir(path.dirname(path.join(source, name)), { recursive: true }); await writeFile(path.join(source, name), value); }
  return { parent, source };
}
const rows = mapping => new Map(mapping.entries.map(row => [row.original, row.replacement]));
test('Local-model mode reaches managed runtime setup without a supplied proposer', async t => {
  const input = '{"full_name":"Alice Reed"}';
  const { source, parent } = await fixture(t, { 'data.json': input });
  // Exercise automatic proposer creation, including its environment lookup.
  // Omitting the cache directory stops the real setup before any downloads.
  await assert.rejects(protectExport({ source, categories: ['names'], generationMode: 'local-model' }), {
    message: 'A private absolute runtime-cache directory is required.',
  });
  assert.deepEqual(await readdir(parent), ['download']);
  assert.equal(await readFile(path.join(source, 'data.json'), 'utf8'), input);
});
test('Creates a separate format-preserving copy, consistent cross-file replacements and a private sibling map', async t => {
  const json = '\uFEFF{ "from": {"name":"Alice Reed", "address":"alice@example.com"}, "phone": "+1 (202) 555-0198", "street_address":"45 Maple Road", "password":"S3cret!Value", "tax_id":"AB-12345678", "text": "Alice Reed emailed alice@example.com; slash \\/ stays; \\u0065scape", "count": 42 }\r\n';
  const { source, parent } = await fixture(t, { 'gmail/messages.jsonl': json, 'notes.txt': 'Alice Reed\nEmail: alice@example.com\nPassword: S3cret!Value\n45 Maple Road', 'empty/data.txt': '' });
  const progress = [];
  const result = await protectExport({ source, categories: all, progress: value => progress.push(value) });
  const map = JSON.parse(await readFile(result.mapping, 'utf8')), m = rows(map);
  assert.equal(result.status, 'finished'); assert.equal(result.files, 3);
  assert.equal(path.dirname(result.mapping), parent); assert.notEqual(result.output, source);
  assert.equal(await readFile(path.join(source, 'gmail/messages.jsonl'), 'utf8'), json);
  const copied = await readFile(path.join(result.output, 'gmail/messages.jsonl'), 'utf8');
  let expected = json;
  for (const original of ['Alice Reed', 'alice@example.com', '+1 (202) 555-0198', '45 Maple Road', 'S3cret!Value', 'AB-12345678']) {
    assert.ok(m.has(original), original); assert.notEqual(m.get(original), original);
    expected = expected.split(original).join(m.get(original));
  }
  assert.equal(copied, expected);
  const notes = await readFile(path.join(result.output, 'notes.txt'), 'utf8');
  assert.equal(notes, `Alice Reed\nEmail: alice@example.com\nPassword: S3cret!Value\n45 Maple Road`.replaceAll('Alice Reed', m.get('Alice Reed')).replaceAll('alice@example.com', m.get('alice@example.com')).replaceAll('S3cret!Value', m.get('S3cret!Value')).replaceAll('45 Maple Road', m.get('45 Maple Road')));
  assert.equal(map.encrypted, false);
  assert.equal((await stat(result.mapping)).mode & 0o777, 0o600);
  assert.equal((await stat(result.output)).mode & 0o777, 0o700);
  assert.equal(progress.at(-1).percent, 100);
  assert.ok(progress.some(p => p.phase === 'Scanning')); assert.ok(progress.some(p => p.phase === 'Copying'));
  assert.equal((await readdir(result.output)).some(name => name.includes('mapping')), false);
});
test('Selections apply independently and numeric IDs keep their JSON type', async t => {
  const text = '{ "email": "a@example.com", "full_name": "Alice Reed", "card_number": 4111111111111111, "text": "Alice Reed" }';
  const { source } = await fixture(t, { 'data.json': text });
  const result = await protectExport({ source, categories: ['identifiers'] });
  const output = JSON.parse(await readFile(path.join(result.output, 'data.json'), 'utf8'));
  assert.equal(output.email, 'a@example.com'); assert.equal(output.full_name, 'Alice Reed');
  assert.equal(output.text, 'Alice Reed'); assert.equal(typeof output.card_number, 'number');
  assert.notEqual(output.card_number, 4111111111111111);
  const second = await protectExport({ source, categories: ['emails'] });
  assert.notEqual(second.output, result.output); assert.equal(JSON.parse(await readFile(path.join(second.output, 'data.json'), 'utf8')).card_number, 4111111111111111);
});
test('Escaped sensitive strings change while unrelated JSON escapes and whitespace remain exact', () => {
  const detector = createDetector(['emails']);
  const text = '{ "email" : "alice\\u0040example.com", "text":"alice@example.com and \\u0065scaped \\/ path" }';
  jsonText(text, detector, 'discover', 'data'); detector.compile();
  const replacement = detector.entries.get('alice@example.com').replacement;
  const output = jsonText(text, detector, 'replace', 'data');
  assert.equal(output, `{ "email" : "${replacement}", "text":"${replacement} and \\u0065scaped \\/ path" }`);
});
test('Longest overlapping values win without replacing substrings or cascading replacements', () => {
  const detector = createDetector(['names']); detector.add('Ann', 'names'); detector.add('Ann Smith', 'names');
  detector.compile();
  const output = detector.replace('Ann Smith met Ann and Anna.');
  assert.equal(output, `${detector.entries.get('Ann Smith').replacement} met ${detector.entries.get('Ann').replacement} and Anna.`);
});
test('MIME plain, base64 and quoted-printable content use the same map; attachments remain exact and flagged', async t => {
  const boundary = 'test-boundary';
  const base = Buffer.from('Hello alice@example.com, keep this text.').toString('base64');
  const binary = 'AAECAwQF//4=';
  const eml = `From: Alice Reed <alice@example.com>\r\nSubject: Contact\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base}\r\n--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<p>Email alice=40example.com</p>\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n${binary}\r\n--${boundary}--\r\n`;
  const { source } = await fixture(t, { 'gmail/emails/email.eml': eml });
  const result = await protectExport({ source, categories: all });
  const m = rows(JSON.parse(await readFile(result.mapping, 'utf8'))), replacement = m.get('alice@example.com');
  const output = await readFile(path.join(result.output, 'gmail/emails/email.eml'), 'utf8');
  assert.ok(output.startsWith(`From: ${m.get('Alice Reed')} <${replacement}>\r\nSubject: Contact\r\n`));
  const encoded = output.match(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/)[1];
  assert.equal(Buffer.from(encoded, 'base64').toString(), `Hello ${replacement}, keep this text.`);
  assert.ok(output.includes(`<p>Email=20${replacement}</p>`));
  assert.ok(output.endsWith(`\r\n${binary}\r\n--${boundary}--\r\n`));
  assert.equal(result.status, 'partial'); assert.equal(result.reviewItems, 1);
  assert.ok(JSON.parse(await readFile(result.report, 'utf8')).warnings.some(w => w.reason.includes('Non-text MIME')));
});
test('Encoded headers preserve decoded surrounding text and unsupported charsets are flagged', () => {
  const detector = createDetector(['emails']), warnings = [];
  const value = 'Write alice@example.com today';
  const eml = `Subject: =?UTF-8?B?${Buffer.from(value).toString('base64')}?=\r\nContent-Type: text/plain; charset=windows-1255\r\n\r\nbody`;
  emailText(eml, detector, 'discover', reason => warnings.push(reason)); detector.compile();
  const output = emailText(eml, detector, 'replace', reason => warnings.push(reason));
  const decoded = [...output.matchAll(/=\?UTF-8\?B\?([^?]*)\?=/g)].map(m => Buffer.from(m[1], 'base64').toString()).join('');
  assert.equal(decoded, `Write ${detector.entries.get('alice@example.com').replacement} today`);
  assert.ok(output.endsWith('\r\n\r\nbody')); assert.ok(warnings.includes('Unsupported MIME charset'));
});
test('Binary files, invalid JSON and invalid UTF-8 are preserved and explicitly reported', async t => {
  const binary = Buffer.from([255, 0, 128, 12]);
  const { source } = await fixture(t, { 'a.png': binary, 'broken.json': '{ bad json', 'bad.txt': binary });
  const result = await protectExport({ source, categories: all });
  assert.equal(result.status, 'partial'); assert.equal(result.reviewItems, 3);
  assert.deepEqual(await readFile(path.join(result.output, 'a.png')), binary);
  assert.equal(await readFile(path.join(result.output, 'broken.json'), 'utf8'), '{ bad json');
});
test('Abort removes only the incomplete copy and does not publish a mapping', async t => {
  const { source, parent } = await fixture(t, { 'data.json': '{"email":"a@example.com"}' });
  const controller = new AbortController();
  await assert.rejects(protectExport({ source, categories: all, signal: controller.signal, progress: event => { if (event.phase === 'Copying') controller.abort(Error('Stopped')); } }), /Stopped/);
  assert.deepEqual(await readdir(parent), ['download']);
  assert.equal(await readFile(path.join(source, 'data.json'), 'utf8'), '{"email":"a@example.com"}');
});
test('Rejects symlinks and invalid options without creating an output', async t => {
  const { source, parent } = await fixture(t, { 'safe.txt': 'hello' });
  await assert.rejects(protectExport({ source, categories: [] }), /Choose/);
  await assert.rejects(protectExport({ source, categories: ['bogus'] }), /Choose/);
  await symlink(path.join(source, 'safe.txt'), path.join(source, 'link.txt'));
  await assert.rejects(protectExport({ source, categories: all }), /symbolic link/);
  assert.deepEqual(await readdir(parent), ['download']);
});
test('Changing source files between scan and copy stops publication', async t => {
  const { source, parent } = await fixture(t, { 'data.json': '{"email":"a@example.com"}' });
  // The first replacement reads the source after discovery. Change it from
  // outside while the engine yields between passes.
  let change;
  await assert.rejects(protectExport({ source, categories: all, progress: event => {
    if (event.phase === 'Scanning' && event.percent === 50 && !change) change = writeFile(path.join(source, 'data.json'), '{"email":"changed@example.com"}');
  } }), /changed/);
  await change; assert.deepEqual(await readdir(parent), ['download']);
});
test('Export requires matching protection settings and completed results', () => {
  const state = { downloadResult: { output: '/source' }, protectionResult: { source: '/source', categories: all, status: 'finished' } };
  assert.equal(protectionMatches(state, new Set(all)), true);
  assert.equal(protectionMatches({ ...state, busy: true }, new Set(all)), false);
  assert.equal(protectionMatches(state, new Set(['emails'])), false);
  assert.equal(protectionMatches({ ...state, downloadResult: { output: '/new' } }, new Set(all)), false);
  assert.equal(protectionMatches({ ...state, protectionResult: { ...state.protectionResult, status: 'failed' } }, new Set(all)), false);
});

test('JSONL records spanning read chunks, including Unicode, preserve record delimiters', async t => {
  const text = 'prefix '.repeat(42000) + 'alice@example.com שלום';
  const line = JSON.stringify({ text }) + '\r\n';
  const { source } = await fixture(t, { 'records.jsonl': line + '{"email":"alice@example.com"}' });
  const result = await protectExport({ source, categories: ['emails'] });
  const replacement = rows(JSON.parse(await readFile(result.mapping, 'utf8'))).get('alice@example.com');
  assert.equal(await readFile(path.join(result.output, 'records.jsonl'), 'utf8'), (line + '{"email":"alice@example.com"}').replaceAll('alice@example.com', replacement));
});
test('Numeric identifiers do not rewrite unrelated numeric counts and passwords preserve JSON syntax', () => {
  const detector = createDetector(['identifiers', 'secrets']);
  const text = '{"tax_id":12345,"count":12345,"password":"quote\\\"and\\nline","authorization":"Bearer abcdefghijklmnop"}';
  jsonText(text, detector, 'discover', 'data'); detector.compile();
  const output = JSON.parse(jsonText(text, detector, 'replace', 'data'));
  assert.equal(output.count, 12345); assert.notEqual(output.tax_id, 12345);
  assert.equal(output.password, detector.entries.get('quote"and\nline').replacement);
  assert.equal(output.authorization, 'Bearer ' + detector.entries.get('abcdefghijklmnop').replacement);
});
test('Encoded mail display names are detected even without a JSON contact record', () => {
  const detector = createDetector(['names']);
  const eml = 'From: =?UTF-8?Q?Alice_Reed?= <alice@example.com>\r\n\r\nHello';
  emailText(eml, detector, 'discover', () => {}); detector.compile();
  const output = emailText(eml, detector, 'replace', () => {});
  assert.equal(output, `From: =?UTF-8?Q?${detector.entries.get('Alice Reed').replacement.replaceAll(' ', '=20')}?= <alice@example.com>\r\n\r\nHello`);
});
test('A selected name does not alter an unselected email local-part', () => {
  const detector = createDetector(['names']); detector.add('Alice', 'names'); detector.compile();
  assert.equal(detector.replace('Alice at Alice.reed@example.com'), `${detector.entries.get('Alice').replacement} at Alice.reed@example.com`);
});
test('Publication conflict never overwrites or removes an existing sibling file', async t => {
  const { readdirSync, writeFileSync } = await import('node:fs');
  const { source, parent } = await fixture(t, { 'data.json': '{"email":"a@example.com"}' });
  let foreign;
  await assert.rejects(protectExport({ source, categories: all, progress: event => {
    if (event.phase === 'Copying' && !foreign) {
      const stage = readdirSync(parent).find(name => name.endsWith('.partial'));
      foreign = path.join(parent, stage.slice(0, -8) + '.mapping.json');
      writeFileSync(foreign, 'unrelated content', { flag: 'wx' });
    }
  } }), /EEXIST/);
  assert.equal(await readFile(foreign, 'utf8'), 'unrelated content');
  assert.deepEqual((await readdir(parent)).sort(), ['download', path.basename(foreign)].sort());
});
