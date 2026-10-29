import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createNeural} from '../src/protection/neural.mjs';
import {runBenchmark} from './benchmark/run.mjs';
import {hash,compareBaseline} from './benchmark/score.mjs';
const options={};
for(let i=2;i<process.argv.length;i++){const key=process.argv[i];if(['--check','--write-baseline'].includes(key))options[key]=true;else if(['--dataset','--baseline','--report','--backend','--precision','--cache'].includes(key)&&process.argv[i+1]&&!process.argv[i+1].startsWith('--'))options[key]=process.argv[++i];else throw Error('Unknown or incomplete benchmark argument.');}
if(options['--check']&&options['--write-baseline'])throw Error('Baseline creation and regression checking are separate actions.');
const datasetPath=options['--dataset'] || process.env.ACTOUT_BENCHMARK_DATASET || 'benchmarks/public-controls.json';
const baselinePath=options['--baseline'] || process.env.ACTOUT_BENCHMARK_BASELINE || 'benchmarks/public-controls.cpu-uint8.baseline.json';
const reportPath=options['--report'] || '.local/benchmark/latest.json';
const data=JSON.parse(await readFile(datasetPath,'utf8'));
const code=[];
for(const dir of ['src/protection','scripts/benchmark'])for(const name of (await readdir(dir)).sort())if(name.endsWith('.mjs'))code.push(name,await readFile(path.join(dir,name),'utf8'));
code.push(await readFile('src/account-owner.mjs','utf8'),await readFile('ui/protection-options.mjs','utf8'));
let neural;
try {
  neural=await createNeural({directory:options['--cache'] || process.env.ACTOUT_TEST_MODEL_CACHE || path.join(os.tmpdir(),'actout-neural-cache'),categories:data.categories || ['names','companies','emails','phones','addresses','secrets','identifiers'],preference:options['--backend'] || 'cpu',precision:options['--precision']});
  const report=await runBenchmark(data,neural,{sourceRevision:hash(code.join('\0'))});
  await mkdir(path.dirname(reportPath),{recursive:true,mode:0o700});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  if(options['--write-baseline'])await writeFile(baselinePath,JSON.stringify({version:1,datasetSha256:report.datasetSha256,signature:report.signature,sourceRevision:report.sourceRevision,summary:report.summary,failures:report.failures,coverage:report.coverage},null,2)+'\n',{flag:'wx',mode:0o600});
  const regressions=options['--check'] ? compareBaseline(report,JSON.parse(await readFile(baselinePath,'utf8'))) : [];
  console.log(JSON.stringify({dataset:report.dataset,signature:report.signature,summary:report.summary,baselineChecked:Boolean(options['--check']),regressions:options['--check'] ? regressions : null,report:reportPath},null,2));
  if(regressions.length)process.exitCode=1;
}finally{await neural?.close();}
