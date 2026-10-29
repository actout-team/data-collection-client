import { createDetector } from '../../src/protection/detect.mjs';
import { createOwnerPolicy } from '../../src/protection/account-owners.mjs';
import { jsonText } from '../../src/protection/formats.mjs';
import { valueText } from '../../src/protection/content.mjs';
import { htmlText, xmlText, csvText, edits } from '../../src/protection/structured.mjs';
import { hash, validateDataset, scoreCase, summarize, failures } from './score.mjs';
const allCategories=['names','companies','emails','phones','addresses','secrets','identifiers'];
export async function runBenchmark(data, neural, {sourceRevision='unknown'}={}) {
  validateDataset(data);
  let queued=[];
  const detector=createDetector(data.categories || allCategories,{ownerPolicy:createOwnerPolicy(data.owners || []),observe:text=>queued.push(text)});
  const warnings=new Map();
  function transform(c,mode,onEdits) {
    const warn=reason=>{if(!warnings.has(c.id))warnings.set(c.id,new Set());warnings.get(c.id).add(reason);};
    if(c.format==='json')return jsonText(c.input,detector,mode,c.context || '',warn,onEdits);
    if(c.format==='text')return valueText(c.input,detector,mode,c.key || '',c.context || '',warn,onEdits);
    return {html:htmlText,xml:xmlText,csv:csvText}[c.format](c.input,detector,mode,warn,onEdits);
  }
  // All cases form one export: production discovery shares value mappings.
  for(const c of data.cases){transform(c,'discover');await neural.discoverMany(queued,detector);queued=[];}
  await detector.prepare();detector.compile();
  const results=[];
  for(const c of data.cases){
    let changes=[];
    const output=transform(c,'replace',found=>{changes=found;});
    if(edits(c.input,[...changes])!==output) throw Error(`Incomplete edit instrumentation: ${c.id}`);
    results.push(scoreCase(c,changes,output));
  }
  const info=neural.info;
  return {version:1,dataset:data.id,datasetSha256:hash(JSON.stringify(data)),createdAt:new Date().toISOString(),sourceRevision,pipeline:info,signature:{model:info.id,revision:info.revision,precision:info.precision,backend:info.backend,threshold:info.threshold,categories:data.categories || allCategories},summary:summarize(results),cohorts:Object.fromEntries([...new Set(results.map(r=>r.cohort))].map(cohort=>[cohort,summarize(results.filter(r=>r.cohort===cohort))])),failures:failures(results),coverage:Object.fromEntries(results.flatMap(r=>Object.entries(r.coverage).map(([id,n])=>[r.id+'/'+id,n]))),results,warnings:[...warnings].map(([id,reasons])=>({id,reasons:[...reasons]})),candidates:{discovered:detector.entries.size,bySource:Object.fromEntries(['model','field-or-rule','identity-fields'].map(source=>[source,[...detector.entries.values()].filter(r=>r.detection.source===source).length])),unapplied:[...detector.entries.values()].filter(row=>!row.occurrences).length},limitations:['Single-author annotations, not independent human validation.','Cases are reviewed regression examples, not a representative unseen holdout.','Complete sensitive recall and edit precision use different units. No F1 or overall accuracy is claimed.','Review regions are excluded, not treated as negative labels.','Cases from one source group are correlated. This benchmark does not establish production recall.']};
}
