// Real model inference against synthetic data. No account data is used.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Tokenizer } from '@huggingface/tokenizers';
import { fileURLToPath, pathToFileURL } from 'node:url';
const appRoot = process.env.ACTOUT_TEST_APP_ROOT || fileURLToPath(new URL('..', import.meta.url));
const { ensureModel } = await import(pathToFileURL(path.join(appRoot, 'src/protection/model-cache.mjs')));
const { protectExport } = await import(pathToFileURL(path.join(appRoot, 'src/protection/index.mjs')));
const { GPU_MODEL, MODEL } = await import(pathToFileURL(path.join(appRoot, 'src/protection/model-config.mjs')));
const cache = process.env.ACTOUT_TEST_MODEL_CACHE || path.join(os.tmpdir(), 'actout-neural-cache');
const preference = process.env.ACTOUT_TEST_BACKEND || 'auto';
const modelDirectory = await ensureModel(cache, { model: preference === 'cpu' ? MODEL : GPU_MODEL });
const tokenizer = new Tokenizer(JSON.parse(await readFile(path.join(modelDirectory, 'tokenizer.json'), 'utf8')), JSON.parse(await readFile(path.join(modelDirectory, 'tokenizer_config.json'), 'utf8')));
const longWord = Array.from({ length: 120 }, (_, i) => createHash('sha256').update(String(i)).digest('hex')).join('');
assert.ok(tokenizer.encode(longWord.slice(0, 2400), { add_special_tokens: false }).ids.length > 512, 'Fixture must reproduce the old oversized-token failure');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'actout-model-smoke-'));
const source = path.join(temporary, 'original'); await mkdir(source);
const categories = ['names','emails','phones','addresses','secrets','identifiers'];
const prose = 'Please contact Alice Reed at alice.reed@acme.com. She lives at 45 Maple Road, Boston, MA 02110. Her password is OrangeMoon99! and her phone is +1 202 555 0198.';
const eml = 'From: Alice Reed <alice.reed@acme.com>\r\nSubject: Notes\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from(prose).toString('base64');
const html = '<article id="Alice"><p>Alice Reed</p><a href="mailto:alice.reed@acme.com">Contact</a></article>';
const files = {
  'a-prose.txt': prose,
  'b-contacts.json': '{ "contacts": [{"first_name":"Alice","last_name":"Reed","email":"alice.reed@acme.com"}], "count":42 }\r\n',
  'c-mail.eml': eml,
  'd-long.txt': 'The team reviewed the schedule and completed the report. '.repeat(110) + 'Michael Turner visited Sarah Wilson.',
  'e-message.jsonl': JSON.stringify({ text: 'John Smith works with Maria Garcia.' })+'\r\n',
  'f-long-mail.eml': 'Subject: Long link\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from(`Tracking URL: https://example.com/${longWord}\nRobert Miller visited Emily Davis.`).toString('base64'),
  'g-contacts.csv': 'full_name,email\r\n"Alice Reed",alice.reed@acme.com\r\n',
  'h-contact.xml': '<Alice><full_name>Alice Reed</full_name><email>alice.reed@acme.com</email></Alice>',
  'i-body.html': html,
  'j-html-mail.eml': 'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from(html).toString('base64'),
  'k-html.json': JSON.stringify({ content_html: html }),
  'slack/messages.jsonl': JSON.stringify({channel:'C00EXAMPLE',user:'U00EXAMPLE',type:'message',ts:'1729183602.000001',text:'Reply to owner@example.net and Alice Reed.'})+'\n',
  'outlook/messages.jsonl': JSON.stringify({id:'OpaqueRecord42',folderId:'OpaqueFolder42',from:[{email:'owner@example.net',routingType:'SMTP'}],body:{type:'HTML',content:'<p>Reply to owner@example.net and Alice Reed.</p>'}})+'\n'
};
for (const [name, value] of Object.entries(files)) { await mkdir(path.dirname(path.join(source,name)), {recursive:true}); await writeFile(path.join(source,name),value); }
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('Unexpected network access during offline protection'); };
try {
  const start = performance.now();
  const result = await protectExport({ source, categories, modelDirectory: cache, preference, accountOwners:[{app:'slack',accountKey:'test-owner',verified:true,source:'authenticated-self-profile',emails:['owner@example.net']}] });
  assert.ok(['finished', 'partial'].includes(result.status));
  const report = JSON.parse(await readFile(result.report, 'utf8'));
  assert.ok(report.warnings.every(w => w.file === '(detection mapping)' || /spelling pool; country matching is unverified/.test(w.reason)), JSON.stringify(report.warnings)); assert.equal(result.detection.runtime,'ONNX Runtime');
  const map = JSON.parse(await readFile(result.mapping,'utf8'));
  const rows = new Map(map.entries.map(row=>[row.original,row.replacement]));
  assert.equal(result.unappliedValues, map.entries.filter(row => !row.occurrences).length);
  assert.ok(!rows.has('owner@example.net'));
  for (const file of ['slack/messages.jsonl','outlook/messages.jsonl']) {
    const original=JSON.parse(files[file]), output=JSON.parse(await readFile(path.join(result.output,file),'utf8'));
    assert.ok(JSON.stringify(output).includes('owner@example.net'));
    if(file.startsWith('slack')) for(const key of ['channel','user','type','ts']) assert.equal(output[key],original[key]);
    else { assert.equal(output.id,original.id);assert.equal(output.folderId,original.folderId);assert.equal(output.body.type,'HTML');assert.equal(output.from[0].routingType,'SMTP'); }
  }
  for (const expected of ['Alice Reed','45 Maple Road, Boston, MA 02110','OrangeMoon99!','Michael Turner','Sarah Wilson','John Smith','Maria Garcia','Robert Miller','Emily Davis']) assert.ok(rows.has(expected), `Missed synthetic entity: ${expected}`);
  const contact = JSON.parse(await readFile(path.join(result.output,'b-contacts.json'),'utf8')).contacts[0];
  assert.equal(rows.get('Alice Reed'), `${contact.first_name} ${contact.last_name}`);
  assert.equal(contact.email.split('@')[0],`${contact.first_name}.${contact.last_name}`.toLowerCase());
  const output = await readFile(path.join(result.output,'a-prose.txt'),'utf8');
  assert.ok(output.includes(rows.get('Alice Reed'))); assert.ok(output.includes(contact.email));
  assert.ok(!output.includes('OrangeMoon99!')); assert.ok(output.includes('! and her phone is '));
  for (const [name,value] of Object.entries(files)) assert.equal(await readFile(path.join(source,name),'utf8'),value);
  const protectedEml = await readFile(path.join(result.output,'c-mail.eml'),'utf8');
  assert.equal(Buffer.from(protectedEml.split('\r\n\r\n')[1],'base64').toString(),output);
  const longMail = await readFile(path.join(result.output, 'f-long-mail.eml'), 'utf8');
  const longBody = Buffer.from(longMail.split('\r\n\r\n')[1], 'base64').toString();
  assert.ok(longBody.endsWith(`${rows.get('Robert Miller')} visited ${rows.get('Emily Davis')}.`));
  assert.equal(longMail.split('\r\n\r\n')[0], files['f-long-mail.eml'].split('\r\n\r\n')[0]);
  const expectedHtml = html.replace('>Alice Reed<', `>${rows.get('Alice Reed')}<`).replace('alice.reed@acme.com', contact.email);
  assert.equal(await readFile(path.join(result.output, 'i-body.html'), 'utf8'), expectedHtml);
  assert.equal(JSON.parse(await readFile(path.join(result.output, 'k-html.json'), 'utf8')).content_html, expectedHtml);
  const htmlMail = await readFile(path.join(result.output, 'j-html-mail.eml'), 'utf8');
  assert.equal(Buffer.from(htmlMail.split('\r\n\r\n')[1], 'base64').toString(), expectedHtml);
  assert.equal(await readFile(path.join(result.output, 'g-contacts.csv'), 'utf8'), `full_name,email\r\n"${rows.get('Alice Reed')}",${contact.email}\r\n`);
  assert.equal(await readFile(path.join(result.output, 'h-contact.xml'), 'utf8'), `<Alice><full_name>${rows.get('Alice Reed')}</full_name><email>${contact.email}</email></Alice>`);
  console.log(`Real model (${result.detection.backendLabel}): format-preserving JSON, CSV, XML, HTML, MIME, oversized tokens, correlated identities, offline operation and source preservation passed (${Math.round(performance.now()-start)} ms).`);
  const before = (await readdir(temporary)).sort(); const controller = new AbortController();
  await assert.rejects(protectExport({source,categories,modelDirectory:cache,preference,signal:controller.signal,progress:event=>{if(event.phase==='Scanning' && event.values)controller.abort(Error('Test abort'));}}),/Test abort/);
  assert.deepEqual((await readdir(temporary)).sort(),before);
  console.log('Real model worker abort: stopped without publishing an incomplete copy.');
} finally { globalThis.fetch = originalFetch; await rm(temporary,{recursive:true,force:true}); }
