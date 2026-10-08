import { describe,it,expect,vi } from 'vitest';
import { createErpHandlers,type ErpServerDependencies } from './runtime-server';
import { AccountPublicError } from '../account-security';
import { executeErp, ErpError, canonicalErpJson } from './runtime';
import { applyErpDelta } from './runtime-sync';
import type { CompanyConfiguration } from './types';
import type { ErpCommand, ErpReceipt, ErpState, ErpStore } from './runtime-types';

const organizationId='fictitious-us-space';
const configuration={schemaVersion:1,organizationId,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Example Street',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}} satisfies CompanyConfiguration;
function setup(mode:'browser'|'device'='browser'){
 const store:ErpStore={read:vi.fn(async()=>null),receipt:vi.fn(async()=>null),commit:vi.fn(async input=>input.receipt)};
 const actor={organizationId,userId:'fictitious-owner',role:'owner' as const,managementEntitled:true,timestamp:'2026-10-08T12:00:00Z'};
 const dependencies:ErpServerDependencies={enabled:()=>true,authority:vi.fn(async()=>({mode,actor})),configuration:vi.fn(async()=>configuration),store:vi.fn(()=>store),taxProvider:async()=>null,rateLimit:vi.fn(async()=>{}),diagnostic:vi.fn()};
 const handlers=createErpHandlers(dependencies);
 const body={idempotencyKey:'initialize-test',expectedRevision:0,command:{type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]}};
 const post=(origin='https://zentraapp.ch',value:unknown=body)=>new Request(`https://zentraapp.ch/api/international/workspaces/${organizationId}/erp`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
 return {store,dependencies,handlers,post,body};
}
/** Real HTTP/core/delta with fictitious Auth and RAM CAS, not SQL or hosted Auth. */
function accountingSetup(){
 let state:ErpState|null=null,key=0;const receipts=new Map<string,ErpReceipt>();
 const actor={organizationId,userId:'fictitious-owner',role:'owner' as const,managementEntitled:true,timestamp:'2026-10-08T12:00:00Z'};
 const store:ErpStore={supportedSchemaVersion:4,read:async()=>structuredClone(state),receipt:async(_org,id)=>structuredClone(receipts.get(id)??null),commit:vi.fn(async input=>{
  if((state?.revision??0)!==input.expectedRevision)throw new ErpError('revision_conflict',409);
  state=applyErpDelta(state,{schemaVersion:4,organizationId,fromRevision:input.expectedRevision,toRevision:input.header.revision,headRevision:input.header.revision,hasMore:false,resetRequired:false,events:[{schemaVersion:4,organizationId,revision:input.header.revision,header:input.header,changes:input.changes,ledgerAudit:input.ledgerAudit,receipt:input.receipt,actorId:actor.userId,occurredAt:input.actor.timestamp}]},organizationId,4);
  receipts.set(input.receipt.idempotencyKey,input.receipt);return input.receipt;
 })};
 const dependencies:ErpServerDependencies={enabled:()=>true,authority:async()=>({mode:'browser',actor}),configuration:async()=>configuration,store:()=>store,freshSupportedSchemaVersion:()=>4,taxProvider:async()=>null,rateLimit:async()=>{},diagnostic:vi.fn()};
 const handlers=createErpHandlers(dependencies),send=(command:ErpCommand)=>executeErp({store,configuration,actor,revalidate:async()=>actor,taxProvider:async()=>null},{idempotencyKey:`seed-${++key}`,expectedRevision:state?.revision??0,command});
 const post=(command:ErpCommand)=>new Request(`https://zentraapp.ch/api/international/workspaces/${organizationId}/erp`,{method:'POST',headers:{Origin:'https://zentraapp.ch','Content-Type':'application/json','X-Zentra-Erp-Schema-Version':'4','X-Zentra-Expected-User':actor.userId},body:JSON.stringify({idempotencyKey:`http-${++key}`,expectedRevision:state?.revision??0,command})});
 return {store,dependencies,handlers,send,post,state:()=>state};
}
const manualJournal:Extract<ErpCommand,{type:'post_manual_journal'}>={type:'post_manual_journal',id:'capital',transactionDate:'2026-10-08',accountingDate:'2026-10-08',periodId:'2026',description:'Fictitious human reviewed capital',sourceReference:'TEST-approval',cashFlowCategory:'financing',lines:[{accountId:'cash',debitMinor:'10000',creditMinor:'0'},{accountId:'equity',debitMinor:'0',creditMinor:'10000'}]};
describe('US ERP HTTP authorization and effects',()=>{
 it('returns accounting_period_closed409 for a real schema4 posting into a closed period without mutation',async()=>{
  const t=accountingSetup();await t.send({type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]});await t.send({type:'close_period',periodId:'2026'});const before=canonicalErpJson(t.state()),commits=vi.mocked(t.store.commit).mock.calls.length;
  const response=await t.handlers.POST(t.post(manualJournal),organizationId);expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'accounting_period_closed'});expect(vi.mocked(t.store.commit).mock.calls).toHaveLength(commits);expect(canonicalErpJson(t.state())).toBe(before);expect(t.dependencies.diagnostic).toHaveBeenCalledWith({operation:'write',code:'accounting_period_closed',status:409});
 });
 it('returns invalid_reversal409 for a real second manual reversal without appending another entry or receipt',async()=>{
  const t=accountingSetup();await t.send({type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]});await t.send(manualJournal);const reversal:ErpCommand={type:'reverse_manual_journal',id:'reverse-first',entryId:'capital',transactionDate:'2026-10-08',accountingDate:'2026-10-08',periodId:'2026',reason:'Fictitious human reviewed correction'};await t.send(reversal);const before=canonicalErpJson(t.state()),commits=vi.mocked(t.store.commit).mock.calls.length;
  const response=await t.handlers.POST(t.post({...reversal,id:'reverse-second'}),organizationId);expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'invalid_reversal'});expect(vi.mocked(t.store.commit).mock.calls).toHaveLength(commits);expect(canonicalErpJson(t.state())).toBe(before);expect(t.dependencies.diagnostic).toHaveBeenCalledWith({operation:'write',code:'invalid_reversal',status:409});
 });
 it.each(['GET','POST'] as const)('reports %s throttling without claiming lost permissions or reaching persistence',async method=>{const t=setup();t.dependencies.rateLimit=async()=>{throw new AccountPublicError('private rate bucket',429);};const request=method==='POST'?t.post():new Request('https://zentraapp.ch/erp');const response=await t.handlers[method](request,organizationId);expect(response.status).toBe(429);expect(await response.json()).toEqual({error:'rate_limited'});expect(t.dependencies.store).not.toHaveBeenCalled();expect(t.dependencies.diagnostic).toHaveBeenCalledWith({operation:method==='POST'?'write':'read',code:'rate_limited',status:429});});
 it('returns initialization config without inventing a ledger or country',async()=>{const t=setup();const r=await t.handlers.GET(new Request('https://zentraapp.ch/erp'),organizationId);expect(r.status).toBe(200);expect(await r.json()).toEqual({status:'uninitialized',configuration});expect(t.store.commit).not.toHaveBeenCalled();});
 it('does not open persistence while feature is disabled',async()=>{const t=setup();t.dependencies.enabled=()=>false;expect((await t.handlers.GET(new Request('https://zentraapp.ch/erp'),organizationId)).status).toBe(404);expect(t.dependencies.authority).not.toHaveBeenCalled();expect(t.dependencies.store).not.toHaveBeenCalled();});
 it.each([401,402,403])('refuses authorization failure %s before persistence',async status=>{const t=setup();t.dependencies.authority=async()=>{throw new AccountPublicError('private detail',status);};const r=await t.handlers.POST(t.post(),organizationId);expect(r.status).toBe(status);expect(t.dependencies.store).not.toHaveBeenCalled();expect(JSON.stringify(await r.json())).not.toContain('private detail');});
 it('rejects cross-origin browser writes and allows authenticated native requests without cookies',async()=>{const browser=setup();expect((await browser.handlers.POST(browser.post('https://evil.example'),organizationId)).status).toBe(403);expect(browser.store.commit).not.toHaveBeenCalled();const device=setup('device');const r=await device.handlers.POST(device.post('tauri://localhost'),organizationId);expect(r.status).toBe(200);expect(device.store.commit).toHaveBeenCalledTimes(1);});
 it('refuses tenant mismatch returned by upstream membership',async()=>{const t=setup();t.dependencies.authority=async()=>({mode:'device',actor:{organizationId:'other',userId:'u',role:'owner',managementEntitled:true,timestamp:'2026-10-08T12:00:00Z'}});expect((await t.handlers.POST(t.post(),organizationId)).status).toBe(403);expect(t.dependencies.configuration).not.toHaveBeenCalled();});
 it('rechecks authority immediately before commit and blocks revocation',async()=>{const t=setup();let calls=0;t.dependencies.authority=async()=>{if(++calls>1)throw new AccountPublicError('revoked',401);return {mode:'device',actor:{organizationId,userId:'u',role:'owner',managementEntitled:true,timestamp:'2026-10-08T12:00:00Z'}};};expect((await t.handlers.POST(t.post(),organizationId)).status).toBe(401);expect(t.store.commit).not.toHaveBeenCalled();});
 it('rejects inflated bodies before commit',async()=>{const t=setup();const r=await t.handlers.POST(t.post(undefined,{...t.body,large:'x'.repeat(262144)}),organizationId);expect(r.status).toBe(413);expect(t.store.commit).not.toHaveBeenCalled();});
 it('refuses financial privilege in request and emits metadata-only diagnostics',async()=>{const t=setup();const r=await t.handlers.POST(t.post(undefined,{...t.body,role:'owner',password:'SECRET'}),organizationId);expect(r.status).toBe(422);expect(t.store.commit).not.toHaveBeenCalled();expect(t.dependencies.diagnostic).toHaveBeenCalledWith({operation:'write',code:'invalid_request',status:422});expect(JSON.stringify(vi.mocked(t.dependencies.diagnostic).mock.calls)).not.toContain('SECRET');});
 it('sanitizes unknown storage exceptions and sets cache/security headers',async()=>{const t=setup();t.store.read=async()=>{throw new Error('private token');};const r=await t.handlers.GET(new Request('https://zentraapp.ch/erp'),organizationId);expect(r.status).toBe(503);expect(await r.json()).toEqual({error:'service_unavailable'});expect(r.headers.get('Cache-Control')).toContain('no-store');});
 it('does not echo a tax identifier in an uninitialized response',async()=>{const t=setup();const privateConfig={...configuration,ein:'12-3456789'};t.dependencies.configuration=async()=>privateConfig;const r=await t.handlers.GET(new Request('https://zentraapp.ch/erp'),organizationId);expect(r.status).toBe(200);const body=await r.json() as {configuration:unknown};expect(body.configuration).not.toHaveProperty('ein');expect(privateConfig.ein).toBe('12-3456789');});
 it.each(['revoked','user','scope','mode','role','entitlement'])('withholds a delayed financial read after %s changes',async change=>{
   const t=setup('device');let calls=0;
   t.dependencies.authority=async()=>{
     const authority={mode:'device' as 'browser'|'device',actor:{organizationId,userId:'fictitious-owner',role:'owner' as 'owner'|'read_only',managementEntitled:true,timestamp:'2026-10-08T12:00:00Z'}};
     if(++calls>1){
       if(change==='revoked')throw new AccountPublicError('private revocation',401);
       if(change==='user')authority.actor.userId='different';if(change==='scope')authority.actor.organizationId='different';
       if(change==='mode')authority.mode='browser';if(change==='role')authority.actor.role='read_only';if(change==='entitlement')authority.actor.managementEntitled=false;
     }
     return authority;
   };
   const r=await t.handlers.GET(new Request('https://zentraapp.ch/erp'),organizationId);
   expect(r.status).toBe(change==='role'?403:change==='entitlement'?402:401);expect(await r.json()).toHaveProperty('error');expect(t.store.commit).not.toHaveBeenCalled();
 });
});
