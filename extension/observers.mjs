// Shared by the extension worker and the dependency-free bundle builder.
export const observers = {
  gmail: {
    name: 'Gmail', id: 'gmail-api', matches: ['https://mail.google.com/*'],
    source: 'gmail-api.mjs', bundle: 'gmail-bundle.js', install: 'installGmailApi',
    property: '__actoutGmailApi', errorProperty: '__actoutGmailError'
  },
  slack: {
    name: 'Slack', id: 'slack-session', matches: ['https://*.slack.com/*'],
    source: 'slack-session.mjs', bundle: 'slack-bundle.js', install: 'installSlackSession',
    property: '__actoutSlackSession'
  },
  outlook: {
    name: 'Outlook', id: 'outlook-session', matches: ['https://outlook.live.com/*'],
    source: 'outlook-session.mjs', bundle: 'outlook-bundle.js', install: 'installOutlookSession',
    property: '__actoutOutlook'
  }
};

export function createObserverRegistration(chrome) {
  const pending = new Map();
  return async function register(id) {
    const observer = observers[id];
    if (!observer) throw Error(`Unknown observer: ${id}`);
    if (!await chrome.permissions.contains({ origins: observer.matches })) return;
    // Pairing and worker startup share one registration. Failed attempts can retry.
    if (!pending.has(id)) {
      const registration = (async () => {
        const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [observer.id] });
        const script = {
          id: observer.id, matches: observer.matches, js: [observer.bundle],
          world: 'MAIN', runAt: 'document_start'
        };
        if (existing.length) await chrome.scripting.updateContentScripts([script]);
        else await chrome.scripting.registerContentScripts([script]);
      })().catch(error => { pending.delete(id); throw error; });
      pending.set(id, registration);
    }
    return pending.get(id);
  };
}

// Old page hooks survive extension reloads. Refresh at most once per version.
export async function prepareObserverTab(chrome, tab, id) {
  const observer = observers[id];
  if (!observer) throw Error(`Unknown observer: ${id}`);
  const version = chrome.runtime.getManifest().version;
  const key = `${id}-refresh-${tab.id}`;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, world: 'MAIN',
    func: property => window[property]?.version || null,
    args: [observer.property]
  });
  if (result?.result === version) {
    await chrome.storage.session.remove(key);
    return true;
  }
  if ((await chrome.storage.session.get(key))[key] === version) {
    throw Error(`${observer.name} helper did not load after refresh (extension ${version}). Check site access, then reload the extension.`);
  }
  await chrome.storage.session.set({ [key]: version });
  await chrome.tabs.reload(tab.id);
  return false;
}
