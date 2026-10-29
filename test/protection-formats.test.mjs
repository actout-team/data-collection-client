import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseFragment } from 'parse5';
import { parse as parseCsv } from 'csv-parse/sync';
import { SaxesParser } from 'saxes';
import { createDetector } from '../src/protection/detect.mjs';
import { jsonText, emailText } from '../src/protection/formats.mjs';
import { htmlText, xmlText, csvText } from '../src/protection/structured.mjs';
import { protectExport } from '../src/protection/index.mjs';

function mapped(original = 'Alice', replacement = 'Avery') {
  const detector = createDetector(['names']); detector.add(original, 'names'); detector.compile();
  detector.entries.get(original).replacement = replacement;
  return detector;
}
test('JSON preserves keys, duplicate keys, scalar types and surrounding bytes', () => {
  const detector = mapped();
  const text = '{ "Alice": "Alice", "items": [true, null, 1e+2, "Alice", {"x":"\\u0041lice"}], "Alice": "unchanged \\/ \\u0065" }\r\n';
  const output = jsonText(text, detector, 'replace', 'data');
  assert.equal(output, '{ "Alice": "Avery", "items": [true, null, 1e+2, "Avery", {"x":"Avery"}], "Alice": "unchanged \\/ \\u0065" }\r\n');
  assert.deepEqual(JSON.parse(output).items, [true, null, 100, 'Avery', { x: 'Avery' }]);
});
test('HTML changes text and human-readable attribute values, preserving tags, IDs and scripts', () => {
  const detector = mapped('Alice', 'Avery "<&');
  const source = '<Alice id="Alice" class="Alice" title="Alice"><b>Alice</b> &nbsp; keep<!--Alice--><script>const Alice = "Alice";</script></Alice>';
  const output = htmlText(source, detector, 'replace');
  assert.equal(output, '<Alice id="Alice" class="Alice" title="Avery &quot;&lt;&amp;"><b>Avery &quot;&lt;&amp;</b> &nbsp; keep<!--Alice--><script>const Alice = "Alice";</script></Alice>');
  const node = parseFragment(output).childNodes[0];
  assert.equal(node.tagName, 'alice'); assert.equal(node.attrs.find(a => a.name === 'title').value, 'Avery "<&');
});
test('HTML entity edits preserve unrelated escapes and unquoted attribute syntax', () => {
  const detector = mapped('Alice Reed', 'Avery Lane');
  const source = '<p title=Alice&#32;Reed>Alice&#32;Reed &amp; unchanged</p>';
  const output = htmlText(source, detector, 'replace');
  assert.equal(output, '<p title=Avery&#32;Lane>Avery Lane &amp; unchanged</p>');
  assert.equal(parseFragment(output).childNodes[0].attrs[0].value, 'Avery Lane');
});
test('HTML inside JSON values preserves the outer escapes and inner structure', () => {
  const source = '{ "content_html": "<p id=\\"Alice\\">\\u0041lice &amp; \\u0065lse<\\/p>", "other":"\\u0065" }';
  const output = jsonText(source, mapped(), 'replace', 'message');
  assert.equal(output, '{ "content_html": "<p id=\\"Alice\\">Avery &amp; \\u0065lse<\\/p>", "other":"\\u0065" }');
  assert.equal(parseFragment(JSON.parse(output).content_html).childNodes[0].attrs[0].value, 'Alice');
});
test('CSV preserves header names, row widths, multiline cells and quote escaping', () => {
  const source = 'Alice,note\r\nAlice,"Alice says ""hello""\nnext line"\r\n';
  const output = csvText(source, mapped('Alice', 'Avery,"Lane"\nSecond'), 'replace');
  const rows = parseCsv(output);
  assert.deepEqual(rows, [['Alice', 'note'], ['Avery,"Lane"\nSecond', 'Avery,"Lane"\nSecond says "hello"\nnext line']]);
  assert.ok(output.startsWith('Alice,note\r\n')); assert.ok(output.endsWith('\r\n'));
});
test('CSV header context discovers sensitive values without treating headers as data', () => {
  const detector = createDetector(['names', 'emails']);
  csvText('full_name,email\nAlice Reed,alice@example.com\n', detector, 'discover');
  assert.ok(detector.entries.has('Alice Reed')); assert.ok(detector.entries.has('alice@example.com'));
  assert.ok(!detector.entries.has('full_name'));
});
test('XML preserves element names, namespaces and attributes while escaping changed values', () => {
  const source = '<?xml version="1.0"?><Alice xmlns:x="urn:Alice" x:name="Alice"><full_name>Alice</full_name><note><![CDATA[Alice]]></note><!--Alice--></Alice>';
  const output = xmlText(source, mapped('Alice', 'Avery & Lane'), 'replace');
  assert.equal(output, '<?xml version="1.0"?><Alice xmlns:x="urn:Alice" x:name="Avery &amp; Lane"><full_name>Avery &amp; Lane</full_name><note><![CDATA[Avery & Lane]]></note><!--Alice--></Alice>');
  const values = [], parser = new SaxesParser({ xmlns: true }); parser.on('text', value => values.push(value)); parser.write(output).close();
  assert.ok(values.includes('Avery & Lane'));
});
test('Invalid generated JSON numbers and XML CDATA fail output validation', () => {
  const detector = createDetector(['identifiers']); detector.add('12345', 'identifiers'); detector.compile();
  detector.entries.get('12345').replacement = '01234';
  assert.throws(() => jsonText('{"tax_id":12345}', detector, 'replace', 'data'), /format validation/);
  assert.throws(() => xmlText('<root><![CDATA[Alice]]></root>', mapped('Alice', ']]><broken>'), 'replace'), /format validation/);
});
test('MIME preserves dates, IDs, boundaries and binary bytes while updating content length', () => {
  const source = 'From: Alice <alice@example.com>\r\nDate: Thu, 15 Oct 2026 06:00:00 +0000\r\nMessage-ID: <Alice@example.com>\r\nContent-Type: text/html\r\nContent-Length: 23\r\n\r\n<p id="Alice">Alice</p>';
  const output = emailText(source, mapped('Alice', 'Avery Lane'), 'replace');
  const [headers, body] = output.split('\r\n\r\n');
  assert.ok(headers.includes('Message-ID: <Alice@example.com>'));
  assert.ok(headers.includes('Date: Thu, 15 Oct 2026 06:00:00 +0000'));
  assert.ok(headers.includes(`Content-Length: ${Buffer.byteLength(body)}`));
  assert.equal(body, '<p id="Alice">Avery Lane</p>');
});
test('MIME boundary injection fails before publication', () => {
  const source = 'Content-Type: multipart/mixed; boundary="part"\r\n\r\n--part\r\nContent-Type: text/plain\r\n\r\nAlice\r\n--part--\r\n';
  assert.throws(() => emailText(source, mapped('Alice', 'Avery\r\n--part\r\n\r\nInjected'), 'replace'), /format validation/);
});
test('MIME attachment contents never reach detection or replacement, including text and nested emails', () => {
  const parts = [
    ['Content-Type: text/plain\r\nContent-Disposition: attachment', 'Alice'],
    ['Content-Type: text/html\r\nContent-Disposition: inline;\r\n filename="report.html"', '<p>Alice</p>'],
    ["Content-Type: text/csv; name*=utf-8''report.csv", 'name\r\nAlice'],
    ["Content-Type: text/plain\r\nContent-Disposition: inline; filename*0*=utf-8''report; filename*1*=.txt", 'Alice'],
    ['Content-Type: message/rfc822\r\nContent-Disposition: attachment', 'From: Alice\r\n\r\nAlice'],
    ['Content-Type: multipart/mixed; boundary="inner"\r\nContent-Disposition: attachment', '--inner\r\nContent-Type: text/plain\r\n\r\nAlice\r\n--inner--']
  ];
  for (const [headers, body] of parts) {
    const attachment = headers + '\r\n\r\n' + body;
    const source = 'Content-Type: multipart/mixed; boundary="outer"\r\n\r\n--outer\r\nContent-Type: text/plain\r\n\r\nAlice\r\n--outer\r\n' + attachment + '\r\n--outer--\r\n';
    const detector = createDetector(['names']);
    detector.discover = () => assert.fail('Attachment content reached discovery');
    detector.add = () => assert.fail('Attachment content reached detection');
    emailText(attachment, detector, 'discover');
    assert.equal(detector.entries.size, 0);
    const warnings = [];
    const output = emailText(source, mapped(), 'replace', warning => warnings.push(warning));
    assert.ok(output.includes('\r\n\r\nAvery\r\n--outer'));
    assert.ok(output.includes(attachment));
    assert.ok(warnings.includes('Attachment content excluded from analysis and copied unchanged'));
  }
});
test('A failed format check removes the staged copy and leaves originals untouched', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'actout-format-')), source = path.join(parent, 'original');
  t.after(() => rm(parent, { recursive: true, force: true })); await mkdir(source);
  const xml = '<root><![CDATA[Alice]]></root>'; await writeFile(path.join(source, 'data.xml'), xml);
  const neural = { discover(_value, detector) { detector.spans = value => [{ start: 0, end: value.length, row: { replacement: ']]><broken>', occurrences: 0 } }]; }, close() {} };
  await assert.rejects(protectExport({ source, categories: ['names'], neural }), /format validation/);
  assert.deepEqual(await readdir(parent), ['original']); assert.equal(await readFile(path.join(source, 'data.xml'), 'utf8'), xml);
});
