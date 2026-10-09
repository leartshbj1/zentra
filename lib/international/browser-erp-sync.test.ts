import { describe, expect, it, vi } from 'vitest';
import { createBrowserErpSession, type BrowserErpRead } from './browser-erp-session';
import { executeErp } from './runtime';
import { applyErpDelta, type ErpDelta, type ErpEvent } from './runtime-sync';
import { publicErpDelta, publicErpState } from './public-projection';
import { money } from './money';
import type { CompanyConfiguration } from './types';
import type { ErpCommand, ErpReceipt, ErpRequest, ErpState, ErpStore } from './runtime-types';

const organizationId='fictitious-browser-sync',userId='fictitious-owner';
const configuration:CompanyConfiguration={schemaVersion:1,organizationId,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Fictitious Street',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'configured'}};
const customer=(id:string):Extract<ErpCommand,{type:'save_customer'}>=>({type:'save_customer',customer:{id,organizationId,kind:'business',name:`Fictitious ${id}`,billingAddress:configuration.address,paymentTermsDays:30}});
const requestUrl=(input:RequestInfo|URL)=>typeof input==='string'?input:input instanceof URL?input.href:input.url;

/** Real ERP engine, committed events and public projections; fictitious RAM
 * persistence and tax evidence only. No external account, provider or network. */
async function fixture(initialize=true){
  let state:ErpState|null=null,key=0,losePost=false;
  const events:ErpEvent[]=[],receipts=new Map<string,ErpReceipt>();
  const actor={organizationId,userId,role:'owner' as const,managementEntitled:true,timestamp:'2026-10-08T12:00:00.000Z'};
  const page=(after:number,limit=10):ErpDelta=>({schemaVersion:4,organizationId,fromRevision:after,toRevision:Math.min(after+limit,events.length),headRevision:events.length,hasMore:after+limit<events.length,resetRequired:false,events:events.slice(after,after+limit)});
  const store:ErpStore={supportedSchemaVersion:4,read:async()=>structuredClone(state),receipt:async(_org,id)=>receipts.get(id)??null,commit:async input=>{
    const event:ErpEvent={schemaVersion:input.header.schemaVersion,organizationId,revision:input.header.revision,header:input.header,changes:input.changes,ledgerAudit:input.ledgerAudit,receipt:input.receipt,actorId:input.actor.userId,occurredAt:input.actor.timestamp};
    state=applyErpDelta(state,{schemaVersion:4,organizationId,fromRevision:input.expectedRevision,toRevision:event.revision,headRevision:event.revision,hasMore:false,resetRequired:false,events:[event]},organizationId,4);
    events.push(event);receipts.set(input.receipt.idempotencyKey,input.receipt);return input.receipt;
  }};
  const execute=(request:ErpRequest)=>executeErp({store,configuration,actor,revalidate:async()=>actor,seller:async()=>({organizationId,displayName:'Fictitious seller'}),taxProvider:async()=>({id:'fictitious-test-only',calculate:async input=>({...input,source:'external-provider' as const,providerReference:'fictitious-test-proof',determinedAt:actor.timestamp,validUntil:'2026-10-09T12:00:00.000Z',lines:input.lines.map(line=>({id:line.id,taxMinor:'0',jurisdiction:'fictitious-only',evidenceReference:'fictitious-only'}))})})},request);
  const send=(command:ErpCommand)=>execute({command,idempotencyKey:`remote-${++key}`,expectedRevision:state?.revision??0});
  if(initialize)await send({type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]});
  let intercept:((url:string,options:RequestInit)=>Promise<Response>|Response|undefined)|null=null;
  const fetcher=vi.fn(async(url:RequestInfo|URL,options?:RequestInit)=>{
    const path=requestUrl(url),init=options!;const intercepted=intercept?.(path,init);if(intercepted)return intercepted;
    if(init.method==='POST'){const result=await execute(JSON.parse(init.body as string));if(losePost){losePost=false;return Response.json({error:'service_unavailable'},{status:503});}return Response.json(result);}
    if(path.endsWith('/revision'))return Response.json(state?{schemaVersion:state.schemaVersion,organizationId,revision:state.revision}:null);
    if(path.includes('/changes?')){const query=new URL(path,'https://fictitious.test').searchParams;return Response.json(publicErpDelta(page(Number(query.get('after')),Number(query.get('limit')))));}
    return Response.json(state?{status:'ready',state:publicErpState(state)}:{status:'uninitialized',configuration});
  });
  const session=createBrowserErpSession({organizationId,expectedUserId:userId,supportedSchemaVersion:4,fetch:fetcher,newId:()=>`local-${++key}`});
  return {session,fetcher,send,page,events,state:()=>state!,setIntercept:(value:typeof intercept)=>{intercept=value;},losePost:()=>{losePost=true;}};
}
const changedState=(read:BrowserErpRead)=>{if(read.status!=='ready')throw new Error('Expected ready fixture');return read.state;};

describe('admitted browser ERP background deltas',()=>{
  it('returns the identical read at a stable head and performs only an admitted compact GET',async()=>{
    const t=await fixture(),current=await t.session.load();t.fetcher.mockClear();
    expect(await t.session.synchronize(current)).toEqual({status:'unchanged',read:current});expect((await t.session.synchronize(current)).read).toBe(current);
    for(const [url,init] of t.fetcher.mock.calls){expect(url).toBe(`/api/international/workspaces/${organizationId}/erp/revision`);expect(init).toMatchObject({method:'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error'});const headers=new Headers(init?.headers);expect(headers.get('X-Zentra-Expected-User')).toBe(userId);expect(headers.get('X-Zentra-Erp-Schema-Version')).toBe('4');expect(headers.has('Authorization')).toBe(false);}
  });
  it('supports a null uninitialized head and remotely initialized schema4 without a full read',async()=>{
    const t=await fixture(false),current=await t.session.load();expect((await t.session.synchronize(current)).read).toBe(current);
    await t.send({type:'initialize',periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]});t.fetcher.mockClear();
    const result=await t.session.synchronize(current);expect(result.status).toBe('changed');expect(changedState(result.read)).toEqual(t.state());expect(t.fetcher.mock.calls.map(([url])=>requestUrl(url))).toEqual([`/api/international/workspaces/${organizationId}/erp/revision`,`/api/international/workspaces/${organizationId}/erp/changes?after=0&limit=10`]);
  });
  it('applies remote customer, estimate, invoice and payment commits through the real immutable delta contract',async()=>{
    const t=await fixture(),current=await t.session.load();await t.send(customer('customer-1'));
    await t.send({type:'save_estimate',id:'estimate-1',expectedEstimateRevision:0,customerId:'customer-1',date:'2026-10-08',expiresAt:'2026-11-08',paymentTermsDays:30,notes:'Fictitious test',lines:[{id:'line-1',description:'Fictitious service',quantityUnits:'1',quantityScale:0,unitPrice:money('USD','10000'),discountBasisPoints:0,taxTreatment:'taxable'}]});
    await t.send({type:'accept_estimate',estimateId:'estimate-1',expectedEstimateRevision:1});
    await t.send({type:'issue_invoice',id:'invoice-1',estimateId:'estimate-1',expectedEstimateRevision:2,date:'2026-10-08',accountingDate:'2026-10-08',dueDate:'2026-11-07',periodId:'2026'});
    await t.send({type:'record_payment',id:'payment-1',invoiceId:'invoice-1',amountMinor:'2500',paymentDate:'2026-10-08',accountingDate:'2026-10-08',periodId:'2026',reference:'Fictitious payment'});
    t.fetcher.mockClear();const result=await t.session.synchronize(current),next=changedState(result.read);
    expect(result.status).toBe('changed');expect(next).toEqual(publicErpState(t.state()));expect(next.invoices[0].payments[0].amount.minorUnits).toBe('2500');expect(next.ledger.entries).toHaveLength(2);expect(changedState(current).customers).toHaveLength(0);expect(Object.isFrozen(next.invoices[0].payments[0].amount)).toBe(true);expect(t.fetcher.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
  });
  it('caps each round at eight pages of 10 events and resumes from the validated partial cursor',async()=>{
    const t=await fixture(),current=await t.session.load();for(let index=0;index<85;index++)await t.send(customer(`customer-${index}`));t.fetcher.mockClear();
    const first=await t.session.synchronize(current);expect(first.status).toBe('changed');expect(changedState(first.read).revision).toBe(81);expect(changedState(first.read).customers).toHaveLength(80);expect(t.fetcher).toHaveBeenCalledTimes(9);
    const second=await t.session.synchronize(first.read);expect(changedState(second.read)).toEqual(t.state());expect(t.fetcher.mock.calls.at(-1)?.[0]).toBe(`/api/international/workspaces/${organizationId}/erp/changes?after=81&limit=10`);
  });
  it('uses one full read only when the durable stream requests reset',async()=>{
    const t=await fixture(),current=await t.session.load();await t.send(customer('remote'));t.fetcher.mockClear();
    t.setIntercept(url=>url.includes('/changes?')?Response.json({...t.page(1),toRevision:1,hasMore:false,resetRequired:true,events:[]}):undefined);
    const result=await t.session.synchronize(current);expect(result.status).toBe('changed');expect(changedState(result.read)).toEqual(t.state());expect(t.fetcher.mock.calls.map(([url])=>requestUrl(url))).toEqual([`/api/international/workspaces/${organizationId}/erp/revision`,`/api/international/workspaces/${organizationId}/erp/changes?after=1&limit=10`,`/api/international/workspaces/${organizationId}/erp`]);
  });
  it('rejects a regressed reset snapshot without changing the original read',async()=>{
    const t=await fixture(),current=await t.session.load();await t.send(customer('remote'));
    t.setIntercept(url=>url.includes('/changes?')?Response.json({...t.page(1),toRevision:1,hasMore:false,resetRequired:true,events:[]}):url.endsWith('/erp')?Response.json(current):undefined);
    await expect(t.session.synchronize(current)).rejects.toMatchObject({code:'invalid_sync_state',outcome:'rejected'});expect(changedState(current).revision).toBe(1);
  });
  it.each(['tenant','schema','lower','null','private'] as const)('rejects a %s head before fetching records',async kind=>{
    const t=await fixture(),current=await t.session.load();t.fetcher.mockClear();const head:Record<string,unknown>={schemaVersion:4,organizationId,revision:1};if(kind==='tenant')head.organizationId='another-company';if(kind==='schema')head.schemaVersion=5;if(kind==='lower')head.revision=0;if(kind==='private')head.secret='private-test';t.setIntercept(()=>Response.json(kind==='null'?null:head));
    await expect(t.session.synchronize(current)).rejects.toMatchObject({code:'invalid_sync_state',outcome:'rejected'});expect(t.fetcher).toHaveBeenCalledOnce();
  });
  it('refuses a newer supported schema and a current projection from another company',async()=>{
    const t=await fixture(),current=await t.session.load();const session=createBrowserErpSession({organizationId,expectedUserId:userId,supportedSchemaVersion:3,fetch:t.fetcher});
    await expect(session.synchronize(current)).rejects.toMatchObject({code:'client_upgrade_required',status:409});t.fetcher.mockClear();const foreign:BrowserErpRead={status:'ready',state:{...changedState(current),configuration:{...changedState(current).configuration,organizationId:'other'}}};
    await expect(t.session.synchronize(foreign)).rejects.toMatchObject({code:'invalid_sync_state'});expect(t.fetcher).toHaveBeenCalledOnce();
  });
  it.each(['revision','schema'] as const)('refuses a valid but regressed %s head',async kind=>{
    const t=await fixture();await t.send(customer('remote'));const current=await t.session.load();t.fetcher.mockClear();t.setIntercept(()=>Response.json({schemaVersion:kind==='schema'?3:4,organizationId,revision:kind==='revision'?1:2}));
    await expect(t.session.synchronize(current)).rejects.toMatchObject({code:'invalid_sync_state'});expect(t.fetcher).toHaveBeenCalledOnce();expect(changedState(current).revision).toBe(2);
  });
  it('rejects a corrupt later page without exposing an earlier valid candidate or mutating the input',async()=>{
    const t=await fixture(),current=await t.session.load(),before=JSON.stringify(current);await t.send(customer('remote-1'));await t.send(customer('remote-2'));
    t.setIntercept(url=>{if(!url.includes('/changes?'))return;const after=Number(new URL(url,'https://fictitious.test').searchParams.get('after')),delta=structuredClone(t.page(after,1));if(after===2)(delta.events[0].changes[0].payload as Record<string,unknown>).organizationId='foreign';return Response.json(delta);});
    await expect(t.session.synchronize(current)).rejects.toMatchObject({code:'invalid_sync_state'});expect(JSON.stringify(current)).toBe(before);
  });
  it('rejects nonprogressing or regressed page heads without a full GET',async()=>{
    const t=await fixture(),current=await t.session.load();await t.send(customer('remote'));t.fetcher.mockClear();t.setIntercept(url=>url.includes('/changes?')?Response.json({...t.page(1),headRevision:1,toRevision:1,events:[],hasMore:false}):undefined);
    await expect(t.session.synchronize(current)).rejects.toMatchObject({code:'invalid_sync_state'});expect(t.fetcher).toHaveBeenCalledTimes(2);
  });
  it('probes admission during uncertainty while preserving exact retry body and never posting automatically',async()=>{
    const t=await fixture(),current=await t.session.load();t.losePost();await expect(t.session.submit(customer('local'),1)).rejects.toMatchObject({outcome:'uncertain'});const original=t.fetcher.mock.calls.at(-1)![1]!.body;await t.send(customer('remote'));t.fetcher.mockClear();
    const result=await t.session.synchronize(current);expect(result).toEqual({status:'deferred',read:current});expect(result.read).toBe(current);expect(t.fetcher).toHaveBeenCalledOnce();expect(requestUrl(t.fetcher.mock.calls[0][0])).toMatch(/\/revision$/);expect(t.session.hasPending()).toBe(true);
    await t.session.retry();const posts=t.fetcher.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts).toHaveLength(1);expect(posts[0][1]!.body).toBe(original);expect(JSON.parse(posts[0][1]!.body as string).command.customer.id).toBe('local');expect(t.state().customers).toHaveLength(2);expect(t.session.hasPending()).toBe(false);
  });
  it.each([401,402,403])('rejects HTTP%s admission at headers without consuming a stalled body or releasing pending',async status=>{
    const t=await fixture(),current=await t.session.load();t.losePost();await expect(t.session.submit(customer('local'),1)).rejects.toMatchObject({outcome:'uncertain'});
    const response=new Response(new ReadableStream({start(){}}),{status,headers:{'Content-Type':'application/json'}}),reader=vi.spyOn(response.body!,'getReader');t.setIntercept(()=>response);
    await expect(t.session.synchronize(current)).rejects.toMatchObject({outcome:'unauthorized',status});expect(reader).not.toHaveBeenCalled();expect(t.session.hasPending()).toBe(true);
  });
  it('probes the head and defers while an explicit local POST is still in flight',async()=>{
    const t=await fixture(),current=await t.session.load();let finish!:(response:Response)=>void;t.setIntercept((_url,init)=>init.method==='POST'?new Promise<Response>(resolve=>{finish=resolve;}):undefined);const writing=t.session.submit(customer('local'),1);const body=t.fetcher.mock.calls.at(-1)![1]!.body as string;
    expect((await t.session.synchronize(current)).status).toBe('deferred');expect(t.fetcher.mock.calls.at(-1)![0]).toBe(`/api/international/workspaces/${organizationId}/erp/revision`);expect(t.session.hasPending()).toBe(true);
    finish(Response.json({receipt:{idempotencyKey:JSON.parse(body).idempotencyKey,commandHash:'a'.repeat(64),revision:2,entityId:'local',action:'save_customer'},replayed:false}));await writing;
  });
  it.each(['write','load'] as const)('defers a delayed delta when a concurrent local %s wins',async operation=>{
    const t=await fixture(),current=await t.session.load();await t.send(customer('remote'));let finish!:(response:Response)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    t.setIntercept(url=>url.includes('/changes?')?new Promise<Response>(resolve=>{finish=resolve;entered();}):undefined);const syncing=t.session.synchronize(current);await started;const page=Response.json(t.page(1));
    if(operation==='write')await t.session.submit(customer('local'),t.state().revision);else await t.session.load();finish(page);
    const result=await syncing;expect(result.status).toBe('deferred');expect(result.read).toBe(current);expect(changedState(current).revision).toBe(1);
  });
  it('does not supersede a local load already in flight',async()=>{
    const t=await fixture(),current=await t.session.load();let finish!:(response:Response)=>void;t.setIntercept(url=>url.endsWith('/erp')?new Promise<Response>(resolve=>{finish=resolve;}):undefined);const loading=t.session.load();
    expect((await t.session.synchronize(current)).status).toBe('deferred');finish(Response.json(current));await expect(loading).resolves.toEqual(current);
  });
  it('withholds a delayed admitted candidate after a second read observes revocation',async()=>{
    const t=await fixture(),current=await t.session.load();await t.send(customer('remote'));let finish!:(response:Response)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    t.setIntercept(url=>url.includes('/changes?')?new Promise<Response>(resolve=>{finish=resolve;entered();}):url.endsWith('/erp')?Response.json({error:'forbidden'},{status:403}):undefined);
    const syncing=t.session.synchronize(current);await started;await expect(t.session.load()).rejects.toMatchObject({outcome:'unauthorized'});finish(Response.json(t.page(1)));await expect(syncing).rejects.toMatchObject({code:'session_changed',outcome:'unauthorized'});
  });
  it('rejects an oversized head before reading its body and maps private error codes to the closed public set',async()=>{
    const t=await fixture(),current=await t.session.load();t.setIntercept(()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'4097'}}));await expect(t.session.synchronize(current)).rejects.toMatchObject({code:'invalid_response'});
    t.setIntercept(()=>Response.json({error:'private-secret-code',debug:'private-token'},{status:503}));await expect(t.session.synchronize(current)).rejects.toMatchObject({code:'service_unavailable'});
  });
  it('enforces streamed head bytes without trusting a missing Content-Length',async()=>{
    const t=await fixture(),current=await t.session.load();const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(' '.repeat(4097)));controller.close();}});t.setIntercept(()=>new Response(body,{headers:{'Content-Type':'application/json'}}));
    await expect(t.session.synchronize(current)).rejects.toMatchObject({code:'invalid_response',outcome:'rejected'});
  });
  it('rejects a delta body larger than the server four MiB page limit',async()=>{
    const t=await fixture(),current=await t.session.load();await t.send(customer('remote'));t.setIntercept(url=>url.includes('/changes?')?new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(4*1024*1024+1)}}):undefined);
    await expect(t.session.synchronize(current)).rejects.toMatchObject({code:'invalid_response',outcome:'rejected'});expect(changedState(current).revision).toBe(1);
  });
  it('bounds a stalled delta body within the total synchronization deadline',async()=>{
    vi.useFakeTimers();try{const t=await fixture(),current=await t.session.load();await t.send(customer('remote'));t.setIntercept(url=>url.includes('/changes?')?new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'application/json'}}):undefined);const sync=t.session.synchronize(current),assertion=expect(sync).rejects.toMatchObject({code:'response_timeout',outcome:'rejected'});await vi.advanceTimersByTimeAsync(30000);await assertion;expect(vi.getTimerCount()).toBe(0);expect(changedState(current).revision).toBe(1);}finally{vi.useRealTimers();}
  });
  it('cannot return a candidate after disposal',async()=>{
    const t=await fixture(),current=await t.session.load();let finish!:(response:Response)=>void;t.setIntercept(()=>new Promise<Response>(resolve=>{finish=resolve;}));const syncing=t.session.synchronize(current);t.session.dispose();finish(Response.json({schemaVersion:4,organizationId,revision:1}));await expect(syncing).rejects.toMatchObject({code:'session_disposed',outcome:'unauthorized'});
  });
});
