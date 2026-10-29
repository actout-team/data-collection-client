// Launch the real Electron entry with an isolated profile. No accounts are used.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import electron from 'electron';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'actout-desktop-'));
const { name, version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
try {
  await mkdir(path.join(temporary, 'app-data'));
  await symlink(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), 'dir');
  await writeFile(path.join(temporary, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'bootstrap.mjs' }));
  await writeFile(path.join(temporary, 'bootstrap.mjs'), `
    import { app, dialog } from 'electron';
    app.setPath('appData', ${JSON.stringify(path.join(temporary, 'app-data'))});
    dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
    app.on('browser-window-created', (_event, win) => {
      win.hide();
      win.webContents.once('did-finish-load', async () => {
        try {
          const title = await win.webContents.executeJavaScript('document.title');
          const state = await win.webContents.executeJavaScript("window.collect.action('state')");
          if (title !== 'ActOut Collect Client' || app.getName() !== title || !state.extensionFolder || !state.apps.gmail)
            throw Error('Desktop title, preload or bridge state is incorrect.');
          console.log('ACTOUT_DESKTOP_OK');
          app.quit();
        } catch (error) { console.error(error); app.exit(1); }
      });
    });
    import(${JSON.stringify(pathToFileURL(path.join(root, 'src/main.mjs')).href)})
      .catch(error => { console.error(error); app.exit(1); });
  `);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [temporary], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.code, 0, `Desktop exited with ${result.signal || result.code}.\n${output}`);
    assert.match(output, /ACTOUT_DESKTOP_OK/);
    console.log('Desktop window, preload and bridge state passed.');
  } finally { clearTimeout(timer); }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
