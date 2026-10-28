import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
let server, exited, directory, base, secret, ready = false, dead = false;
const send = value => { if (process.connected) process.send(value, () => {}); };
async function freePort() {
  const listener = createServer();
  await new Promise((resolve,reject) => { listener.once('error',reject); listener.listen(0,'127.0.0.1',resolve); });
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
async function libraryDirectories(root) {
  const found = new Set();
  async function walk(dir) { for (const item of await readdir(dir,{withFileTypes:true})) { const file=path.join(dir,item.name); if(item.isDirectory()) await walk(file); else if(/\.(?:so(?:\..*)?|dll|dylib)$/i.test(item.name)) found.add(dir); } }
  await walk(root); return [...found];
}
async function cleanup() {
  if (server && !dead) server.kill('SIGKILL');
  await exited; if (directory) await rm(directory,{recursive:true,force:true});
}
process.once('disconnect', () => { cleanup().finally(() => process.exit()); });
process.once('SIGTERM', () => { cleanup().finally(() => process.exit()); });
process.on('exit', () => { if(server && !dead) server.kill('SIGKILL'); });
async function start(config) {
  const { executable, model, root, target, runtimeDirectory } = config;
  directory = await mkdtemp(path.join(root,'session-'));
  secret = randomBytes(32).toString('hex'); const keyfile=path.join(directory,'key'); await writeFile(keyfile,secret,{mode:0o600,flag:'wx'});
  const port=await freePort(); base=`http://127.0.0.1:${port}`;
  const env={...process.env}; for(const key of Object.keys(env)) if(/^LLAMA_|^HF_TOKEN$/.test(key)) delete env[key];
  const libdirs=await libraryDirectories(runtimeDirectory);
  if(process.platform==='linux') env.LD_LIBRARY_PATH=[...libdirs,env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
  if(process.platform==='win32') env.PATH=[...libdirs,env.PATH].filter(Boolean).join(path.delimiter);
  // b11658 maps core LLAMA_LOG_INFO allocation records to trace verbosity 4.
  // Level 3 hides the very evidence required by the GPU verification below.
  const args=['--model',model,'--host','127.0.0.1','--port',String(port),'--api-key-file',keyfile,'--ctx-size','2048','--parallel','1','--threads',String(Math.max(1,Math.min(4,os.availableParallelism()))),'--gpu-layers',target.gpu==='cpu'?'0':'99','--offline','--no-webui','--no-slots','--no-context-shift','--reasoning','off','--log-verbosity','4','--log-colors','off','--no-log-jsonl'];
  // Zero model layers alone still lets llama.cpp initialize GPU KV/ops.
  if (target.gpu === 'cpu') args.push('--device', 'none', '--no-kv-offload', '--no-op-offload');
  const startup={stdout:'',stderr:''}; let gpuLayers=0;
  send({log:`Starting replacement runtime: ${target.gpu}. Verifying model-layer allocation.`});
  server=spawn(executable,args,{env,cwd:path.dirname(executable),windowsHide:true,stdio:['ignore','pipe','pipe']});
  exited=new Promise(resolve=>server.once('close',()=>{dead=true;send({nativeExited:true});resolve();}));
  server.on('error',()=>{dead=true;});
  if (server.pid) send({nativePid:server.pid});
  for (const stream of ['stdout','stderr']) server[stream].on('data',chunk=>{
    // Only parse startup allocation diagnostics. Never retain inference text.
    if(ready)return; startup[stream]=(startup[stream]+chunk.toString()).slice(-16000);
    for(const match of startup[stream].matchAll(/offloaded (\d+)\/\d+ layers to GPU/g))gpuLayers=Math.max(gpuLayers,Number(match[1]));
  });
  const deadline=Date.now()+110000;
  while(Date.now()<deadline && !dead) {
    try {
      const response=await fetch(base+'/health',{headers:{Authorization:`Bearer ${secret}`},redirect:'error',signal:AbortSignal.timeout(1500)});
      if(response.ok && (await response.json()).status==='ok') {
        if(target.gpu!=='cpu' && !gpuLayers) throw Error('GPU allocation was not verified.');
        ready=true;startup.stdout='';startup.stderr='';send({log:`Replacement runtime ready: ${target.gpu}, ${gpuLayers} GPU layers.`});
        return {backend:target.gpu,gpuLayers};
      }
    } catch(error) { if(error.message==='GPU allocation was not verified.') throw error; }
    await delay(150);
  }
  throw Error(dead?'Managed local AI runtime failed to start. Check available memory and graphics drivers.':'Managed local AI startup timed out.');
}
async function generate(body) {
  if(!ready||dead)throw Error('Managed local AI runtime is unavailable.');
  const response=await fetch(base+'/v1/chat/completions',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify(body),signal:AbortSignal.timeout(110000)});
  if(!response.ok)throw Error('Managed local AI rejected the replacement request.');
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>65536)throw Error('Managed local AI response exceeded its limit.');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
process.on('message',async message=>{
  try {
    if(message.close){await cleanup();send({closed:true});process.disconnect();}
    else if(message.init){send({info:await start(message.init)});}
    else if(message.body){send({result:await generate(message.body)});}
  } catch(error) {
    // Do not return server response bodies or native stderr, which may contain data.
    const safe=/^(?:Managed local AI|GPU allocation)/.test(error.message)?error.message:'Managed local AI failed. Retry protection.';
    send({error:safe});
    if(!ready)await cleanup();
  }
});
