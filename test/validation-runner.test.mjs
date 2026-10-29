import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { aggregateReports } from '../scripts/benchmark/aggregate.mjs';

test('A failed benchmark still evaluates every suite and precision, and exits unsuccessfully', async () => {
  const source = (await readFile(new URL('../scripts/validate-protection.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  const calls = [], outputs = [];
  const process = { argv: ['node', 'validate'], env: {}, execPath: 'node', exit: () => { throw Error('Unexpected early exit'); } };
  const run = new (async () => {}).constructor('readdir', 'access', 'readFile', 'writeFile', 'rm', 'spawnSync', 'aggregateReports', 'process', 'console', source);
  await run(
    async directory => directory === 'test' ? ['fixture.test.mjs'] : ['ground-truth.private.json', 'ground-truth.extra.private.json'],
    async () => {},
    async file => JSON.stringify({ dataset: file, datasetSha256: file, sourceRevision: 'fixture', signature: {}, results: [] }),
    async (file, data) => outputs.push([file, JSON.parse(data)]), async () => {},
    (_node, args) => { calls.push(args); return { status: args.includes('--dataset') && args.includes('uint8') ? 1 : 0 }; },
    aggregateReports, process, { log() {}, error() {} }
  );
  assert.equal(calls.filter(args => args[0] === 'scripts/benchmark-protection.mjs').length, 6);
  assert.equal(outputs.length, 2);
  assert.ok(outputs.every(([, report]) => report.suites.length === 3));
  assert.equal(process.exitCode, 1);
});
