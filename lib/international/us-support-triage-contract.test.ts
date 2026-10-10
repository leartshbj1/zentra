import { randomUUID } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { US_SUPPORT_TRIAGE_MODEL,US_SUPPORT_TRIAGE_RECIPE_VERSION,hashUsSupportTriageRequest,hashUsSupportTriageSource,
  validateUsSupportTriageRequest,validateUsSupportTriageSource,validateUsSupportTriageGrant,validateUsSupportTriageDecision,validateUsSupportTriageResult,
  type UsSupportTriageRequest,type UsSupportTriageSource,type UsSupportTriageGrant,type UsSupportTriageDecision } from './us-support-triage-contract';

const org=randomUUID(),ws=randomUUID(),actor=randomUUID();
const q:UsSupportTriageRequest={schemaVersion:1,requestId:randomUUID(),connectionId:randomUUID(),expectedMailboxRevision:1,uid:'123',expectedMessageVersion:'1700000000',processingPolicyVersion:'support-process-v1',consent:true};
const source:UsSupportTriageSource={provider:'infomaniak',mailboxId:'mailbox',folderId:'inbox',uid:'123',messageVersion:q.expectedMessageVersion,receivedAt:1_700_000_000,messageSha256:'a'.repeat(64),attachmentCount:0,bodyComplete:true};
const grant:UsSupportTriageGrant={schemaVersion:1,organizationId:org,workspaceId:ws,environment:'TEST',bucket:'support_message_classify',periodId:'2026-10',periodStart:1790812800,periodEnd:1793491200,limit:10,
  budgetPolicyVersion:'support-budget-v1',processingPolicyVersion:q.processingPolicyVersion,catalogVersion:'catalog-test',priceId:'price_Test',recipeVersion:US_SUPPORT_TRIAGE_RECIPE_VERSION,threshold:0.9};
const decision:UsSupportTriageDecision={schemaVersion:1,category:'billing',priority:'normal',categoryConfidence:0.95,priorityConfidence:0.94,confidence:0.94,language:'en',languageConfidence:0.95,humanRequested:0,
  reviewReasons:[],needsReview:false,model:US_SUPPORT_TRIAGE_MODEL,recipeVersion:US_SUPPORT_TRIAGE_RECIPE_VERSION};
describe('strict US Support triage contract',()=>{
  it('accepts detached exact contracts and hashes actor/company/command identity',async()=>{
    expect(validateUsSupportTriageRequest(q)).toEqual(q); expect(validateUsSupportTriageSource(source)).toEqual(source); expect(validateUsSupportTriageGrant(grant)).toEqual(grant);
    expect(await hashUsSupportTriageRequest(org,ws,actor,q)).not.toBe(await hashUsSupportTriageRequest(org,ws,randomUUID(),q));
    expect(await hashUsSupportTriageRequest(org,ws,actor,q)).not.toBe(await hashUsSupportTriageRequest(org,ws,actor,{...q,expectedMailboxRevision:2}));
    const parsed=validateUsSupportTriageDecision(decision,{source,grant}); expect(parsed).toEqual(decision); expect(parsed).not.toBe(decision);
  });
  it.each([{consent:false},{processingPolicyVersion:''},{uid:'123/evil'},{body:'forged message'},{quota:1000},{expectedMailboxRevision:1.5},{requestId:q.requestId.toUpperCase()}])('rejects unknown or malformed request %j',patch=>{
    expect(()=>validateUsSupportTriageRequest({...q,...patch})).toThrowError(expect.objectContaining({code:'invalid_triage_request',status:422}));
  });
  it.each([{body:'secret'},{token:'secret'},{messageSha256:'x'.repeat(64)},{bodyComplete:'true'},{attachmentCount:-1},{mailboxId:' spaced '}])('rejects private source extras or malformed facts %j',patch=>{
    expect(()=>validateUsSupportTriageSource({...source,...patch})).toThrowError(expect.objectContaining({status:503}));
  });
  it('keeps stable source locator across versions and observed bytes but separates company/workspace',async()=>{
    const hash=await hashUsSupportTriageSource(org,ws,source);
    expect(await hashUsSupportTriageSource(org,ws,{...source,messageVersion:'later',messageSha256:'b'.repeat(64)})).toBe(hash);
    expect(await hashUsSupportTriageSource(randomUUID(),ws,source)).not.toBe(hash); expect(await hashUsSupportTriageSource(org,randomUUID(),source)).not.toBe(hash);
  });
  it('requires every evidence-based review reason exactly once in canonical order',()=>{
    const s={...source,attachmentCount:1,bodyComplete:false}, d={...decision,category:'other',categoryConfidence:0.6,confidence:0.6,humanRequested:0.2,
      reviewReasons:['low_confidence','human_requested','other_category','unread_attachments','incomplete_body'],needsReview:true};
    expect(validateUsSupportTriageDecision(d,{source:s,grant})).toEqual(d);
    for(const reviewReasons of [[],d.reviewReasons.slice(1),[...d.reviewReasons].reverse(),[...d.reviewReasons,'low_confidence']]) expect(()=>validateUsSupportTriageDecision({...d,reviewReasons},{source:s,grant})).toThrow();
  });
  it('language confidence also triggers review and threshold boundary does not',()=>{
    const d={...decision,languageConfidence:0.899,needsReview:true,reviewReasons:['low_confidence']}; expect(validateUsSupportTriageDecision(d,{source,grant})).toEqual(d);
    expect(validateUsSupportTriageDecision({...decision,languageConfidence:0.9},{source,grant}).needsReview).toBe(false);
  });
  it.each([{model:'jev-latest'},{confidence:0.99},{language:'unknown'},{priority:'critical'},{destination:{teamId:'x'}},{needsReview:true},{recipeVersion:'other'}])('rejects mutable or actionable result %j',patch=>{
    expect(()=>validateUsSupportTriageDecision({...decision,...patch},{source,grant})).toThrow();
  });
  it('rejects invalid months, scope, stale period and supplier bucket',()=>{
    for(const patch of [{periodId:'2026-11'},{periodEnd:grant.periodEnd+1},{bucket:'supplier_invoice_extract'},{limit:0},{threshold:NaN},{organizationId:randomUUID()}])
      expect(()=>validateUsSupportTriageGrant({...grant,...patch},org,ws,1791580000)).toThrow();
    expect(()=>validateUsSupportTriageGrant(grant,org,ws,grant.periodEnd)).toThrow();
  });
  it('ties completed result to source/grant and requires durable dispatch',()=>{
    const job={schemaVersion:1,id:randomUUID(),organizationId:org,workspaceId:ws,actorUserId:actor,requestId:q.requestId,source,sourceHash:'b'.repeat(64),grant,createdAt:1791580000,state:'completed',dispatchId:randomUUID(),result:decision,completedAt:1791580001};
    const result={job,requestId:q.requestId,requestHash:'c'.repeat(64),replayed:true}; expect(validateUsSupportTriageResult(result,org,ws)).toEqual(result);
    expect(()=>validateUsSupportTriageResult({...result,job:{...job,dispatchId:null}})).toThrow(); expect(()=>validateUsSupportTriageResult({...result,job:{...job,state:'reserved'}})).toThrow();
  });
});
