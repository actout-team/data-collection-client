// Download routes stay fixed. Never fetch an arbitrary URL supplied by a page,
// file name, API response, or desktop request. Browser cookies stay in Chrome.
export const driveDownloadHosts = ['docs.google.com', 'drive.usercontent.google.com', '*.googleusercontent.com'];
export function driveFilePlan(item, authuser) {
  if (!item || !/^[\w-]{1,200}$/.test(item.id || '') || !/^\d{1,3}$/.test(authuser || '')) throw Error('Invalid Drive file or account.');
  const type = item.mimeType;
  if (type === 'application/vnd.google-apps.folder') return { skip: 'folder' };
  if (type === 'application/vnd.google-apps.shortcut') return { skip: 'shortcut' };
  if (item.capabilities?.canDownload === false) return { skip: 'download-not-permitted' };
  const formats = {
    'application/vnd.google-apps.document': ['document', 'docx'],
    'application/vnd.google-apps.spreadsheet': ['spreadsheets', 'xlsx'],
    'application/vnd.google-apps.presentation': ['presentation', 'pptx'],
    'application/vnd.google-apps.drawing': ['drawings', 'pdf']
  };
  if (formats[type]) {
    const [product, extension] = formats[type];
    const route = product === 'presentation' ? `export/${extension}` : `export?format=${extension}`;
    return { url: `https://docs.google.com/${product}/d/${item.id}/${route}${route.includes('?') ? '&' : '?'}authuser=${authuser}`, extension, native: true };
  }
  if (typeof type !== 'string' || type.startsWith('application/vnd.google-apps.')) return { skip: 'unsupported-google-file' };
  const extension = String(item.title || '').match(/\.([a-zA-Z0-9]{1,10})$/)?.[1]?.toLowerCase() || 'bin';
  return { url: `https://drive.usercontent.google.com/download?id=${item.id}&export=download&authuser=${authuser}`, extension, native: false };
}

export function createDriveDownloads({ fetchImpl = fetch, maxBytes = 128 * 1024 * 1024 } = {}) {
  const active = new Map();
  const approved = input => {
    try {
      const u = new URL(input);
      return u.protocol === 'https:' && !u.username && !u.password && !u.port && (['docs.google.com', 'drive.usercontent.google.com'].includes(u.hostname) || u.hostname.endsWith('.googleusercontent.com'));
    } catch { return false; }
  };
  async function clear(key) {
    const state = active.get(key); active.delete(key);
    if (state) { clearTimeout(state.timer); state.controller.abort(); await state.reader?.cancel().catch(() => {}); }
  }
  async function open(key, item, authuser) {
    await clear(key);
    const plan = driveFilePlan(item, authuser);
    if (plan.skip) return { status: 'skipped', reason: plan.skip };
    if (!plan.native && Number(item.fileSize) > maxBytes) return { status: 'skipped', reason: 'file-exceeds-128mb-limit' };
    const controller = new AbortController();
    const state = { controller, reader: null, bytes: 0, pending: null, timer: setTimeout(() => controller.abort(), 45000) };
    active.set(key, state);
    try {
      const response = await fetchImpl(plan.url, { credentials: 'include', redirect: 'follow', signal: controller.signal });
      const contentType = response.headers.get('content-type') || '';
      const disposition = response.headers.get('content-disposition') || '';
      if (!response.ok || !approved(response.url) || !response.body) throw Error(`Drive file download failed (HTTP ${response.status}).`);
      // Login/consent/virus-check pages are never mistaken for file contents.
      if (/text\/html|application\/json/i.test(contentType) && !/attachment/i.test(disposition)) throw Error('Drive returned a login, consent, or download confirmation page.');
      const length = response.headers.get('content-length');
      const encoded = response.headers.get('content-encoding');
      if (length != null && Number(length) > maxBytes) throw Error('Drive file exceeds the 128 MB download limit.');
      state.reader = response.body.getReader();
      clearTimeout(state.timer);
      state.timer = setTimeout(() => controller.abort(), 120000);
      return { status: 'ready', extension: plan.extension, contentType, expectedBytes: length == null || (encoded && encoded !== 'identity') ? null : Number(length) };
    } catch (error) {
      await clear(key);
      throw Error(/^Drive /.test(error.message || '') ? error.message : 'Drive file download failed or timed out.');
    }
  }
  async function chunk(key) {
    const state = active.get(key);
    if (!state?.reader) throw Error('Drive file stream expired. Retry the export.');
    try {
      let value = state.pending;
      if (!value) {
        const next = await state.reader.read();
        if (next.done) { const bytes = state.bytes; await clear(key); return { done: true, bytes }; }
        value = next.value;
      }
      const part = value.subarray(0, 256 * 1024);
      state.pending = value.length > part.length ? value.subarray(part.length) : null;
      state.bytes += part.byteLength;
      if (state.bytes > maxBytes) throw Error('Drive file exceeds the 128 MB download limit.');
      let text = '';
      for (let offset = 0; offset < part.length; offset += 8192) text += String.fromCharCode(...part.subarray(offset, offset + 8192));
      return { done: false, base64: btoa(text), bytes: state.bytes };
    } catch (error) {
      await clear(key);
      throw Error(/^Drive /.test(error.message || '') ? error.message : 'Drive file stream failed or timed out.');
    }
  }
  return { open, chunk, clear };
}
