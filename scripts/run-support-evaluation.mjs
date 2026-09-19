import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildCorpus, corpusHash, CORPUS_SEED } from './support-evaluation-corpus.mjs';

const origin='https://zentraapp.ch';
const directory=resolve('outputs/support-evaluation-2000-20260920');
mkdirSync(directory,{recursive:true});
const tickets=buildCorpus(), hash=corpusHash(tickets);
const corpusPath=resolve(directory,'tickets.json'), resultPath=resolve(directory,'results.jsonl');
if(existsSync(corpusPath) && corpusHash(JSON.parse(readFileSync(corpusPath,'utf8')))!==hash)throw new Error('Corpus changed; use a separate evaluation directory.');
writeFileSync(corpusPath,JSON.stringify(tickets,null,2));
const metadata={seed:CORPUS_SEED,sha256:hash,total:2000,semanticFamilies:50,languages:['fr','de','it','en'],forms:10,threshold:85,policyVersion:'support-2026-09-19-v2',origin,expectedLabelsSentToProvider:false,externalAssignments:false};
writeFileSync(resolve(directory,'method.json'),JSON.stringify(metadata,null,2));

const previous=existsSync(resultPath)?readFileSync(resultPath,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
if(new Set(previous.map(r=>r.id)).size!==previous.length || previous.some(r=>r.corpusHash!==hash))throw new Error('Invalid checkpoint');
const finished=new Set(previous.map(r=>r.id));
const pending=tickets.filter(t=>!finished.has(t.id));
console.log(JSON.stringify({phase:'prepared',total:tickets.length,remaining:pending.length,corpusHash:hash}));
if(process.argv.includes('--prepare-only'))process.exit(0);
const token=readFileSync('C:/Users/alb/Documents/Zentra/Acces-prive-Support-20260919.txt','utf8').match(/zsa_[A-Za-z0-9_-]{64}/)?.[0];
if(!token)throw new Error('Private admin credential unavailable');
const auth=await fetch(origin+'/api/support/admin/session',{method:'POST',redirect:'error',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token}),signal:AbortSignal.timeout(20000)});
if(!auth.ok)throw new Error('Admin authentication failed: '+auth.status);
const cookie=auth.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
const headers={Origin:origin,'Content-Type':'application/json',Cookie:cookie};
let offset=0,completed=previous.length,fatal=null;
const results=[...previous], attempts=[];
const startedAt=new Date().toISOString();
async function worker(){
  while(offset<pending.length && !fatal){
    const batch=pending.slice(offset,offset+10); offset+=batch.length;
    const start=Date.now();
    try{
      const response=await fetch(origin+'/api/support',{method:'POST',redirect:'error',headers,body:JSON.stringify({action:'evaluateTestBatch',tickets:batch.map(({id,subject,body})=>({id,subject,body}))}),signal:AbortSignal.timeout(60000)});
      if(!response.ok)throw new Error('Evaluation HTTP '+response.status);
      const data=await response.json();
      if(data.policyVersion!==metadata.policyVersion || data.threshold!==85 || data.results?.length!==batch.length)throw new Error('Policy or result mismatch');
      for(const item of batch){
        const matches=data.results.filter(r=>r.id===item.id);
        if(matches.length!==1)throw new Error('Missing or duplicate result');
        const observed=matches[0];
        const row={...item,...observed,corpusHash:hash,checkedAt:new Date().toISOString()};
        results.push(row); appendFileSync(resultPath,JSON.stringify(row)+'\n');completed++;
      }
      attempts.push({ids:batch.map(t=>t.id),status:response.status,durationMs:Date.now()-start});
      if(completed%50===0 || completed===tickets.length)console.log(JSON.stringify({phase:'running',completed,total:tickets.length,unavailable:results.filter(r=>r.error).length,elapsedSeconds:Math.round((Date.now()-Date.parse(startedAt))/1000)}));
    }catch(error){fatal=error instanceof Error?error.message:'Evaluation failed';}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
}
await Promise.all([worker(),worker()]);
writeFileSync(resolve(directory,'requests-'+Date.now()+'.json'),JSON.stringify({startedAt,endedAt:new Date().toISOString(),attempts,fatal},null,2));
if(fatal)throw new Error(fatal+'; completed results retained for resuming.');
if(results.length!==2000)throw new Error('Incomplete run');
const valid=results.filter(r=>r.decision),automatic=valid.filter(r=>r.automatic);
const pct=(n,d)=>d?Math.round(n/d*10000)/100:null;
const correctCategory=r=>r.decision?.category===r.expected.category;
const correctPriority=r=>r.decision?.priority===r.expected.priority;
const joint=r=>correctCategory(r)&&correctPriority(r);
const correctAuto=r=>joint(r)&&!r.expected.mustReview;
const summarize=rows=>({total:rows.length,valid:rows.filter(r=>r.decision).length,categoryCorrect:rows.filter(correctCategory).length,priorityCorrect:rows.filter(correctPriority).length,bothCorrect:rows.filter(joint).length,automatic:rows.filter(r=>r.automatic).length,automaticWrongCategory:rows.filter(r=>r.automatic&&!correctCategory(r)).length,automaticWrongCategoryOrPriority:rows.filter(r=>r.automatic&&!joint(r)).length,mustReviewBypassed:rows.filter(r=>r.automatic&&r.expected.mustReview).length});
const grouped=key=>Object.fromEntries([...new Set(results.map(key))].sort().map(k=>[k,summarize(results.filter(r=>key(r)===k))]));
const distribution=key=>Object.fromEntries([...new Set(results.map(key))].sort().map(k=>[k,results.filter(r=>key(r)===k).length]));
const confusion={};for(const r of valid){confusion[r.expected.category]??={};confusion[r.expected.category][r.decision.category]=(confusion[r.expected.category][r.decision.category]||0)+1;}
const times=valid.map(r=>r.durationMs).sort((a,b)=>a-b);
const metrics=summarize(results);
const tokenCount=valid.reduce((s,r)=>s+r.decision.inputTokens,0);
const report={...metadata,startedAt,finishedAt:new Date().toISOString(),...metrics,unavailable:results.length-valid.length,
  categoryAccuracyAll:pct(metrics.categoryCorrect,results.length),categoryAccuracyValid:pct(metrics.categoryCorrect,valid.length),priorityAccuracyAll:pct(metrics.priorityCorrect,results.length),jointAccuracyAll:pct(metrics.bothCorrect,results.length),automaticShare:pct(automatic.length,results.length),automaticCategoryPrecision:pct(automatic.filter(correctCategory).length,automatic.length),automaticJointAndReviewPrecision:pct(automatic.filter(correctAuto).length,automatic.length),
  humanCases:results.filter(r=>r.expected.humanRequested).length,humanCasesAutomaticallyRouted:results.filter(r=>r.expected.humanRequested&&r.automatic).length,
  thresholdComparison:[85,90,95,99].map(threshold=>{const rows=valid.filter(r=>r.decision.category!=='other'&&r.decision.confidence>=threshold/100&&r.decision.signals?.humanRequested<0.2&&r.decision.destination?.teamId);return{threshold,automatic:rows.length,wrongCategory:rows.filter(r=>!correctCategory(r)).length,wrongCategoryOrPriority:rows.filter(r=>!joint(r)).length,reviewBypassed:rows.filter(r=>r.expected.mustReview).length};}),
  byLanguage:grouped(r=>r.language),byCategory:grouped(r=>r.expected.category),byForm:grouped(r=>r.form),expectedPriority:distribution(r=>r.expected.priority),confusion,
  modelVersions:[...new Set(valid.map(r=>r.decision.model))],policyVersions:[...new Set(valid.map(r=>r.decision.policyVersion))],inputTokens:tokenCount,estimatedProviderCostUsd:Math.round(tokenCount*0.042/1e6*1e6)/1e6,costSource:'https://docs.typesafe.ai/models',costCaveat:'Estimate from reported successful response tokens; unavailable calls may add usage. Not an invoice.',
  latencyMs:{median:times[Math.floor(times.length*.5)],p95:times[Math.min(times.length-1,Math.floor(times.length*.95))],max:times.at(-1)},
  limitations:['Synthetic templated corpus: 50 semantic scenarios x 4 languages x 10 forms; related examples are not independent.','Labels fixed before calls; subjective priority boundaries may require human adjudication.','Exact production classifier and routing gate with synthetic teams; no real Zendesk/Freshdesk/Gorgias assignment.','No prompt or threshold tuning during the run.','Not a measured time saving or an estimate of real customer traffic accuracy.']};
writeFileSync(resolve(directory,'summary.json'),JSON.stringify(report,null,2));
const failures=results.filter(r=>!joint(r)||r.expected.mustReview&&r.automatic||r.error);
writeFileSync(resolve(directory,'errors.json'),JSON.stringify(failures,null,2));
const columns=['id','language','form','expectedCategory','actualCategory','expectedPriority','actualPriority','automatic','confidence','mustReview','humanRequested','durationMs','error'];
const csv=[columns,...results.map(r=>[r.id,r.language,r.form,r.expected.category,r.decision?.category,r.expected.priority,r.decision?.priority,r.automatic,r.decision?.confidence,r.expected.mustReview,r.decision?.signals?.humanRequested,r.durationMs,r.error])].map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(';')).join('\n');
writeFileSync(resolve(directory,'results.csv'),'\uFEFF'+csv);
console.log(JSON.stringify({phase:'complete',report}));
