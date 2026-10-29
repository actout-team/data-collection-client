import { protectionOptions, protectionMatches } from './protection-options.mjs';
import { nameStyleOptions } from '../src/protection/name-styles.mjs';
import { createAutoAdvance } from './auto-advance.mjs';
import { updateAccountDialog } from './account-dialog.mjs';
import { renderTransfer } from './progress.mjs';
import { catalog, steps, appPage, stepBlock, canReview, PAGE_SIZE } from './catalog.mjs';
let state = {}, selected = new Set(['slack', 'gmail']), step = 0, page = 1;
const $ = selector => document.querySelector(selector);
const cards = new Map(), stepButtons = [];
const autoAdvance = createAutoAdvance(go);
const protections = new Set(protectionOptions.map(option => option.id));
const replacementSettings = () => ({ namePreference: $('#name-style').value, generationMode: $('#generation-mode').value });
for (const [value, label] of nameStyleOptions) { const option = document.createElement('option'); option.value = value; option.textContent = label; $('#name-style').append(option); }
for (const id of ['#name-style', '#generation-mode']) $(id).onchange = () => render(state);
for (const option of protectionOptions) {
  const label = document.createElement('label'); label.className = 'protection-option';
  label.innerHTML = `<input type="checkbox" checked value="${option.id}"><span><strong>${option.label}</strong><small>${option.detail}</small></span>`;
  label.querySelector('input').onchange = event => { event.target.checked ? protections.add(option.id) : protections.delete(option.id); render(state); };
  $('#protection-options').append(label);
}
for (const [index, label] of steps.entries()) {
  const item = document.createElement('li'), button = document.createElement('button');
  button.innerHTML = `<span class="step-number">${index + 1}</span><span>${label}</span>`;
  button.onclick = () => go(index); item.append(button); $('#steps').append(item); stepButtons.push(button);
}
function cardFor(app) {
  if (cards.has(app.id)) return cards.get(app.id);
  const pending = app.maturity === 'pending', card = document.createElement('article');
  card.className = `app-card ${app.maturity}`;
  card.innerHTML = `<div class="card-main"><input type="checkbox" aria-label="Select ${app.name}"><div class="app-icon"><img src="icons/${app.id}.svg" alt="" width="30" height="30"></div><div class="app-info"><h3>${app.name}</h3><p class="category"></p></div>${app.maturity === 'tested' ? '' : `<span class="maturity ${app.maturity}">${app.statusLabel || (app.maturity === 'beta' ? 'Beta' : pending ? 'Pending' : 'Experimental')}</span>`}</div><p class="detail"></p><div class="card-bottom"><p class="connection" role="status"></p><button class="connect secondary">Connect</button></div>${pending ? '<span class="account-placeholder"></span>' : `<button class="account-settings link">Account…</button><dialog class="account-dialog" aria-labelledby="account-title-${app.id}"><div class="dialog-heading"><h3 id="account-title-${app.id}">Connect ${app.name}</h3><button class="close-account secondary" aria-label="Close account settings">×</button></div><select aria-label="Choose ${app.name} account" hidden></select><label class="account-label">Browser tab URL<input class="hint" type="url" placeholder="${app.name} tab URL" aria-label="${app.name} tab URL"></label><button class="connect-account primary">Connect</button></dialog>`}`;
  card.querySelector('.category').textContent = app.category;
  card.querySelector('.detail').textContent = app.detail;
  card.querySelector('[type=checkbox]').onchange = event => { event.target.checked ? selected.add(app.id) : selected.delete(app.id); render(state); };
  if (!pending) {
    const dialog = card.querySelector('dialog');
    const message = document.createElement('p');
    message.className = 'account-message'; message.setAttribute('role', 'status'); message.tabIndex = -1; message.hidden = true;
    dialog.querySelector('.dialog-heading').after(message);
    card.querySelector('.account-settings').onclick = () => dialog.showModal();
    card.querySelector('.close-account').onclick = () => dialog.close();
    card.querySelector('.connect-account').onclick = () => act('connect', { id: app.id, hint: card.querySelector('.hint').value });
    card.querySelector('.connect').onclick = () => act('connect', { id: app.id, hint: card.querySelector('.hint').value });
    card.querySelector('select').onchange = event => {
      if (event.target.value) { card.querySelector('.hint').value = event.target.value; act('connect', { id: app.id, hint: event.target.value }); }
    };
  }
  cards.set(app.id, card); return card;
}
function renderApps() {
  const result = appPage(catalog, $('#app-search').value, page); page = result.page;
  const list = $('#connectors'), key = result.items.map(a => a.id).join(',');
  if (list.dataset.items !== key) { list.dataset.items = key; list.replaceChildren(...result.items.map(cardFor)); }
  for (const app of result.items) {
    const card = cardFor(app), status = state.apps?.[app.id] || {}, pending = app.maturity === 'pending';
    card.querySelector('[type=checkbox]').checked = selected.has(app.id);
    card.querySelector('[type=checkbox]').disabled = !!state.busy || pending;
    const connection = card.querySelector('.connection');
    connection.textContent = pending ? '' : status.account || status.status || 'Not connected';
    connection.title = connection.textContent;
    card.classList.toggle('connected', !!status.connected);
    card.classList.toggle('selected', selected.has(app.id));
    card.querySelector('.connect').textContent = pending ? 'Pending' : status.connected ? 'Reconnect' : 'Connect';
    card.querySelector('.connect').disabled = pending || !!state.busy || !state.browserConnected;
    card.querySelector('.connect').hidden = pending;
    if (pending) continue;
    card.querySelector('.hint').disabled = !!state.busy;
    card.querySelector('.account-settings').disabled = !!state.busy;
    card.querySelector('.account-settings').textContent = status.choices?.length ? 'Choose tab…' : 'Account…';
    card.querySelector('.connect-account').disabled = !!state.busy || !state.browserConnected;
    const select = card.querySelector('select'); select.disabled = !!state.busy;
    const choices = JSON.stringify(status.choices || []);
    if (select.dataset.choices !== choices) {
      select.dataset.choices = choices; select.replaceChildren(new Option('Choose tab…', ''));
      for (const choice of status.choices || []) select.add(new Option(`${choice.title} — ${choice.url}`, choice.url));
    }
    select.hidden = !status.choices?.length;
    updateAccountDialog(card, status);
  }
  $('#no-apps').hidden = result.total > 0;
  $('#app-results').textContent = result.total ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, result.total)} of ${result.total} apps` : '0 apps';
  $('#page-number').textContent = `${page} / ${result.pages}`;
  $('#previous-page').disabled = page <= 1; $('#next-page').disabled = page >= result.pages;
  $('#selected-count').textContent = `${selected.size} selected`;
}
function block(index) {
  if (index === 2 && state.downloadResult && (state.downloadResult.days !== $('#days-back').valueAsNumber || [...selected].sort().join(',') !== [...state.downloadResult.ids].sort().join(','))) return 'Settings changed. Download again.';
  if (index === 3 && !protectionMatches(state, protections, replacementSettings())) return 'Create a copy with these protection settings.';
  return stepBlock(index, state, selected);
}
function reachable(target) {
  if (state.busy) return false;
  if (target <= step) return true;
  for (let i = step; i < target; i++) if (block(i)) return false;
  return true;
}
function go(target) {
  if (target < 0 || target >= steps.length || target === step || !reachable(target)) return;
  const direction = target > step ? 1 : -1;
  const current = document.querySelector(`.page[data-step="${step}"]`);
  current.getAnimations?.().forEach(animation => animation.cancel()); current.hidden = true;
  step = target; $('#pages').scrollTop = 0;
  const next = document.querySelector(`.page[data-step="${step}"]`); next.hidden = false;
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) next.animate([{ opacity: 0, transform: `translateY(${direction * 10}px)` }, { opacity: 1, transform: 'translateY(0)' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
  render(state); next.querySelector('h2').focus({ preventScroll: true });
}
async function act(name, payload) {
  try {
    const result = await window.collect.action(name, payload);
    if (result.error) showStatus(result.error);
    if (result.folder) { state.folder = result.folder; $('#folder').textContent = result.folder; }
    return result;
  } catch { showStatus('Desktop connection interrupted. Restart the app.'); }
}
function showStatus(message) {
  $('#status').textContent = message || 'Ready';
  $('#status').title = message || 'Ready';
  $('#status-detail').textContent = message || 'Ready';
}
function render(next) {
  state = { ...next, folder: next.folder || state.folder };
  renderTransfer(state.transfer); renderApps();
  $('#extension-path').textContent = state.extensionFolder || '';
  $('#bridge').textContent = state.browserConnected ? '● Connected' : 'Not connected';
  $('#bridge').classList.toggle('ready', !!state.browserConnected);
  $('.browser-card').classList.toggle('connected', !!state.browserConnected);
  $('#browser-state').textContent = state.browserConnected ? 'Connected' : 'Keep Chrome open.';
  stepButtons.forEach((button, index) => {
    button.disabled = !reachable(index);
    if (index === step) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    button.classList.toggle('past', index < step);
  });
  $('#previous-step').disabled = step === 0 || !!state.busy;
  $('#next-step').hidden = step === steps.length - 1;
  $('#next-step').disabled = !!block(step);
  $('#next-step').textContent = 'Next →';
  $('#next-step').title = state.busy ? '' : block(step);
  const chosen = catalog.filter(a => selected.has(a.id)), capture = chosen.some(a => a.mode === 'capture');
  $('#download-apps').textContent = chosen.length ? chosen.map(a => a.name).join(' · ') : 'No apps selected.';
  $('#capture-note').hidden = !capture;
  $('#download').disabled = !!stepBlock(1, state, selected);
  $('#days-back').disabled = !!state.busy;
  $('#download').textContent = 'Download';
  $('#choose').disabled = !!state.busy;
  $('#cancel').hidden = !state.busy;
  const protectedReady = protectionMatches(state, protections, replacementSettings());
  $('#output').disabled = !protectedReady;
  $('#mapping').disabled = !protectedReady;
  $('#export-report').disabled = !protectedReady;
  $('#name-style').disabled = !!state.busy; $('#generation-mode').disabled = !!state.busy;
  $('#generation-help').textContent = $('#generation-mode').value === 'local-model' ? 'Local AI sets itself up on first use (about 1.1 GB in addition to the detection models), then works offline. Spelling style is approximate.' : 'No additional replacement model. Unfamiliar names use spelling pools and may lose regional style.';
  $('#protect').disabled = !canReview(state) || !protections.size;
  $('#abort-protection').hidden = !state.busy;
  for (const input of $('#protection-options').querySelectorAll('input')) input.disabled = !!state.busy;
  const protection = state.protection, protectedResult = state.protectionResult;
  $('#protection-progress').hidden = !protection;
  $('#protection-phase').textContent = protection ? `${protection.phase}${protection.engine ? ` · ${protection.engine}` : ''}` : '';
  $('#protection-count').textContent = protection ? `${protection.percent}% · ${protection.files}/${protection.totalFiles} files` : '';
  $('#protection-bar').setAttribute('aria-valuenow', String(protection?.percent || 0));
  $('#protection-bar .fill').style.width = `${protection?.percent || 0}%`;
  $('#protection-result').textContent = protectedResult && !protectedReady && !state.busy ? 'Settings changed. Create a new copy.' : protectedResult ? `${protectedResult.values} values · ${protectedResult.replacements} replacements${protectedResult.reviewItems ? ` · ${protectedResult.reviewItems} items need review` : ''}` : '';
  $('#review-protection').hidden = !protectedResult;
  $('#review-protection').disabled = !!state.busy;
  showStatus(state.message);
  const result = state.protectionResult;
  $('#export-summary').textContent = result ? `${result.files.toLocaleString()} files copied` : 'No export yet';
  $('#export-detail').textContent = result ? `${result.status === 'finished' ? 'Replacements complete' : 'Review unprocessed content'}. ${result.values} mapped values.` : '';
  $('#export-path').textContent = result?.output || '';
  const lines = (state.logs || []).map(e => `${new Date(e.time).toLocaleTimeString()} [${e.source}] ${e.level.toUpperCase()} ${e.message}${e.count ? ` (×${e.count})` : ''}`).join('\n');
  if ($('#log').textContent !== lines) { $('#log').textContent = lines; $('#log').scrollTop = $('#log').scrollHeight; }
  if (state.folder) $('#folder').textContent = state.folder;
  // Completed results advance even when coverage or protection needs review.
  // Failed/cancelled operations stay here. Existing readiness checks still apply.
  autoAdvance({ step, ready: step < 4 && !block(step) && (step !== 2 || ['finished', 'partial'].includes(state.downloadResult?.status)) && (step !== 3 || ['finished', 'partial'].includes(state.protectionResult?.status)) });
}
$('#previous-step').onclick = () => go(step - 1);
$('#next-step').onclick = () => go(step + 1);
$('#app-search').oninput = () => { page = 1; renderApps(); };
$('#previous-page').onclick = () => { page--; renderApps(); };
$('#next-page').onclick = () => { page++; renderApps(); };
$('#copy-logs').onclick = async () => { const result = await act('copy-logs'); if (!result?.ok) return; $('#copy-logs').textContent = 'Copied'; setTimeout(() => { $('#copy-logs').textContent = 'Copy'; }, 1500); };
window.addEventListener('error', event => { window.collect.action('renderer-error', event.message).catch(() => {}); });
window.addEventListener('unhandledrejection', event => { window.collect.action('renderer-error', event.reason?.message || 'Unhandled UI error').catch(() => {}); });
$('#extension').onclick = () => act('extension');
$('#chrome-extensions').onclick = () => act('chrome-extensions');
$('#copy-extension-folder').onclick = async () => { const result = await act('copy-extension-folder'); if (result?.ok) { $('#copy-extension-folder').textContent = 'Copied'; setTimeout(() => { $('#copy-extension-folder').textContent = 'Copy path'; }, 1500); } };
$('#choose').onclick = () => act('folder');
$('#days-back').oninput = () => render(state);
$('#download').onclick = () => { if ($('#days-back').reportValidity()) return act('download', { ids: [...selected], days: $('#days-back').valueAsNumber }); };
$('#cancel').onclick = () => act('cancel');
$('#output').onclick = () => act('output');
$('#protect').onclick = () => act('protect', { categories: [...protections], ...replacementSettings() });
$('#abort-protection').onclick = () => act('cancel');
$('#mapping').onclick = () => act('mapping');
$('#review-protection').onclick = () => act('protection-report');
$('#export-report').onclick = () => act('protection-report');
window.collect.onState(render);
render(await window.collect.action('state'));
