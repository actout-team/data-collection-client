import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appName, configureApp } from '../src/app-settings.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'actout-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = {};
  const app = { getPath: () => root, setPath: (key, value) => { state[key] = value; }, setName: name => { state.name = name; } };
  return { root, app, state };
}

test('Fresh installs use the ActOut app name and data folder', async t => {
  const { root, app, state } = await fixture(t);
  configureApp(app);
  assert.equal(state.name, 'ActOut Collect Client');
  assert.equal(state.userData, path.join(root, appName));
});

for (const oldName of ['agentsim-collect', 'AgentSim Collect']) {
  test(`Renaming preserves existing data from ${oldName}`, async t => {
    const { root, app, state } = await fixture(t);
    const old = path.join(root, oldName);
    await mkdir(path.join(old, 'protection-model'), { recursive: true });
    await writeFile(path.join(old, 'protection-model', 'fixture'), 'cached model');
    configureApp(app);
    assert.equal(state.name, appName);
    assert.equal(state.userData, old);
    assert.equal(await readFile(path.join(state.userData, 'protection-model', 'fixture'), 'utf8'), 'cached model');
  });
}

test('Existing ActOut data takes precedence over a previous installation', async t => {
  const { root, app, state } = await fixture(t);
  await mkdir(path.join(root, 'agentsim-collect'));
  await mkdir(path.join(root, appName));
  configureApp(app);
  assert.equal(state.userData, path.join(root, appName));
});
