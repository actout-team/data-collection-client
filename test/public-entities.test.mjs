import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publicEntities, createPublicEntityPolicy } from '../src/protection/public-entities.mjs';
import { createDetector } from '../src/protection/detect.mjs';
import { createReplacements } from '../src/protection/replacements.mjs';
import { jsonText, emailText } from '../src/protection/formats.mjs';
import { htmlText, xmlText, csvText } from '../src/protection/structured.mjs';
import { protectExport } from '../src/protection/index.mjs';

test('Public aliases, suffixes and domain labels are recognized without lookups or substring exemptions', () => {
  for (const value of ['Google', 'HubSpot', 'apple', 'Apple Inc.', 'Google LLC', 'Microsoft Teams', 'NASA', 'גוגל', 'Ｇｏｏｇｌｅ']) assert.equal(publicEntities.isEntity(value), true, value);
  for (const value of ['gmail.com', 'GOOGLE.COM', 'app-eu1.hubspot.com', 'mail.google.com', 'google.com.']) assert.equal(publicEntities.isDomain(value), true, value);
  for (const value of ['Googley', 'Private Consultancy', 'John Apple', 'Google Partners LLC', 'notgoogle.com', 'google.com.evil.test', 'gmail.com.attacker.com', 'gοοgle.com', 'google.com@evil.test', 'https://google.com']) assert.equal(publicEntities.isEntity(value), false, value);
  assert.deepEqual(publicEntities.spans('Googley google.com.evil.test notgoogle.com'), []);
});
test('Both rule and model candidates preserve public entities while mixed detections still protect private names', async () => {
  const observed = [], d = createDetector(['names', 'companies'], { observe: t => observed.push(t) });
  for (const value of ['Google', 'HubSpot', 'Apple Inc.', 'Ｇｏｏｇｌｅ']) {
    d.discover(value, 'company'); d.add(value, 'names', { source: 'model' });
  }
  assert.equal(d.entries.size, 0); assert.deepEqual(observed, []);
  d.add('Alice at Google', 'names', { source: 'model' }); d.add('Private Consultancy', 'companies');
  assert.ok(d.entries.has('Alice')); assert.ok(!d.entries.has('Alice at Google'));
  const calls = [];
  await d.prepare({ proposer: async input => { calls.push(input.original); return input.category === 'names' ? ['Nora'] : ['Cedar', 'Works']; } }); d.compile();
  assert.ok(!calls.some(value => /Google|HubSpot|Apple/.test(value)));
  assert.equal(d.replace('Alice at Google uses HubSpot and Apple Inc.'), `${d.entries.get('Alice').replacement} at Google uses HubSpot and Apple Inc.`);
  assert.notEqual(d.replace('Private Consultancy'), 'Private Consultancy');
});
test('Public email domains stay byte-exact while every sensitive local part changes', () => {
  const originals = ['name@gmail.com', 'support@hubspot.com', 'alice@GOOGLE.COM', 'contact@mail.apple.com', '123456@outlook.com', '---@gmail.com'];
  const d = createDetector(['emails']); originals.forEach(v => d.add(v, 'emails')); d.compile();
  for (const original of originals) {
    const replacement = d.entries.get(original).replacement;
    assert.notEqual(replacement.split('@')[0], original.split('@')[0]);
    assert.equal(replacement.split('@')[1], original.split('@')[1]);
    assert.equal(d.replace(original), replacement);
  }
  const custom = createReplacements().generate('emails', 'alice@privatecustomer.example');
  assert.notEqual(custom.split('@')[1], 'privatecustomer.example');
});
test('Replacement guard prevents a mapping learned elsewhere from changing public mentions', () => {
  const d = createDetector(['secrets','names','companies']);
  const source = JSON.stringify({ password: 'Google', first_name: 'Miro', company: 'Miro', body: 'Google and Miro integrate with Apple.' });
  jsonText(source, d, 'discover'); d.compile();
  const out = JSON.parse(jsonText(source, d, 'replace'));
  assert.notEqual(out.password, 'Google'); assert.notEqual(out.first_name, 'Miro');
  assert.equal(out.company, 'Miro'); assert.equal(out.body, 'Google and Miro integrate with Apple.');
  assert.notEqual(d.replace('password: Google'), 'password: Google');
  assert.equal(d.replace('Visit Google today'), 'Visit Google today');
});
test('Known domain guard does not mistake a private email local part or a spoofed host for a public brand', () => {
  const d = createDetector(['emails', 'companies']);
  for (const value of ['google@private.example', 'alice@google.com.evil.test']) d.add(value, 'emails');
  d.add('Googley', 'companies'); d.compile();
  assert.notEqual(d.replace('google@private.example'), 'google@private.example');
  assert.ok(!d.replace('alice@google.com.evil.test').endsWith('@google.com.evil.test'));
  assert.notEqual(d.replace('Googley'), 'Googley');
});
test('Public brands survive JSON, CSV, XML, HTML and MIME while private values share replacements', () => {
  const d = createDetector(['names','companies','emails']);
  d.add('Alice', 'names'); d.add('Google', 'companies'); d.add('Apple', 'names'); d.add('alice@hubspot.com', 'emails'); d.compile();
  const fixtures = [
    [jsonText, '{"company":"Google","body":"Alice uses Apple","email":"alice@hubspot.com"}'],
    [csvText, 'company,name,email\nGoogle,Alice,alice@hubspot.com\n'],
    [xmlText, '<root company="Google"><name>Alice</name><email>alice@hubspot.com</email></root>'],
    [htmlText, '<p>Alice uses Google and Apple. alice@hubspot.com</p>'],
    [emailText, 'From: Alice <alice@hubspot.com>\r\nSubject: Google and Apple\r\n\r\nAlice uses Google.'],
  ];
  for (const [fn, source] of fixtures) {
    const out = fn(source, d, 'replace');
    assert.ok(out.includes('Google')); assert.ok(out.includes('@hubspot.com'));
    assert.ok(!out.includes('Alice')); assert.ok(!out.includes('alice@'));
    if (source.includes('Apple')) assert.ok(out.includes('Apple'));
  }
});
test('Reviewed registry additions extend protection without auto-trusting unknown names or model output', async () => {
  const policy = createPublicEntityPolicy({ names: ['Public Example Institute'], domains: ['public-example.org'] });
  assert.equal(policy.isEntity('Public Example Institute'), true); assert.equal(policy.isDomain('mail.public-example.org'), true);
  assert.equal(publicEntities.isEntity('Public Example Institute'), false);
  assert.throws(() => createPublicEntityPolicy({ domains: ['https://google.com'] }), /Invalid public domain/);
  const d = createDetector(['companies','emails'], { publicPolicy: policy });
  d.add('Public Example Institute','companies'); d.add('alice@public-example.org','emails'); d.compile();
  assert.equal(d.entries.size,1); assert.ok(d.replace('alice@public-example.org').endsWith('@public-example.org'));
  const privateName = createDetector(['companies']); privateName.add('Veloran', 'companies');
  let calls=0;
  await privateName.prepare({ proposer: async () => { calls++; return calls===1 ? ['Google'] : ['Novelisca']; } });
  privateName.compile(); assert.equal(calls,2); assert.notEqual(privateName.entries.get('Veloran').replacement,'Google');
});
test('Real export pipeline skips public model false positives and reports the applied policy without entity text', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'public-policy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root,'source'); await mkdir(source);
  const input = '{"company":"Google","text":"Alice at HubSpot","email":"alice@apple.com"}\n';
  await writeFile(path.join(source,'data.jsonl'),input);
  const logs = [], neural = { discover(value,d) { d.add(value === 'Alice at HubSpot' ? value : 'Google','names',{source:'model'}); }, close() {} };
  const result=await protectExport({source,categories:['names','companies','emails'],neural,log:(_level,message)=>logs.push(message)});
  const out=JSON.parse(await readFile(path.join(result.output,'data.jsonl'),'utf8'));
  assert.equal(out.company,'Google'); assert.ok(out.text.endsWith(' at HubSpot')); assert.ok(out.email.endsWith('@apple.com'));
  assert.notEqual(out.text,'Alice at HubSpot'); assert.equal(await readFile(path.join(source,'data.jsonl'),'utf8'),input);
  const mapping=JSON.parse(await readFile(result.mapping,'utf8')), report=JSON.parse(await readFile(result.report,'utf8'));
  assert.ok(!mapping.entries.some(e=>['Google','HubSpot','Apple'].includes(e.original)));
  assert.equal(report.publicEntityPolicy.network,false); assert.equal(report.publicEntityPolicy.modelMayExempt,false);
  assert.ok(report.publicEntityPolicy.excludedCandidates>0); assert.match(logs.join('\n'),/Public-entity policy/); assert.doesNotMatch(logs.join('\n'),/Alice|Google|HubSpot|alice@/);
});
test('A public brand homonym in a sensitive street address does not exempt the address', () => {
  const d = createDetector(['addresses']);
  const source = '{"street_address":"123 Apple Street","text":"Delivery: 123 Apple Street. Apple released a product."}';
  jsonText(source,d,'discover'); d.compile();
  const out=JSON.parse(jsonText(source,d,'replace'));
  assert.notEqual(out.street_address,'123 Apple Street');
  assert.ok(out.text.includes(d.entries.get('123 Apple Street').replacement));
  assert.ok(out.text.endsWith('Apple released a product.'));
});
