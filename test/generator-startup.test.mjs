import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import vm from 'node:vm';
import path from 'node:path';

// Run the actual worker with native I/O fixtures. b11658 emits LLAMA_LOG_INFO
// allocation records only at verbosity 4 (common_log_get_verbosity in log.cpp).
async function startup({ gpu = 'metal', stream = 'stderr', allocation = 'offloaded 29/29 layers to GPU\n' } = {}) {
  const source = (await readFile(new URL('../src/protection/generator-worker.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  const messages = [], process = new EventEmitter(), server = new EventEmitter();
  Object.assign(process, { env: {}, platform: 'darwin', connected: true, send: value => messages.push(value) });
  Object.assign(server, { pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => server.emit('close') });
  let args;
  const context = vm.createContext({ process, path, randomBytes, Buffer, AbortSignal,
    os: { availableParallelism: () => 4 },
    mkdtemp: async () => '/private/cache/session', writeFile: async () => {}, rm: async () => {}, readdir: async () => [],
    createServer: () => Object.assign(new EventEmitter(), { listen(_port, _host, done) { done(); }, address: () => ({ port: 12345 }), close: done => done() }),
    spawn: (_executable, passedArgs) => {
      args = passedArgs;
      queueMicrotask(() => {
        if (Number(args[args.indexOf('--log-verbosity') + 1]) >= 4) {
          server[stream].emit('data', Buffer.from(allocation.slice(0, 12)));
          server[stream].emit('data', Buffer.from(allocation.slice(12)));
        }
      });
      return server;
    },
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }),
    delay: async () => {},
  });
  vm.runInContext(source, context);
  await process.listeners('message')[0]({ init: { executable: '/runtime/llama-server', model: '/cache/model.gguf', root: '/private/cache', runtimeDirectory: '/runtime', target: { gpu } } });
  return { messages, args, server, context };
}
for (const stream of ['stderr', 'stdout']) test(`GPU startup verifies b11658 allocation on ${stream}, including split chunks`, async () => {
  const run = await startup({ stream });
  assert.equal(run.messages.find(m => m.error)?.error, undefined);
  assert.equal(run.messages.find(m => m.info)?.info.gpuLayers, 29);
  assert.equal(run.messages.find(m => m.info)?.info.backend, 'metal');
  const before = run.messages.length;
  run.server[stream].emit('data', Buffer.from('private inference text'));
  assert.equal(run.messages.length, before);
  assert.ok(!JSON.stringify(run.messages).includes('private inference text'));
});
for (const allocation of ['', 'offloaded 0/29 layers to GPU\n']) test(`GPU startup refuses missing or zero offload evidence: ${JSON.stringify(allocation)}`, async () => {
  const run = await startup({ allocation });
  assert.match(run.messages.find(m => m.error)?.error || '', /GPU allocation/);
  assert.equal(run.messages.some(m => m.info), false);
});
test('Explicit CPU startup needs no GPU allocation evidence', async () => {
  const run = await startup({ gpu: 'cpu', allocation: '' });
  assert.equal(run.messages.find(m => m.info)?.info.backend, 'cpu');
  assert.equal(run.args[run.args.indexOf('--gpu-layers') + 1], '0');
  assert.equal(run.args[run.args.indexOf('--device') + 1], 'none');
  assert.ok(run.args.includes('--no-kv-offload'));
  assert.ok(run.args.includes('--no-op-offload'));
});
