// Runs in Gmail's MAIN world. API reads never navigate or open messages.
export async function gmailRead(op, args, expected) {
  try { return { ok: true, value: await read() }; }
  catch (error) { return { ok: false, error: String(error?.message || error).slice(0, 300), code: error?.code || 'GMAIL_FAILED' }; }
  async function read() {
    const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
    if (!document.querySelector('[role="main"]')) fail('LOGIN_REQUIRED', 'Sign in to Gmail and wait for the mailbox to load.');
    const gmail = window.__actoutGmailApi;
    if (!gmail) fail('HELPER_FAILED', window.__actoutGmailError || 'Gmail helper did not load. Reload the extension and refresh the Gmail tab, then reconnect.');
    const validEmail = value => typeof value === 'string' && /^[^\s@<>]+@[^\s@<>]+$/.test(value);
    let account = window.GLOBALS?.[10];
    // Read only account UI, never arbitrary message text or the account switcher list.
    if (!validEmail(account)) account = document.title.match(/([^\s<>]+@[^\s<>]+)\s+[-–—]\s+Gmail\s*$/i)?.[1];
    if (!validEmail(account)) {
      const button = document.querySelector('a[href^="https://accounts.google.com/SignOutOptions"]');
      const label = button?.getAttribute('aria-label') || button?.getAttribute('title') || '';
      account = label.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    }
    if (!validEmail(account)) fail('ACCOUNT_UNAVAILABLE', 'Gmail is open, but its account address could not be read. Refresh the mailbox tab and reconnect.');
    if (expected && account !== expected.account) fail('ACCOUNT_CHANGED', 'Gmail account changed. Reconnect.');
    if (op === 'identity') {
      let probe;
      try { probe = await fetch(location.pathname, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(15000) }); }
      catch (error) { fail('PROBE_FAILED', `Gmail session check failed: ${error.message}. Refresh Gmail and reconnect.`); }
      const url = new URL(probe.url);
      await probe.body?.cancel();
      if (!probe.ok || url.origin !== location.origin || !url.pathname.startsWith(location.pathname)) fail('SESSION_EXPIRED', 'Gmail session could not be verified. Refresh Gmail or sign in again, then reconnect.');
      await gmail.ready();
      const button = document.querySelector('a[href^="https://accounts.google.com/SignOutOptions"]');
      const label = button?.getAttribute('aria-label') || button?.getAttribute('title') || '';
      const prefix = label.includes(account) ? label.slice(0, label.indexOf(account)).replace(/[\s(]+$/, '').trim() : '';
      const fullName = prefix.includes(':') ? prefix.slice(prefix.indexOf(':') + 1).trim() : '';
      const ownerProfile = /^[\p{L}\p{M} .’'\-]{2,128}$/u.test(fullName) ? { full_name: fullName } : {};
      return { account, helperVersion: gmail.version || 'unknown', ...(Object.keys(ownerProfile).length ? { ownerProfile } : {}) };
    }
    if (op === 'gmail-page') return gmail.search(args);
    if (op === 'gmail-thread') return gmail.thread(args);
    throw Error('Unknown Gmail read operation.');
  }
}
