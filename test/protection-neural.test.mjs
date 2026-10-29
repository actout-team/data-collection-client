import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetector } from '../src/protection/detect.mjs';
import { textWindows } from '../src/protection/neural.mjs';
import { ensureModel } from '../src/protection/model-cache.mjs';
import { MODEL } from '../src/protection/model-config.mjs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { jsonText } from '../src/protection/formats.mjs';
const all = ['names','emails','phones','addresses','secrets','identifiers'];
test('Full names, component fields and email conventions stay correlated regardless of discovery order', () => {
  const d = createDetector(all);
  for (const value of ['alice.reed@example.com','alicereed@example.com','areed@example.com']) d.add(value, 'emails');
  d.add('Alice', 'names'); d.add('Reed', 'names'); d.add('Alice Reed', 'names'); d.compile();
  const mapped = v => d.entries.get(v).replacement;
  const first = mapped('Alice'), last = mapped('Reed');
  assert.equal(mapped('Alice Reed'), `${first} ${last}`);
  assert.equal(mapped('alice.reed@example.com').split('@')[0], `${first}.${last}`.toLowerCase());
  assert.equal(mapped('alicereed@example.com').split('@')[0], `${first}${last}`.toLowerCase());
  assert.equal(mapped('areed@example.com').split('@')[0], `${first[0]}${last}`.toLowerCase());
  assert.equal(new Set([...d.entries.values()].filter(x=>x.category==='emails').map(x=>x.replacement.split('@')[1])).size,1);
});
test('Generated values preserve name case, separators, address components and credential shape', () => {
  const d = createDetector(all);
  for (const n of ['Alice Reed', 'ALICE REED', 'alice reed']) d.add(n,'names');
  for (const a of ['45 Maple Road', '45 Maple Road, Boston, MA 02110']) d.add(a,'addresses');
  d.add('Ab9!Cde#123','secrets'); d.compile();
  const m = v=>d.entries.get(v).replacement;
  assert.equal(m('ALICE REED'), m('Alice Reed').toUpperCase()); assert.equal(m('alice reed'),m('Alice Reed').toLowerCase());
  assert.ok(m('45 Maple Road, Boston, MA 02110').startsWith(m('45 Maple Road')+','));
  assert.match(m('Ab9!Cde#123'),/^[A-Z][a-z][0-9]![A-Z][a-z]{2}#[0-9]{3}$/);
  assert.notEqual(m('Ab9!Cde#123'),'Ab9!Cde#123');
});
test('Case aliases may share a replacement without failing uniqueness checks', () => {
  const d=createDetector(['names']);d.add('aLiCe','names');d.add('Alice','names');d.compile();
  assert.equal(d.entries.get('aLiCe').replacement,d.entries.get('Alice').replacement);
});
test('Every model window is bounded, overlaps its neighbors and includes the tail', () => {
  const text='A sentence about Alice Reed. '.repeat(700)+'FINAL PERSON';
  const chunks=[...textWindows(text)];assert.ok(chunks.length>5);assert.ok(chunks.every(x=>x.length<=2400));
  assert.ok(chunks.at(-1).endsWith('FINAL PERSON'));
  for(let i=1;i<chunks.length;i++) assert.ok(chunks[i-1].includes(chunks[i].slice(0,100)));
  assert.deepEqual([...textWindows('4111 1111 1111 1111')], ['4111 1111 1111 1111']);
  assert.deepEqual([...textWindows('A literal <value> in parsed text')], ['A literal <value> in parsed text']);
});
test('Model downloads are fixed public assets; invalid bytes fail integrity and clean partial files', async t => {
  const root=await mkdtemp('/tmp/actout-model-download-test-');t.after(()=>rm(root,{recursive:true,force:true}));
  const requests=[];
  await assert.rejects(ensureModel(root,{fetchModel:async url=>{requests.push(url);return new Response('invalid model');}}),/integrity/);
  assert.deepEqual(requests,[`https://huggingface.co/${MODEL.id}/resolve/${MODEL.revision}/onnx/model_quint8.onnx`]);
  assert.deepEqual(await readdir(`${root}/${MODEL.revision}`),[]);
});
test('Aborted model setup makes no download request', async t => {
  const root=await mkdtemp('/tmp/actout-model-abort-test-');t.after(()=>rm(root,{recursive:true,force:true}));
  const c=new AbortController();c.abort(Error('stop'));
  await assert.rejects(ensureModel(root,{signal:c.signal,fetchModel:async()=>{throw Error('must not fetch');}}),/stop/);
});
test('Field and pattern detection still runs independently of the model and respects selected categories', () => {
  const d=createDetector(['secrets']);const text='{"text":"Her password is OrangeMoon99!","full_name":"Alice Reed"}';
  jsonText(text,d,'discover','data');d.compile();const output=jsonText(text,d,'replace','data');
  assert.ok(output.includes('Alice Reed'));assert.ok(!output.includes('OrangeMoon99!'));
});
test('Large contact sets avoid replacement collisions and do not require model inference', () => {
  const d=createDetector(['names','emails']);
  for(let i=0;i<400;i++) { const suffix=String.fromCharCode(97+Math.floor(i/26),97+i%26); d.add('Person'+suffix,'names');d.add('contact'+suffix+'@example.com','emails'); }
  d.compile();assert.equal(d.entries.size,800);assert.equal(new Set([...d.entries.values()].map(x=>x.replacement)).size,800);
});
test('Names that already occur in the input are not emitted as replacement identities', () => {
  const d=createDetector(['names']);for(const name of ['Alice','Alex','Avery','Bailey','Casey','Jordan','Reed','Morgan'])d.add(name,'names');
  d.compile(); for(const row of d.entries.values()) assert.ok(!d.entries.has(row.replacement));
});
test('Short detected names are replaced in prose without changing longer words', () => {
  const d=createDetector(['names']);d.add('Li','names');d.add('Jo','names');d.compile();
  assert.equal(d.replace('Li called Jo about Linux.'),`${d.entries.get('Li').replacement} called ${d.entries.get('Jo').replacement} about Linux.`);
});
