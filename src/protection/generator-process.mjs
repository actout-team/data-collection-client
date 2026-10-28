import { fork } from 'node:child_process';
export async function startGeneratorProcess(config, { signal, log = () => {}, workerURL = new URL('./generator-worker.mjs', import.meta.url) } = {}) {
  signal?.throwIfAborted();
  const child = fork(workerURL, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [], stdio: ['ignore','ignore','ignore','ipc'] });
  let pending, stopped, closing = false, nativePid;
  const exited = new Promise(resolve => child.once('close', resolve));
  const stopNative = () => { if (nativePid) { try { process.kill(nativePid, 'SIGKILL'); } catch {} nativePid = null; } };
  const stop = () => { stopNative(); child.kill('SIGKILL'); };
  process.once('exit', stop);
  function settle(error, value) { if (!pending) return; clearTimeout(pending.timer); error ? pending.reject(error) : pending.resolve(value); pending = null; }
  const abort = () => { stopped = signal.reason || Error('Aborted'); settle(stopped); stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  child.on('message', message => {
    if (message.nativePid) { nativePid = message.nativePid; return; }
    if (message.nativeExited) { nativePid = null; return; }
    if (message.log) { log('info', message.log); return; }
    settle(message.error ? Error(message.error) : null, message);
  });
  child.on('error', () => { stopped = Error('Could not start the managed replacement runtime.'); settle(stopped); });
  child.on('close', () => { if (!closing && !stopped) stopped = Error('Managed replacement runtime stopped unexpectedly.'); settle(stopped); stopNative(); });
  function request(message, timeout = 120000) {
    signal?.throwIfAborted(); if (stopped) return Promise.reject(stopped);
    if (pending) return Promise.reject(Error('Replacement requests must run sequentially.'));
    return new Promise((resolve, reject) => {
      pending = { resolve, reject, timer: setTimeout(() => { stopped = Error('Managed replacement runtime timed out. Retry protection.'); settle(stopped); stop(); }, timeout) };
      child.send(message, error => { if (error) settle(Error('Managed runtime connection closed.')); });
    });
  }
  const close = async () => {
    if (closing) return; closing = true; signal?.removeEventListener('abort', abort);
    if (!stopped && !signal?.aborted) await request({ close: true }, 5000).catch(() => {});
    stop(); await exited; process.removeListener('exit', stop);
  };
  try {
    const initialized = await request({ init: config }, 120000);
    return { info: initialized.info, generate: async body => (await request({ body })).result, close };
  } catch (error) { await close(); throw error; }
}
