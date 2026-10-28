import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;
export function secretMatches(a, b) {
  return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw Error('Body too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
export async function createBridge({ port = 4319, pairing, approve, savePairing = async () => {}, onEvent = () => {} }) {
  const queue = [], pending = new Map();
  let waiter, pairingNow = false, lastSeen = 0;
  const send = (res, code, data) => {
    if (!res.writableEnded && !res.destroyed) {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    }
  };
  const dispatch = () => {
    if (!waiter || !queue.length) return;
    const res = waiter; waiter = null; send(res, 200, queue.shift());
  };
  const server = http.createServer(async (req, res) => {
    try {
      const origin = req.headers['x-extension-origin'];
      const actualPort = server.address().port;
      if (req.headers.host !== `127.0.0.1:${actualPort}` || !extensionOrigin.test(origin || '') || (req.headers.origin && req.headers.origin !== origin)) return send(res, 403, { error: 'Forbidden' });
      if (req.url === '/pair' && req.method === 'POST') {
        if (pairingNow) return send(res, 409, { error: 'Pairing already pending' });
        pairingNow = true;
        onEvent('info', 'extension', 'Pairing requested. Waiting for desktop approval.');
        try {
          if (!await approve(origin)) { onEvent('warn', 'extension', 'Pairing declined.'); return send(res, 403, { error: 'Pairing declined' }); }
          const next = { origin, token: randomBytes(32).toString('hex') };
          await savePairing(next); pairing = next;
          onEvent('info', 'extension', 'Pairing approved.');
          for (const p of [...pending.values()]) p.reject(Error('Browser paired again. Retry connection.'));
          send(res, 200, { token: pairing.token });
        } finally { pairingNow = false; }
        return;
      }
      if (!pairing || origin !== pairing.origin || !secretMatches(req.headers.authorization, `Bearer ${pairing.token}`)) return send(res, 401, { error: 'Pair the extension first' });
      lastSeen = Date.now();
      if (req.url === '/status' && req.method === 'GET') return send(res, 200, { ok: true });
      if (req.url === '/next' && req.method === 'GET') {
        if (waiter) send(waiter, 200, {});
        waiter = res;
        const timeout = setTimeout(() => { if (waiter === res) waiter = null; send(res, 200, {}); }, 20000);
        res.on('close', () => { clearTimeout(timeout); if (waiter === res) waiter = null; });
        dispatch(); return;
      }
      if (req.url === '/diagnostic' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.source === 'hubspot' && Array.isArray(body.messages)) {
          for (const message of body.messages.slice(0, 16)) {
            if (typeof message === 'string') onEvent('info', 'hubspot', message.slice(0, 500));
          }
        } else onEvent('warn', 'extension', `Recovered bridge error: ${String(body.message).slice(0, 300)}`);
        return send(res, 200, { ok: true });
      }
      if (req.url === '/result' && req.method === 'POST') {
        const body = await readBody(req), p = pending.get(body.id);
        if (p && body.error) onEvent('error', 'extension', `${p.label}: ${body.error}`);
        if (p) body.error ? p.reject(Object.assign(Error(String(body.error).slice(0, 300)), { code: typeof body.code === 'string' ? body.code.slice(0, 40) : undefined })) : p.resolve(body.data);
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: 'Not found' });
    } catch { send(res, 400, { error: 'Invalid bridge request' }); }
  });
  server.requestTimeout = 65000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    port: server.address().port,
    connected: () => Date.now() - lastSeen < 45000,
    ask(task, signal) {
      if (!pairing) return Promise.reject(Error('Install and pair the Chrome extension first.'));
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const finish = (fn, value) => {
          clearTimeout(timeout); signal?.removeEventListener('abort', abort); pending.delete(id);
          const index = queue.findIndex(t => t.id === id); if (index >= 0) queue.splice(index, 1);
          fn(value);
        };
        const abort = () => finish(reject, signal.reason);
        const timeout = setTimeout(() => {
          onEvent('error', 'extension', `${task.app}/${task.op}: command timed out.`);
          finish(reject, Error('Chrome did not respond. Open Chrome and check the extension pairing.'));
        }, 75000);
        pending.set(id, { label: `${task.app}/${task.op}`, resolve: v => finish(resolve, v), reject: e => finish(reject, e) });
        signal?.addEventListener('abort', abort, { once: true });
        queue.push({ ...task, id }); dispatch();
      });
    },
    close() {
      for (const p of [...pending.values()]) p.reject(Error('Collector closed.'));
      if (waiter) send(waiter, 200, {});
      server.closeAllConnections(); server.close();
    }
  };
}
