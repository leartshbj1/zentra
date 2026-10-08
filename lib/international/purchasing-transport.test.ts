import { describe, expect, it, vi } from 'vitest';
import { createErpHandlers, type ErpServerDependencies } from './runtime-server';
import { createErpSyncHandlers } from './runtime-sync-server';
import { createBrowserErpSession } from './browser-erp-session';
import { createSupabaseErpStore } from './runtime-store';
import { createSupabaseErpSyncStore } from './runtime-sync-store';
import { applyErpDelta, type ErpDelta, type ErpEvent } from './runtime-sync';
import { ERP_SCHEMA_HEADER, erpClientSchemaVersion } from './erp-schema-capability';
import { ErpError } from './erp-contract';
import { AccountPublicError } from '../account-security';
import type { FinancialAuthority } from './accounting/ledger';
import type { CompanyConfiguration } from './types';
import type { ErpCommand, ErpCommit, ErpReceipt, ErpState, ErpStore } from './runtime-types';
import { publicErpState } from './public-projection';

// Real cookie-session/HTTP handlers/ERP/delta validators. Auth, RPC and the CAS
// book below are synthetic RAM ports: no hosted PostgREST, payment or native proof.
const org = 'fictitious-purchasing-transport';
const configuration: CompanyConfiguration = {schemaVersion:1,organizationId:org,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Example Street',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'},ein:'12-3456789'};
const initialActor: FinancialAuthority = {organizationId:org,userId:'fictitious-owner',role:'owner',managementEntitled:true,timestamp:'2026-10-08T12:00:00.000Z'};
const initialize: ErpCommand = {type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]};
const vendor: ErpCommand = {type:'save_vendor',vendor:{id:'vendor',organizationId:org,kind:'business',name:'Fictitious Supplier',billingAddress:configuration.address,paymentTermsDays:30}};
const bill: ErpCommand = {type:'record_vendor_bill',id:'bill',vendorId:'vendor',reference:'EXAMPLE-1',date:'2026-10-08',accountingDate:'2026-10-08',dueDate:'2026-11-07',periodId:'2026',netMinor:'10000',purchaseTaxMinor:'825',expenseAccountId:'purchases',sourceReference:'manual:example-document'};
const payment: ErpCommand = {type:'record_vendor_payment',id:'payment',billId:'bill',amountMinor:'5000',paymentDate:'2026-10-09',accountingDate:'2026-10-09',periodId:'2026',reference:'manual:example-payment'};
function fixture(serverCapability:1|2=2) {
  let state:ErpState|null=null, sequence=0, clock=0, actor=structuredClone(initialActor), loseResponse=false;
  const receipts=new Map<string,ErpReceipt>(), events:ErpEvent[]=[], commits:ErpCommit[]=[];
  const page=(after:number):ErpDelta=>({schemaVersion:serverCapability,organizationId:org,fromRevision:after,toRevision:state?.revision??0,headRevision:state?.revision??0,hasMore:false,resetRequired:false,events:events.filter(event=>event.revision>after)});
  const store:ErpStore={supportedSchemaVersion:serverCapability,read:vi.fn(async()=>state),receipt:vi.fn(async(_org,key)=>receipts.get(key)??null),commit:vi.fn(async commit=>{
    if(commit.expectedRevision!==(state?.revision??0))throw new ErpError('revision_conflict',409);
    const event:ErpEvent={schemaVersion:commit.header.schemaVersion,organizationId:org,revision:commit.header.revision,header:commit.header,changes:commit.changes,ledgerAudit:commit.ledgerAudit,receipt:commit.receipt,actorId:commit.actor.userId,occurredAt:commit.actor.timestamp};
    const delta:ErpDelta={schemaVersion:serverCapability,organizationId:org,fromRevision:commit.expectedRevision,toRevision:commit.header.revision,headRevision:commit.header.revision,hasMore:false,resetRequired:false,events:[event]};
    state=applyErpDelta(state,delta,org,serverCapability);events.push(structuredClone(event));commits.push(structuredClone(commit));receipts.set(commit.receipt.idempotencyKey,structuredClone(commit.receipt));return structuredClone(commit.receipt);
  })};
  const dependencies:ErpServerDependencies={enabled:()=>true,authority:vi.fn(async()=>({mode:'browser' as const,actor:{...actor,timestamp:new Date(Date.UTC(2026,9,8,12,0,0,++clock)).toISOString()}})),configuration:async()=>configuration,store:vi.fn((cap?:1|2)=>({...store,supportedSchemaVersion:Math.min(cap??1,serverCapability) as 1|2,receipt:async(organizationId:string,key:string)=>{
    if((state?.schemaVersion??1)>(cap??1))throw new ErpError('client_upgrade_required',409);
    return store.receipt(organizationId,key);
  }})),taxProvider:async()=>null,rateLimit:vi.fn(async()=>{}),diagnostic:vi.fn()};
  const handler=createErpHandlers(dependencies);
  const sync=createErpSyncHandlers({...dependencies,syncStore:vi.fn(()=>({supportedSchemaVersion:serverCapability,revision:async()=>state?{schemaVersion:state.schemaVersion,organizationId:org,revision:state.revision}:null,changes:async(_org:string,after:number)=>state?page(after):null}))});
  const request=(cap:1|2=2,command?:ErpCommand,key=`operation-${++sequence}`,revision=state?.revision??0)=>new Request(`https://zentraapp.ch/api/international/workspaces/${org}/erp`,{method:command?'POST':'GET',headers:{Origin:'https://zentraapp.ch','Content-Type':'application/json','X-Zentra-Expected-User':initialActor.userId,...(cap===2?{[ERP_SCHEMA_HEADER]:'2'}:{})},...(command?{body:JSON.stringify({idempotencyKey:key,expectedRevision:revision,command})}:{})});
  const fetcher=vi.fn(async(url:RequestInfo|URL,options?:RequestInit)=>{
    const target=typeof url==='string'?url:url instanceof URL?url.href:url.url;
    const r=new Request(new URL(target,'https://zentraapp.ch'),{...options,headers:{...Object.fromEntries(new Headers(options?.headers)),Origin:'https://zentraapp.ch'}});
    const result=r.method==='POST'?await handler.POST(r,org):await handler.GET(r,org);
    if(loseResponse&&r.method==='POST'&&result.ok){loseResponse=false;throw new TypeError('synthetic lost HTTP response');}return result;
  });
  const browser=createBrowserErpSession({organizationId:org,expectedUserId:initialActor.userId,supportedSchemaVersion:2,fetch:fetcher,newId:()=>`browser-${++sequence}`});
  const send=(command:ErpCommand,cap:1|2=2)=>handler.POST(request(cap,command),org);
  const ready=async()=>{expect((await send(initialize)).status).toBe(200);expect((await send(vendor)).status).toBe(200);expect((await send(bill)).status).toBe(200);};
  return {dependencies,handler,sync,store,fetcher,browser,request,send,ready,events,commits,page,state:()=>state!,actor:(next:Partial<FinancialAuthority>)=>{actor={...actor,...next};},lose:()=>{loseResponse=true;}};
}
describe('explicit purchasing transport capability and unchanged Auth admission',()=>{
  it('runs a cookie browser through initialize, vendor, approved bill and partial payment with exact public data',async()=>{
    const t=fixture();expect((await t.browser.load()).status).toBe('uninitialized');
    for(const command of [initialize,vendor,bill,payment]){
      await t.browser.submit(command,t.state()?.revision??0);const current=await t.browser.load();expect(current.status).toBe('ready');
      if(current.status==='ready'){expect(current.state).toEqual(publicErpState(t.state()));expect(current.state.configuration).not.toHaveProperty('ein');}
    }
    expect(t.state()).toMatchObject({schemaVersion:2,revision:4,counters:{estimate:0,invoice:0},vendorBills:[{total:{minorUnits:'10825'},validatedBy:initialActor.userId}],vendorPayments:[{amount:{minorUnits:'5000'},recordedBy:initialActor.userId}]});
    expect(t.state().ledger.entries).toHaveLength(2);
    for(const commit of t.commits.slice(2)){const row=commit.changes.find(change=>['vendor_bill','vendor_payment'].includes(change.kind))!.payload as Record<string,unknown>;expect(row.approvedAt??row.recordedAt).toBe(commit.actor.timestamp);expect(commit.changes.find(change=>change.kind==='journal')!.payload).toMatchObject({postedAt:commit.actor.timestamp});}
    for(const [,options] of t.fetcher.mock.calls){expect(new Headers(options?.headers).get(ERP_SCHEMA_HEADER)).toBe('2');expect(options?.credentials).toBe('same-origin');expect(new Headers(options?.headers).has('Authorization')).toBe(false);}
  });
  it('retains and retries exactly one vendor payment after the real handler committed but HTTP delivery failed',async()=>{
    const t=fixture();await t.ready();await t.browser.load();t.lose();await expect(t.browser.submit(payment,3)).rejects.toMatchObject({outcome:'uncertain'});expect(t.state().vendorPayments).toHaveLength(1);expect(t.browser.hasPending()).toBe(true);
    const original=t.fetcher.mock.calls.at(-1)![1]?.body;expect((await t.browser.retry()).replayed).toBe(true);expect(t.fetcher.mock.calls.at(-1)![1]?.body).toBe(original);expect(t.state().revision).toBe(4);expect(t.state().vendorPayments).toHaveLength(1);expect(t.state().ledger.entries).toHaveLength(2);
  });
  it('rejects legacy browser purchasing locally before creating a request or calling fetch',async()=>{
    const fetcher=vi.fn();const browser=createBrowserErpSession({organizationId:org,fetch:fetcher});await expect(browser.submit(vendor,1)).rejects.toMatchObject({code:'client_upgrade_required',status:409,outcome:'rejected'});expect(fetcher).not.toHaveBeenCalled();expect(browser.hasPending()).toBe(false);
  });
  it('rejects a v2 book returned incorrectly to a legacy browser without treating it as usable financial data',async()=>{
    const t=fixture();await t.ready();const fetcher=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>Response.json({status:'ready',state:publicErpState(t.state())}));const browser=createBrowserErpSession({organizationId:org,fetch:fetcher});await expect(browser.load()).rejects.toMatchObject({code:'client_upgrade_required',status:409});expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has(ERP_SCHEMA_HEADER)).toBe(false);
  });
  it('allows legacy reads before first purchase, then fails legacy reads and exact old receipt retries closed',async()=>{
    const t=fixture();const old=t.request(1,initialize,'old-init',0);expect((await t.handler.POST(old.clone() as Request,org)).status).toBe(200);expect((await t.handler.GET(t.request(1),org)).status).toBe(200);await t.send(vendor);const r=await t.handler.GET(t.request(1),org);expect(r.status).toBe(409);expect(await r.json()).toEqual({error:'client_upgrade_required'});const replay=await t.handler.POST(old.clone() as Request,org);expect(replay.status).toBe(409);expect(await replay.json()).toEqual({error:'client_upgrade_required'});expect(t.state().revision).toBe(2);
  });
  it('keeps the server capability closed even when a client announces v2',async()=>{
    const t=fixture(1);expect((await t.send(initialize)).status).toBe(200);const r=await t.send(vendor);expect(r.status).toBe(409);expect(await r.json()).toEqual({error:'purchasing_unavailable'});expect(t.state().schemaVersion).toBe(1);expect(t.state()).not.toHaveProperty('vendors');expect(t.state().revision).toBe(1);
  });
  it('enforces the trusted factory cap rather than allowing an uncapped port to replay to a legacy writer',async()=>{
    const t=fixture();t.dependencies.store=()=>t.store;const r=await t.send(initialize,1);expect(r.status).toBe(409);expect(await r.json()).toEqual({error:'client_upgrade_required'});expect(t.store.receipt).not.toHaveBeenCalled();expect(t.store.commit).not.toHaveBeenCalled();
  });
  it.each(['save_vendor','record_vendor_bill','record_vendor_payment'])('requires an explicit v2 header for %s even when the server supports it',async action=>{
    const t=fixture();const command=[vendor,bill,payment].find(item=>item.type===action)!;const r=await t.send(command,1);expect(r.status).toBe(409);expect(await r.json()).toEqual({error:'client_upgrade_required'});expect(t.dependencies.store).not.toHaveBeenCalled();expect(t.store.commit).not.toHaveBeenCalled();
  });
  it.each(['3','02','2, 2',' 2 ',''])('rejects malformed capability %j (whitespace normalization tested separately)',async value=>{
    const t=fixture();const r=t.request();r.headers.set(ERP_SCHEMA_HEADER,value);const normalized=r.headers.get(ERP_SCHEMA_HEADER);const response=await t.handler.GET(r,org);expect(response.status).toBe(normalized==='2'?200:422);if(normalized!=='2')expect(t.store.read).not.toHaveBeenCalled();
  });
  it.each(['member','read_only'] as const)('v2 never supplies financial permission for %s',async role=>{
    const t=fixture();await t.send(initialize);t.actor({role});const r=await t.send(vendor);expect(r.status).toBe(403);expect(await r.json()).toEqual({error:'financial_permission_required'});expect(t.state().revision).toBe(1);
  });
  it.each([401,402,403])('Auth denial %s precedes parsing capability or opening storage',async status=>{
    const t=fixture();t.dependencies.authority=async()=>{throw new AccountPublicError('private Auth detail',status);};const request=t.request();request.headers.set(ERP_SCHEMA_HEADER,'3');const r=await t.handler.POST(request,org);expect(r.status).toBe(status);expect(t.dependencies.store).not.toHaveBeenCalled();expect(JSON.stringify(await r.json())).not.toContain('private');
  });
  it('withholds a v2 read after actual access is revoked and does not leak the version or book',async()=>{
    const t=fixture();await t.ready();let calls=0;t.dependencies.authority=async()=>{if(++calls>1)throw new AccountPublicError('revoked',401);return {mode:'browser',actor:initialActor};};const r=await t.handler.GET(t.request(1),org);expect(r.status).toBe(401);expect(await r.json()).toEqual({error:'unauthorized'});
  });
  it.each(['revision','changes'] as const)('returns %s only to a capable admitted reader and keeps old callers closed',async operation=>{
    const t=fixture();await t.ready();const old=new Request(`https://zentraapp.ch/erp/changes?after=0`),current=new Request(old.url,{headers:{[ERP_SCHEMA_HEADER]:'2'}});
    const rejected=await t.sync[operation](old,org);expect(rejected.status).toBe(409);expect(await rejected.json()).toEqual({error:'client_upgrade_required'});
    const accepted=await t.sync[operation](current,org);expect(accepted.status).toBe(200);const result=await accepted.json();expect(result).toMatchObject({schemaVersion:2,organizationId:org});if(operation==='changes'){const replica=applyErpDelta(null,result,org,2)!;expect(replica).toEqual(publicErpState(t.state()));expect((result as ErpDelta).events.map(event=>event.schemaVersion)).toEqual([1,2,2]);}
  });
  it('bounds schema headers without changing omitted/default v1 behavior',()=>{
    expect(erpClientSchemaVersion(new Request('https://zentraapp.ch'))).toBe(1);expect(erpClientSchemaVersion(new Request('https://zentraapp.ch',{headers:{[ERP_SCHEMA_HEADER]:'1'}}))).toBe(1);expect(erpClientSchemaVersion(new Request('https://zentraapp.ch',{headers:{[ERP_SCHEMA_HEADER]:'2'}}))).toBe(2);expect(()=>createBrowserErpSession({organizationId:org,supportedSchemaVersion:3 as 1|2})).toThrow('invalid_request');
  });
});
describe('capability-selected Supabase ports',()=>{
  it.each([1,2] as const)('selects all guarded RPC names for capability%s while preserving existing receipt shape',async cap=>{
    const t=fixture();await t.send(initialize);const rpc=vi.fn(async(name:string)=>name.includes('receipt')?t.commits[0].receipt:name.includes('revision')?{schemaVersion:cap,organizationId:org,revision:1}:name.includes('delta')?{...t.page(0),schemaVersion:cap}:t.state());
    const client={rpc:async<T>(name:string,_parameters:Readonly<Record<string,unknown>>):Promise<T>=>await rpc(name) as T};
    const store=createSupabaseErpStore(client,{supportedSchemaVersion:cap}),sync=createSupabaseErpSyncStore(client,{supportedSchemaVersion:cap});
    expect(await store.read(org)).toEqual(t.state());expect(await store.receipt(org,t.commits[0].receipt.idempotencyKey)).toEqual(t.commits[0].receipt);await sync.revision(org);await sync.changes(org,0,100);
    expect(rpc.mock.calls.map(([name])=>name)).toEqual(['zentra_read_us_erp','zentra_us_erp_receipt','zentra_us_erp_revision','zentra_us_erp_delta'].map(name=>cap===2?`${name}_v2`:name));
  });
  it('defaults both ports to1; a forged v2 state cannot pass the legacy port',async()=>{
    const t=fixture();await t.ready();const rpc=vi.fn(async()=>t.state());const client={rpc:async<T>(_name:string,_parameters:Readonly<Record<string,unknown>>):Promise<T>=>await rpc() as T};const store=createSupabaseErpStore(client);expect(store.supportedSchemaVersion).toBe(1);expect(createSupabaseErpSyncStore(client).supportedSchemaVersion).toBe(1);await expect(store.read(org)).rejects.toMatchObject({code:'client_upgrade_required',status:409});
  });
});
