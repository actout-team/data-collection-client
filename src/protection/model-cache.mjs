import { mkdir, readFile, open, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { errorDetail } from './diagnostics.mjs';
import { MODEL } from './model-config.mjs';
async function digest(file) {
  const hash = createHash('sha256');
  try { for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function ensureModel(root, { signal, progress = () => {}, fetchModel = fetch, log = () => {}, model = MODEL } = {}) {
  log('info', `Checking model cache: ${model.id} @ ${model.revision.slice(0, 8)} (${model.precision}).`);
  progress({ phase: 'Checking local model', percent: 0 });
  const directory = path.join(root, model.revision);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of model.files) {
    signal?.throwIfAborted();
    const destination = path.join(directory, file.name);
    if (await digest(destination) === file.sha256) { log('info', `${file.name}: cached, SHA-256 verified.`); continue; }
    log('info', `${file.name}: missing or invalid. Downloading pinned asset.`);
    progress({ phase: 'Downloading local model', percent: 0 });
    const temporary = destination + '.' + randomUUID() + '.partial';
    let handle;
    try {
      const response = await fetchModel(`https://huggingface.co/${model.id}/resolve/${model.revision}/${file.remote}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
      if (!response.ok || !response.body) throw Error('Model download failed. Check your connection and retry.');
      handle = await open(temporary, 'wx', 0o600);
      let bytes = 0; const total = Number(response.headers.get('content-length'));
      const hash = createHash('sha256');
      for await (const chunk of response.body) {
        signal?.throwIfAborted(); bytes += chunk.length;
        if (bytes > (file.size || 64 * 1024 * 1024)) throw Error('Model download exceeds its size limit.');
        hash.update(chunk); await handle.writeFile(chunk);
        progress({ phase: 'Downloading local model', percent: total ? Math.min(99, Math.floor(bytes / total * 100)) : 0 });
      }
      if (hash.digest('hex') !== file.sha256) throw Error('Model integrity check failed. Retry protection.');
      await handle.close(); handle = null; signal?.throwIfAborted(); await rename(temporary, destination);
      log('info', `${file.name}: downloaded ${bytes} bytes, SHA-256 verified.`);
    } catch (error) {
      log('error', `${file.name} download failed: ${errorDetail(error)}`); throw error;
    } finally { await handle?.close(); await rm(temporary, { force: true }); }
  }
  // Parse only the fixed, integrity-verified tokenizer files. No remote code.
  JSON.parse(await readFile(path.join(directory, 'tokenizer.json'), 'utf8'));
  log('info', 'Local model cache verified. No download needed for cached assets.');
  return directory;
}
