import { readdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const publicOnly=process.argv.slice(2).includes('--public-only');
if(process.argv.slice(2).some(arg=>arg!=='--public-only'))throw Error('Unknown validation argument.');
const privateDirectory=process.env.AGENTSIM_PRIVATE_BENCHMARK || '.local/benchmark/private';
if(!publicOnly)await access(privateDirectory+'/ground-truth.private.json').catch(()=>{throw Error('Private ground truth is missing. Restore the saved benchmark bundle or explicitly run --public-only.');});
function run(args){const result=spawnSync(process.execPath,args,{stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status || 1);}
run(['scripts/check.mjs']);
run(['scripts/build-extension.mjs']);
run(['--test',...(await readdir('test')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'test/'+name)]);
for(const precision of ['uint8','float32']){
  run(['scripts/benchmark-protection.mjs','--precision',precision,'--baseline',`benchmarks/public-controls.cpu-${precision}.baseline.json`,'--report',`.local/benchmark/public.cpu-${precision}.json`,'--check']);
  if(!publicOnly)run(['scripts/benchmark-protection.mjs','--dataset',privateDirectory+'/ground-truth.private.json','--precision',precision,'--baseline',`${privateDirectory}/baseline.cpu-${precision}.json`,'--report',`.local/benchmark/private.cpu-${precision}.json`,'--check']);
}
