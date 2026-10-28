// Serialized into the selected HubSpot tab's ISOLATED world; keep self-contained.
// This reader needs DOM cookies and same-origin fetch, not website JS globals.
// Website contract inspected in crm-index-ui 2.54559 (October 2026):
// /api/graphql/crm accepts an array of named queries; crmObjectsSearch exposes
// allProperties, total, offset and hasMore. Never accept caller-provided URLs,
// GraphQL text or headers. Session credentials stay inside the browser.
export async function hubspotRead(op, args = {}, expected = null) {
  const diagnostics = [];
  const note = text => { if (diagnostics.length < 16) diagnostics.push(text.slice(0, 500)); };
  const shape = value => value === null ? 'null' : Array.isArray(value) ? `array(${value.length})` : typeof value;
  const number = value => Number.isSafeInteger(value) ? String(value) : shape(value);
  const success = value => ({ ok: true, value: op === 'hubspot-page' && args?.diagnostics ? { ...value, diagnostics } : value, ...(args?.diagnostics ? { diagnostics } : {}) });
  const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
  try {
    if (!['identity', 'hubspot-page'].includes(op)) fail('UNSUPPORTED', 'Unsupported HubSpot operation.');
    const hosts = ['app.hubspot.com', 'app-eu1.hubspot.com', 'app-na1.hubspot.com', 'app-na2.hubspot.com'];
    const initial = new URL(location.href);
    const portalId = initial.pathname.match(/^\/[^/]+\/(\d+)(?:\/|$)/)?.[1];
    if (initial.protocol !== 'https:' || initial.port || !hosts.includes(initial.hostname) || !portalId) fail('LOGIN_REQUIRED', 'Open a signed-in HubSpot portal and reconnect.');
    const checkScope = () => {
      const now = new URL(location.href);
      if (now.origin !== initial.origin || now.pathname.match(/^\/[^/]+\/(\d+)(?:\/|$)/)?.[1] !== portalId) fail('ACCOUNT_CHANGED', 'HubSpot portal changed. Reconnect.');
    };
    if (expected && (expected.origin !== initial.origin || expected.portalId !== portalId)) fail('ACCOUNT_CHANGED', 'HubSpot portal changed. Reconnect.');
    let type, offset, start, end;
    const scope = args?.scope ?? 'window';
    note(`Reader: operation=${op}, input=${shape(args)}, expectedAccount=${expected ? 'present' : 'missing'}.`);
    if (op === 'hubspot-page') {
      if (!['window', 'all'].includes(scope)) fail('INVALID_REQUEST', 'Invalid HubSpot query scope.');
      const types = { contacts: '0-1', companies: '0-2', deals: '0-3' };
      type = Object.hasOwn(types, args.type) ? types[args.type] : null;
      // Missing/null cursors both mean the first page. Canonical decimal cursors
      // are accepted too, but arbitrary coercions (booleans, fractions) are not.
      offset = args.cursor == null ? 0 : typeof args.cursor === 'string' && /^(0|[1-9]\d{0,3})$/.test(args.cursor) ? Number(args.cursor) : args.cursor;
      start = typeof args.window?.start === 'string' ? new Date(args.window.start).getTime() : NaN;
      end = typeof args.window?.end === 'string' ? new Date(args.window.end).getTime() : NaN;
      note(`Page input: scope=${scope}, type=${type || 'unsupported'}, cursor=${shape(args.cursor)}, offset=${number(offset)}, window=${shape(args.window)}, start=${shape(args.window?.start)}/${Number.isFinite(start) ? 'valid' : 'invalid'}, end=${shape(args.window?.end)}/${Number.isFinite(end) ? 'valid' : 'invalid'}.`);
      if (!type) fail('INVALID_REQUEST', 'Invalid HubSpot record type. Expected contacts, companies or deals.');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= 10000) fail('INVALID_REQUEST', `Invalid HubSpot cursor: expected an integer from 0 to 9999, received ${shape(args.cursor)}.`);
      if (!Number.isFinite(start) || !Number.isFinite(end)) fail('INVALID_REQUEST', `Invalid HubSpot date window: start=${shape(args.window?.start)}/${Number.isFinite(start) ? 'valid' : 'invalid'}, end=${shape(args.window?.end)}/${Number.isFinite(end) ? 'valid' : 'invalid'}.`);
      if (start < 0 || start >= end) fail('INVALID_REQUEST', 'Invalid HubSpot date window: start must be non-negative and earlier than end.');
      if (!expected?.userId) fail('ACCOUNT_CHANGED', 'Reconnect HubSpot before downloading.');
    }
    async function request(path, body) {
      checkScope();
      const url = new URL(path, initial.origin); url.searchParams.set('portalId', portalId);
      const headers = { Accept: 'application/json' };
      if (body) {
        let csrf;
        try { csrf = decodeURIComponent(document.cookie.match(/(?:^|;\s*)csrf\.app=([^;]*)/)?.[1] || ''); } catch { /* Invalid cookie: reconnect below. */ }
        if (!csrf) fail('LOGIN_REQUIRED', 'HubSpot session token is missing. Refresh the selected tab and reconnect.');
        headers['X-HubSpot-CSRF-hubspotapi'] = csrf; headers['Content-Type'] = 'application/json';
      }
      const began = Date.now();
      note(`Request: ${body ? 'POST' : 'GET'} ${path}${body ? ` operation=CollectHubspotRecords objectType=${type} offset=${offset} count=100 scope=${scope} filters=${scope === 'all' ? 0 : 2} startMs=${start} endMs=${end}` : ''}.`);
      const response = await fetch(url.href, {
        method: body ? 'POST' : 'GET', credentials: 'include', redirect: 'error', cache: 'no-store', headers,
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
      });
      checkScope();
      const contentType = response.headers.get('content-type') || '';
      const mediaType = /application\/json/i.test(contentType) ? 'application/json' : /text\/html/i.test(contentType) ? 'text/html' : contentType ? 'other' : 'missing';
      note(`Response: ${path} HTTP ${response.status}, content-type=${mediaType}, headersAfter=${Date.now() - began}ms.`);
      if (response.status === 429) {
        await response.body?.cancel();
        const retry = response.headers.get('retry-after');
        const seconds = Number(retry) || (Date.parse(retry) - Date.now()) / 1000;
        return { rateLimited: true, retryAfter: Number.isFinite(seconds) && seconds > 0 ? seconds : null };
      }
      if (!response.ok) {
        await response.body?.cancel();
        fail(response.status === 401 ? 'LOGIN_REQUIRED' : response.status === 403 ? 'FORBIDDEN' : 'HTTP_ERROR', `HubSpot returned HTTP ${response.status}. Refresh the session or check record permissions.`);
      }
      if (!/application\/json/i.test(response.headers.get('content-type') || '') || !response.body) {
        await response.body?.cancel(); fail('UNSUPPORTED_RESPONSE', 'HubSpot returned an unexpected response. Refresh the tab and reconnect.');
      }
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 8 * 1024 * 1024) fail('RESPONSE_LIMIT', 'HubSpot page exceeds the 8 MiB limit. Coverage is incomplete.');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      checkScope();
      const bytes = new Uint8Array(size); let position = 0;
      for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
      note(`Body: ${path}, bytes=${size}, elapsed=${Date.now() - began}ms.`);
      try { return { data: JSON.parse(new TextDecoder().decode(bytes)) }; }
      catch { fail('UNSUPPORTED_RESPONSE', 'HubSpot returned invalid JSON.'); }
    }
    // Verify the current user on each page, including switches within one portal.
    const session = await request('/api/login-verify/hub-user-info');
    if (session.rateLimited) {
      if (op === 'identity') fail('RATE_LIMIT', 'HubSpot is rate limited. Try connecting again shortly.');
      return success({ status: 429, retryAfter: session.retryAfter });
    }
    note(`Session structure: root=${shape(session.data)}, portal=${shape(session.data?.portal)}, user=${shape(session.data?.user)}, userId=${shape(session.data?.user?.user_id)}, errors=${shape(session.data?.errors)}.`);
    const info = session.data, userId = String(info?.user?.user_id ?? '');
    if (!/^\d+$/.test(userId) || !info?.portal?.portal_id || info?.errors?.length) fail('LOGIN_REQUIRED', 'HubSpot session could not be verified. Sign in and reconnect.');
    if (String(info.portal.portal_id) !== portalId || (expected && userId !== expected.userId)) fail('ACCOUNT_CHANGED', 'HubSpot account changed. Reconnect.');
    if (op === 'identity') return success({ mode: 'website-api', authenticated: true, origin: initial.origin, portalId, userId, ownerProfile: Object.fromEntries(['email', 'first_name', 'last_name', 'full_name', 'phone', 'mobile_phone', 'street_address', 'postal_address'].filter(key => typeof info.user[key] === 'string' && info.user[key].length <= 256).map(key => [key, info.user[key]])), account: `HubSpot portal ${portalId} · user ${userId}` });
    const modified = args.type === 'contacts' ? 'lastmodifieddate' : 'hs_lastmodifieddate';
    const filterGroups = scope === 'all' ? [] : ['createdate', modified].map(property => ({ filters: [
      { property, operator: 'GTE', value: String(start) },
      { property, operator: 'LT', value: String(end) },
    ] }));
    const query = `query CollectHubspotRecords($filterGroups: [FilterGroup!]!, $sorts: [Sort!], $objectTypeId: String!, $count: Int, $offset: Int) {
      crmObjectsSearch(filterGroups: $filterGroups, sorts: $sorts, type: $objectTypeId, count: $count, offset: $offset) {
        total offset hasMore results { id properties: allProperties { name value } }
        validationErrors { __typename ... on GenericValidationError { message } }
      }
    }`;
    const response = await request('/api/graphql/crm', [{ operationName: 'CollectHubspotRecords', query, variables: {
      objectTypeId: type, filterGroups, sorts: scope === 'all' ? [{ property: modified, order: 'DESC' }, { property: 'hs_object_id', order: 'ASC' }] : [{ property: 'hs_object_id', order: 'ASC' }], count: 100, offset,
    } }]);
    if (response.rateLimited) return success({ status: 429, retryAfter: response.retryAfter });
    const batch = response.data;
    note(`GraphQL structure: batch=${shape(batch)}, first=${shape(batch?.[0])}, data=${shape(batch?.[0]?.data)}, errors=${shape(batch?.[0]?.errors)}.`);
    // Only extract known schema-error forms. Never log arbitrary server messages,
    // extensions, values, headers or record/property contents.
    for (const error of (Array.isArray(batch?.[0]?.errors) ? batch[0].errors.slice(0, 3) : [])) {
      const message = typeof error?.message === 'string' ? error.message : '';
      const safe = message.match(/^Cannot query field "[A-Za-z_][A-Za-z_0-9]*" on type "[A-Za-z_][A-Za-z_0-9]*"\./)?.[0]
        || message.match(/^Unknown (?:type|argument) "[A-Za-z_][A-Za-z_0-9]*"/)?.[0];
      note(`GraphQL error: ${safe || 'server message omitted to protect record contents'}`);
    }
    if (!Array.isArray(batch) || batch.length !== 1 || batch[0]?.errors?.length) fail('QUERY_FAILED', 'HubSpot CRM query failed. The website API may have changed or record access is restricted.');
    const result = batch[0]?.data?.crmObjectsSearch;
    note(`Search structure: search=${shape(result)}, results=${shape(result?.results)}, total=${number(result?.total)}, offset=${number(result?.offset)}, hasMore=${typeof result?.hasMore === 'boolean' ? result.hasMore : shape(result?.hasMore)}, validationErrors=${shape(result?.validationErrors)}.`);
    if (!result || result.validationErrors?.length || !Array.isArray(result.results) || result.results.length > 100 || typeof result.hasMore !== 'boolean' || !Number.isSafeInteger(result.total) || result.total < 0) fail('UNSUPPORTED_RESPONSE', 'HubSpot CRM returned an unsupported search result or rejected the date filters.');
    // Partition before approaching the website search result ceiling. This also
    // avoids silently accepting capped totals as a complete scan.
    if (scope === 'window' && offset === 0 && result.total >= 9000) return success({ splitRequired: true });
    if (result.hasMore && (!Number.isSafeInteger(result.offset) || result.offset <= offset || result.results.length === 0)) fail('PAGINATION_FAILED', 'HubSpot continuation is missing or did not advance.');
    return success({ records: result.results, hasMore: result.hasMore, nextCursor: result.hasMore ? result.offset : null, total: result.total });
  } catch (error) {
    // Do not echo response bodies, tokens or browser exceptions containing URLs.
    const known = typeof error.code === 'string';
    note(`Failure: ${known ? error.code : error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_OR_RUNTIME'}, requests are stopped for this page.`);
    return { ok: false, code: known ? error.code : 'HUBSPOT_FAILED', error: known ? error.message : 'HubSpot request failed or timed out. Refresh the tab and reconnect.', ...(args?.diagnostics ? { diagnostics } : {}) };
  }
}
