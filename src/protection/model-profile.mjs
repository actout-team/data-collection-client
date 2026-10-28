import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export function summarizeProfile(events) {
  let gpuKernels = 0, cpuKernels = 0, gpuMatrixKernels = 0, cpuMatrixKernels = 0;
  for (const event of events) {
    const provider = event.args?.provider;
    if (!provider || !event.name?.endsWith('_kernel_time')) continue;
    const gpu = /WebGpu|CUDA|Dml/i.test(provider), matrix = /MatMul|Gemm|Attention|Conv/i.test(event.args.op_name || '');
    if (gpu) { gpuKernels++; if (matrix) gpuMatrixKernels++; }
    else { cpuKernels++; if (matrix) cpuMatrixKernels++; }
  }
  return { verified: gpuMatrixKernels > 0, gpuKernels, cpuKernels, gpuMatrixKernels, cpuMatrixKernels };
}
export async function readProfile(directory) {
  const file = (await readdir(directory)).find(name => name.endsWith('.json'));
  if (!file) throw Error('GPU execution profile was not produced. Acceleration could not be verified.');
  return summarizeProfile(JSON.parse(await readFile(path.join(directory, file), 'utf8')));
}
