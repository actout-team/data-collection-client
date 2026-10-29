// Outlook.com Beta: observe this tab's web session. Secrets never cross the bridge.
export function installOutlookSession(target = window, version = 'development') {
  if (target.__actoutOutlook) return;
  const origin = target.location.origin;
  const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
  const validOrigin = () => origin === 'https://outlook.live.com' && target.location.origin === origin && /^\/mail(?:\/|$)/.test(target.location.pathname);
  const originalFetch = target.fetch, tracked = new WeakMap();
  let credentials, anchor, account, folderTemplate, headerTemplate, identityTemplate, observedEmail, generation = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const field = FieldURI => ({ __type: 'PropertyUri:#Exchange', FieldURI });
  const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
  function reset() { generation++; account = folderTemplate = headerTemplate = identityTemplate = credentials = observedEmail = undefined; }
  function observe(input, options = {}) {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, origin);
      if (!validOrigin() || url.origin !== origin || url.pathname !== '/owa/service.svc' || (options.method || input?.method || 'GET').toUpperCase() !== 'POST') return null;
      const headers = new Headers(options.headers || input?.headers);
      const nextAnchor = headers.get('x-anchormailbox'), authorization = headers.get('authorization');
      if (!nextAnchor || nextAnchor.length > 1024 || !authorization || authorization.length > 32768) return null;
      if (anchor && anchor !== nextAnchor) reset();
      anchor = nextAnchor;
      credentials = Object.fromEntries(['authorization', 'content-type', 'x-anchormailbox', 'x-owa-sessionid', 'x-client-version', 'x-tenantid'].map(k => [k, headers.get(k)]).filter(([, v]) => v));
      const action = headers.get('action') || url.searchParams.get('action');
      if (!['FindFolder', 'GetMailboxByIdentity'].includes(action)) return null;
      const encoded = headers.get('x-owa-urlpostdata');
      const raw = encoded ? decodeURIComponent(encoded) : options.body;
      if (typeof raw !== 'string' || raw.length > 131072) return null;
      const request = JSON.parse(raw);
      if (action === 'FindFolder' && !folderTemplate && request.Body?.Traversal === 'Deep' && request.Body?.ReturnParentFolder === true && safeId(request.Body?.ParentFolderIds?.[0]?.Id)) {
        folderTemplate = request; headerTemplate = request.Header;
      }
      if (action === 'GetMailboxByIdentity') {
        const email = request.Identity?.RawIdentity;
        if (typeof email !== 'string' || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
        if (observedEmail && observedEmail !== email.toLowerCase()) {
          const currentCredentials = credentials; reset(); credentials = currentCredentials;
        }
        observedEmail = email.toLowerCase();
        identityTemplate = request;
        return { generation, anchor, email: email.toLowerCase() };
      }
    } catch { /* Observation must not alter Outlook requests. */ }
    return null;
  }
  function acceptIdentity(ticket, data) {
    if (!ticket || ticket.generation !== generation || ticket.anchor !== anchor || ticket.email !== observedEmail || data?.WasSuccessful !== true || !data.MailboxOptions?.Identity) return;
    const name = typeof data.MailboxOptions.Identity.DisplayName === 'string' ? data.MailboxOptions.Identity.DisplayName : '';
    account = { authenticated: true, accountId: anchor, account: ticket.email, email: ticket.email, name, ownerProfile: { email: ticket.email, full_name: name } };
  }
  async function boundedJson(response) {
    if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) { await response.body?.cancel(); fail('OUTLOOK_SIZE', 'Outlook response exceeds 8 MB.'); }
    const reader = response.body.getReader(), chunks = []; let length = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 8 * 1024 * 1024) fail('OUTLOOK_SIZE', 'Outlook response exceeds 8 MB.'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('OUTLOOK_SCHEMA', 'Outlook returned a non-JSON response. Refresh Outlook and reconnect.'); }
  }
  target.fetch = function(input, options) {
    const ticket = observe(input, options);
    const result = originalFetch.apply(this, arguments);
    if (ticket) result.then(r => { if (r.ok) return boundedJson(r.clone()).then(data => acceptIdentity(ticket, data)); }).catch(() => {});
    return result;
  };
  const proto = target.XMLHttpRequest.prototype, open = proto.open, setHeader = proto.setRequestHeader, send = proto.send;
  proto.open = function(method, url) { tracked.set(this, { method, url, headers: {} }); return open.apply(this, arguments); };
  proto.setRequestHeader = function(name, value) { const record = tracked.get(this); if (record) record.headers[name] = value; return setHeader.apply(this, arguments); };
  proto.send = function(body) {
    const record = tracked.get(this), ticket = record && observe(record.url, { ...record, body });
    if (ticket) this.addEventListener('load', () => { try { if (this.status === 200) { const data = this.responseType === 'json' ? this.response : this.responseText.length <= 8 * 1024 * 1024 ? JSON.parse(this.responseText) : null; acceptIdentity(ticket, data); } } catch { /* Ignore non-JSON responses. */ } }, { once: true });
    return send.apply(this, arguments);
  };
  function check(expected) {
    if (!validOrigin() || !credentials || !account || !folderTemplate || !headerTemplate || !identityTemplate) fail('LOGIN_REQUIRED', 'Refresh the signed-in Outlook.com mail tab, then reconnect. Waiting for its session and folder requests.');
    if (expected && (expected.accountId !== account.accountId || expected.email?.toLowerCase() !== account.email)) fail('ACCOUNT_CHANGED', 'Outlook account changed. Reconnect before exporting.');
  }
  async function request(action, shape, expected, body = false) {
    check(expected); const before = generation, bound = clone(account);
    const headers = { ...credentials, action, 'content-type': 'application/json; charset=utf-8' };
    if (!body) headers['x-owa-urlpostdata'] = encodeURIComponent(JSON.stringify(shape));
    const response = await originalFetch.call(target, `${origin}/owa/service.svc?action=${action}&app=Mail`, { method: 'POST', credentials: 'include', redirect: 'error', headers, ...(body ? { body: JSON.stringify(shape) } : {}), signal: AbortSignal.timeout(25000) });
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); reset(); fail('LOGIN_REQUIRED', 'Outlook session expired or access was denied. Refresh Outlook and reconnect.'); }
    if ([429, 500, 502, 503, 504].includes(response.status)) { await response.body?.cancel(); return { status: response.status, retryAfter: response.headers.get('retry-after') }; }
    if (!response.ok) { await response.body?.cancel(); fail('OUTLOOK_HTTP', `Outlook read failed (${response.status}).`); }
    const data = await boundedJson(response);
    check(bound); if (before !== generation) fail('ACCOUNT_CHANGED', 'Outlook account changed during a read.');
    return { status: 200, data };
  }
  target.__actoutOutlook = { version, async read(op, args = {}, expected) {
    check(expected);
    if (op === 'identity') {
      const result = await request('GetMailboxByIdentity', identityTemplate, expected);
      if (result.status !== 200) fail('OUTLOOK_RETRY', 'Outlook is busy. Retry Connect shortly.');
      if (result.data.WasSuccessful !== true) fail('LOGIN_REQUIRED', 'Outlook could not verify this mailbox. Refresh and reconnect.');
      return clone(account);
    }
    if (!expected?.authenticated) fail('LOGIN_REQUIRED', 'Connect Outlook before reading mail.');
    const offset = args.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) fail('OUTLOOK_ARGUMENT', 'Invalid Outlook page offset.');
    if (op === 'outlook-folders') {
      const shape = clone(folderTemplate);
      shape.Body.Paging = { __type: 'IndexedPageView:#Exchange', BasePoint: 'Beginning', Offset: offset, MaxEntriesReturned: 100 };
      shape.Body.FolderShape.AdditionalProperties = ['TotalCount', 'UnreadCount', 'DisplayName', 'FolderClass', 'ParentFolderId'].map(field);
      return request('FindFolder', shape, expected);
    }
    if (op === 'outlook-items') {
      if (!safeId(args.folderId)) fail('OUTLOOK_ARGUMENT', 'Invalid Outlook folder.');
      return request('FindItem', { __type: 'FindItemJsonRequest:#Exchange', Header: { ...clone(headerTemplate), RequestServerVersion: 'V2018_01_18' }, Body: {
        __type: 'FindItemRequest:#Exchange', ParentFolderIds: [{ __type: 'FolderId:#Exchange', Id: args.folderId }],
        ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'IdOnly', AdditionalProperties: ['Subject', 'ConversationId', 'DateTimeReceived', 'DateTimeSent', 'From', 'IsRead', 'InternetMessageId', 'HasAttachments'].map(field) },
        Traversal: 'Shallow', Paging: { __type: 'IndexedPageView:#Exchange', BasePoint: 'Beginning', Offset: offset, MaxEntriesReturned: 100 }, FocusedViewFilter: -1, ViewFilter: 'All',
        SortOrder: [{ __type: 'SortResults:#Exchange', Order: 'Descending', Path: field('ItemLastModifiedTime') }]
      } }, expected);
    }
    if (op === 'outlook-conversation') {
      if (!safeId(args.conversationId)) fail('OUTLOOK_ARGUMENT', 'Invalid Outlook conversation.');
      return request('GetConversationItems', { __type: 'GetConversationItemsJsonRequest:#Exchange', Header: { ...clone(headerTemplate), RequestServerVersion: 'V2017_08_18' }, Body: {
        __type: 'GetConversationItemsRequest:#Exchange', Conversations: [{ __type: 'ConversationRequestType:#Exchange', ConversationId: { __type: 'ItemId:#Exchange', Id: args.conversationId }, SyncState: '' }],
        ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'IdOnly', MaximumBodySize: 2097152, MaximumRecipientsToReturn: 20, FilterHtmlContent: true, BlockExternalImagesIfSenderUntrusted: true, CalculateOnlyFirstBody: true, BodyShape: 'UniqueFragment' },
        ShapeName: 'ItemPart', SortOrder: 'DateOrderAscending', MaxItemsToReturn: 20, Action: 'ReturnRootNode', ReturnSubmittedItems: true, ReturnDeletedItems: true
      } }, expected, true);
    }
    fail('OUTLOOK_ARGUMENT', 'Unsupported Outlook operation.');
  } };
}
