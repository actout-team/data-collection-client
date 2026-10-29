import { hostPermissions } from './catalog.mjs';
const button = document.querySelector('#pair'), status = document.querySelector('#status');
document.querySelector('#version').textContent = `Extension ${chrome.runtime.getManifest().version}`;
button.onclick = async () => {
  button.disabled = true;
  try {
    if (!await chrome.permissions.request({ origins: [...new Set(hostPermissions)] })) throw Error('Website access was not granted.');
    status.textContent = 'Approve the pairing in ActOut Collect Client. This tab will stay open.';
    const reply = await chrome.runtime.sendMessage({ type: 'pair' });
    if (!reply?.ok) throw Error(reply?.error || 'The extension did not respond. Reload it at chrome://extensions and try again.');
    status.textContent = 'Paired. Return to ActOut Collect Client and choose Connect.';
  } catch (e) { status.textContent = `Pairing failed: ${e.message}. Make sure ActOut Collect Client is running.`; }
  finally { button.disabled = false; }
};
