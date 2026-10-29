import { readdir, access, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { aggregateReports } from './benchmark/aggregate.mjs';
const publicOnly=process.argv.slice(2).includes('--public-only');
if(process.argv.slice(2).some(arg=>arg!=='--public-only'))throw Error('Unknown validation argument.');
const privateDirectory=process.env.ACTOUT_PRIVATE_BENCHMARK || '.local/benchmark/private';
if(!publicOnly)await access(privateDirectory+'/ground-truth.private.json').catch(()=>{throw Error('Private ground truth is missing. Restore the saved benchmark bundle or explicitly run --public-only.');});
const privateSuites=publicOnly ? [] : (await readdir(privateDirectory)).filter(name=>/^ground-truth(?:\.[a-z0-9-]+)?\.private\.json$/.test(name)).sort();
let failed=false;
function run(args,{collect=false}={}){const result=spawnSync(process.execPath,args,{stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0){if(!collect)process.exit(result.status || 1);failed=true;}}
run(['scripts/check.mjs']);
run(['scripts/build-extension.mjs']);
run(['--test',...(await readdir('test')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'test/'+name)]);
for(const precision of ['uint8','float32']){
  const aggregatePath=`.local/benchmark/aggregate.cpu-${precision}.json`;
  await rm(aggregatePath,{force:true});
  const reportPaths=[`.local/benchmark/public.cpu-${precision}.json`];
  await rm(reportPaths[0],{force:true});
  run(['scripts/benchmark-protection.mjs','--precision',precision,'--baseline',`benchmarks/public-controls.cpu-${precision}.baseline.json`,'--report',`.local/benchmark/public.cpu-${precision}.json`,'--check'],{collect:true});
  for(const dataset of privateSuites){
    const suffix=dataset.slice('ground-truth'.length,-'.private.json'.length);
    await rm(`.local/benchmark/private${suffix}.cpu-${precision}.json`,{force:true});
    run(['scripts/benchmark-protection.mjs','--dataset',privateDirectory+'/'+dataset,'--precision',precision,'--baseline',`${privateDirectory}/baseline${suffix}.cpu-${precision}.json`,'--report',`.local/benchmark/private${suffix}.cpu-${precision}.json`,'--check'],{collect:true});
    reportPaths.push(`.local/benchmark/private${suffix}.cpu-${precision}.json`);
  }
  try {
    const aggregate={scope:publicOnly?'public-only':'all-current-suites',...aggregateReports(await Promise.all(reportPaths.map(async file=>JSON.parse(await readFile(file,'utf8')))))};
    await writeFile(aggregatePath,JSON.stringify(aggregate,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({scope:publicOnly?'public-only':'all-current-suites',report:aggregatePath,cases:aggregate.summary.cases,scoredRegions:aggregate.scoredRegions,metrics:aggregate.metrics,completeSensitiveCoverage:`${aggregate.summary.covered}/${aggregate.summary.sensitive}`}));
  } catch(error) { failed=true; console.error(`Could not aggregate ${precision}: ${error.message}`); }
}
if(failed)process.exitCode=1;
