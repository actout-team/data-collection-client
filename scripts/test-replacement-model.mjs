import assert from 'node:assert/strict';
import { createLocalProposer } from '../src/protection/local-proposer.mjs';
import { startGeneratorProcess } from '../src/protection/generator-process.mjs';
import { createDetector } from '../src/protection/detect.mjs';
import path from 'node:path';
import os from 'node:os';
const directory = process.env.AGENTSIM_TEST_REPLACEMENT_CACHE || path.join(os.tmpdir(), 'agentsim-replacement-model');
const proposer = await createLocalProposer({ directory, start: async (config, options) => { const runtime = await startGeneratorProcess(config, options); if (process.env.AGENTSIM_TEST_TRACE === '1') { const generate = runtime.generate; runtime.generate = async body => { const result = await generate(body); console.log('Synthetic-test response:', JSON.stringify(result)); return result; }; } return runtime; }, preference: process.env.AGENTSIM_REPLACEMENT_BACKEND || 'auto', log: (level, message) => console.log(level, message), progress: e => { if (!e.phase.includes('MB')) console.log(e.phase); } });
try {
  console.log(JSON.stringify(proposer.info));
  const detector = createDetector(['names','companies','emails']);
  for (const original of ['Alice Reed','יעל כהן','Zorvani Melqueth']) detector.add(original,'names');
  detector.add('BrightWave Labs Ltd.','companies');
  detector.add('alice.reed@gmail.com','emails');
  await detector.prepare({ proposer }); detector.compile();
  const entries = [...detector.entries.values()];
  for (const row of entries) { assert.notEqual(row.original,row.replacement); console.log(row.category,JSON.stringify(row.original),'->',JSON.stringify(row.replacement)); }
  const name=detector.entries.get('Alice Reed').replacement.toLowerCase().replace(' ','.');
  assert.equal(detector.entries.get('alice.reed@gmail.com').replacement, name+'@gmail.com');
  assert.match(detector.entries.get('יעל כהן').replacement,/^\p{Script=Hebrew}+ \p{Script=Hebrew}+$/u);
  assert.match(detector.entries.get('BrightWave Labs Ltd.').replacement,/ Labs Ltd\.$/);
  console.log('Real model generation, validation and correlated email checks passed.');
} finally { await proposer.close(); }
