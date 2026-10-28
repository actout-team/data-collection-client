// Serialized into the selected tab. Observe browser reads, never replay requests.
// No headers, cookies, storage tokens or request bodies leave this helper.
export function saasRead(op, config, expected) {
  const fail = (message, code = 'CAPTURE_FAILED') => ({ ok: false, error: message, code });
  const scope = () => config.scope ? location.pathname.match(new RegExp(config.scope))?.[1] || null : location.origin;
  const account = scope();
  if (!account || /\/(login|signin|sign-in)(\/|$)/i.test(location.pathname)) return fail('Open a signed-in app page, then reconnect.', 'LOGIN_REQUIRED');
  const origin = location.origin;
  let helper = window.__agentsimSaasCapture;
  if (op === 'identity' && !expected) {
    if (helper && helper.version !== config.version) return fail('Refresh the app tab to load the updated capture helper.');
    if (!helper) {
      const maxResponse = 512 * 1024, maxTotal = 8 * 1024 * 1024, maxRecords = 100;
      let active = false, nonce, startedAt, boundScope, boundOrigin, records = [], bytes = 0, skipped = 0, generation = 0;
      const secret = /authorization|cookie|password|passwd|secret|token|csrf|xsrf|credential|api.?key|session/i;
      function clean(value, depth = 0) {
        if (depth > 40) return '[depth limit]';
        if (typeof value === 'string') return value.replace(/Bearer\s+\S+/gi, '[redacted]').replace(/([?&](?:token|access_token|key|signature|sig|auth|code)=)[^&#\s]*/gi, '$1[redacted]');
        if (Array.isArray(value)) return value.map(v => clean(v, depth + 1));
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).filter(([key]) => !secret.test(key)).map(([key, v]) => [key, clean(v, depth + 1)]));
      }
      function eligible(url, method, body) {
        if (!active || Date.now() - startedAt > 15 * 60 * 1000 || location.origin !== boundOrigin || scope() !== boundScope) { active = false; return null; }
        try {
          const u = new URL(url, location.href);
          if (u.origin !== boundOrigin || u.username || u.password) return null;
          if (method === 'GET' && config.readPaths.some(pattern => new RegExp(pattern, 'i').test(u.pathname))) return u.pathname;
          // Observe only explicitly named read POSTs. Persisted GraphQL queries
          // without visible query text are deliberately excluded.
          if (method === 'POST' && config.readPosts?.includes(u.pathname)) return u.pathname;
          if (method === 'POST' && config.graphql === u.pathname && typeof body === 'string') {
            const query = JSON.parse(body).query;
            if (typeof query === 'string' && /^\s*query\b/.test(query) && !/\bmutation\b/.test(query)) return u.pathname;
          }
        } catch { /* Unknown request shape stays in the browser. */ }
        return null;
      }
      function save(path, text, ticket) {
        if (!active || ticket !== generation || location.origin !== boundOrigin || scope() !== boundScope) return;
        if (text.length > maxResponse || records.length >= maxRecords) { skipped++; return; }
        try {
          const data = clean(JSON.parse(text));
          const record = { path, capturedAt: new Date().toISOString(), data };
          const size = JSON.stringify(record).length;
          if (bytes + size > maxTotal) { skipped++; return; }
          bytes += size; records.push(record);
        } catch { skipped++; }
      }
      const originalFetch = window.fetch;
      window.fetch = function(input, init) {
        const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
        const method = String(init?.method || input?.method || 'GET').toUpperCase();
        const path = eligible(url, method, init?.body), ticket = generation;
        const pending = originalFetch.apply(this, arguments);
        if (path) pending.then(async response => {
          if (!response.ok || !/json/i.test(response.headers.get('content-type') || '')) return;
          // Bound memory before parsing, including responses without Content-Length.
          const clone = response.clone(), reader = clone.body?.getReader();
          if (!reader) return;
          let size = 0, chunks = [];
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > maxResponse) { skipped++; await reader.cancel(); return; }
              chunks.push(value);
            }
            const buffer = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
            save(path, new TextDecoder().decode(buffer), ticket);
          } finally { reader.releaseLock(); }
        }).catch(() => {});
        return pending;
      };
      const proto = window.XMLHttpRequest?.prototype;
      if (proto) {
        const open = proto.open, send = proto.send, requests = new WeakMap();
        proto.open = function(method, url) { requests.set(this, { method: String(method).toUpperCase(), url }); return open.apply(this, arguments); };
        proto.send = function(body) {
          const req = requests.get(this), path = req && eligible(req.url, req.method, body), ticket = generation;
          if (path) this.addEventListener('load', () => {
            if (this.status < 200 || this.status >= 300 || !/json/i.test(this.getResponseHeader('content-type') || '')) return;
            try { save(path, this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText, ticket); } catch { skipped++; }
          }, { once: true });
          return send.apply(this, arguments);
        };
      }
      helper = {
        version: config.version,
        start() { generation++; records = []; bytes = 0; skipped = 0; nonce = crypto.randomUUID(); startedAt = Date.now(); boundScope = scope(); boundOrigin = location.origin; active = true; },
        identity() { return { account: `${config.name}: selected tab (unverified account)`, origin: boundOrigin, scope: boundScope, nonce, mode: 'capture', authenticated: false }; },
        snapshot() { active = false; return { count: records.length, skipped, startedAt, stoppedAt: Date.now() }; },
        read(index) { return records[index]; },
        clear() { active = false; generation++; records = []; bytes = 0; }
      };
      Object.defineProperty(window, '__agentsimSaasCapture', { value: helper, configurable: true });
    }
    helper.start();
  }
  if (!helper) return fail('The page was refreshed. Reconnect, then browse the records again.');
  const identity = helper.identity();
  if (identity.origin !== origin || identity.scope !== account || (expected && (expected.nonce !== identity.nonce || expected.origin !== origin || expected.scope !== account))) return fail('The selected tab or capture session changed. Reconnect.', 'ACCOUNT_CHANGED');
  if (op === 'identity') return { ok: true, value: identity };
  if (!expected) return fail('Reconnect before reading a capture.');
  if (op === 'capture-snapshot') return { ok: true, value: helper.snapshot() };
  if (op === 'capture-clear') { helper.clear(); return { ok: true, value: {} }; }
  if (op === 'capture-record' && Number.isInteger(config.index) && config.index >= 0) {
    const value = helper.read(config.index);
    return value ? { ok: true, value } : fail('Capture record is unavailable. Reconnect.');
  }
  return fail('Unsupported capture operation.');
}
