import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetector } from '../src/protection/detect.mjs';
import { valueText } from '../src/protection/content.mjs';
import { jsonText } from '../src/protection/formats.mjs';
import { htmlText, xmlText } from '../src/protection/structured.mjs';

function protect(source, transform, originals) {
  const d = createDetector(['secrets']);
  transform(source, d, 'discover');
  assert.deepEqual([...d.entries.keys()].sort(), [...originals].sort());
  d.compile();
  const output = transform(source, d, 'replace');
  for (const original of originals) {
    assert.notEqual(d.entries.get(original).replacement, original);
    assert.equal(d.entries.get(original).category, 'secrets');
    assert.ok(d.entries.get(original).occurrences > 0);
  }
  return { output, d };
}

test('Message prose retains credential context through JSON and HTML routing', () => {
  const html = '<html><body><div>This is a test with my password: violet</div></body></html>';
  const source = JSON.stringify({ body: { contentType: 'html', content: html }, password_label: 'password' });
  const { output, d } = protect(source, jsonText, ['violet']);
  const parsed = JSON.parse(output);
  assert.equal(parsed.body.content, html.replace('violet', d.entries.get('violet').replacement));
  assert.equal(parsed.password_label, 'password');
  assert.equal(d.entries.get('violet').occurrences, 1);
});

test('Quoted, short and multiple credentials preserve surrounding prose and labels', () => {
  const source = 'For testing, password: "a=b{c}"; API key: violet\nAnother password: xy';
  const { output, d } = protect(source, valueText, ['a=b{c}', 'violet', 'xy']);
  assert.equal(output, [...d.entries.values()].reduce((text, row) => text.replace(row.original, row.replacement), source));
});

test('HTML inline label context and entities reach values without rewriting DOM attributes', () => {
  const source = '<div><b>Password:</b> <span>v&#105;olet</span>; keep this text</div><input type="password" name="login" value="sunshine" id="sunshine">';
  const { output, d } = protect(source, htmlText, ['violet', 'sunshine']);
  assert.equal(output, source.replace('v&#105;olet', d.entries.get('violet').replacement).replace('value="sunshine"', `value="${d.entries.get('sunshine').replacement}"`));
});

test('XML namespaces, CDATA, attributes and field descriptors retain secret field meaning', () => {
  const source = '<root xmlns:s="urn:test"><s:password>a=b{c}</s:password><password><![CDATA[[bracket]]]></password><field name="password" value="violet"/><item s:password="sunshine"/></root>';
  const { output } = protect(source, xmlText, ['a=b{c}', '[bracket]', 'violet', 'sunshine']);
  assert.ok(output.includes('<s:password>'));
  assert.ok(output.includes('<field name="password" value="'));
});

test('Code, schema labels, descriptive prose and unrelated DOM blocks do not become credentials', () => {
  for (const [source, transform] of [
    ['```js\npassword: violet\n```\npassword: required.\nconst password = "violet";', valueText],
    ['{"password":"password","key":"violet"}', jsonText],
    ['<div>Password:</div><div>violet</div><script>password: sunshine</script>', htmlText],
    ['<div>```js\npassword: violet\n```</div>', htmlText],
    ['<root><field name="password"/><property><name>sunshine</name></property></root>', xmlText]
  ]) {
    const { output } = protect(source, transform, []);
    assert.equal(output, source);
  }
});

test('Secret discovery and replacement respect the selected categories', () => {
  const source = '<p>Here is my password: violet</p>';
  const d = createDetector(['emails']);
  htmlText(source, d, 'discover'); d.compile();
  assert.equal(d.entries.size, 0);
  assert.equal(htmlText(source, d, 'replace'), source);
});

test('Authentication codes are protected in both sentence orders and inline HTML', () => {
  for (const [source, transform, codes] of [
    ['Your confirmation code is 482716', valueText, ['482716']],
    ['731904 is your Example Log In Code', valueText, ['731904']],
    ['Security code: 6294; password: violet; verification code = 84719302', valueText, ['6294', 'violet', '84719302']],
    ['<h1>390817 is your Example sign-in code</h1><p>Verification code: <b>471903</b></p>', htmlText, ['390817', '471903']],
    [JSON.stringify({ text: 'Your one-time code is 194732', count: '194732' }), jsonText, ['194732']],
    [JSON.stringify({ text: 'Your verification code: 194732.', count: '194732' }), jsonText, ['194732']]
  ]) {
    const { output, d } = protect(source, transform, codes);
    if (transform === jsonText) assert.equal(JSON.parse(output).count, '194732');
    else assert.equal(output, [...d.entries.values()].reduce((text, row) => text.replace(row.original, row.replacement), source));
  }
});

test('Ordinary numbers, incomplete codes, code samples and unrelated labels stay unchanged', () => {
  for (const source of [
    'Order code: 482716. Invoice number: 731904. Postal code: 6294.',
    'Confirmation code is expired. Security code is required.',
    'Verification code: 123456789; confirmation code: 123456-extra; security code: 1234.56',
    '```text\nConfirmation code: 482716\n```',
    '482716 appears in a report. A verification code is needed.'
  ]) assert.equal(protect(source, valueText, []).output, source);
});
