import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetector } from '../src/protection/detect.mjs';
import { summarizeProfile } from '../src/protection/model-profile.mjs';
import { createBackend, preferredProvider } from '../src/protection/model-backend.mjs';
import { writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

test('Numeric names, structural address words and exhausted short-value pools get unique replacements', () => {
  const detector = createDetector(['names', 'addresses', 'secrets']);
  for (let i = 0; i < 5000; i++) detector.add(String(i), 'names');
  for (const word of ['Street','Road','Unit','Floor','North','--','!']) detector.add(word, 'addresses');
  for (const initial of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') detector.add(initial, 'names');
  detector.compile();
  const values = [...detector.entries.values()];
  assert.equal(new Set(values.map(v => v.replacement)).size, values.length);
  for (const row of values) assert.ok(!detector.entries.has(row.replacement));
  for (const row of values.slice(0, 5000)) assert.match(row.replacement, /^[1-9]\d*$/);
});
test('Large name/email maps retain identity correlation after the short name pool is exhausted', () => {
  const detector = createDetector(['names','emails']);
  for (let i = 0; i < 1200; i++) {
    const suffix = String.fromCharCode(97 + Math.floor(i / 676), 97 + Math.floor(i / 26) % 26, 97 + i % 26);
    detector.add(`Person${suffix} Surname${suffix}`, 'names');
    detector.add(`person${suffix}.surname${suffix}@example.com`, 'emails');
  }
  detector.compile();
  for (const row of detector.entries.values()) if (row.category === 'names') {
    const email = detector.entries.get(row.original.toLowerCase().replace(' ', '.') + '@example.com');
    assert.equal(email.replacement.split('@')[0], row.replacement.toLowerCase().replace(' ', '.'));
  }
});
test('A provider label or GPU shape operations cannot pass the acceleration check', () => {
  const event = (provider, op) => ({ name: 'test_kernel_time', args: { provider, op_name: op } });
  assert.equal(summarizeProfile([event('CPUExecutionProvider','MatMul'), event('WebGpuExecutionProvider','Shape')]).verified, false);
  const result = summarizeProfile([event('WebGpuExecutionProvider','MatMul'), event('CPUExecutionProvider','LSTM')]);
  assert.equal(result.verified, true); assert.equal(result.gpuMatrixKernels, 1); assert.equal(result.cpuKernels, 1);
  assert.equal(summarizeProfile([event('CUDAExecutionProvider','FusedMatMul')]).verified, true);
  assert.throws(() => preferredProvider('darwin',['cpu','webgpu'],'cuda'), /unavailable/);
});
test('GPU verification reads the actual startup profile and deletes it before user data runs', async () => {
  let options;
  const fake = { listSupportedBackends: () => [{name:'webgpu',bundled:true}], InferenceSession: {create: async (_file, supplied) => {
    options = supplied;
    return { endProfiling() {}, release() {}, run() {} };
  }} };
  const backend = await createBackend(fake, 'unused');
  const directory = path.dirname(options.profileFilePrefix);
  try {
    await writeFile(options.profileFilePrefix + '.json', JSON.stringify([{ name:'test_kernel_time', args:{provider:'WebGpuExecutionProvider',op_name:'MatMul'} }]));
    assert.equal((await backend.verify()).verified, true);
    await assert.rejects(readdir(directory), {code:'ENOENT'});
  } finally { await backend.close(); }
});
