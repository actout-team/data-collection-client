import { getApp } from '../extension/catalog.mjs';
export function etaText(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return 'Estimating…';
  if (seconds < 60) return 'Less than a minute';
  if (seconds < 3600) return `About ${Math.ceil(seconds / 60)} min`;
  const minutes = Math.ceil(seconds / 60);
  return `About ${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

export function renderTransfer(value) {
  const panel = document.querySelector('#transfer');
  panel.hidden = !value;
  if (!value) return;
  panel.classList.toggle('running', value.active);
  const ended = value.apps.every(app => !['queued', 'running'].includes(app.status));
  document.querySelector('#transfer-title').textContent = value.complete ? 'Scan complete' : ended ? 'Download stopped' : 'Downloading';
  document.querySelector('#transfer-eta').textContent = ended ? (value.apps.some(app => app.status === 'partial') ? 'Partial' : value.complete ? 'Complete' : 'Partial files kept') : value.eta === null ? 'Estimating…' : `${etaText(value.eta)} remaining`;
  document.querySelector('#transfer-percent').textContent = `${value.percent}% estimated`;
  setBar(document.querySelector('#transfer-bar'), value.percent, value.active && value.percent === 0);
  const rows = document.querySelector('#transfer-apps');
  const key = value.apps.map(app => app.id).join(',');
  if (rows.dataset.apps !== key) {
    rows.dataset.apps = key; rows.replaceChildren();
    for (const app of value.apps) {
      const row = document.createElement('div'); row.className = 'transfer-app'; row.dataset.app = app.id;
      row.innerHTML = '<div class="transfer-line"><strong></strong><span class="app-eta"></span></div><div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="fill"></div></div><small></small>';
      row.querySelector('strong').textContent = getApp(app.id)?.name || app.id;
      row.querySelector('.track').setAttribute('aria-label', `${app.id} estimated progress`);
      rows.append(row);
    }
  }
  for (const app of value.apps) {
    const row = [...rows.children].find(row => row.dataset.app === app.id);
    const running = app.status === 'running';
    row.classList.toggle('running', running);
    const label = app.completed ? (app.status === 'partial' ? 'Partial' : 'Done') : app.status === 'queued' ? 'Queued' : running ? etaText(app.eta) : app.status === 'cancelled' ? 'Cancelled' : 'Stopped';
    row.querySelector('.app-eta').textContent = label;
    setBar(row.querySelector('.track'), app.percent, running && app.eta === null && app.percent === 0);
    const speed = app.secondsPerRecord === null ? '' : ` · ${app.secondsPerRecord.toFixed(1)} sec/record`;
    const units = app.totalUnits === null ? '' : ` · ${app.completedUnits}/${app.totalUnits} conversations`;
    if (getApp(app.id)?.mode === 'capture') {
      row.querySelector('.app-eta').textContent = running ? 'Saving captures' : app.status === 'queued' ? 'Queued' : 'Partial capture';
      row.querySelector('small').textContent = 'Live captures only. No date filter.';
      continue;
    }
    row.querySelector('small').textContent = `${app.records.toLocaleString()} saved${speed}${units}`;
  }
}
function setBar(bar, percent, learning) {
  bar.classList.toggle('learning', learning);
  if (learning) bar.removeAttribute('aria-valuenow');
  else bar.setAttribute('aria-valuenow', String(percent));
  bar.querySelector('.fill').style.width = `${learning ? 25 : percent}%`;
}
