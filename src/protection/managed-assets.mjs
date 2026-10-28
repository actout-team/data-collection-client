import { mkdir, open, rename, rm, lstat, readFile, readdir, readlink, realpath, chmod, writeFile } from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { GENERATOR_MODEL, RUNTIME_ASSETS, RUNTIME_VERSION } from './generator-assets.mjs';
const run = promisify(execFile);
export async function digestFile(file, signal) {
  try {
    const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Unexpected entry in the local model cache.');
    const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) { signal?.throwIfAborted(); hash.update(chunk); }
    return hash.digest('hex');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function cacheLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close();
      return () => rm(file, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(file, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { await rm(file, { force: true }); continue; } }
      }
      throw Error('Local AI setup is already in progress in another Collect process. Close that process and retry.');
    }
  }
  throw Error('Could not acquire the local AI cache lock.');
}
export async function ensureAsset(directory, asset, { signal, progress = () => {}, fetchAsset = fetch, phase = 'Downloading local AI', timeoutMs = 1800000 } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, asset.name);
  progress({ phase: 'Verifying cached ' + asset.name, percent: 0 });
  if (await digestFile(destination, signal) === asset.sha256) return destination;
  const unlock = await cacheLock(destination + '.lock');
  const partial = destination + '.' + asset.sha256.slice(0, 12) + '.partial';
  try {
    signal?.throwIfAborted();
    let offset = 0;
    try { const stat = await lstat(partial); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Unexpected partial download entry.'); offset = stat.size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (offset > asset.size) { await rm(partial); offset = 0; }
    if (offset === asset.size) {
      if (await digestFile(partial, signal) === asset.sha256) { await rename(partial, destination); return destination; }
      await rm(partial); offset = 0;
    }
    const combined = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    const response = await fetchAsset(asset.url, { signal: combined, headers: offset ? { Range: `bytes=${offset}-` } : {} });
    if (!response.ok || !response.body) throw Error('Local AI download failed. Check the connection and retry; partial downloads are retained.');
    if (offset && response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      if (!range || Number(range[1]) !== offset || Number(range[2]) !== asset.size - 1 || Number(range[3]) !== asset.size) throw Error('Unexpected download resume response.');
    } else if (response.status === 200) offset = 0;
    else throw Error('Unexpected local AI download response.');
    const handle = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (offset ? constants.O_APPEND : constants.O_TRUNC), 0o600);
    let bytes = offset, lastPercent = -1;
    try {
      for await (const chunk of response.body) {
        signal?.throwIfAborted(); bytes += chunk.byteLength;
        if (bytes > asset.size) throw Error('Local AI download exceeds the pinned size.');
        await handle.writeFile(chunk);
        const percent = Math.floor(bytes / asset.size * 100);
        if (percent !== lastPercent) { lastPercent = percent; progress({ phase: `${phase} (${Math.floor(bytes / 1048576)}/${Math.ceil(asset.size / 1048576)} MB)`, percent: Math.min(99, percent) }); }
      }
    } finally { await handle.close(); }
    progress({ phase: 'Verifying downloaded ' + asset.name, percent: 99 });
    if (bytes !== asset.size || await digestFile(partial, signal) !== asset.sha256) { await rm(partial, { force: true }); throw Error('Local AI integrity check failed. Retry to download a fresh copy.'); }
    signal?.throwIfAborted(); await rename(partial, destination); return destination;
  } finally { await unlock(); }
}
export function runtimeTarget(platform, arch, { cpu = false, nvidia = false } = {}) {
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return { id: `macos-${arch}`, gpu: cpu ? 'cpu' : 'metal' };
  if (platform === 'linux' && ['arm64', 'x64'].includes(arch)) return !cpu && nvidia && arch === 'x64' ? { id: 'ubuntu-cuda-12.8-x64', dependency: 'cuda-linux', gpu: 'cuda' } : { id: `ubuntu-${arch}`, gpu: 'cpu' };
  if (platform === 'win32' && ['arm64', 'x64'].includes(arch)) return !cpu && nvidia && arch === 'x64' ? { id: 'win-cuda-12.4-x64', dependency: 'cuda-windows', gpu: 'cuda' } : { id: `win-cpu-${arch}`, gpu: 'cpu' };
  throw Error(`Automatic local AI setup does not support ${platform}/${arch}.`);
}
export async function detectRuntimeTarget(preference = 'auto') {
  if (!['auto','cpu'].includes(preference)) throw Error('Replacement backend must be auto or cpu.');
  let nvidia = false;
  if (preference !== 'cpu' && ['linux','win32'].includes(process.platform)) {
    try { const { stdout } = await run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 5000, windowsHide: true }); nvidia = !!stdout.trim(); } catch { /* No accessible NVIDIA driver. */ }
  }
  return runtimeTarget(process.platform, process.arch, { cpu: preference === 'cpu', nvidia });
}
export function validateArchivePaths(listing) {
  const names = listing.split(/\r?\n/).filter(Boolean);
  if (!names.length || names.some(n => /[\\\x00-\x1f]/.test(n) || n.startsWith('/') || /^[a-z]:/i.test(n) || n.split('/').includes('..'))) throw Error('Unsafe local runtime archive paths.');
  return names;
}
export async function runtimeInventory(root) {
  const files = [], resolvedRoot = await realpath(root);
  async function visit(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.name === '.verified.json') continue;
      const file = path.join(dir, item.name), relative = path.relative(root, file);
      if (item.isSymbolicLink()) {
        const resolved = await realpath(file); if (!resolved.startsWith(resolvedRoot + path.sep)) throw Error('Runtime link escapes its directory.');
        files.push({ path: relative, link: await readlink(file) });
      } else if (item.isDirectory()) await visit(file);
      else if (item.isFile()) files.push({ path: relative, sha256: await digestFile(file) });
      else throw Error('Unexpected runtime filesystem entry.');
    }
  }
  await visit(root); return files.sort((a,b) => a.path.localeCompare(b.path));
}
export async function installRuntime(root, target, { signal, progress = () => {}, fetchAsset, runArchive = run } = {}) {
  const directory = path.resolve(root, 'runtimes', RUNTIME_VERSION + '-' + target.id);
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  const assets = [RUNTIME_ASSETS[target.id], ...(target.dependency ? [RUNTIME_ASSETS[target.dependency]] : [])];
  const expected = assets.map(a => a.sha256);
  const executableName = target.id.startsWith('win') ? 'llama-server.exe' : 'llama-server';
  async function verified() {
    try {
      const receipt = JSON.parse(await readFile(path.join(directory, '.verified.json'), 'utf8'));
      if (JSON.stringify(receipt.archives) !== JSON.stringify(expected)) return null;
      const files = await runtimeInventory(directory);
      if (JSON.stringify(files) !== JSON.stringify(receipt.files)) return null;
      const executable = files.find(f => path.basename(f.path) === executableName && f.sha256);
      return executable ? path.join(directory, executable.path) : null;
    } catch (error) { if (signal?.aborted) throw signal.reason; return null; }
  }
  const cached = await verified(); if (cached) { if (process.platform !== 'win32') await chmod(cached, 0o700); return cached; }
  const unlock = await cacheLock(directory + '.lock');
  const staging = directory + '.' + randomUUID() + '.partial';
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const asset of assets) {
      const archive = await ensureAsset(path.join(root, 'downloads'), asset, { signal, progress, fetchAsset, phase: 'Downloading local AI runtime' });
      const options = { signal, timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
      const { stdout } = await runArchive(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-tf', archive], options);
      validateArchivePaths(stdout); progress({ phase: 'Installing local AI runtime', percent: 0 });
      await runArchive(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archive, '-C', staging], options);
    }
    const files = await runtimeInventory(staging), executable = files.find(f => path.basename(f.path) === executableName && f.sha256);
    if (!executable) throw Error('Downloaded runtime does not contain the expected executable.');
    if (process.platform !== 'win32') await chmod(path.join(staging, executable.path), 0o700);
    await writeFile(path.join(staging, '.verified.json'), JSON.stringify({ archives: expected, files }), { mode: 0o600, flag: 'wx' });
    signal?.throwIfAborted(); await rm(directory, { recursive: true, force: true }); await rename(staging, directory);
    return path.join(directory, executable.path);
  } finally { await rm(staging, { recursive: true, force: true }); await unlock(); }
}
export async function ensureGenerator(root, options = {}) {
  if (!root || !path.isAbsolute(root)) throw Error('A private absolute runtime-cache directory is required.');
  const target = options.target || await detectRuntimeTarget(options.preference || 'auto');
  const executable = await installRuntime(root, target, options);
  const model = await ensureAsset(path.join(root, 'models', GENERATOR_MODEL.revision), GENERATOR_MODEL, { ...options, phase: 'Downloading replacement model' });
  return { executable, model, target, root, runtimeDirectory: path.resolve(root, 'runtimes', RUNTIME_VERSION + '-' + target.id) };
}
