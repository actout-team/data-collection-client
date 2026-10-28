// Drive website protocol sampled in Chrome on 2026-10-16. Serialized into MAIN.
// Credentials are computed and used in the selected tab, never returned.
export async function driveRead(op, input = {}, expected = null) {
  const fail = (message, code = 'DRIVE_FAILED') => ({ ok: false, error: message, code });
  const origin = 'https://drive.google.com';
  const accountPath = location.pathname.match(/^\/drive\/u\/(\d+)(?:\/|$)/);
  if (location.origin !== origin || !accountPath) return fail('Open a signed-in Google Drive account and reconnect.', 'LOGIN_REQUIRED');
  const authuser = accountPath[1];
  if (!['identity', 'drive-page'].includes(op)) return fail('Unsupported Drive operation.');
  if (expected && (expected.origin !== origin || expected.authuser !== authuser)) return fail('Drive account changed. Reconnect.', 'ACCOUNT_CHANGED');
  const api = 'https://drivefrontend-pa.clients6.google.com';
  let key;
  for (const entry of performance.getEntriesByType('resource')) {
    try {
      const u = new URL(entry.name);
      if (u.origin === api && ['/v1/account', '/v1/items:list', '/v1/sharedDrives:list'].includes(u.pathname)) key ||= u.searchParams.get('key');
    } catch { /* Ignore unrelated performance entries. */ }
  }
  if (!key || !/^[A-Za-z0-9_-]{10,200}$/.test(key)) return fail('Refresh the Drive tab so its website API configuration can be observed, then reconnect.', 'DRIVE_SESSION_MISSING');
  async function request(path, fields, body) {
    const cookie = document.cookie.split(/;\s*/).find(v => v.startsWith('SAPISID='))?.slice(8);
    if (!cookie) throw Object.assign(Error('Drive login is unavailable. Sign in and reconnect.'), { code: 'LOGIN_REQUIRED' });
    const now = Math.floor(Date.now() / 1000);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${now} ${cookie} ${origin}`)))).map(v => v.toString(16).padStart(2, '0')).join('');
    const url = new URL(path, api);
    url.search = new URLSearchParams({ key, alt: 'json', fields }).toString();
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET', credentials: 'include', redirect: 'error',
      headers: { authorization: `SAPISIDHASH ${now}_${hash}`, 'x-goog-authuser': authuser, 'content-type': 'application/json+protobuf' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000)
    });
    if ([401, 403].includes(response.status)) throw Object.assign(Error(`Drive authentication or access failed (HTTP ${response.status}). Reconnect the selected account.`), { code: 'LOGIN_REQUIRED' });
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      return { status: response.status, retryAfter: response.headers.get('retry-after') };
    }
    if (!response.ok || !/json/i.test(response.headers.get('content-type') || '')) throw Error(`Drive ${path}: unexpected HTTP ${response.status} or content type.`);
    // Bound responses before parsing. No response text is included in errors.
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw Error('Drive response exceeded the 8 MB page limit.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const buffer = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    let data;
    try { data = JSON.parse(new TextDecoder().decode(buffer)); } catch { throw Error('Drive returned invalid JSON.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) throw Error('Drive response schema changed or returned an API error.');
    return { status: 200, data };
  }
  try {
    const profile = await request('/v1/account', 'account.user.id,account.user.email,account.user.short_name,account.metadata.root_folder_id');
    if (profile.status !== 200) return op === 'identity' ? fail('Drive is temporarily rate limited or unavailable. Retry Connect.') : { ok: true, value: profile };
    const user = profile.data.account?.user, root = profile.data.account?.metadata?.rootFolderId;
    if (!user || typeof user.id !== 'string' || !user.id || typeof user.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(user.email) || typeof root !== 'string' || !root) throw Error('Drive account response is missing its verified identity.');
    const identity = { authenticated: true, account: user.email, accountId: user.id, origin, authuser, rootFolderId: root, ownerProfile: { email: user.email, first_name: user.shortName || '' } };
    if (expected && (expected.accountId !== identity.accountId || expected.account !== identity.account)) return fail('Drive account changed. Reconnect.', 'ACCOUNT_CHANGED');
    if (op === 'identity') return { ok: true, value: identity };
    if (!expected) return fail('Connect Drive before collecting files.');
    const start = Date.parse(input.start), end = Date.parse(input.end), cursor = input.cursor ?? '';
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || start < 0 || typeof cursor !== 'string' || cursor.length > 32768) return fail('Invalid Drive date window or cursor.');
    const pageSize = input.pageSize ?? 100;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) return fail('Invalid Drive page size.');
    const query = []; query[4] = 0; // Exclude trash, as in the website's observed requests.
    // Observed modified-after and modified-before predicates. Widen the lower
    // boundary by one millisecond, then enforce [start,end) again in the collector.
    query[30] = [[5, start - 1], [2, end]];
    const fields = 'items(id,title,mime_type,parent,create_date_millis,modified_date_millis,file_size,alternate_link,trashed,owner(id,email,is_me),capabilities(can_download),shortcut_details(target_id,target_mime_type),team_drive_id),continuation_token,search_response_metadata(incomplete_search)';
    const result = await request('/v1/items:list', fields, [query, [pageSize, cursor, [2, 5]]]);
    if (result.status !== 200) return { ok: true, value: result };
    const data = result.data;
    if (Object.keys(data).some(key => !['items', 'continuationToken', 'searchResponseMetadata'].includes(key))) throw Error('Drive list response contains an unrecognized schema.');
    if (data.searchResponseMetadata?.incompleteSearch != null && typeof data.searchResponseMetadata.incompleteSearch !== 'boolean') throw Error('Drive search completeness field changed.');
    if ((data.items != null && !Array.isArray(data.items)) || (data.continuationToken != null && typeof data.continuationToken !== 'string')) throw Error('Drive list response schema changed.');
    const items = data.items || [];
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !/^[\w-]{1,200}$/.test(item.id) || typeof item.title !== 'string' || typeof item.mimeType !== 'string') throw Error('Drive item response is missing required fields.');
    }
    if (location.pathname.match(/^\/drive\/u\/(\d+)(?:\/|$)/)?.[1] !== authuser) return fail('Drive account changed during the request.', 'ACCOUNT_CHANGED');
    return { ok: true, value: { status: 200, items, nextCursor: data.continuationToken || null, incompleteSearch: data.searchResponseMetadata?.incompleteSearch === true } };
  } catch (error) {
    // Never expose URLs, credential material, or API response contents.
    const known = /^(Drive |Invalid |Connect )/.test(error.message || '');
    return fail(known ? error.message : 'Drive network read failed or timed out. Retry after checking the selected tab.', error.code || 'DRIVE_FAILED');
  }
}
