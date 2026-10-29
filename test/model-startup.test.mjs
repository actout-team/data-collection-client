import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { startModelWorker } from '../src/protection/model-client.mjs';
import { preferredProvider, createBackend } from '../src/protection/model-backend.mjs';
import { modelError } from '../src/protection/diagnostics.mjs';
import { protectExport } from '../src/protection/index.mjs';
async function workerFixture(t, code) {
  const root = await mkdtemp('/tmp/actout-worker-test-'); t.after(() => rm(root, {recursive:true,force:true}));
  await writeFile(root+'/worker.mjs',code); return pathToFileURL(root+'/worker.mjs');
}
test('Worker import failures preserve the missing package and remediation',async t=>{
  const workerURL=await workerFixture(t,"import 'actout-missing-runtime-dependency';");
  await assert.rejects(startModelWorker({workerURL}),error=>error.message.includes('ERR_MODULE_NOT_FOUND') && error.message.includes('actout-missing-runtime-dependency') && error.message.includes('npm install'));
});
test('Unexpected worker exit is reported with its exit code',async t=>{
  const workerURL=await workerFixture(t,'process.exit(17)');
  await assert.rejects(startModelWorker({workerURL}),/exited with code 17/);
});
test('Worker log messages cannot accidentally resolve startup or inference requests',async t=>{
  const workerURL=await workerFixture(t,`process.once('message', () => {
    process.send({log:{level:'info',message:'loading'}});
    process.send({ready:true,backend:'coreml'});
    process.on('message',m=>{process.send({log:{level:'info',message:'working'}});process.send(m.close?{closed:true}:{spans:[{start:0,end:3,category:'names'}],backend:'coreml'});});});`);
  const logs=[];const worker=await startModelWorker({workerURL,log:(...row)=>logs.push(row)});
  try {assert.equal(worker.backend,'coreml');assert.equal((await worker.detect('Sam'))[0].category,'names');assert.equal(logs.length,2);} finally {await worker.close();}
});
test('Model errors fail protection without a rules-only copy or source changes',async t=>{
  const parent=await mkdtemp('/tmp/actout-model-fail-');t.after(()=>rm(parent,{recursive:true,force:true}));
  const source=parent+'/source';await mkdir(source);await writeFile(source+'/data.txt','private@example.com');
  const logs=[];let closed=false;
  await assert.rejects(protectExport({source,categories:['emails'],log:(level,message)=>logs.push(message),neural:{info:{backendLabel:'CPU'},discover:async()=>{throw Error('Synthetic inference failure');},close:async()=>{closed=true;}}}),/Synthetic inference failure/);
  assert.deepEqual(await readdir(parent),['source']);assert.ok(closed);assert.ok(logs.some(x=>x.includes('file 1/1')));assert.ok(!logs.join('\n').includes('private@example.com'));
});
test('Backend selection prefers direct GPU providers and permits explicit CPU selection',()=>{
  assert.equal(preferredProvider('darwin',['cpu','coreml','webgpu']),'webgpu');
  assert.equal(preferredProvider('linux',['cpu','cuda']),'cuda');
  assert.equal(preferredProvider('win32',['cpu','dml','webgpu']),'webgpu');
  assert.equal(preferredProvider('win32',['cpu','dml']),'dml');
  assert.equal(preferredProvider('darwin',['cpu']),'cpu');
  assert.equal(preferredProvider('darwin',['cpu','coreml'],'cpu'),'cpu');
});
test('Accelerator initialization and inference errors are not hidden by CPU retries',async()=>{
  const requested=[];const fake={listSupportedBackends:()=>[{name:'cpu',bundled:true},{name:'webgpu',bundled:true}],InferenceSession:{create:async(_,options)=>{requested.push(options);throw Error('Native initialization failed');}}};
  await assert.rejects(createBackend(fake,'unused',{platform:'darwin'}),/Native initialization failed/);assert.equal(requested.length,1);
  fake.InferenceSession.create=async()=>({run:async()=>{throw Error('Graph failed');},release:async()=>{}});
  const backend=await createBackend(fake,'unused',{platform:'darwin'});await assert.rejects(backend.run({}),/Graph failed/);await backend.close();
});
test('Diagnostic messages redact credentials and retain useful error codes',()=>{
  const text=modelError(Object.assign(Error('password=secret123 alice@example.com'),{code:'ERR_RUNTIME'}),'Model load');
  assert.ok(text.includes('ERR_RUNTIME'));assert.ok(!text.includes('secret123'));assert.ok(!text.includes('alice@example.com'));
});
test('Native process termination preserves the parent and cleans profiling files', async t => {
  const workerURL = await workerFixture(t, `import {writeFileSync} from 'node:fs';
    process.once('message', ({init}) => {
      writeFileSync(init.profileRoot + '/startup.json', '[]');
      process.send({log:{level:'info',message:init.profileRoot}});
      process.stderr.write('Failed to get a WebGPU adapter: No supported adapters.');
      process.kill(process.pid, 'SIGTERM');
    });`);
  let directory;
  await assert.rejects(startModelWorker({workerURL, log: (_, value) => {directory = value;}}), /No GPU adapter is available/);
  assert.ok(directory);
  await assert.rejects(readdir(directory), {code:'ENOENT'});
});
