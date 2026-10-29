import { getCollector } from './connectors/index.mjs';
import { accountOwner } from './account-owner.mjs';
import { protectExport } from './protection/index.mjs';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, clipboard } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { apps, getApp, allowedSite } from '../extension/catalog.mjs';
import { createBridge } from './bridge.mjs';
import { createWriter, downloadStatus, jsonFile, pause, slackApi, daysBackWindow } from './export.mjs';
import { createProgress } from './progress.mjs';
import { createLog } from './log.mjs';
import { configureApp } from './app-settings.mjs';

process.umask(0o077);
configureApp(app);
const root = fileURLToPath(new URL('..', import.meta.url));
const extensionFolder = app.isPackaged ? path.join(process.resourcesPath, 'chrome-extension') : path.join(root, 'extension');
const activity = createLog();
const state = { extensionFolder, logs: activity.entries, apps: Object.fromEntries(apps.map(a => [a.id, { status: 'Disconnected' }])), busy: false, message: 'Pair the Chrome extension to begin.', output: '' };
let win, bridge, job, outputParent, estimator, estimateFile;
let estimateHistory = {};
const connections = new Map();
const emit = () => { if (win && !win.isDestroyed()) win.webContents.send('state', { ...state, transfer: estimator?.snapshot(), browserConnected: bridge?.connected() }); };
const log = (level, source, message) => { activity.add(level, source, message); emit(); };
const progress = message => { state.message = message; emit(); };
function begin() {
  if (job) throw Error('Wait for the current action or cancel it.');
  job = new AbortController(); state.busy = true; emit(); return job.signal;
}
function end() { job = null; state.busy = false; emit(); }
const request = (id, signal, expected) => task => bridge.ask({ ...task, app: id, expected }, signal);
async function identity(id, signal, expected) {
  const ask = request(id, signal, expected);
  return id === 'slack' ? slackApi(ask, 'auth.test', {}, signal) : ask({ op: 'identity' });
}
async function connect(id, hint) {
  if (!getApp(id) || (hint && !allowedSite(id, hint))) throw Error('Invalid connector URL.');
  const signal = begin(); connections.delete(id);
  log('info', id, 'Connect requested. Looking for the selected browser tab.');
  state.apps[id] = { status: 'Waiting for Chrome…' }; emit();
  try {
    const deadline = Date.now() + 180000;
    let lastError = 'Log in in the Chrome tab.';
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const found = await bridge.ask({ app: id, op: 'locate', hint, open: true }, signal);
      if (found.version !== app.getVersion()) throw Error(`Extension ${found.version || 'older build'} differs from desktop ${app.getVersion()}. In chrome://extensions reload ActOut Collect Client Bridge from the folder shown in Connect work browser, then retry Connect.`);
      if (found.choices) {
        log('info', id, 'Choose the browser tab in the account popup, even if only one is open.');
        state.apps[id] = { status: 'Choose the mailbox or workspace to connect.', choices: found.choices };
        emit();
        return;
      }
      if (found.waitingMessage) { lastError = found.waitingMessage; log('info', id, lastError); }
      if (found.ready) {
        log('info', id, 'Browser tab ready. Checking the session.');
        try {
          const account = await identity(id, signal);
          if (id === 'gmail') log('info', 'gmail', `Desktop ${app.getVersion()}, Gmail helper ${account.helperVersion || 'unknown'}.`);
          connections.set(id, account);
          log('info', id, account.mode === 'capture' ? 'Capture armed for 15 minutes. Browse records in the selected tab. Account identity and historical coverage are unverified.' : 'Authenticated session confirmed.');
          state.apps[id] = { status: 'Connected', account: account.account || `${account.user} · ${account.team}`, connected: true };
          progress(account.mode === 'capture' ? `${getApp(id).name} capture ready. Browse lists/details in that tab, then save the observed responses. Days back does not apply.` : `${getApp(id).name} connected. Select the apps to download.`); return;
        } catch (error) {
          if (error.code !== 'LOGIN_REQUIRED') throw error;
          lastError = error.message;
          log('info', id, lastError);
        }
      }
      state.apps[id].status = `Waiting for login: ${lastError}`; emit();
      await pause(2000, signal);
    }
    throw Error(`Connection timed out. ${lastError}`);
  } catch (error) { log(signal.aborted ? 'info' : 'error', id, error.message); state.apps[id] = { status: signal.aborted ? 'Connection cancelled' : error.message }; throw error; }
  finally { end(); }
}
async function download({ ids, days = 90 } = {}) {
  const window = daysBackWindow(days);
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !getApp(id) || !connections.has(id))) throw Error('Connect every selected app first.');
  const signal = begin();
  state.downloadResult = null; state.protectionResult = null; state.protection = null; state.output = '';
  estimator = createProgress(ids, window, estimateHistory); emit();
  log('info', 'app', `Download requested for ${ids.join(', ')}.`);
  let report, reportPath;
  try {
    for (const id of ids) { progress(`Checking ${getApp(id).name}…`); connections.set(id, await identity(id, signal, connections.get(id))); }
    const dir = path.join(outputParent, `collect-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    state.output = dir; reportPath = path.join(dir, 'report.json');
    report = { version: 1, daysBack: days, window, status: 'running', apps: {} };
    await jsonFile(reportPath, report);
    for (const id of ids) {
      if (signal.aborted) { report.apps[id] = { status: 'cancelled', messages: 0 }; continue; }
      const appDir = path.join(dir, id), writer = await createWriter(appDir);
      const stats = report.apps[id] = { status: 'running', account: connections.get(id), owner: accountOwner(id, connections.get(id)), messages: 0, channels: 0, warnings: [] };
      const ask = request(id, signal, connections.get(id));
      estimator.begin(id);
      let scanComplete = false;
      log('info', id, getApp(id).mode === 'capture' ? 'Saving observed API responses. Days back is NOT applied to experimental capture.' : `Collecting the last ${days} days: ${window.start} to ${window.end}.`);
      try {
        Object.assign(stats, await getCollector(id)({ ask, window, dir: appDir, writer, signal, progress, stats, meter: event => estimator.update(id, event), diagnostic: message => log('info', id, message) }));
        scanComplete = stats.scanComplete !== false;
      } catch (error) {
        stats.status = signal.aborted ? 'cancelled' : stats.messages ? 'partial' : 'failed'; stats.warnings.push(error.message);
      } finally {
        log(stats.status === 'failed' ? 'error' : stats.status === 'partial' ? 'warn' : 'info', id, `${stats.status}: ${stats.messages} ${stats.unit === 'api-responses' ? 'API responses' : stats.unit === 'records' ? 'records' : 'messages'} saved.`);
        if (stats.coverage) log(stats.status === 'partial' ? 'warn' : 'info', id, stats.coverage);
        for (const warning of stats.warnings.slice(-5)) log('warn', id, warning);
        await writer.close();
        await jsonFile(reportPath, report);
        estimator.finish(id, stats.status, scanComplete);
      }
    }
    report.status = downloadStatus(report.apps, signal.aborted);
    report.finishedAt = new Date().toISOString(); await jsonFile(reportPath, report);
    const count = Object.values(report.apps).reduce((sum, a) => sum + a.messages, 0);
    progress(report.status === 'failed' ? 'Download failed — no messages saved. See the Activity log below.' : `${report.status === 'finished' ? 'Download finished' : report.status === 'cancelled' ? 'Download cancelled' : 'Download saved with limitations'} — ${count} saved items. Open the folder for report.json.`);
  } catch (error) {
    log(signal.aborted ? 'info' : 'error', 'app', error.message);
    if (report) { report.status = signal.aborted ? 'cancelled' : 'partial'; report.error = error.message; await jsonFile(reportPath, report).catch(() => {}); }
    throw error;
  } finally {
    if (report && state.output) state.downloadResult = { status: report.status, saved: Object.values(report.apps).reduce((sum, a) => sum + (a.messages || 0), 0), ids: [...ids], days, owners: Object.values(report.apps).map(a => a.owner).filter(Boolean), output: state.output };
    for (const row of estimator.snapshot().apps) if (['queued', 'running'].includes(row.status)) estimator.finish(row.id, signal.aborted ? 'cancelled' : 'failed', false);
    if (estimateFile) await jsonFile(estimateFile, estimateHistory).catch(() => {});
    end();
  }
}

async function protect({ categories, namePreference = 'auto', generationMode = 'pools' } = {}) {
  const download = state.downloadResult;
  if (!download || !['finished', 'partial', 'cancelled'].includes(download.status) || (download.status === 'cancelled' && !download.saved)) throw Error('Download data first.');
  const signal = begin();
  state.protectionResult = null;
  state.protection = { phase: 'Scanning', percent: 0, files: 0, totalFiles: 0, values: 0 };
  try {
    state.protectionResult = await protectExport({ source: download.output, accountOwners: download.owners || [], categories, namePreference, generationMode, preference: process.env.ACTOUT_PROTECTION_BACKEND || 'auto', log: (level, message) => log(level, 'protection', message), modelDirectory: path.join(app.getPath('userData'), 'protection-model'), signal, progress: update => { state.protection = update; progress(`${update.phase} · ${update.percent}%`); } });
    state.output = state.protectionResult.output;
    const result = state.protectionResult;
    log(result.status === 'partial' ? 'warn' : 'info', 'protection', `${result.files} files copied; ${result.values} mapped values; ${result.replacements} replacements. ${result.reviewItems} items need review. Original files unchanged.`);
    progress(result.status === 'partial' ? 'Copy ready. Review unprocessed content.' : 'Protected copy ready.');
  } catch (error) {
    state.protection = { ...state.protection, phase: signal.aborted ? 'Aborted' : 'Failed' };
    throw error;
  } finally { end(); }
}

// Finish evaluating the entry module before waiting for Electron's ready event.
// A top-level await here prevents Electron from reaching ready at all.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.whenReady().then(start).catch(error => {
    console.error('ActOut Collect Client could not start:', error);
    log('error', 'app', error.message);
    dialog.showErrorBox('ActOut Collect Client could not start', error.message);
    app.exit(1);
  });
}

async function start() {
  console.info('ActOut Collect Client: opening window…');
  activity.add('info', 'app', `ActOut Collect Client ${app.getVersion()} starting.`);
  outputParent = app.isPackaged ? path.join(app.getPath('downloads'), 'ActOut Collect Client') : path.join(root, 'downloads');
  estimateFile = path.join(app.getPath('userData'), 'estimates.json');
  try { const saved = JSON.parse(await readFile(estimateFile, 'utf8')); if (saved && typeof saved === 'object' && !Array.isArray(saved)) estimateHistory = saved; } catch { /* First run: learn from current records. */ }
  const pairFile = path.join(app.getPath('userData'), 'bridge.private.json');
  let pairing;
  try { pairing = JSON.parse(safeStorage.decryptString(await readFile(pairFile))); } catch { /* First launch or Keychain unavailable. */ }
  win = new BrowserWindow({ width: 900, height: 800, minWidth: 700, minHeight: 650, backgroundColor: '#f5f7fa', webPreferences: { preload: path.join(root, 'src/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.setMenu(null);
  win.webContents.on('preload-error', (_event, _path, error) => log('error', 'ui', `Preload failed: ${error.message}`));
  win.webContents.on('did-fail-load', (_event, code, description) => log('error', 'ui', `Page load failed (${code}): ${description}`));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  try {
    bridge = await createBridge({
      pairing, onEvent: log,
      approve: async origin => {
        win.show(); win.focus();
        const result = await dialog.showMessageBox(win, { type: 'question', title: 'Pair Chrome', message: 'Allow this Chrome extension to connect?', detail: `Only approve immediately after clicking Pair in ActOut Collect Client Bridge.\nExtension ID: ${origin.split('://')[1]}\nIt can send data from the apps you select to this computer. Experimental apps capture API responses while you browse.`, buttons: ['Cancel', 'Pair'], defaultId: 0, cancelId: 0 });
        return result.response === 1;
      },
      savePairing: async value => {
        if (safeStorage.isEncryptionAvailable()) await writeFile(pairFile, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
        // Without Keychain encryption, keep the local pairing secret only in memory.
      }
    });
  } catch (error) { throw Error(`Local bridge could not start. Port 4319 may already be in use. ${error.message}`); }
  ipcMain.handle('action', async (event, action, payload) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return { error: 'Invalid sender' };
    try {
      if (action === 'state') return { ...state, transfer: estimator?.snapshot(), browserConnected: bridge?.connected(), folder: outputParent };
      if (action === 'connect') await connect(payload?.id, payload?.hint?.trim() || '');
      else if (action === 'download') await download(payload);
      else if (action === 'protect') await protect(payload);
      else if (action === 'copy-logs') clipboard.writeText(activity.text());
      else if (action === 'renderer-error') log('error', 'ui', String(payload).slice(0, 400));
      else if (action === 'cancel') { log('info', 'app', 'Cancellation requested.'); job?.abort(Error('Cancelled by user.')); progress('Cancelling…'); }
      else if (action === 'chrome-extensions') {
        await new Promise((resolve, reject) => execFile('/usr/bin/open', ['-a', 'Google Chrome', 'chrome://extensions/'], error => error ? reject(Error('Could not open Chrome. Paste chrome://extensions into its address bar.')) : resolve()));
      }
      else if (action === 'extension') {
        const error = await shell.openPath(extensionFolder);
        if (error) throw Error(`Could not open the extension folder: ${error}`);
      }
      else if (action === 'copy-extension-folder') clipboard.writeText(extensionFolder);
      else if (action === 'output' && !state.busy && state.protectionResult) await shell.openPath(state.protectionResult.output);
      else if (action === 'mapping' && !state.busy && state.protectionResult) shell.showItemInFolder(state.protectionResult.mapping);
      else if (action === 'protection-report' && !state.busy && state.protectionResult) await shell.openPath(state.protectionResult.report);
      else if (action === 'folder') {
        if (job) throw Error('Wait for the current action.');
        const choice = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
        if (!choice.canceled) outputParent = choice.filePaths[0];
      }
      return { ok: true, folder: outputParent };
    } catch (error) { log('error', 'app', error.message); progress(error.message); return { error: error.message }; }
  });
  await win.loadFile(path.join(root, 'ui/index.html'));
  console.info('ActOut Collect Client: window loaded.');
  log('info', 'app', 'Window loaded. Waiting for the Chrome extension.');
  let browserConnected = false;
  const heartbeat = setInterval(() => {
    const connected = bridge.connected();
    if (connected !== browserConnected) {
      browserConnected = connected;
      log(connected ? 'info' : 'warn', 'extension', connected ? 'Chrome bridge connected.' : 'Chrome bridge stopped responding. Check Chrome and the extension.');
    } else emit();
  }, 2000); heartbeat.unref();
  app.on('before-quit', () => { job?.abort(Error('Application closed.')); bridge?.close(); });
  win.on('close', event => {
    if (job) { event.preventDefault(); job.abort(Error('Window closed during collection.')); progress('Cancelling… Close again after the download stops.'); }
  });
  app.on('window-all-closed', () => app.quit());
}
