import { describe,it,expect,vi } from 'vitest';
import { applyErpDelta,validateErpDelta,validateErpRevision,type ErpDelta,type ErpEvent,type ErpSyncStore } from './runtime-sync';
import { executeErp,canonicalErpJson } from './runtime';
import { createErpSyncHandlers,type ErpSyncServerDependencies } from './runtime-sync-server';
import { createSupabaseErpSyncStore } from './runtime-sync-store';
import type { ErpState,ErpStore,ErpRequest,ErpCommit,ErpReceipt } from './runtime-types';
import type { CompanyConfiguration } from './types';
import { AccountPublicError } from '../account-security';
import { money } from './money';
import type { TaxCalculationProvider } from './invoicing';
import type { FinancialAuthority } from './accounting/ledger';

const org='fictitious-stream';
const config={schemaVersion:1,organizationId:org,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Example Street',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'configured'}} satisfies CompanyConfiguration;
const actor:FinancialAuthority={organizationId:org,userId:'fictitious-owner',role:'owner',managementEntitled:true,timestamp:'2026-10-08T12:00:00Z'};
const provider:TaxCalculationProvider={id:'fictitious-only',async calculate(r){return {...r,source:'external-provider',providerReference:'fictitious-proof',determinedAt:actor.timestamp,validUntil:'2026-10-09T12:00:00Z',lines:r.lines.map(l=>({id:l.id,taxMinor:'0',jurisdiction:'fictitious-NY',evidenceReference:'fictitious-only'}))};}};
class StreamStore implements ErpStore {
  state:ErpState|null=null;events:ErpEvent[]=[];receipts=new Map<string,ErpReceipt>();
  async read(){return this.state;}
  async receipt(_org:string,key:string){return this.receipts.get(key)??null;}
  async commit(c:ErpCommit){
    const delta=page(this.events.length,this.events.length+1,[{schemaVersion:1,organizationId:org,revision:c.header.revision,header:c.header,changes:c.changes,ledgerAudit:c.ledgerAudit,receipt:c.receipt,actorId:c.actor.userId,occurredAt:c.actor.timestamp}]);
    const event=delta.events[0];this.state=applyErpDelta(this.state,delta,org);this.events.push(event);this.receipts.set(c.receipt.idempotencyKey,c.receipt);return c.receipt;
  }
}
function page(from:number,head:number,events:readonly ErpEvent[]):ErpDelta{return {schemaVersion:1,organizationId:org,fromRevision:from,toRevision:from+events.length,headRevision:head,hasMore:from+events.length<head,resetRequired:false,events};}
async function fixture(){
  const store=new StreamStore();let key=0;
  const send=(command:ErpRequest['command'])=>executeErp({store,configuration:config,actor,revalidate:async()=>actor,taxProvider:async()=>provider,seller:async()=>({organizationId:org,displayName:'Fictitious Seller'})},{idempotencyKey:`event-${++key}`,expectedRevision:store.state?.revision??0,command});
  await send({type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]});
  const initial=store.state!;
  await send({type:'save_customer',customer:{id:'c1',organizationId:org,kind:'business',name:'Fictitious Customer',billingAddress:config.address,paymentTermsDays:30}});
  await send({type:'save_estimate',id:'q1',expectedEstimateRevision:0,customerId:'c1',date:'2026-10-08',expiresAt:'2026-11-08',paymentTermsDays:30,lines:[{id:'l1',description:'Fictitious service',quantityUnits:'1',quantityScale:0,unitPrice:money('USD','10000'),discountBasisPoints:0,taxTreatment:'taxable'}],notes:''});
  await send({type:'accept_estimate',estimateId:'q1',expectedEstimateRevision:1});
  await send({type:'issue_invoice',id:'i1',estimateId:'q1',expectedEstimateRevision:2,date:'2026-10-08',accountingDate:'2026-10-08',dueDate:'2026-11-07',periodId:'2026'});
  const issued=store.state!;
  await send({type:'record_payment',id:'p1',invoiceId:'i1',amountMinor:'2500',paymentDate:'2026-10-08',accountingDate:'2026-10-08',periodId:'2026',reference:'Fictitious receipt'});
  return {store,initial,issued};
}
function server(){
  const store:ErpSyncStore={revision:vi.fn(async()=>({schemaVersion:1 as const,organizationId:org,revision:6})),changes:vi.fn(async()=>page(6,6,[]))};
  const deps:ErpSyncServerDependencies={enabled:()=>true,authority:vi.fn(async()=>({mode:'device' as const,actor})),configuration:async()=>config,rateLimit:vi.fn(async()=>{}),diagnostic:vi.fn(),syncStore:vi.fn(()=>store)};
  return {store,deps,handlers:createErpSyncHandlers(deps),request:(query='')=>new Request(`https://zentraapp.ch/erp/changes${query}`)};
}
describe('delayed US sync admission',()=>{
  it.each(['revision','changes'] as const)('preserves %s throttling without opening the financial stream or changing Auth',async operation=>{const t=server();t.deps.rateLimit=async()=>{throw new AccountPublicError('private quota',429);};const response=await t.handlers[operation](t.request(operation==='changes'?'?after=6':''),org);expect(response.status).toBe(429);expect(await response.json()).toEqual({error:'rate_limited'});expect(t.deps.syncStore).not.toHaveBeenCalled();expect(t.deps.diagnostic).toHaveBeenCalledWith({operation:'read',code:'rate_limited',status:429});});
  it.each(['revision','changes'] as const)('withholds %s after membership revocation during the store read',async operation=>{
    const t=server();let readComplete=false;
    t.deps.authority=async()=>{if(readComplete)throw new AccountPublicError('private revoked identity',403);return {mode:'device',actor};};
    t.store.revision=async()=>{readComplete=true;return {schemaVersion:1,organizationId:org,revision:6};};
    t.store.changes=async()=>{readComplete=true;return page(6,6,[]);};
    const response=await t.handlers[operation](t.request(operation==='changes'?'?after=6':''),org);
    expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'forbidden'});
    expect(JSON.stringify(vi.mocked(t.deps.diagnostic).mock.calls)).not.toContain('private revoked identity');
  });
});

describe('durable US change stream',()=>{
  it('reconstructs the book from paged committed events and resumes at the last applied cursor',async()=>{
    const t=await fixture();let state:ErpState|null=null;
    for(let i=0;i<t.store.events.length;i+=2)state=applyErpDelta(state,page(i,t.store.events.length,t.store.events.slice(i,i+2)),org);
    expect(canonicalErpJson(state)).toBe(canonicalErpJson(t.store.state));expect(state!.invoices[0].payments).toHaveLength(1);expect(state!.ledger.entries).toHaveLength(2);
    expect(applyErpDelta(state,page(6,6,[]),org)).toBe(state);
  });
  it('does not partially mutate cached state on a gap or a corrupt batch',async()=>{
    const t=await fixture(),before=canonicalErpJson(t.initial),events=structuredClone(t.store.events.slice(1));
    events[3]={...events[3],changes:[...events[3].changes,{kind:'customer',id:'foreign',payload:{id:'foreign',organizationId:'other'}}]};
    expect(()=>applyErpDelta(t.initial,page(1,6,events),org)).toThrow('invalid_sync_state');expect(canonicalErpJson(t.initial)).toBe(before);
    expect(()=>applyErpDelta(t.initial,page(1,6,t.store.events.slice(2)),org)).toThrow('invalid_sync_state');
  });
  it('requires a full reload on a pre-stream baseline and refuses silent historical invoice edits',async()=>{
    const t=await fixture();expect(()=>applyErpDelta(t.initial,{...page(1,6,[]),resetRequired:true,hasMore:false},org)).toThrow('sync_reset_required');
    const original=structuredClone(t.store.events[5]);const bad={...original,changes:original.changes.map(c=>c.kind==='invoice'?{...c,payload:{...c.payload as object,notes:'Changed after issue'}}:c)};
    expect(()=>applyErpDelta(t.issued,page(5,6,[bad]),org)).toThrow('invalid_sync_state');expect(t.issued.invoices[0].payments).toHaveLength(0);
  });
  it('rejects a foreign head, nonprogressing pages and oversized pages',()=>{
    expect(()=>validateErpRevision({schemaVersion:1,organizationId:'other',revision:1},org)).toThrow('invalid_sync_state');
    expect(()=>validateErpDelta(page(0,1,[]),org,0)).toThrow('invalid_sync_state');
    expect(()=>validateErpDelta({...page(0,101,[]),events:Array(101).fill({})},org,0)).toThrow('invalid_sync_state');
    expect(validateErpRevision({schemaVersion:1,organizationId:org,revision:1,privateCredential:'PRIVATE-FIXTURE'},org)).toEqual({schemaVersion:1,organizationId:org,revision:1});
  });
  it.each(['chart','period','counter','private-header','invalid-customer','missing-configuration'])('rejects %s corruption without changing reports or cached records',async kind=>{
    const t=await fixture(),events=structuredClone(t.store.events.slice(1)),original=events[0];
    if(kind==='chart')events[0]={...original,header:{...original.header,ledger:{...original.header.ledger,accounts:original.header.ledger.accounts.map(a=>a.id==='sales'?{...a,type:'asset'}:a)}}};
    if(kind==='period')events[0]={...original,header:{...original.header,ledger:{...original.header.ledger,periods:original.header.ledger.periods.map(p=>({...p,start:'2026-02-01'}))}}};
    if(kind==='counter')events[0]={...original,header:{...original.header,counters:{...original.header.counters,invoice:999}}};
    if(kind==='private-header')Object.assign(events[0].header,{privateCredential:'PRIVATE-FIXTURE'});
    if(kind==='invalid-customer')events[0]={...original,changes:[{kind:'customer',id:'c1',payload:{id:'c1',organizationId:org,name:null,apiToken:'PRIVATE-FIXTURE'}}]};
    if(kind==='missing-configuration')Object.assign(events[0].header,{configuration:undefined});
    expect(()=>applyErpDelta(t.initial,page(1,6,events),org)).toThrow();expect(t.initial.customers).toHaveLength(0);expect(t.initial.counters.invoice).toBe(0);
  });
  it('copies and deeply freezes the candidate so later wire mutations cannot change a payment',async()=>{
    const t=await fixture(),wire=structuredClone(page(5,6,t.store.events.slice(5))),cached=applyErpDelta(t.issued,wire,org)!;
    const invoice=wire.events[0].changes.find(c=>c.kind==='invoice')!.payload as {payments:{amount:{minorUnits:string}}[]};invoice.payments[0].amount.minorUnits='1';
    expect(cached.invoices[0].payments[0].amount.minorUnits).toBe('2500');expect(Object.isFrozen(cached.invoices[0].payments[0].amount)).toBe(true);expect(t.issued.invoices[0].payments).toHaveLength(0);
  });
  it('uses only scoped RPCs and validates privileged responses before exposing them',async()=>{
    const rpc=vi.fn(async(name:string)=>name==='zentra_us_erp_revision'?{schemaVersion:1,organizationId:org,revision:6}:page(6,6,[]));
    const store=createSupabaseErpSyncStore({rpc:rpc as unknown as Parameters<typeof createSupabaseErpSyncStore>[0]['rpc']});
    expect(await store.revision(org)).toMatchObject({revision:6});expect(await store.changes(org,6,20)).toMatchObject({events:[]});expect(rpc).toHaveBeenLastCalledWith('zentra_us_erp_delta',{p_organization:org,p_after_revision:6,p_limit:20});
    rpc.mockImplementation(async()=>({schemaVersion:1,organizationId:'other',revision:6}));await expect(store.revision(org)).rejects.toThrow('invalid_sync_state');
  });
});
describe('US stream HTTP boundaries',()=>{
  it('returns only an authorized current head with no cache',async()=>{const t=server(),r=await t.handlers.revision(t.request(),org);expect(r.status).toBe(200);expect(await r.json()).toEqual({schemaVersion:1,organizationId:org,revision:6});expect(r.headers.get('Cache-Control')).toContain('no-store');expect(t.store.changes).not.toHaveBeenCalled();});
  it.each([401,402,403])('denies status %s without opening persistence',async status=>{const t=server();t.deps.authority=async()=>{throw new AccountPublicError('private token',status);};const r=await t.handlers.changes(t.request('?after=6'),org);expect(r.status).toBe(status);expect(t.deps.syncStore).not.toHaveBeenCalled();expect(JSON.stringify(await r.json())).not.toContain('private token');});
  it('keeps unavailable features and foreign workspaces closed',async()=>{const t=server();t.deps.enabled=()=>false;expect((await t.handlers.revision(t.request(),org)).status).toBe(404);expect(t.deps.authority).not.toHaveBeenCalled();t.deps.enabled=()=>true;t.deps.authority=async()=>({mode:'device',actor:{...actor,organizationId:'other'}});expect((await t.handlers.revision(t.request(),org)).status).toBe(403);expect(t.deps.syncStore).not.toHaveBeenCalled();});
  it.each(['','?after=6&after=7','?after=-1','?after=1.5','?after=6&limit=101','?after=6&limit=0','?after=6&organizationId=other'])('refuses invalid cursor %s before reading records',async query=>{const t=server(),r=await t.handlers.changes(t.request(query),org);expect(r.status).toBe(422);expect(t.deps.syncStore).not.toHaveBeenCalled();});
  it('sanitizes private upstream failures',async()=>{const t=server();t.store.revision=async()=>{throw new Error('private access token');};const r=await t.handlers.revision(t.request(),org);expect(r.status).toBe(503);expect(await r.json()).toEqual({error:'service_unavailable'});expect(t.deps.diagnostic).toHaveBeenCalledWith({operation:'read',code:'service_unavailable',status:503});});
});
