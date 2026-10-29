import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('ESM entry finishes loading while Electron readiness is still pending', () => {
  // Electron emits ready only after its ESM entry has evaluated. Model that
  // ordering without a GUI so an accidental top-level wait cannot pass CI.
  const harness = `
    import vm from 'node:vm';
    import { readFile } from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
    const entry = pathToFileURL(process.argv[1]);
    let waited = false;
    const electron = {
      app: { requestSingleInstanceLock: () => true, on() {}, whenReady() { waited = true; return new Promise(() => {}); } },
      BrowserWindow: class {}, dialog: {}, ipcMain: {}, safeStorage: {}, shell: {}, clipboard: {}
    };
    const module = new vm.SourceTextModule(await readFile(entry, 'utf8'), {
      initializeImportMeta(meta) { meta.url = entry.href; }
    });
    await module.link(async specifier => {
      const exports = specifier === 'electron' ? electron : specifier === './app-settings.mjs' ? { configureApp() {} } : await import(specifier.startsWith('node:') ? specifier : new URL(specifier, entry).href);
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      });
    });
    const timer = setTimeout(() => { console.error('Entry waits for ready before it finishes loading.'); process.exit(1); }, 1000);
    await module.evaluate();
    clearTimeout(timer);
    if (!waited) throw Error('Startup did not schedule readiness.');
    console.log('Entry loaded without waiting for ready.');
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', harness, fileURLToPath(new URL('../src/main.mjs', import.meta.url))], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Entry loaded without waiting for ready/);
});
