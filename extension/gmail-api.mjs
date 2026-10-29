// Protocol references: InboxSDK getSyncThreadsForSearch/getSyncThreadFromSyncThreadId
// and Gmail.js parse_fd_request_payload. No third-party code is bundled here.
const field = (node, number) => Array.isArray(node) ? node[number - 1] : node?.[number];
const threadId = value => typeof value === 'string' && /^thread-[af]:[A-Za-z0-9_-]{1,128}$/.test(value);
const messageId = value => typeof value === 'string' && /^msg-[af]:[A-Za-z0-9_-]{1,128}$/.test(value);
const kind = value => value === null ? 'null' : Array.isArray(value) ? `array(${value.length})` : typeof value;
const list = (value, name) => { if (!Array.isArray(value)) throw Error(`${name}: expected array, got ${kind(value)}`); return value; };
// Types and lengths only. Never include response values or arbitrary object keys.
function parseWithContext(raw, context, parse) {
  try { return parse(); }
  catch (error) {
    let shape = 'non-JSON';
    try {
      const root = JSON.parse(raw.replace(/^\s*\)\]\}'\s*\n?/, ''));
      shape = kind(root) + ' fields=' + Array.from({ length: 6 }, (_, i) => `${i + 1}:${kind(field(root, i + 1))}`).join(',');
    } catch {}
    throw Object.assign(Error(`Gmail ${context}: ${error.message}; chars=${raw.length}; root=${shape}`.slice(0, 300)), { code: 'GMAIL_FORMAT' });
  }
}
const text = value => typeof value === 'string' ? value : '';
function checkedResponse(raw) {
  let data;
  try { data = JSON.parse(raw.replace(/^\s*\)\]\}'\s*\n?/, '')); }
  catch { throw Error('Gmail returned non-JSON data. Refresh Gmail and reconnect.'); }
  if (!data || field(data, 1) !== 0) throw Error('Gmail API did not report a successful read.');
  return data;
}
export function parseSearch(raw, offset) {
  return parseWithContext(raw, `bv offset=${offset}`, () => parseSearchPayload(raw, offset));
}
function parseSearchPayload(raw, offset) {
  const data = checkedResponse(raw);
  const descriptors = field(data, 3);
  // Gmail omits the repeated protobuf field for empty results. Keep this
  // distinct from an explicit empty page so the collector can verify coverage.
  if (descriptors == null) return { threads: [], done: true, ambiguous: true, nextOffset: offset };
  const threads = list(descriptors, 'search response field 3').map(wrapper => {
    const item = field(wrapper, 1), id = field(item, 4);
    if (!threadId(id)) throw Error('Gmail returned an invalid thread ID.');
    const messageIds = list(field(item, 5), 'search messages field 3[].1.5').map(m => field(m, 1));
    if (!messageIds.every(messageId)) throw Error('Gmail returned an invalid message ID.');
    return { id, messageIds };
  });
  if (new Set(threads.map(t => t.id)).size !== threads.length) throw Error('Gmail returned duplicate threads in a page.');
  return { threads, done: threads.length === 0, nextOffset: offset + threads.length, signature: threads.map(t => t.id).join(',') };
}
const contact = node => ({ address: text(field(node, 2)), name: text(field(node, 3)) });
export function parseThread(raw, expectedId) {
  return parseWithContext(raw, 'fd', () => parseThreadPayload(raw, expectedId));
}
function parseThreadPayload(raw, expectedId) {
  const threads = list(field(checkedResponse(raw), 2), 'thread response field 2');
  const matches = threads.filter(t => field(t, 1) === expectedId);
  if (matches.length !== 1 || threads.length !== 1) throw Error('Gmail returned an unexpected thread.');
  const thread = matches[0];
  const metadata = list(field(field(thread, 2), 2), 'message metadata field 2[].2.2');
  const allIds = [], messages = [];
  for (const item of list(field(thread, 3), 'thread messages field 2[].3')) {
    const id = field(item, 1), body = field(item, 2);
    if (!messageId(id) || !body || allIds.includes(id)) throw Error('Gmail message data is incomplete or duplicated.');
    allIds.push(id);
    const meta = metadata.find(m => field(m, 1) === id);
    const labels = list(field(meta, 4), 'message labels field 4');
    if (labels.includes('^s') || labels.includes('^k')) continue; // Spam / Trash, including mixed-label threads.
    const timestamp = Number(field(body, 17));
    if (!Number.isFinite(timestamp) || timestamp <= 0) throw Error('Gmail message timestamp is missing.');
    const parts = field(field(body, 6), 2);
    const readable = Array.isArray(parts) && parts.every(part => typeof field(field(part, 3), 2) === 'string');
    const recipients = n => (field(body, n) == null ? [] : list(field(body, n), 'recipients')).map(contact);
    const attachments = (field(body, 14) == null ? [] : list(field(body, 14), 'attachments')).map(a => {
      const descriptor = field(a, 1), details = field(descriptor, 4);
      return { id: text(field(descriptor, 2)), name: text(field(details, 3)), mimeType: text(field(details, 4)), size: Number(field(details, 5)) || 0 };
    });
    messages.push({ id, thread_id: expectedId, timestamp, subject: text(field(body, 5)),
      from: contact(field(meta, 2)), to: recipients(1), cc: recipients(2), bcc: recipients(3),
      smtp_id: text(field(body, 8)), labels, attachments,
      content_html: readable ? parts.map(p => field(field(p, 3), 2)).join('') : null,
      content_status: readable ? 'readable' : 'unavailable' });
  }
  return { messages, allIds };
}
export function installGmailApi(target = window, version = 'development') {
  if (target.__actoutGmailApi) return target.__actoutGmailApi;
  const headers = {}, tracked = new WeakMap();
  const account = target.location.pathname.match(/^\/mail(\/u\/\d+)\//)?.[1];
  if (!account) return;
  const syncPath = `/sync${account}/i/`;
  const capture = (url, supplied) => {
    try {
      const u = new URL(url, target.location.href);
      if (u.origin !== target.location.origin || !u.pathname.startsWith(syncPath)) return;
      for (const name of ['x-framework-xsrf-token', 'x-gmail-btai']) {
        const value = new Headers(supplied).get(name);
        if (value) headers[name] = value;
      }
    } catch { /* Observing headers must never interrupt Gmail. */ }
  };
  const proto = target.XMLHttpRequest.prototype, originalOpen = proto.open, originalHeader = proto.setRequestHeader;
  proto.open = function(method, url, ...args) { tracked.set(this, { url, headers: {} }); return originalOpen.call(this, method, url, ...args); };
  proto.setRequestHeader = function(name, value) {
    const result = originalHeader.call(this, name, value), entry = tracked.get(this);
    if (entry) { entry.headers[name] = value; capture(entry.url, entry.headers); }
    return result;
  };
  const originalFetch = target.fetch.bind(target);
  target.fetch = function(input, options) {
    capture(typeof input === 'string' || input instanceof URL ? String(input) : input.url, options?.headers || input?.headers);
    return originalFetch(input, options);
  };
  const ready = async () => {
    for (let i = 0; i < 30; i++) {
      if (headers['x-framework-xsrf-token'] && headers['x-gmail-btai']) return;
      await new Promise(resolve => target.setTimeout(resolve, 400));
    }
    throw Error('Gmail session headers are not ready. Refresh the Gmail tab once, wait for it to load, then reconnect.');
  };
  async function request(endpoint, body) {
    await ready();
    const response = await originalFetch(`${syncPath}${endpoint}?rt=r&pt=ji`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Google-BTD': '1' },
      body: JSON.stringify(body), credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(25000)
    });
    if (!response.ok) throw Error(`Gmail ${endpoint} request failed (HTTP ${response.status}). Refresh Gmail and reconnect.`);
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 12 * 1024 * 1024) throw Error('Gmail API response exceeds 12 MB.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const decoder = new TextDecoder();
    return chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
  }
  const api = {
    version,
    ready,
    async search({ start, end, offset, precise = false }) {
      if (![start, end, offset].every(Number.isSafeInteger) || start >= end || offset < 0) throw Error('Invalid Gmail search window or offset.');
      const date = seconds => new Date(seconds * 1000).toISOString().slice(0, 10).replaceAll('-', '/');
      // Overlap one second at the boundary; message IDs are deduplicated locally.
      const query = precise ? `after:${start - 1} before:${end}` : `after:${date(start - 86400)} before:${date(end + 86400)}`;
      const body = [[null, 51, null, query, null, null, null, null, null, offset]];
      return parseSearch(await request('bv', body), offset);
    },
    async thread({ id }) {
      if (!threadId(id)) throw Error('Invalid Gmail thread ID.');
      return parseThread(await request('fd', [[[id, 1]], 2]), id);
    }
  };
  target.__actoutGmailApi = api;
  return api;
}
