import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
async function run(outcome) {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('async function protect('), source.indexOf('// Finish evaluating'));
  const state = { downloadResult: { output: '/original', saved: 3, status: 'partial' }, protectionResult: { output: '/old-copy' } }, calls = [];
  const context = vm.createContext({ state, process: { env: {} }, path: { join: (...parts) => parts.join('/') }, app: { getPath: () => '/app-data' },
    begin: () => { state.busy = true; return new AbortController().signal; }, end: () => { state.busy = false; },
    log() {}, progress() {}, protectExport: async args => {
      calls.push(args); args.progress({ phase: 'Copying', percent: 60, files: 1, totalFiles: 2, values: 4 });
      if (outcome === 'fail') throw Error('Protection failed');
      return { source: args.source, output: '/new-copy', mapping: '/new-copy.mapping.json', categories: args.categories, status: outcome, files: 2, values: 4, replacements: 8, reviewItems: outcome === 'partial' ? 1 : 0 };
    }
  });
  vm.runInContext(handler, context);
  let error;
  try { await vm.runInContext("protect({categories:['emails']})", context); } catch (e) { error = e; }
  return { state, calls, error };
}
for (const status of ['finished', 'partial']) test(`Protection IPC routes ${status} copies to export while retaining original download`, async () => {
  const { state, calls, error } = await run(status);
  assert.equal(error, undefined); assert.equal(calls[0].source, '/original');
  assert.equal(state.downloadResult.output, '/original'); assert.equal(state.output, '/new-copy');
  assert.equal(state.protectionResult.mapping, '/new-copy.mapping.json'); assert.equal(state.busy, false);
});
test('Protection failure clears the previous result and restores idle state', async () => {
  const { state, error } = await run('fail');
  assert.match(error.message, /failed/); assert.equal(state.busy, false);
  assert.equal(state.protectionResult, null); assert.equal(state.protection.phase, 'Failed');
});
