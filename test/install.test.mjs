import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'collect-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project with spaces');
  const bin = path.join(root, 'bin');
  await mkdir(project);
  await mkdir(bin);
  await copyFile(new URL('../Install.command', import.meta.url), path.join(project, 'Install.command'));
  for (const name of ['package.json', 'package-lock.json']) await writeFile(path.join(project, name), '{}');
  const log = path.join(root, 'npm-calls');
  // Fake npm records the actual directory and prevents installation or app launch.
  await writeFile(path.join(bin, 'npm'), '#!/bin/bash\nprintf "%s:%s\\n" "$1" "$PWD" >> "$INSTALL_TEST_LOG"\nif [[ "$1" == ci ]]; then exit "${INSTALL_TEST_CI_STATUS:-0}"; fi\n');
  await chmod(path.join(bin, 'npm'), 0o755);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, INSTALL_TEST_LOG: log, INSTALL_TEST_CI_STATUS: String(options.ciStatus || 0) };
  return { root, project, bin, log, env };
}

test('Installer resolves its own folder with spaces before calling npm', async t => {
  const f = await fixture(t);
  const result = spawnSync('/bin/bash', [path.join(f.project, 'Install.command')], { cwd: tmpdir(), env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const lines = (await readFile(f.log, 'utf8')).trim().split('\n');
  assert.deepEqual(lines.map(line => line.split(':')[0]), ['ci', 'start']);
  assert.ok(lines.every(line => line.endsWith('/project with spaces')));
});

test('Installer recovers after its inherited working directory is deleted', async t => {
  const f = await fixture(t);
  const stale = path.join(f.root, 'removed');
  await mkdir(stale);
  const result = spawnSync('/bin/bash', ['-c', 'cd "$1" && rmdir "$1" && /bin/bash "$2"', 'test', stale, path.join(f.project, 'Install.command')], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(f.log, 'utf8'), /^ci:.*\/project with spaces\nstart:/);
});

test('Installer never starts the client when npm ci fails', async t => {
  const f = await fixture(t, { ciStatus: 17 });
  const result = spawnSync('/bin/bash', [path.join(f.project, 'Install.command')], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Dependency installation failed/);
  assert.equal((await readFile(f.log, 'utf8')).trim().split('\n').length, 1);
});

test('Installer explains denied Node directory access without invoking npm', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.bin, 'node'), '#!/bin/bash\nexit 1\n');
  await chmod(path.join(f.bin, 'node'), 0o755);
  const result = spawnSync('/bin/bash', [path.join(f.project, 'Install.command')], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node cannot access the project folder/);
  assert.match(result.stderr, /Files and Folders/);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});
