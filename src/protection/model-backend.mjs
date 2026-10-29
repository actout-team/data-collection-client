import { availableParallelism, tmpdir } from 'node:os';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readProfile } from './model-profile.mjs';
export function preferredProvider(platform, available, preference = 'auto') {
  if (preference !== 'auto') {
    if (!['cpu', 'webgpu', 'cuda', 'dml'].includes(preference) || !available.includes(preference)) throw Error(`Requested model backend is unavailable: ${preference}.`);
    return preference;
  }
  const candidates = platform === 'darwin' ? ['webgpu'] : platform === 'win32' ? ['webgpu', 'dml'] : ['cuda', 'webgpu'];
  return candidates.find(name => available.includes(name)) || 'cpu';
}
export const backendLabel = (provider, platform = process.platform) => ({ webgpu: platform === 'darwin' ? 'Metal GPU' : platform === 'win32' ? 'DirectX GPU' : 'Vulkan GPU', cuda: 'NVIDIA GPU', dml: 'DirectML GPU', cpu: 'CPU' })[provider];
export async function createBackend(ort, modelPath, { preference = 'auto', log = () => {}, platform = process.platform, profileRoot = tmpdir() } = {}) {
  const available = ort.listSupportedBackends().filter(item => {
    if (item.name !== 'cuda' || item.bundled) return true;
    const root = path.dirname(path.dirname(createRequire(import.meta.url).resolve('onnxruntime-node')));
    return readdirSync(path.join(root, 'bin')).some(version => existsSync(path.join(root, 'bin', version, platform, process.arch, platform === 'win32' ? 'onnxruntime_providers_cuda.dll' : 'libonnxruntime_providers_cuda.so')));
  }).map(item => item.name);
  const provider = preferredProvider(platform, available, preference);
  log('info', `Installed backends: ${available.join(', ')}. Selected: ${backendLabel(provider)}.`);
  const profile = provider === 'cpu' ? null : await mkdtemp(path.join(profileRoot, 'actout-gpu-check-'));
  const options = name => ({
    executionProviders: name === 'cpu' ? ['cpu'] : [name === 'webgpu' ? { name } : { name, deviceId: 0 }, 'cpu'],
    intraOpNumThreads: Math.min(4, availableParallelism()), interOpNumThreads: 1,
    executionMode: 'sequential', enableMemPattern: name !== 'dml', graphOptimizationLevel: 'all', logSeverityLevel: 3,
    ...(profile ? { enableProfiling: true, profileFilePrefix: path.join(profile, 'startup') } : {})
  });
  let session;
  try { session = await ort.InferenceSession.create(modelPath, options(provider)); }
  catch (error) { if (profile) await rm(profile, { recursive: true, force: true }); throw error; }
  log('info', `Model session loaded: ${backendLabel(provider)}. Verifying execution with synthetic input.`);
  return {
    provider,
    run: feeds => session.run(feeds),
    async verify() {
      if (!profile) return { verified: false };
      session.endProfiling();
      try {
        const result = await readProfile(profile);
        if (!result.verified) throw Error('Model matrix operations did not execute on the GPU. Protection stopped.');
        log('info', `GPU execution verified: ${result.gpuMatrixKernels} matrix kernels on GPU, ${result.cpuMatrixKernels} on CPU (${result.gpuKernels} GPU / ${result.cpuKernels} CPU kernels total).`);
        return result;
      } finally { await rm(profile, { recursive: true, force: true }); }
    },
    async close() { try { await session.release(); } finally { if (profile) await rm(profile, { recursive: true, force: true }); } }
  };
}
