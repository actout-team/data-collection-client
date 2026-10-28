import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { modelError } from './diagnostics.mjs';
export async function startModelWorker({ directory, categories, preference, modelFile, signal, log = () => {}, workerURL = new URL('./model-worker.mjs', import.meta.url) }) {
  signal?.throwIfAborted();
  const profileRoot = await mkdtemp(path.join(tmpdir(), 'agentsim-model-'));
  // Native GPU errors can abort a process. Keep them outside Electron's main process.
  const worker = fork(workerURL, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let pending, stopped, closing = false, backend, acceleration, stderr = '';
  const exited = new Promise(resolve => worker.once('close', resolve));
  worker.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
  function settle(error, result) {
    if (!pending) return;
    clearTimeout(pending.timer);
    error ? pending.reject(error) : pending.resolve(result); pending = null;
  }
  function fail(error) { stopped = error; settle(error); }
  function wait(message) {
    if (stopped) return Promise.reject(stopped);
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      pending = { resolve, reject, timer: setTimeout(() => { fail(Error('Local model timed out after 120 seconds.')); worker.kill('SIGKILL'); }, 120000) };
      try { if (message) worker.send(message, error => { if (error) fail(error); }); } catch (error) { fail(error); }
    });
  }
  const abort = () => { fail(signal.reason || Error('Aborted')); worker.kill('SIGKILL'); };
  worker.on('error', error => fail(Error(modelError(error, 'Model worker'))));
  worker.on('close', (code, exitSignal) => {
    if (closing) settle(null, { closed: true });
    else if (!stopped) {
      const detail = /No supported adapters/.test(stderr) ? 'Failed to get a WebGPU adapter: No supported adapters.' : stderr.trim();
      fail(Error(modelError(Error(`Model worker exited with ${exitSignal ? `signal ${exitSignal}` : `code ${code}`}. ${detail}`), 'Model process')));
    }
  });
  worker.on('message', message => {
    if (message.log) { log(message.log.level, message.log.message); return; }
    if (message.backend) backend = message.backend;
    if (message.acceleration) acceleration = message.acceleration;
    settle(message.error ? Error(message.error) : null, message);
  });
  signal?.addEventListener('abort', abort, { once: true });
  const close = async () => {
    if (closing) return;
    closing = true; signal?.removeEventListener('abort', abort);
    if (!stopped && !signal?.aborted) await wait({ close: true }).catch(() => {});
    worker.kill('SIGKILL'); await exited;
    await rm(profileRoot, { recursive: true, force: true });
  };
  try { await wait({ init: { directory, categories, preference, modelFile, profileRoot } }); }
  catch (error) { stopped = error; await close(); throw error; }
  return { get backend() { return backend; }, get acceleration() { return acceleration; }, async detect(text) { return (await wait({ text })).spans; }, close };
}
