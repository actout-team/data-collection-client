import { observers, createObserverRegistration, prepareObserverTab } from './observers.mjs';
import { outlookRead } from './outlook.mjs';
import { hubspotRead } from './hubspot.mjs';
import { saasRead } from './saas.mjs';
import { getApp, allowedSite, accountPath, readRequest } from './catalog.mjs';
import { slackRead } from './page.mjs';
import { gmailRead } from './gmail.mjs';
// Use a persistent tab so switching to Electron to approve pairing keeps the UI open.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage().catch(console.error));
const base = 'http://127.0.0.1:4319';
let polling = false;
const registerObserver = createObserverRegistration(chrome);
async function local(path, options = {}) {
  const { token } = await chrome.storage.local.get('token');
  const response = await fetch(base + path, { ...options, headers: {
    'Content-Type': 'application/json', 'X-Extension-Origin': chrome.runtime.getURL('').replace(/\/$/, ''),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }, signal: AbortSignal.timeout(path === '/pair' ? 60000 : 30000) });
  if (!response.ok) throw Error(`Desktop bridge: ${response.status}`);
  return response.json();
}
async function run(task) {
  const { app: id, op, hint } = task, app = getApp(id);
  if (!app) throw Error('Unknown app.');
  const key = `session-${id}`;
  if (op === 'forget') {
    await chrome.storage.session.remove(key); return { ok: true };
  }
  if (op === 'locate') {
    const version = chrome.runtime.getManifest().version;
    if (['capture', 'website-api'].includes(app.mode) && !await chrome.permissions.contains({ origins: app.hosts.map(h => `https://${h}/*`) })) throw Error('Open the extension and click Pair desktop app to approve site access, then retry Connect here.');
    if (hint && (!allowedSite(id, hint) || !accountPath(id, hint))) throw Error('Use a signed-in mailbox or workspace URL.');
    const all = await chrome.tabs.query({});
    const matches = all.filter(t => allowedSite(id, t.url) && (!hint || (new URL(t.url).origin === new URL(hint).origin && accountPath(id, t.url) === accountPath(id, hint))));
    if (matches.length >= 1 && !hint) return { version, choices: matches.map(t => ({ url: t.url, title: t.title })) };
    let tab = matches[0];
    const saved = (await chrome.storage.session.get(key))[key];
    if (!tab && saved && (!hint || saved.hint === hint)) { try { tab = await chrome.tabs.get(saved.tabId); } catch { /* Closed tab. */ } }
    if (!tab && task.open) tab = await chrome.tabs.create({ url: hint || app.home, active: true });
    if (!tab) return { version };
    const path = allowedSite(id, tab.url) ? accountPath(id, tab.url) : null;
    await chrome.storage.session.set({ [key]: { tabId: tab.id, origin: path ? new URL(tab.url).origin : null, path, hint: hint || '' } });
    if (!path || tab.status !== 'complete') return { version, waiting: true };
    const cookies = await chrome.cookies.getAll({ url: tab.url });
    const cookiePresent = cookies.some(c => app.cookies.includes(c.name) && (c.session || c.expirationDate > Date.now() / 1000));
    if (id === 'slack') {
      await registerObserver('slack');
      if (!await prepareObserverTab(chrome, tab, 'slack')) return { version, waiting: true, waitingMessage: 'Refreshing Slack to activate the updated connector…' };
    }
    if (id === 'outlook') {
      await registerObserver('outlook');
      if (!await prepareObserverTab(chrome, tab, 'outlook')) return { version, waiting: true, waitingMessage: 'Refreshing Outlook to activate the Beta connector…' };
    }
    if (id === 'gmail') await registerObserver('gmail');
    if (id === 'gmail') await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['gmail-bundle.js'] });
    return { version, url: tab.url, ready: true, cookiePresent };
  }
  const session = (await chrome.storage.session.get(key))[key];
  if (!session) throw Error('Reconnect this app.');
  const tab = await chrome.tabs.get(session.tabId);
  if (!allowedSite(id, tab.url) || new URL(tab.url).origin !== session.origin || accountPath(id, tab.url) !== session.path) throw Error('Browser account/tab changed. Reconnect.');
  let func, args;
  if (id === 'outlook') {
    if (!['identity', 'outlook-folders', 'outlook-items', 'outlook-conversation'].includes(op)) throw Error('Unsupported Outlook operation.');
    func = outlookRead; args = [op, task.body || {}, task.expected || null];
  } else if (id === 'slack') {
    if (op !== 'request' || !readRequest(id, tab.url, task.path, task.method)) throw Error('Unsupported Slack operation.');
    func = slackRead; args = [task.path, task.body || {}, task.expected || null];
  } else if (id === 'hubspot') {
    if (!['identity', 'hubspot-page'].includes(op)) throw Error('Unsupported HubSpot operation.');
    func = hubspotRead; args = [op, { ...task.body, diagnostics: true }, task.expected || null];
  } else if (app.mode === 'capture') {
    if (!['identity', 'capture-snapshot', 'capture-record', 'capture-clear'].includes(op)) throw Error('Unsupported capture operation.');
    func = saasRead; args = [op, { name: app.name, scope: app.scope, readPaths: app.readPaths, readPosts: app.readPosts, graphql: app.graphql, version: chrome.runtime.getManifest().version, index: task.index }, task.expected || null];
  } else if (id === 'gmail') {
    if (!['identity', 'gmail-page', 'gmail-thread'].includes(op)) throw Error('Unsupported Gmail operation.');
    func = gmailRead; args = [op, task.body || {}, task.expected || null];
  } else {
    throw Error('No browser reader registered for this app.');
  }
  const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: id === 'hubspot' ? 'ISOLATED' : 'MAIN', func, args });
  const reply = result?.result;
  if (!reply || typeof reply.ok !== 'boolean') throw Error(`${app.name} browser script returned no response. Reload the extension and refresh the selected tab.`);
  if (id === 'hubspot' && Array.isArray(reply.diagnostics) && reply.diagnostics.length) {
    try {
      await local('/diagnostic', { method: 'POST', body: JSON.stringify({ source: 'hubspot', messages: reply.diagnostics.slice(0, 16).filter(value => typeof value === 'string').map(value => value.slice(0, 500)) }) });
    } catch { /* Diagnostics must not turn a successful read into a failed page. */ }
  }
  if (!reply.ok) throw Object.assign(Error(reply.error || `${app.name} read failed.`), { code: reply.code });
  if (id === 'gmail' && op === 'identity' && reply.value?.helperVersion !== chrome.runtime.getManifest().version) {
    throw Error(`Gmail helper ${reply.value?.helperVersion || 'unknown'} differs from extension ${chrome.runtime.getManifest().version}. Refresh the Gmail tab and reconnect.`);
  }
  return reply.value;
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (!(await chrome.storage.local.get('token')).token) return;
    // /next long-polls when idle. Keep draining work instead of pausing after
    // 100 commands until the next 30-second recovery alarm.
    while (true) {
      const task = await local('/next');
      const { lastBridgeError } = await chrome.storage.local.get('lastBridgeError');
      if (lastBridgeError) {
        try {
          await local('/diagnostic', { method: 'POST', body: JSON.stringify({ message: lastBridgeError }) });
          await chrome.storage.local.remove('lastBridgeError');
        } catch { /* Older desktop versions may not support diagnostics yet. */ }
      }
      if (!task.id) continue;
      let result;
      try { result = { data: await run(task) }; } catch (e) { result = { error: e.message, code: e.code }; }
      await local('/result', { method: 'POST', body: JSON.stringify({ id: task.id, ...result }) });
    }
  } catch (error) {
    await chrome.storage.local.set({ lastBridgeError: String(error.message).slice(0, 300) });
    // Report this error on the next successful connection.
  }
  finally { polling = false; }
}
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type !== 'pair' || sender.id !== chrome.runtime.id) return;
  (async () => {
    await registerObserver('gmail');
    await registerObserver('slack');
    await registerObserver('outlook');
    const result = await local('/pair', { method: 'POST', body: '{}' });
    await chrome.storage.local.set({ token: result.token });
    // Confirm the saved pairing immediately instead of waiting for the next poll.
    await local('/status');
    respond({ ok: true }); poll();
  })().catch(e => respond({ error: e.message }));
  return true;
});
chrome.alarms.create('poll', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(poll);
poll();

for (const id of Object.keys(observers)) {
  registerObserver(id).catch(error => console.error(`${observers[id].name} observer setup failed:`, error.message));
}
