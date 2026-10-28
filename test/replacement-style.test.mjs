import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createDetector } from '../src/protection/detect.mjs';
import { createLocalProposer } from '../src/protection/local-proposer.mjs';
import { createReplacements } from '../src/protection/replacements.mjs';
import { replacementGrammar } from '../src/protection/replacement-grammar.mjs';
import { jsonText } from '../src/protection/formats.mjs';
import { protectExport } from '../src/protection/index.mjs';
import { protectionMatches } from '../ui/protection-options.mjs';

const mapped = (d, source) => d.entries.get(source).replacement;
test('Known spelling styles, native scripts, name punctuation and independent fields remain consistent', async () => {
  for (const [source, script] of [['יעל כהן', /\p{Script=Hebrew}/u], ['Юрий Иванов', /\p{Script=Cyrillic}/u], ['عمر منصور', /\p{Script=Arabic}/u]]) {
    const d = createDetector(['names']);
    d.add(source, 'names'); d.add(source.split(' ')[0], 'names'); await d.prepare(); d.compile();
    assert.match(mapped(d, source), script); assert.equal(mapped(d, source).split(' ')[0], mapped(d, source.split(' ')[0]));
  }
  const d = createDetector(['names'], { namePreference: 'es' });
  d.add('Dr. Aranda-Gomez', 'names'); await d.prepare(); d.compile();
  assert.match(mapped(d, 'Dr. Aranda-Gomez'), /^Dr\. \p{L}+-\p{L}+$/u);
});
test('Phone country/area codes, separators and extensions remain in place', () => {
  const g = createReplacements();
  for (const [original, shape] of [
    ['+972 54-123-4567', /^\+972 54-\d{3}-\d{4}$/], ['+1 (202) 555-0198', /^\+1 \(202\) \d{3}-\d{4}$/],
    ['0044 20 7123 4567', /^0044 \d{2} \d{4} \d{4}$/], ['050-123-4567 ext. 42', /^050-\d{3}-\d{4} ext\. \d{2}$/],
  ]) { const value = g.generate('phones', original); assert.match(value, shape); assert.notEqual(value, original); assert.equal(g.generate('phones', original), value); }
  for (let i = 0; i < 100; i++) assert.match(createReplacements().generate('phones', '1234567890'), /^[1-9]\d{9}$/);
});
test('Public providers stay exact; custom domains change consistently and names link to email conventions', async () => {
  const d = createDetector(['names', 'emails']);
  d.add('Alice Reed', 'names');
  for (const mail of ['alice.reed+notes17@gmail.com', 'areed@outlook.com', 'alice@acme.com', 'sales@acme.com', 'alice@mail.gmail.com.evil.test']) d.add(mail, 'emails');
  await d.prepare(); d.compile();
  const [first, last] = mapped(d, 'Alice Reed').toLowerCase().split(' ');
  assert.ok(mapped(d, 'alice.reed+notes17@gmail.com').startsWith(`${first}.${last}+`));
  assert.ok(mapped(d, 'alice.reed+notes17@gmail.com').endsWith('@gmail.com'));
  assert.equal(mapped(d, 'areed@outlook.com'), `${first[0]}${last}@outlook.com`);
  assert.equal(mapped(d, 'alice@acme.com').split('@')[1], mapped(d, 'sales@acme.com').split('@')[1]);
  assert.match(mapped(d, 'sales@acme.com'), /^sales@[a-z]+\.com$/);
  assert.ok(!mapped(d, 'alice@mail.gmail.com.evil.test').endsWith('evil.test'));
});
test('Company brand shape, acronym length, suffixes and field routing are preserved', async () => {
  for (const company of ['BrightWave Labs Ltd.', 'ACME Technologies GmbH', 'Cedar & River LLC']) {
    const d = createDetector(['companies']); const source = JSON.stringify({ company_name: company, count: 20 });
    jsonText(source, d, 'discover', 'data'); await d.prepare(); d.compile();
    const result = JSON.parse(jsonText(source, d, 'replace', 'data'));
    assert.notEqual(result.company_name, company); assert.equal(result.count, 20);
    if (company.startsWith('Bright')) assert.match(result.company_name, /^[A-Z][a-z]+[A-Z][a-z]+ Labs Ltd\.$/);
    if (company.startsWith('ACME')) assert.match(result.company_name, /^[A-Z]{4} Technologies GmbH$/);
    if (company.startsWith('Cedar')) assert.match(result.company_name, /^\p{L}+ & \p{L}+ LLC$/u);
  }
});
test('Model integration accepts unfamiliar synthetic spellings and retries invalid suggestions and preserve global name/email links', async () => {
  const d = createDetector(['names', 'emails', 'companies']);
  for (const name of ['Zorvani Melqueth', 'Zorvani', 'Melqueth']) d.add(name, 'names');
  d.add('zorvani.melqueth@gmail.com', 'emails'); d.add('Quorvex Labs Ltd.', 'companies');
  let calls = 0;
  const proposer = async ({ category, attempt }) => { calls++; if (!attempt) return ['Zorvani', 'Melqueth']; return category === 'names' ? ['Talvori', 'Renquath'] : ['Veltrion']; };
  await d.prepare({ proposer }); d.compile();
  assert.equal(mapped(d, 'Zorvani Melqueth'), 'Talvori Renquath');
  assert.equal(mapped(d, 'zorvani.melqueth@gmail.com'), 'talvori.renquath@gmail.com');
  assert.equal(mapped(d, 'Quorvex Labs Ltd.'), 'Veltrion Labs Ltd.');
  assert.equal(calls, 4); // Two entities, invalid then valid; components reuse the map.
});
test('Invalid model candidates use marked fallbacks without source reuse, script loss or broken identity links', async () => {
  for (const candidate of [['Alice', 'Reed'], ['<b>Nova</b>', 'Riven'], ['Nova', 'Nova'], ['נועם', 'לוי'], ['Nova']]) {
    const d = createDetector(['names']); d.add('Alice Reed', 'names');
    let calls = 0; const logs = [];
    await d.prepare({ proposer: async () => { calls++; return candidate; }, log: (...args) => logs.push(args) }); d.compile();
    assert.equal(calls, 3); assert.equal(d.generation.fallbackEntities, 1);
    assert.equal(d.entries.get('Alice Reed').generation, 'synthetic-fallback');
    assert.match(mapped(d, 'Alice Reed'), /^[A-Za-z]+ [A-Za-z]+$/);
    assert.ok(!mapped(d, 'Alice Reed').includes('Alice')); assert.ok(!mapped(d, 'Alice Reed').includes('Reed'));
    assert.ok(!JSON.stringify(logs).includes('Alice')); assert.ok(logs.some(([level]) => level === 'warn'));
  }
  const d = createDetector(['names']); d.add('Longfirstname Surname', 'names'); d.add('Longfirstname Other', 'names');
  let n = 0; await d.prepare({ proposer: async () => ++n === 1 ? ['Novafirstname', 'Riverton'] : ['Different', 'Valen'] }); d.compile();
  assert.equal(mapped(d, 'Longfirstname Other').split(' ')[0], 'Novafirstname');
  assert.equal(d.generation.fallbackEntities, 1);
});
test('Managed proposer prepares a private runtime and requests structured output without a preinstalled service', async () => {
  const calls = [];
  let closed = false;
  const proposer = await createLocalProposer({ directory: '/private/cache', ensure: async (directory, options) => { calls.push({ directory, options }); return { test: true }; }, start: async config => {
    assert.deepEqual(config, { test: true });
    return { info: { backend: 'cpu' }, close: async () => { closed = true; }, generate: async body => { calls.push({ body }); return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ replacements: ['Talvori','Renquath'] }) } }] }; } };
  } });
  assert.deepEqual(await proposer({ category: 'names', original: 'Zorvani Melqueth', tokens: ['Zorvani','Melqueth'], known: [null,null], namePreference: 'auto', attempt: 0 }), ['Talvori','Renquath']);
  assert.equal(calls[0].directory, '/private/cache');
  assert.match(calls[1].body.grammar, /root ::= /); assert.match(calls[1].body.grammar, /word1 ::=/);
  assert.equal(calls[1].body.cache_prompt, false); assert.equal(proposer.info.runtime, 'Managed llama.cpp');
  await proposer.close(); assert.equal(closed, true);
});
test('Failed runtime setup and cancelled requests cannot fall back to an external service', async () => {
  await assert.rejects(createLocalProposer({ ensure: async () => { throw Error('Integrity check failed'); }, start: async () => { throw Error('must not start'); } }), /Integrity/);
  const abort = new AbortController(); abort.abort(Error('cancelled'));
  await assert.rejects(createLocalProposer({ signal: abort.signal, ensure: async () => ({}), start: async () => { throw Error('must not start'); } }), /cancelled/);
});
test('Changing generator or spelling style invalidates the previous protected export', () => {
  const state = { downloadResult: { output: '/source' }, protectionResult: { source: '/source', status: 'finished', categories: ['names'], generation: { mode: 'local-model', namePreference: 'es' } } };
  assert.ok(protectionMatches(state, ['names'], { generationMode: 'local-model', namePreference: 'es' }));
  assert.ok(!protectionMatches(state, ['names'], { generationMode: 'pools', namePreference: 'es' }));
  assert.ok(!protectionMatches(state, ['names'], { generationMode: 'local-model', namePreference: 'fr' }));
});
test('Real file pipeline preserves original/schema and records the model generation mode', async t => {
  const parent = await mkdtemp('/tmp/agentsim-style-'); t.after(() => rm(parent, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises'); const source = parent + '/input'; await mkdir(source);
  const input = '{ "full_name":"Zorvani Melqueth", "company":"Quorvex Labs Ltd.", "email":"zorvani.melqueth@gmail.com", "phone":"+972 54-123-4567", "count":42 }\n';
  await writeFile(source + '/data.json', input);
  const proposer = async ({ category }) => category === 'names' ? ['Talvori', 'Renquath'] : ['Veltrion'];
  const result = await protectExport({ source, categories: ['names','companies','emails','phones'], generationMode: 'local-model', proposer });
  assert.equal(await readFile(source + '/data.json', 'utf8'), input);
  const out = JSON.parse(await readFile(result.output + '/data.json', 'utf8'));
  assert.equal(out.full_name, 'Talvori Renquath'); assert.equal(out.email, 'talvori.renquath@gmail.com'); assert.equal(out.count, 42);
  assert.equal(result.generation.mode, 'local-model'); assert.equal(result.generation.modelEntities, 2);
  const fallback = await protectExport({ source, categories: ['names'], generationMode: 'local-model', proposer: async () => ['Zorvani', 'Melqueth'] });
  assert.equal(fallback.status, 'partial'); assert.equal(fallback.generation.fallbackEntities, 1);
  const fallbackData = JSON.parse(await readFile(fallback.output + '/data.json', 'utf8'));
  assert.notEqual(fallbackData.full_name, 'Zorvani Melqueth'); assert.equal(fallbackData.count, 42);
  const map = JSON.parse(await readFile(fallback.mapping, 'utf8'));
  assert.equal(map.entries.find(row => row.original === 'Zorvani Melqueth').generation, 'synthetic-fallback');
  assert.equal(await readFile(source + '/data.json', 'utf8'), input);
});

test('Repeated name components are generated once and expanded consistently', async () => {
  let calls = 0;
  const proposer = await createLocalProposer({ ensure: async () => ({}), start: async () => ({ close: async () => {}, generate: async body => {
    calls++;
    const input = JSON.parse(body.messages[1].content.split('Input data: ')[1]);
    assert.deepEqual(input.tokens, ['Alice', 'Reed']);
    return { choices: [{ finish_reason: 'stop', message: { content: '{"replacements":["Nora","Brooks"]}' } }] };
  } }) });
  const d = createDetector(['names', 'emails']);
  d.add('Alice Alice Reed', 'names'); d.add('Alice Reed', 'names'); d.add('alice.reed@gmail.com', 'emails');
  await d.prepare({ proposer }); d.compile();
  assert.equal(calls, 1); assert.equal(mapped(d, 'Alice Alice Reed'), 'Nora Nora Brooks');
  assert.equal(mapped(d, 'alice.reed@gmail.com'), 'nora.brooks@gmail.com');
  assert.equal(d.generation.fallbackEntities, 0);
});

test('Long names use bounded model requests and preserve known components', async () => {
  const tokens = Array.from({ length: 30 }, (_, i) => 'Surname' + String.fromCharCode(65 + Math.floor(i / 26), 65 + i % 26));
  const calls = [];
  const proposer = await createLocalProposer({ ensure: async () => ({}), start: async () => ({ close: async () => {}, generate: async body => {
    const input = JSON.parse(body.messages[1].content.split('Input data: ')[1]); calls.push(input);
    assert.ok(input.tokens.length <= 6); assert.ok(input.tokens.join('').length <= 96); assert.ok(body.max_tokens <= 1024);
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ replacements: input.tokens.map((_, i) => input.known[i] || 'Novel' + String.fromCharCode(65 + i)) }) } }] };
  } }) });
  const result = await proposer({ category: 'names', original: tokens.join(' '), tokens, known: tokens.map((_, i) => i ? null : 'Existing'), namePreference: 'auto' });
  assert.equal(result.length, 30); assert.equal(result[0], 'Existing'); assert.equal(calls.length, 5);
});

test('Runtime failures and aborts still stop protection instead of generating fallback exports', async t => {
  const parent = await mkdtemp('/tmp/agentsim-runtime-failure-'); t.after(() => rm(parent, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises'); const source = parent + '/input'; await mkdir(source);
  await writeFile(source + '/data.json', '{"full_name":"Alice Reed"}');
  await assert.rejects(protectExport({ source, categories: ['names'], generationMode: 'local-model', proposer: async () => { throw Error('Runtime failed'); } }), /Runtime failed/);
  assert.deepEqual(await readdir(parent), ['input']);
  const controller = new AbortController();
  await assert.rejects(protectExport({ source, categories: ['names'], generationMode: 'local-model', signal: controller.signal, proposer: async () => { controller.abort(Error('Stopped')); return null; } }), /Stopped/);
  assert.deepEqual(await readdir(parent), ['input']);
});

test('Grammar restricts initials and company acronyms and excludes nonletter Unicode symbols', () => {
  const acronym = replacementGrammar(['ACME'], [null], 'companies');
  assert.match(acronym, /letter0\{3,3\}/);
  const initial = replacementGrammar(['A'], [null]);
  assert.ok(!initial.split('\n').find(line => line.startsWith('word0')).includes('letter0'));
  const grammar = replacementGrammar(['Alice'], [null]);
  const alphabet = grammar.split('\n').find(line => line.startsWith('letter0 ::= ')).slice('letter0 ::= '.length);
  const allowed = new RegExp('^' + alphabet + '$', 'u');
  assert.equal(allowed.test('é'), true); assert.equal(allowed.test('×'), false); assert.equal(allowed.test('÷'), false);
});

test('Retries receive rejection reasons without disclosing entity text in logs', async () => {
  const d = createDetector(['names']); d.add('Alice Reed', 'names');
  const reasons = [];
  await d.prepare({ proposer: async ({ rejection, attempt }) => { reasons.push(rejection); return attempt ? ['Nora', 'Brooks'] : ['Alice', 'Reed']; } }); d.compile();
  assert.deepEqual(reasons, [undefined, 'source_value_reused']);
  assert.equal(d.generation.fallbackEntities, 0);
});
