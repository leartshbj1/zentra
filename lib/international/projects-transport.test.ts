import { describe, expect, it, vi } from 'vitest';
import { exportFixture } from './export-test-fixture';
import { validateStoredErp } from './runtime-validation';
import { applyErpDelta, type ErpEvent } from './runtime-sync';
import { createErpHandlers, type ErpServerDependencies } from './runtime-server';
import { createErpSyncHandlers } from './runtime-sync-server';
import { createUsExportHandlers } from './export-server';
import { erpClientSchemaVersion } from './erp-schema-capability';
import { validateErpRequest } from './erp-request';
import type { ErpCommit, ErpReceipt, ErpStore } from './runtime-types';
import type { FinancialAuthority } from './accounting/ledger';

// Real engine-built project/financial state. HTTP Auth/CAS seams are synthetic;
// PostgreSQL, hosted Auth and runtime deployment are not proved by this file.
async function fixture(){
  const state=await exportFixture('accrual','','Recorded service','12345',true),org=state.configuration.organizationId;
  let ceiling:1|2|3=3,enabled=true,actor:FinancialAuthority={organizationId:org,userId:'expected-owner',role:'owner',managementEntitled:true,timestamp:'2026-10-08T12:00:00.000Z'};
  const receipts=new Map<string,ErpReceipt>();
  const read=vi.fn(async()=>state),commit=vi.fn(async(input:ErpCommit)=>{receipts.set(input.receipt.idempotencyKey,input.receipt);return input.receipt;});
  const store:ErpStore={supportedSchemaVersion:3,read,commit,receipt:async(_org,key)=>receipts.get(key)??null};
  const deps:ErpServerDependencies={enabled:()=>enabled,authority:vi.fn(async()=>({mode:'browser' as const,actor:{...actor}})),configuration:async()=>state.configuration,store:()=>store,freshSupportedSchemaVersion:vi.fn(async()=>ceiling),taxProvider:async()=>null,seller:async()=>state.invoices[0].sellerSnapshot,rateLimit:async()=>{},diagnostic:vi.fn()};
  const request=(method='GET',cap=3,body?:unknown)=>new Request('https://zentra.test/erp',{method,headers:{Origin:'https://zentra.test','X-Zentra-Erp-Schema-Version':String(cap),'X-Zentra-Expected-User':'expected-owner','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const input={idempotencyKey:'exact-project-update',expectedRevision:state.revision,command:{type:'save_projects',projects:[{id:state.projects![0].id,expectedProjectRevision:state.projects![0].revision,customerId:state.projects![0].customerId,name:'Fresh approved project name',status:'active',notes:'',startDate:null,targetDate:null,budgetMinor:null,vendorBillIds:['bill-1']}]}};
  return {state,org,deps,store,read,commit,request,input,setCeiling:(v:1|2|3)=>{ceiling=v;},setActor:(v:FinancialAuthority)=>{actor=v;},actor:()=>actor,setEnabled:(v:boolean)=>{enabled=v;}};
}
describe('project capability3 projection and request boundaries',()=>{
  it.each(['revision','number','counter','bill_twice','customer'] as const)('rejects globally impossible stored projects (%s)',async kind=>{
    const t=await fixture(),state=structuredClone(t.state) as unknown as {revision:number;projects:Record<string,unknown>[];counters:{project:number}};
    if(kind==='revision')state.projects[0].revision=state.revision+1;if(kind==='number')state.projects[0].number='PRJ-000002';if(kind==='counter')state.counters.project=2;if(kind==='customer')state.projects[0].customerId='nonexistent';
    if(kind==='bill_twice'){state.projects.push({...state.projects[0],id:'second',number:'PRJ-000002'});state.counters.project=2;}
    expect(()=>validateStoredErp(state,t.org)).toThrow('invalid_stored_state');
  });
  it('validates capability3 only as a protocol value; extra/combined values fail',()=>{
    expect(erpClientSchemaVersion(new Request('https://zentra.test',{headers:{'X-Zentra-Erp-Schema-Version':'3'}}))).toBe(3);
    for(const value of ['5','03','3, 2',' 3x'])expect(()=>erpClientSchemaVersion(new Request('https://zentra.test',{headers:{'X-Zentra-Erp-Schema-Version':value}}))).toThrow('invalid_request');
  });
  it('rejects own getters without evaluating the project or command accessor',async()=>{
    const t=await fixture(),getter=vi.fn(()=>t.input.command);const input={...t.input};Object.defineProperty(input,'command',{enumerable:true,get:getter});expect(()=>validateErpRequest(input,t.org)).toThrow('invalid_request');expect(getter).not.toHaveBeenCalled();
  });
  it('rejects project-array accessors/sparse items without invocation and captures detached facts',async()=>{
    const t=await fixture(),getter=vi.fn(()=>t.input.command.projects[0]),projects:unknown[]=[];Object.defineProperty(projects,0,{enumerable:true,get:getter});
    expect(()=>validateErpRequest({...t.input,command:{type:'save_projects',projects}},t.org)).toThrow('invalid_request');expect(getter).not.toHaveBeenCalled();
    expect(()=>validateErpRequest({...t.input,command:{type:'save_projects',projects:Array(1)}},t.org)).toThrow('invalid_request');
    const parsed=validateErpRequest(t.input,t.org);t.input.command.projects[0].name='Mutated later';expect(parsed.command.type==='save_projects'&&parsed.command.projects[0].name).toBe('Fresh approved project name');
  });
  it('keeps head3 private when a late capability flag closes during GET',async()=>{
    const t=await fixture();t.read.mockImplementationOnce(async()=>{t.setCeiling(2);return t.state;});const response=await createErpHandlers(t.deps).GET(t.request(),t.org);expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'client_upgrade_required'});
  });
  it('checks fresh authority AFTER an asynchronous capability read',async()=>{
    const t=await fixture();t.deps.freshSupportedSchemaVersion=async()=>{t.setActor({...t.actor(),userId:'other-account'});return 3 as const;};const response=await createErpHandlers(t.deps).GET(t.request(),t.org);expect(response.status).toBe(401);expect(await response.json()).toEqual({error:'session_changed'});
  });
  it('requires capability3 on project writes before any mutation',async()=>{
    const t=await fixture();const response=await createErpHandlers(t.deps).POST(t.request('POST',2,t.input),t.org);expect(response.status).toBe(409);expect(t.commit).not.toHaveBeenCalled();
  });
  it('refuses an injected receipt for another project while preserving its public shape',async()=>{
    const t=await fixture();t.commit.mockImplementationOnce(async input=>({...input.receipt,entityId:'another-project'}));const response=await createErpHandlers(t.deps).POST(t.request('POST',3,t.input),t.org);expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'invalid_receipt'});
  });
  it('refuses the commit if the project flag closes before the final admission',async()=>{
    const t=await fixture();t.deps.freshSupportedSchemaVersion=async()=>2 as const;const response=await createErpHandlers(t.deps).POST(t.request('POST',3,t.input),t.org);expect(response.status).toBe(409);expect(t.commit).not.toHaveBeenCalled();
  });
  it('withholds a committed receipt after flag closure and allows only an exact historical retry',async()=>{
    const t=await fixture();t.commit.mockImplementationOnce(async input=>{t.setCeiling(2);return input.receipt;});const handlers=createErpHandlers(t.deps);const response=await handlers.POST(t.request('POST',3,t.input),t.org);expect(response.status).toBe(409);expect(t.commit).toHaveBeenCalledTimes(1);
    const saved=t.commit.mock.calls[0][0].receipt;t.store.receipt=async()=>saved;t.setCeiling(3);const resumed=await handlers.POST(t.request('POST',3,t.input),t.org);expect(resumed.status).toBe(200);expect(await resumed.json()).toEqual({receipt:saved,replayed:true});expect(t.commit).toHaveBeenCalledTimes(1);
  });
  it.each(['revision','changes'] as const)('withholds %s when its capability closes during the read',async operation=>{
    const t=await fixture();const sync=createErpSyncHandlers({...t.deps,syncStore:()=>({supportedSchemaVersion:3,revision:async()=>{t.setCeiling(2);return {schemaVersion:3,organizationId:t.org,revision:t.state.revision};},changes:async()=>{t.setCeiling(2);return {schemaVersion:3,organizationId:t.org,fromRevision:t.state.revision,toRevision:t.state.revision,headRevision:t.state.revision,hasMore:false,resetRequired:false,events:[]};}})});
    const request=new Request(`https://zentra.test/erp/changes?after=${t.state.revision}`,{headers:{'X-Zentra-Expected-User':'expected-owner','X-Zentra-Erp-Schema-Version':'3'}});const response=await sync[operation](request,t.org);expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'client_upgrade_required'});
  });
  it('withholds a project export after rendering when capability3 closes',async()=>{
    const t=await fixture(),fonts=vi.fn(async()=>({regular:new Uint8Array([1]),bold:new Uint8Array([2])}));const handlers=createUsExportHandlers({...t.deps,diagnostic:vi.fn(),fonts,render:async()=>{t.setCeiling(2);return '<!doctype html><p>PRIVATE PROJECT</p>';}});
    const response=await handlers.documents(new Request('https://zentra.test/exports?format=html',{headers:{'X-Zentra-Expected-User':'expected-owner','X-Zentra-Erp-Schema-Version':'3'}}),t.org,'project',t.state.projects![0].id);expect(response.status).toBe(409);expect(await response.text()).not.toContain('PRIVATE PROJECT');expect(fonts).not.toHaveBeenCalled();
  });
  it('rejects a project delta whose entity timestamp differs from its durable receipt instant',async()=>{
    const t=await fixture();await createErpHandlers(t.deps).POST(t.request('POST',3,t.input),t.org);const c=t.commit.mock.calls[0][0];const event:ErpEvent={schemaVersion:3,organizationId:t.org,revision:c.receipt.revision,header:c.header,changes:c.changes,ledgerAudit:c.ledgerAudit,receipt:c.receipt,actorId:c.actor.userId,occurredAt:'2026-10-08T13:00:00Z'};
    expect(()=>applyErpDelta(t.state,{schemaVersion:3,organizationId:t.org,fromRevision:t.state.revision,toRevision:event.revision,headRevision:event.revision,hasMore:false,resetRequired:false,events:[event]},t.org,3)).toThrow('invalid_sync_state');
  });
});
