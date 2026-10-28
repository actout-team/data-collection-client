import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const pause = (ms, signal) => delay(ms, undefined, { signal });
export function downloadStatus(apps, cancelled = false) {
  const results = Object.values(apps);
  if (cancelled) return 'cancelled';
  if (results.some(a => a.status === 'failed') && !results.some(a => a.messages > 0)) return 'failed';
  return results.some(a => a.status !== 'finished') ? 'partial' : 'finished';
}
export function daysBackWindow(days = 90, end = new Date()) {
  if (!Number.isInteger(days) || days < 1 || days > 36500) throw Error('Days back must be a whole number from 1 to 36500.');
  return { start: new Date(end.getTime() - days * 86400000).toISOString(), end: end.toISOString() };
}
export async function jsonFile(file, data) {
  await writeFile(file + '.tmp', JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(file + '.tmp', file);
}
export async function createWriter(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const handles = new Map();
  return {
    async append(name, record) {
      if (!/^[a-z]+\.jsonl$/.test(name)) throw Error('Invalid output filename.');
      if (!handles.has(name)) handles.set(name, await open(path.join(dir, name), 'ax', 0o600));
      await handles.get(name).writeFile(JSON.stringify(record) + '\n');
    },
    async close() { for (const h of handles.values()) await h.close(); }
  };
}
export async function slackApi(ask, method, body = {}, signal, diagnostic = () => {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    signal?.throwIfAborted();
    const result = await ask({ op: 'request', path: `/api/${method}`, method: 'POST', body });
    if (result?.status === 429 || result?.data?.error === 'ratelimited') {
      const seconds = Number(result.retryAfter);
      const wait = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
      diagnostic(`Slack ${method}: rate limited, retrying in ${wait}s (attempt ${attempt + 1}/8).`);
      await pause(wait * 1000, signal); continue;
    }
    if (!result?.data?.ok) {
      const reason = result?.data?.error || result?.error || 'invalid response';
      throw Object.assign(Error(`Slack: ${reason}`), { code: ['not_authed', 'invalid_auth', 'token_revoked', 'account_inactive'].includes(reason) ? 'LOGIN_REQUIRED' : 'SLACK_FAILED' });
    }
    return result.data;
  }
  throw Error('Slack rate limit persists. Partial files were kept; try again later.');
}
