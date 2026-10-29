// Observe Slack API authentication, including workspace-subdomain requests. No message bodies are kept.
export function installSlackSession(target = window, version = 'development') {
  if (target.__actoutSlackSession) return;
  const workspace = () => target.location.pathname.match(/^\/client\/(T[A-Z0-9]+)(?:\/|$)/)?.[1];
  let token, team, transport, observed = 0;
  const tracked = new WeakMap();
  function capture(input, body, headers) {
    try {
      const url = new URL(input, target.location.href), current = workspace();
      if (!current || url.protocol !== 'https:' || !/^[a-z0-9-]+\.slack\.com$/.test(url.hostname) || !!url.port || !!url.username || !!url.password || !/^\/api\/[a-zA-Z.]+$/.test(url.pathname)) return;
      observed++;
      let params;
      if (typeof body === 'string' && body.length <= 256 * 1024) {
        params = body.trim().startsWith('{') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
      } else if (body instanceof URLSearchParams || (typeof FormData !== 'undefined' && body instanceof FormData)) {
        params = Object.fromEntries(['token', 'team_id', '_x_mode', '_x_sonic', '_x_app_name'].map(key => [key, body.get(key)]));
      }
      if (params?.team_id && params.team_id !== current) return;
      const authorization = new Headers(headers).get('authorization');
      const candidate = params?.token || authorization?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
      if (typeof candidate !== 'string' || !/^xox[cps]-[A-Za-z0-9-]+$/.test(candidate)) return;
      token = candidate; team = current;
      const query = new URLSearchParams();
      for (const key of ['_x_id', '_x_csid', 'slack_route', '_x_version_ts', '_x_foreground', '_x_frontend_build_type', '_x_desktop_ia', '_x_gantry', 'fp', '_x_num_retries']) {
        const value = url.searchParams.get(key); if (value && value.length <= 2048) query.set(key, value);
      }
      const fields = {};
      for (const key of ['_x_mode', '_x_sonic', '_x_app_name']) if (typeof params?.[key] === 'string' && params[key].length <= 200) fields[key] = params[key];
      transport = { origin: url.origin, query: query.toString(), fields };
    } catch { /* Never interfere with Slack traffic. */ }
  }
  const originalFetch = target.fetch;
  target.fetch = function(input, options) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    capture(url, options?.body, options?.headers || input?.headers);
    return originalFetch.apply(this, arguments);
  };
  const proto = target.XMLHttpRequest.prototype;
  const open = proto.open, header = proto.setRequestHeader, send = proto.send;
  proto.open = function(method, url) { tracked.set(this, { url, headers: {} }); return open.apply(this, arguments); };
  proto.setRequestHeader = function(name, value) {
    const entry = tracked.get(this); if (entry) entry.headers[name] = value;
    return header.apply(this, arguments);
  };
  proto.send = function(body) {
    const entry = tracked.get(this); if (entry) capture(entry.url, body, entry.headers);
    return send.apply(this, arguments);
  };
  target.__actoutSlackSession = {
    version,
    // Called only inside the tab by slackRead, never returned across the bridge.
    getToken: requested => requested === team && requested === workspace() ? token : undefined,
    getTransport: requested => requested === team && requested === workspace() ? transport : undefined,
    status: () => ({ observed, captured: !!token && team === workspace() })
  };
}
