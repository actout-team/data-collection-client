import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ensureAsset, runtimeTarget, validateArchivePaths, runtimeInventory } from '../src/protection/managed-assets.mjs';
import { startGeneratorProcess } from '../src/protection/generator-process.mjs';
const content = Buffer.from('a fixed synthetic model asset');
const asset = { name: 'model.gguf', url: 'https://example.test/pinned-model', size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
async function temp(t) { const dir = await mkdtemp('/tmp/agentsim-runtime-test-'); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const partial = dir => dir + '/' + asset.name + '.' + asset.sha256.slice(0,12) + '.partial';
test('Verified asset installs automatically, uses private permissions and works offline on reuse', async t => {
  const dir = await temp(t); let requests = 0;
  const file = await ensureAsset(dir, asset, { fetchAsset: async url => { assert.equal(url,asset.url); requests++; return new Response(content); } });
  assert.deepEqual(await readFile(file), content);
  assert.equal(await ensureAsset(dir, asset, { fetchAsset: async () => { throw Error('must stay offline'); } }), file);
  assert.equal(requests,1); assert.deepEqual(await readdir(dir),['model.gguf']);
});
test('Interrupted downloads resume at the exact verified range and finish with SHA-256 validation', async t => {
  const dir=await temp(t); await writeFile(partial(dir),content.subarray(0,8));
  await ensureAsset(dir,asset,{ fetchAsset: async (_url,options) => {
    assert.equal(options.headers.Range,'bytes=8-');
    return new Response(content.subarray(8),{status:206,headers:{'content-range':`bytes 8-${content.length-1}/${content.length}`}});
  }});
  assert.deepEqual(await readFile(dir+'/model.gguf'),content);
});
test('Servers ignoring Range restart safely and malformed ranges never publish', async t => {
  const dir=await temp(t);await writeFile(partial(dir),content.subarray(0,8));
  await assert.rejects(ensureAsset(dir,asset,{fetchAsset:async()=>new Response(content,{status:206,headers:{'content-range':'bytes 0-5/6'}})}),/resume/);
  await ensureAsset(dir,asset,{fetchAsset:async()=>new Response(content)});
  assert.deepEqual(await readFile(dir+'/model.gguf'),content);
});
test('Corrupt downloads and oversized bytes cannot be published or executed', async t => {
  const dir=await temp(t);
  await assert.rejects(ensureAsset(dir,asset,{fetchAsset:async()=>new Response('x'.repeat(content.length))}),/integrity/);
  assert.deepEqual(await readdir(dir),[]);
  await assert.rejects(ensureAsset(dir,asset,{fetchAsset:async()=>new Response('x'.repeat(content.length+1))}),/size/);
  assert.ok(!(await readdir(dir)).includes('model.gguf'));
});
test('Cancellation keeps resumable bytes and releases the setup lock', async t => {
  const dir=await temp(t),controller=new AbortController();
  await assert.rejects(ensureAsset(dir,asset,{signal:controller.signal,fetchAsset:async()=>new Response(new ReadableStream({start(c){c.enqueue(content.subarray(0,8));c.enqueue(content.subarray(8));c.close();}})),progress:e=>{if(e.phase.includes('MB'))controller.abort(Error('stop'));}}),/stop/);
  assert.equal((await readFile(partial(dir))).length,8);
  assert.ok(!(await readdir(dir)).some(f=>f.endsWith('.lock')));
});
test('Cached corruption is redownloaded and active download locks are respected', async t => {
  const dir=await temp(t);await writeFile(dir+'/model.gguf','broken');
  await writeFile(dir+'/model.gguf.lock',String(process.pid));
  await assert.rejects(ensureAsset(dir,asset),/already in progress/);
  await rm(dir+'/model.gguf.lock');await ensureAsset(dir,asset,{fetchAsset:async()=>new Response(content)});
  assert.deepEqual(await readFile(dir+'/model.gguf'),content);
});
test('Runtime selection includes Metal and bundled CUDA dependencies with explicit CPU mode', () => {
  assert.equal(runtimeTarget('darwin','arm64').gpu,'metal');assert.equal(runtimeTarget('darwin','x64',{cpu:true}).gpu,'cpu');
  assert.deepEqual(runtimeTarget('linux','x64',{nvidia:true}),{id:'ubuntu-cuda-12.8-x64',dependency:'cuda-linux',gpu:'cuda'});
  assert.equal(runtimeTarget('win32','x64',{nvidia:true}).dependency,'cuda-windows');
  assert.equal(runtimeTarget('linux','x64',{cpu:true,nvidia:true}).gpu,'cpu');assert.throws(()=>runtimeTarget('unknown','x64'),/support/);
});
test('Archive traversal and absolute paths are rejected before extraction', () => {
  assert.deepEqual(validateArchivePaths('llama/\nllama/llama-server\n'),['llama/','llama/llama-server']);
  for(const p of ['../escape','/tmp/escape','C:/escape','a/../../escape','a\\escape'])assert.throws(()=>validateArchivePaths(p),/Unsafe/);
});
test('Managed child process starts, returns a response and shuts down without leaving a service', async t => {
  const dir=await temp(t);const file=dir+'/worker.mjs';
  await writeFile(file,"process.on('message',m=>{if(m.init)process.send({info:{backend:'cpu'}});else if(m.body)process.send({result:{echo:m.body}});else if(m.close){process.send({closed:true});process.disconnect();}});");
  const runtime=await startGeneratorProcess({}, {workerURL:pathToFileURL(file)});
  try{assert.deepEqual(await runtime.generate({hello:'world'}),{echo:{hello:'world'}});}finally{await runtime.close();}
});
test('Aborting an in-flight generation terminates the managed process', async t => {
  const dir=await temp(t);const file=dir+'/worker.mjs';await writeFile(file,"process.on('message',m=>{if(m.init)process.send({info:{backend:'cpu'}});});");
  const controller=new AbortController();const runtime=await startGeneratorProcess({}, {workerURL:pathToFileURL(file),signal:controller.signal});
  const pending=runtime.generate({hello:'world'});controller.abort(Error('cancelled'));
  await assert.rejects(pending,/cancelled/);await runtime.close();
});

test('Runtime inventory supports macOS /tmp aliases but rejects links outside the installation', async t => {
  const root=await temp(t); await writeFile(root+'/engine','binary'); await symlink('engine',root+'/engine-link');
  const files=await runtimeInventory(root); assert.equal(files.length,2); assert.equal(files.find(f=>f.link).link,'engine');
  await symlink('/etc/hosts',root+'/escape'); await assert.rejects(runtimeInventory(root),/escapes/);
});
