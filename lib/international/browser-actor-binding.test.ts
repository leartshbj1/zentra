import {describe,it,expect,vi} from 'vitest';
import {createErpHandlers,type ErpServerDependencies} from './runtime-server';
import {createErpSyncHandlers} from './runtime-sync-server';
import type {CompanyConfiguration} from './types';
import type {ErpCommit} from './runtime-types';

const org='actor-bound-us',userId='fictitious-owner';
const config:CompanyConfiguration={schemaVersion:1,organizationId:org,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Example Street',city:'Brooklyn',postalCode:'11201',subdivision:'NY'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}};
function setup(){
  const actor={organizationId:org,userId,role:'owner' as const,managementEntitled:true,timestamp:'2026-10-08T12:00:00Z'};
  const store={read:vi.fn(async()=>null),receipt:vi.fn(async()=>null),commit:vi.fn(async(input:ErpCommit)=>input.receipt)};
  const deps:ErpServerDependencies={enabled:()=>true,authority:vi.fn(async()=>({mode:'browser' as const,actor})),configuration:vi.fn(async()=>config),store:vi.fn(()=>store),taxProvider:async()=>null,rateLimit:vi.fn(async()=>{}),diagnostic:vi.fn()};
  const syncStore={revision:vi.fn(async()=>null),changes:vi.fn(async()=>null)};
  const handlers=createErpHandlers(deps),sync=createErpSyncHandlers({...deps,syncStore:()=>syncStore});
  const body={idempotencyKey:'original-key',expectedRevision:0,command:{type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]}};
  function request(expected:string|undefined,post=false){return new Request('https://zentra.test/erp?after=0',{method:post?'POST':'GET',headers:{...(expected===undefined?{}:{'X-Zentra-Expected-User':expected}),...(post?{Origin:'https://zentra.test','Content-Type':'application/json'}:{})},...(post?{body:JSON.stringify(body)}:{})});}
  return{deps,store,syncStore,handlers,sync,request};
}
describe('rendered account binding never grants ERP permission',()=>{
 it.each(['read','write','revision','changes'] as const)('refuses a stale %s form before configuration, persistence or rate counters',async operation=>{const t=setup();const r=operation==='read'?await t.handlers.GET(t.request('previous-account'),org):operation==='write'?await t.handlers.POST(t.request('previous-account',true),org):await t.sync[operation](t.request('previous-account'),org);expect(r.status).toBe(401);expect(await r.json()).toEqual({error:'session_changed'});expect(t.deps.configuration).not.toHaveBeenCalled();expect(t.deps.store).not.toHaveBeenCalled();expect(t.deps.rateLimit).not.toHaveBeenCalled();expect(t.syncStore.revision).not.toHaveBeenCalled();expect(t.syncStore.changes).not.toHaveBeenCalled();});
 it.each([undefined,userId])('retains admission with an absent or exact binding %s',async expected=>{const t=setup();expect((await t.handlers.GET(t.request(expected),org)).status).toBe(200);expect(t.store.read).toHaveBeenCalledOnce();});
 it('does not let an exact actor header bypass Auth or subscription',async()=>{const t=setup();t.deps.authority=async()=>{throw new Error('private auth failure');};const r=await t.handlers.GET(t.request(userId),org);expect(r.status).toBe(503);expect(await r.json()).toEqual({error:'service_unavailable'});expect(t.deps.store).not.toHaveBeenCalled();});
 it.each(['','owner, previous-account',' owner'])('rejects a malformed or inexact binding %s',async expected=>{const t=setup();const r=await t.handlers.GET(t.request(expected),org);expect(r.status).toBe(401);expect(t.deps.configuration).not.toHaveBeenCalled();});
});
