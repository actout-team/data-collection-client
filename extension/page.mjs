// Executed in Slack's MAIN world. Authentication stays inside the selected tab.
export async function slackRead(path, body, expected) {
  try { return { ok: true, value: await read() }; }
  catch (error) { return { ok: false, error: String(error?.message || error).slice(0, 300), code: error?.code || 'SLACK_FAILED' }; }
  async function read() {
    const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
    if (!/^\/api\/(auth\.test|conversations\.(list|history|replies)|users\.list)$/.test(path)) fail('SLACK_FAILED', 'Unsupported Slack read.');
    let config, storage = 'available';
    try { config = JSON.parse(localStorage.getItem('localConfig') || '{}'); }
    catch { config = {}; storage = 'unavailable'; }
    const teamId = location.pathname.match(/\/client\/(T[A-Z0-9]+)(?:\/|$)/)?.[1];
    if (!teamId) fail('LOGIN_REQUIRED', 'Open a specific Slack workspace in the browser, then Connect.');
    const teams = Object.entries(config?.teams || {}).map(([key, t]) => ({ ...t, id: t?.id || t?.team_id || key }));
    const team = teams.find(t => t.id === teamId);
    const boots = [window.TS?.boot_data, window.boot_data].filter(Boolean);
    const boot = boots.find(b => b.api_token && (!b.team_id || b.team_id === teamId));
    const observer = window.__agentsimSlackSession;
    const token = observer?.getToken(teamId) || boot?.api_token || team?.token;
    if (typeof token !== 'string' || !token) fail('SESSION_UNAVAILABLE',
      `Slack session unavailable: storage=${storage}, teams=${teams.length}, selected=${!!team}, boot=${boots.length}, observer=${!!observer}, requests=${observer?.status().observed || 0}. Refresh Slack once, open a channel, then Connect.`);
    if (expected && expected.team_id !== teamId) fail('ACCOUNT_CHANGED', 'Slack workspace changed. Reconnect.');
    const transport = observer?.getTransport?.(teamId);
    const apiOrigin = transport?.origin || location.origin;
    const apiUrl = new URL(apiOrigin);
    if (apiUrl.protocol !== 'https:' || !/^[a-z0-9-]+\.slack\.com$/.test(apiUrl.hostname) || apiUrl.port || apiUrl.username || apiUrl.password) fail('SLACK_FAILED', 'Invalid Slack API origin.');
    async function request(method, params) {
      // Match the observed web client: workspace host, routing query, multipart.
      const url = new URL(`/api/${method}`, apiOrigin); url.search = transport?.query || '';
      const form = new FormData();
      for (const [key, value] of Object.entries({ ...transport?.fields, ...params, token })) form.set(key, String(value));
      const response = await fetch(url.href, {
        method: 'POST', body: form, credentials: 'include',
        redirect: 'error', signal: AbortSignal.timeout(25000)
      });
      if (!response.ok) return { error: `HTTP ${response.status}`, status: response.status, retryAfter: response.headers.get('retry-after') };
      const raw = await response.text();
      if (raw.length > 12 * 1024 * 1024) throw Error('Slack response too large.');
      let data;
      try { data = JSON.parse(raw); } catch { throw Error('Slack returned an unexpected response. Reconnect.'); }
      return { data };
    }
    // Verify tab/workspace identity before any message data leaves Chrome.
    const auth = await request('auth.test', {});
    if (!auth.data?.ok) return auth;
    if (auth.data.team_id !== teamId || (expected && auth.data.user_id !== expected.user_id)) fail('ACCOUNT_CHANGED', 'Slack account/workspace changed. Reconnect.');
    if (path === '/api/auth.test') {
      const { ok, user, user_id, team, team_id } = auth.data;
      return { data: { ok, user, user_id, team, team_id } };
    }
    const result = await request(path.slice('/api/'.length), body || {});
    return result;
  }
}
