import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hash, validateDataset, scoreCase, summarize, failures, compareBaseline } from '../scripts/benchmark/score.mjs';
import { runBenchmark } from '../scripts/benchmark/run.mjs';
const region=(text,id,start,end,action)=>({id,start,end,action,reason:'Fixture label',category:action==='obfuscate'?'secrets':undefined,textSha256:hash(text.slice(start,end))});
function fixture(){const input='secret / owner / uncertain';return {id:'one',group:'thread',cohort:'synthetic',format:'text',input,inputSha256:hash(input),exhaustive:true,provenance:{derivation:'synthetic'},regions:[region(input,'secret',0,6,'obfuscate'),region(input,'owner',9,14,'retain-owner'),region(input,'review',17,26,'review')]};}
test('Scorer distinguishes full misses, partial leaks, overreach, exemptions and review-only edits',()=>{
 const c=fixture();
 const perfect=scoreCase(c,[{start:0,stop:6}]);assert.equal(perfect.covered,1);assert.equal(perfect.correctEdits,1);assert.deepEqual(failures([perfect]),[]);
 const partial=scoreCase(c,[{start:0,stop:3}]);assert.deepEqual(partial.missed,['secret']);assert.deepEqual(partial.partial,['secret']);assert.equal(partial.coverage.secret,3);
 const wide=scoreCase(c,[{start:0,stop:14}]);assert.equal(wide.covered,1);assert.equal(wide.unexpected.length,1);assert.deepEqual(wide.protectedChanges,['owner']);
 const review=scoreCase(c,[{start:17,stop:26}]);assert.equal(review.excludedEdits,1);assert.equal(review.unexpected.length,0);assert.equal(review.covered,0);
 assert.equal(summarize([scoreCase({...c,regions:[c.regions[1]]},[])]).completeSensitiveRecall,null);
});
test('Malformed, overlapping and stale labels are rejected before inference',()=>{
 const data={version:1,id:'test',cases:[fixture()]};assert.equal(validateDataset(data),data);
 for(const mutate of [d=>d.cases.push(fixture()),d=>d.cases[0].input+='x',d=>d.cases[0].regions[1].start=2,d=>d.cases[0].regions[0].action='unknown']){const changed=structuredClone(data);mutate(changed);assert.throws(()=>validateDataset(changed));}
});
test('Detection confusion counts use labeled regions, exclude review and keep partial leaks visible', () => {
 const c = fixture();
 const missed = scoreCase(c, []);
 const partial = scoreCase(c, [{ start: 0, stop: 3 }, { start: 9, stop: 10 }, { start: 17, stop: 26 }]);
 const summary = summarize([missed, partial]);
 assert.deepEqual(summary.detection, {
  unit: 'labeled-region', prediction: 'any-edit-overlap', TP: 1, FP: 1, TN: 1, FN: 1,
  TPR: 0.5, FPR: 0.5, TNR: 0.5, FNR: 0.5
 });
 assert.equal(summary.completeSensitiveRecall, 0);
 assert.deepEqual(partial.partial, ['secret']);
 const positives = summarize([scoreCase({ ...c, regions: [c.regions[0]] }, [])]).detection;
 assert.equal(positives.TPR, 0); assert.equal(positives.FNR, 1);
 assert.equal(positives.FPR, null); assert.equal(positives.TNR, null);
 const negatives = summarize([scoreCase({ ...c, regions: [c.regions[1]] }, [])]).detection;
 assert.equal(negatives.TPR, null); assert.equal(negatives.FNR, null);
 assert.equal(negatives.FPR, 0); assert.equal(negatives.TNR, 1);
 const split = { ...c, regions: [
  { ...region(c.input, 'first', 0, 3, 'obfuscate'), entity: 'shared' },
  { ...region(c.input, 'second', 3, 6, 'obfuscate'), entity: 'shared' }
 ] };
 const result = scoreCase(split, [{ start: 0, stop: 3 }]);
 assert.equal(result.sensitive, 1);
 assert.equal(result.detection.TP, 1); assert.equal(result.detection.FN, 1);
});
test('Baseline comparison rejects unlike runs and catches new failures and worse partial coverage',()=>{
 const base={version:1,datasetSha256:'a',signature:{precision:'uint8'},failures:['old'],coverage:{'case/entity':4}};
 assert.deepEqual(compareBaseline({...base,failures:['old','new'],coverage:{'case/entity':2}},base),['new','case/entity:reduced-coverage']);
 assert.throws(()=>compareBaseline({...base,datasetSha256:'b'},base),/differs/);
 assert.throws(()=>compareBaseline({...base,signature:{precision:'float32'}},base),/differs/);
});
test('Public corpus oracle scores perfectly and a mutation in every retained region is detected',async()=>{
 const corpus=validateDataset(JSON.parse(await readFile(new URL('../benchmarks/public-controls.json',import.meta.url))));
 for(const c of corpus.cases){
  const oracle=c.regions.filter(r=>r.action==='obfuscate').map(r=>({start:r.start,stop:r.end}));
  const result=scoreCase(c,oracle);assert.equal(result.covered,result.sensitive);assert.equal(result.unexpected.length,0);
  for(const r of c.regions.filter(r=>['ignore','retain-owner','retain-public'].includes(r.action))){const changed=scoreCase(c,[...oracle,{start:r.start,stop:r.end}]);assert.ok(changed.protectedChanges.includes(r.id));}
 }
});
test('Real format routing produces complete edit events, including CSV and nested HTML',async()=>{
 const data=JSON.parse(await readFile(new URL('../benchmarks/public-controls.json',import.meta.url)));
 const neural={info:{id:'test',revision:'fixture',precision:'test',backend:'test',threshold:0},async discoverMany(){}};
 const report=await runBenchmark(data,neural);
 const csv=report.results.find(r=>r.id==='csv');assert.equal(csv.covered,csv.sensitive);
 assert.ok(!JSON.stringify(report).includes('owner@example.org'));assert.ok(!JSON.stringify(report).includes('sunshine'));
});
