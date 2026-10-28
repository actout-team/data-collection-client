import { saasApps } from './saas-catalog.mjs';
// Shared connection policy. No arbitrary URLs or write methods cross the bridge.
export const apps = [
  { id: 'gmail', name: 'Gmail', home: 'https://mail.google.com/mail/u/0/', hosts: ['mail.google.com'], cookies: ['SID', '__Secure-1PSID'], detail: 'Message bodies and metadata. No MIME originals or attachment contents.' },
  { id: 'slack', name: 'Slack', home: 'https://app.slack.com/client', hosts: ['*.slack.com'], cookies: ['d'], detail: 'Accessible channels, DMs and thread replies as JSONL. Attachment metadata only.' },
  ...saasApps
];
export const getApp = id => apps.find(a => a.id === id);
export function allowedSite(id, input) {
  try {
    const u = new URL(input), app = getApp(id);
    return !!app && u.protocol === 'https:' && !u.username && !u.password && !u.port && app.hosts.some(h =>
      h.startsWith('*.') ? u.hostname.endsWith(h.slice(1)) : u.hostname === h);
  } catch { return false; }
}
export function accountPath(id, url) {
  const u = new URL(url);
  const app = getApp(id);
  if (app?.scope) return u.pathname.match(new RegExp(app.scope))?.[1] || null;
  if (app?.mode === 'capture') return '/';
  return id === 'gmail' ? u.pathname.match(/^\/mail\/u\/\d+\//)?.[0] : u.pathname.match(/^\/client\/T[A-Z0-9]+/)?.[0] || '/';
}
export function readRequest(id, base, path, method) {
  if (id !== 'slack' || !allowedSite(id, base) || method !== 'POST' || typeof path !== 'string') return false;
  return /^\/api\/(auth\.test|conversations\.(list|history|replies)|users\.list)$/.test(path);
}
export const hostPermissions = [...new Set(apps.flatMap(a => [...a.hosts, ...(a.downloadHosts || [])].map(h => `https://${h}/*`)))];
