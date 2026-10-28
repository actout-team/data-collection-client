import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createReplacements } from '../src/protection/replacements.mjs';
import { replacementGrammar } from '../src/protection/replacement-grammar.mjs';
import { protectExport } from '../src/protection/index.mjs';

// Evaluate the emitted word-rule subset instead of merely checking grammar text.
function wordPattern(grammar) {
  const rules = new Map(grammar.split('\n').map(line => line.split(' ::= ')));
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expand = name => {
    const body = rules.get(name); assert.equal(typeof body, 'string', `Missing rule ${name}`);
    const tokens = [...body.matchAll(/"(?:\\.|[^"\\])*"|\[(?:\\.|[^\]\\])*\]|[A-Za-z]\w*|\{\d+,\d+\}|[|*]/g)];
    let end = 0;
    const result = tokens.map(m => {
      assert.equal(body.slice(end, m.index).trim(), ''); end = m.index + m[0].length;
      const token = m[0];
      return token.startsWith('"') ? escape(JSON.parse(token)) : /^[A-Za-z]/.test(token) ? `(?:${expand(token)})` : token;
    }).join('');
    assert.equal(body.slice(end).trim(), ''); return result;
  };
  return new RegExp(`^(?:${expand('word0')})$`, 'u');
}

test('Decoding rejects original prefixes/extensions before model sampling', () => {
  for (const [original, accepted, rejected] of [
    ['Alice', ['Amira', 'Alina', 'Nora'], ['Alice', 'ALICE', 'Alicex', 'Aliceva', 'Alic', 'Ali']],
    ['Marelux', ['Veltora', 'Mariona'], ['Marelux', 'MARELUX', 'Mareluxa', 'Marel', 'Mare']],
    ['יעל', ['מיכל', 'יפה'], ['יעל', 'יעלה']],
  ]) {
    const pattern = wordPattern(replacementGrammar([original], [null]));
    for (const value of accepted) assert.ok(pattern.test(JSON.stringify(value)), value);
    for (const value of rejected) assert.ok(!pattern.test(JSON.stringify(value)), value);
  }
  const shortlist = wordPattern(replacementGrammar(['Anna'], [null], 'names', [['Ann', 'Annabelle', 'Nora']]));
  assert.ok(shortlist.test('"Nora"')); assert.ok(!shortlist.test('"Ann"')); assert.ok(!shortlist.test('"Annabelle"'));
  assert.ok(wordPattern(replacementGrammar(['Marelux'], ['Veltora'], 'companies')).test('"Veltora"'));
});

test('Company fallback completes 1,200 companies after every model proposal fails', async () => {
  const generator = createReplacements();
  const suffix = i => String.fromCharCode(97 + Math.floor(i / 676), 97 + Math.floor(i / 26) % 26, 97 + i % 26);
  const rows = Array.from({ length: 1200 }, (_, i) => ({ category: 'companies', original: `Quar${suffix(i)} & Vel${suffix(i)} Labs LLC` }));
  const originals = new Set(rows.flatMap(r => [r.original, ...r.original.split(/[^A-Za-z]+/)]).map(v => v.toLowerCase()));
  let calls = 0;
  await generator.prepare(rows, { proposer: async ({ tokens }) => { calls++; return tokens.map(t => t + 'a'); } });
  assert.equal(calls, 3600); assert.equal(generator.info.fallbackEntities, 1200);
  const used = new Set();
  for (const row of rows) {
    assert.equal(row.generation, 'synthetic-fallback');
    const result = generator.generate('companies', row.original);
    assert.match(result, /^[A-Z][a-z]+ & [A-Z][a-z]+ Labs LLC$/);
    const tokens = result.split(' & ').flatMap(v => v.split(' Labs LLC')[0]);
    for (const token of tokens) {
      assert.ok(!originals.has(token.toLowerCase())); assert.ok(!used.has(token.toLowerCase())); used.add(token.toLowerCase());
      for (const source of row.original.match(/[A-Za-z]+/g).slice(0, 2)) assert.ok(!token.toLowerCase().includes(source.toLowerCase()));
    }
    assert.equal(generator.generate('companies', row.original), result);
  }
  assert.equal(used.size, 2400);
});

test('Repeated company components reuse accepted mappings and keep occurrence formatting', async () => {
  const generator = createReplacements(), requests = [];
  const rows = ['Quorvex Technologies LLC', 'Quorvex & Meravin LLC', 'Quorvex Labs', 'Quorvex Quorvex Ltd.'].map(original => ({ original, category: 'companies' }));
  await generator.prepare(rows, { proposer: async request => {
    requests.push(request);
    return request.tokens.map((t, i) => request.known[i] || ({ Quorvex: 'Veltora', Meravin: 'Solvani' }[t]));
  } });
  assert.equal(requests.length, 2); assert.equal(generator.info.fallbackEntities, 0);
  assert.deepEqual(requests[1].known, ['Veltora', null]);
  assert.equal(generator.generate('companies', 'Quorvex Quorvex Ltd.'), 'Veltora Veltora Ltd.');
  assert.equal(generator.generate('companies', 'QUORVEX\u00a0 Labs'), 'VELTORA\u00a0 Labs');
  assert.equal(generator.generate('companies', 'quorvex  Labs'), 'veltora  Labs');
});

test('Fallback name pools and model shortlists reject source-spelling substrings', async () => {
  for (let i = 0; i < 20; i++) {
    const generator = createReplacements({ namePreference: 'en' });
    const rows = ['Ann', 'Anna'].map(original => ({ original, category: 'names' }));
    await generator.prepare(rows, { proposer: async ({ suggestions, tokens }) => {
      for (const [index, options] of suggestions.entries()) for (const option of options) {
        const a = option.toLowerCase(), b = tokens[index].toLowerCase(); assert.ok(!a.includes(b) && !b.includes(a));
      }
      return tokens;
    } });
    for (const { original } of rows) {
      const result = generator.generate('names', original).toLowerCase();
      assert.ok(!result.includes(original.toLowerCase()) && !original.toLowerCase().includes(result));
    }
  }
});

test('Large fallback export publishes a reviewable copy with intact schema and originals', async t => {
  const parent = await mkdtemp('/tmp/collect-company-capacity-'); t.after(() => rm(parent, { recursive: true, force: true }));
  const source = parent + '/input'; await mkdir(source);
  const rows = Array.from({ length: 300 }, (_, i) => ({ company: 'Quar' + String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26) + ' Labs LLC', count: i }));
  const input = JSON.stringify(rows, null, 2) + '\n'; await writeFile(source + '/records.json', input);
  const result = await protectExport({ source, categories: ['companies'], generationMode: 'local-model', proposer: async ({ tokens }) => tokens });
  assert.equal(result.status, 'partial'); assert.equal(result.generation.fallbackEntities, 300);
  assert.equal(await readFile(source + '/records.json', 'utf8'), input);
  const output = JSON.parse(await readFile(result.output + '/records.json', 'utf8'));
  assert.equal(output.length, rows.length); assert.equal(new Set(output.map(r => r.company)).size, rows.length);
  output.forEach((row, i) => { assert.deepEqual(Object.keys(row), ['company', 'count']); assert.equal(row.count, i); assert.notEqual(row.company, rows[i].company); assert.match(row.company, / Labs LLC$/); });
});
