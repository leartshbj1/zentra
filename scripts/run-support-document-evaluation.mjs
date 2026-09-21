import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { development, holdout } from './support-document-corpus.mjs';

const phase = process.argv[2];
if (!/^[a-z0-9-]{1,60}$/.test(phase || '')) throw Error('Provide a unique evaluation label');
const extraction = process.argv.includes('--extraction');
const samples = process.argv.includes('--holdout') ? holdout : development;
const origin = 'https://zentraapp.ch';
const directory = `outputs/document-evaluation-20260921/${phase}`;
mkdirSync(directory, {recursive:true});
const hash = createHash('sha256').update(JSON.stringify(samples)).digest('hex');
writeFileSync(`${directory}/corpus.json`,JSON.stringify(samples,null,2));
const token = readFileSync('C:/Users/alb/Documents/Zentra/Acces-prive-Support-20260919.txt','utf8').match(/zsa_[A-Za-z0-9_-]{64}/)?.[0];
if (!token) throw Error('Admin access unavailable');
const auth = await fetch(origin+'/api/support/admin/session',{method:'POST',redirect:'error',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token}),signal:AbortSignal.timeout(20000)});
if(!auth.ok) throw Error('Admin authentication HTTP '+auth.status);
const cookie = auth.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
const results=[];
for(let i=0;i<samples.length;i+=5){
  const batch=samples.slice(i,i+5);
  const response = await fetch(origin+'/api/support',{method:'POST',redirect:'error',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({action:extraction?'evaluateDocumentBatch':'evaluateTestBatch',tickets:batch.map(({id,subject,body,recipient})=>({id,subject,body,...(extraction?{recipient}:{})}))}),signal:AbortSignal.timeout(60000)});
  if(!response.ok) throw Error('Evaluation HTTP '+response.status);
  const data = await response.json();
  for(const sample of batch){
    const found=data.results?.filter(r=>r.id===sample.id);
    if(found?.length!==1) throw Error('Missing/duplicate result');
    const result={...sample,...found[0],policyVersion:data.policyVersion};
    results.push(result);
    console.log(JSON.stringify({id:result.id,expected:result.expected.category,actual:result.decision?.category,priority:result.decision?.priority,categoryConfidence:result.decision?.categoryConfidence,priorityConfidence:result.decision?.priorityConfidence,automatic:result.automatic,extraction:result.extraction && {kind:result.extraction.kind,reference:result.extraction.reference,totalCents:result.extraction.totalCents,issues:result.extraction.issues},error:result.error}));
  }
  writeFileSync(`${directory}/results.json`,JSON.stringify(results,null,2));
}
const summary={corpusHash:hash,testedAt:new Date().toISOString(),total:results.length,categoryCorrect:results.filter(r=>r.expected.category===r.decision?.category).length,priorityCorrect:results.filter(r=>r.expected.priority===r.decision?.priority).length,automatic:results.filter(r=>r.automatic).length,wrongAutomatic:results.filter(r=>r.automatic&&(r.decision.category!==r.expected.category||r.expected.mustReview)).length,unavailable:results.filter(r=>r.error).length,threshold:85,synthetic:true,externalAssignments:false,policies:[...new Set(results.map(r=>r.policyVersion))]};
writeFileSync(`${directory}/summary.json`,JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary));
