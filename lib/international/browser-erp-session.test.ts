import { describe, expect, it, vi } from 'vitest';
import { createBrowserErpSession, BrowserErpError } from './browser-erp-session';
import { createLedger } from './accounting/ledger';
import { nationalAdapter } from './countries/adapters';
import type { CompanyConfiguration } from './types';
import type { ErpCommand, ErpReceipt, ErpState } from './runtime-types';

const organizationId='browser-US';
const configuration:CompanyConfiguration={schemaVersion:1,organizationId,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Fictitious Street',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}};
const periods=[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open' as const}];
const command:ErpCommand={type:'initialize',periods};
const state:ErpState={schemaVersion:1,revision:1,configuration,counters:{estimate:0,invoice:0},customers:[],estimates:[],invoices:[],ledger:createLedger({organizationId,currency:'USD',basis:'accrual',accounts:nationalAdapter('US').starterChart,periods})};
const receipt:ErpReceipt={idempotencyKey:'stable-request',commandHash:'a'.repeat(64),revision:1,entityId:organizationId,action:'initialize'};
function fixture(){
  const queue:Array<()=>Promise<Response>|Response>=[];
  const fetcher=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>{const response=queue.shift();if(!response)throw new Error('No queued response');return response();});
  const newId=vi.fn(()=> 'stable-request');
  const session=createBrowserErpSession({organizationId,expectedUserId:'expected-auth-user',fetch:fetcher,newId});
  const enqueue=(value:unknown,status=200)=>queue.push(()=>Response.json(value,{status}));
  return {session,fetcher,newId,queue,enqueue};
}
async function error(promise:Promise<unknown>,code:string,outcome:string,status:number){await expect(promise).rejects.toMatchObject({name:'BrowserErpError',code,outcome,status});}
describe('browser ERP cookie transport, not offline or persistent storage',()=>{
  it('loads uninitialized or ready US projections through same-origin cookies only',async()=>{
    const t=fixture();t.enqueue({status:'uninitialized',configuration});expect(await t.session.load()).toEqual({status:'uninitialized',configuration});t.enqueue({status:'ready',state});expect(await t.session.load()).toEqual({status:'ready',state});
    for(const [url,options] of t.fetcher.mock.calls){expect(url).toBe('/api/international/workspaces/browser-US/erp');expect(options).toMatchObject({method:'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error'});expect(new Headers(options?.headers).has('Authorization')).toBe(false);expect(new Headers(options?.headers).get('X-Zentra-Expected-User')).toBe('expected-auth-user');}
  });
  it('retains the original body and key after a lost response without creating another mutation',async()=>{
    const t=fixture();const mutable=structuredClone(command);t.queue.push(()=>{throw new TypeError('private-network-token');});await error(t.session.submit(mutable,0),'response_unavailable','uncertain',0);expect(t.session.hasPending()).toBe(true);
    (mutable.periods[0] as {id:string}).id='changed-after-send';await error(t.session.submit(command,0),'pending_operation','rejected',409);expect(t.fetcher).toHaveBeenCalledTimes(1);
    t.enqueue({receipt,replayed:true});expect(await t.session.retry()).toEqual({receipt,replayed:true});expect(t.session.hasPending()).toBe(false);expect(t.newId).toHaveBeenCalledOnce();expect(t.fetcher.mock.calls[1][1]?.body).toBe(t.fetcher.mock.calls[0][1]?.body);expect(JSON.parse(t.fetcher.mock.calls[1][1]?.body as string).command.periods[0].id).toBe('2026');
  });
  it.each([[503,'service_unavailable','uncertain'],[404,'feature_unavailable','uncertain'],[409,'configuration_changed','uncertain'],[401,'session_changed','unauthorized'],[402,'management_entitlement_required','unauthorized'],[403,'forbidden','unauthorized']] as const)('does not reinterpret postcommit HTTP %s as a rejected transaction',async(status,code,outcome)=>{
    const t=fixture();t.enqueue({error:code},status);await error(t.session.submit(command,0),status===401?'unauthorized':code,outcome,status);expect(t.session.hasPending()).toBe(true);
    t.enqueue({receipt,replayed:true});expect(await t.session.retry()).toEqual({receipt,replayed:true});expect(t.newId).toHaveBeenCalledOnce();expect(t.fetcher.mock.calls[1][1]?.body).toBe(t.fetcher.mock.calls[0][1]?.body);
  });
  it.each([[401,'unauthorized'],[402,'management_entitlement_required'],[403,'forbidden']] as const)('HTTP%s remains unauthorized when its body is not JSON, preserving pending privately',async(status,code)=>{
    const t=fixture();t.queue.push(()=>new Response('<html>private proxy token</html>',{status}));await error(t.session.submit(command,0),code,'unauthorized',status);expect(t.session.hasPending()).toBe(true);t.enqueue({receipt,replayed:true});await t.session.retry();expect(t.fetcher.mock.calls[1][1]?.body).toBe(t.fetcher.mock.calls[0][1]?.body);
    t.queue.push(()=>new Response('private forbidden page',{status}));await error(t.session.load(),code,'unauthorized',status);
  });
  it.each([[401,'unauthorized'],[402,'management_entitlement_required'],[403,'forbidden']] as const)('HTTP%s rejects immediately without consuming a stalled JSON body',async(status,code)=>{
    vi.useFakeTimers();try{const t=fixture();const response=Response.json({error:code},{status});const json=vi.spyOn(response,'json').mockImplementation(()=>new Promise(()=>{}));t.queue.push(()=>response);await error(t.session.submit(command,0),code,'unauthorized',status);expect(json).not.toHaveBeenCalled();expect(t.session.hasPending()).toBe(true);expect(t.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);}finally{vi.useRealTimers();}
  });
  it.each(['revision_conflict','estimate_revision_conflict','idempotency_conflict'])('treats the explicit precommit %s as rejected and requires a read before another submission',async code=>{
    const t=fixture();t.enqueue({error:code},409);await error(t.session.submit(command,0),code,'rejected',409);expect(t.session.hasPending()).toBe(false);await error(t.session.submit(command,0),'read_required','rejected',409);expect(t.fetcher).toHaveBeenCalledOnce();
    t.enqueue({status:'uninitialized',configuration});await t.session.load();t.enqueue({receipt,replayed:false});expect(await t.session.submit(command,0)).toEqual({receipt,replayed:false});
  });
  it('a GET during uncertainty does not release the pending command or automatically resend it',async()=>{
    const t=fixture();t.enqueue({error:'service_unavailable'},503);await error(t.session.submit(command,0),'service_unavailable','uncertain',503);t.enqueue({status:'ready',state});await t.session.load();expect(t.session.hasPending()).toBe(true);expect(t.fetcher).toHaveBeenCalledTimes(2);await error(t.session.submit(command,1),'pending_operation','rejected',409);
  });
  it('requires a fresh read after a reliable receipt before accepting another command',async()=>{
    const t=fixture();t.enqueue({receipt,replayed:false});await t.session.submit(command,0);await error(t.session.submit(command,1),'read_required','rejected',409);expect(t.fetcher).toHaveBeenCalledOnce();t.enqueue({status:'ready',state});await t.session.load();
    t.enqueue({error:'revision_conflict'},409);await error(t.session.submit(command,1),'revision_conflict','rejected',409);expect(t.fetcher).toHaveBeenCalledTimes(3);
  });
  it('a read begun before a write conflict cannot clear the required fresh read',async()=>{
    const t=fixture();let finish!:(response:Response)=>void;t.queue.push(()=>new Promise(resolve=>{finish=resolve;}));const old=t.session.load();t.enqueue({error:'revision_conflict'},409);await error(t.session.submit(command,0),'revision_conflict','rejected',409);finish(Response.json({status:'uninitialized',configuration}));await error(old,'stale_read','rejected',0);await error(t.session.submit(command,0),'read_required','rejected',409);expect(t.fetcher).toHaveBeenCalledTimes(2);
    t.enqueue({status:'uninitialized',configuration});await t.session.load();t.enqueue({receipt,replayed:false});await t.session.submit(command,0);
  });
  it('a read begun before a successful write cannot replace the required latest state',async()=>{
    const t=fixture();let finish!:(response:Response)=>void;t.queue.push(()=>new Promise(resolve=>{finish=resolve;}));const old=t.session.load();t.enqueue({receipt,replayed:false});await t.session.submit(command,0);finish(Response.json({status:'uninitialized',configuration}));await error(old,'stale_read','rejected',0);await error(t.session.submit(command,1),'read_required','rejected',409);
  });
  it('does not deliver an older read after a newer read or an unauthorized write',async()=>{
    const t=fixture();let finish!:(response:Response)=>void;t.queue.push(()=>new Promise(resolve=>{finish=resolve;}));const old=t.session.load();t.enqueue({status:'ready',state});await t.session.load();finish(Response.json({status:'uninitialized',configuration}));await error(old,'stale_read','rejected',0);
    t.queue.push(()=>new Promise(resolve=>{finish=resolve;}));const revoked=t.session.load();t.enqueue({error:'session_changed'},401);await error(t.session.submit(command,0),'unauthorized','unauthorized',401);finish(Response.json({status:'ready',state}));await error(revoked,'stale_read','rejected',0);expect(t.session.hasPending()).toBe(true);
  });
  it('a read begun before an uncertain write cannot present precommit state as the latest read',async()=>{
    const t=fixture();let finish!:(response:Response)=>void;t.queue.push(()=>new Promise(resolve=>{finish=resolve;}));const old=t.session.load();t.enqueue({error:'service_unavailable'},503);await error(t.session.submit(command,0),'service_unavailable','uncertain',503);finish(Response.json({status:'uninitialized',configuration}));await error(old,'stale_read','rejected',0);expect(t.session.hasPending()).toBe(true);
    t.enqueue({status:'ready',state});await t.session.load();expect(t.session.hasPending()).toBe(true);
  });
  it.each([401,402,403])('withholds a delayed authorized POST after a parallel denied GET%s and preserves exact recovery',async status=>{
    const t=fixture();let finish!:(response:Response)=>void;t.queue.push(()=>new Promise(resolve=>{finish=resolve;}));
    const writing=t.session.submit(command,0).catch(error=>error);t.enqueue({error:'forbidden'},status);
    await error(t.session.load(),status===401?'unauthorized':status===402?'management_entitlement_required':'forbidden','unauthorized',status);finish(Response.json({receipt,replayed:false}));
    expect(await writing).toMatchObject({code:'session_changed',outcome:'unauthorized',status:0});expect(t.session.hasPending()).toBe(true);
    t.enqueue({receipt,replayed:true});expect(await t.session.retry()).toEqual({receipt,replayed:true});
    expect(t.fetcher.mock.calls[2][1]?.body).toBe(t.fetcher.mock.calls[0][1]?.body);expect(t.newId).toHaveBeenCalledOnce();
  });
  it.each(['malformed','private','wrong-status'])('keeps uncertainty for %s error responses without exposing private response text',async kind=>{
    const t=fixture();if(kind==='malformed')t.queue.push(()=>new Response('private <html>debug token</html>',{status:503}));if(kind==='private')t.enqueue({error:'private_account_secret',debug:'private-token'},409);if(kind==='wrong-status')t.enqueue({error:'revision_conflict'},503);
    const expected=kind==='malformed'?'invalid_response':kind==='private'?'service_unavailable':'revision_conflict';await error(t.session.submit(command,0),expected,'uncertain',kind==='private'?409:503);expect(t.session.hasPending()).toBe(true);t.enqueue({receipt,replayed:true});await t.session.retry();
  });
  it('does not reuse financial state after the cookie account changes',async()=>{
    const t=fixture();t.enqueue({status:'ready',state});await t.session.load();t.enqueue({error:'session_changed'},401);await error(t.session.submit(command,0),'unauthorized','unauthorized',401);t.enqueue({error:'unauthorized'},401);await error(t.session.load(),'unauthorized','unauthorized',401);expect(t.session.hasPending()).toBe(true);
    t.enqueue({error:'idempotency_conflict'},409);await error(t.session.retry(),'idempotency_conflict','rejected',409);await error(t.session.submit(command,0),'read_required','rejected',409);expect(t.newId).toHaveBeenCalledOnce();
  });
  it.each(['key','action','entity','revision','hash','shape'])('withholds a malformed receipt %s while preserving exact retry',async field=>{
    const t=fixture();const bad:Record<string,unknown>={...receipt};if(field==='key')bad.idempotencyKey='foreign-key';if(field==='action')bad.action='save_customer';if(field==='entity')bad.entityId='foreign-org';if(field==='revision')bad.revision=9;if(field==='hash')bad.commandHash='private-debug';if(field==='shape')bad.debug='private-token';
    t.enqueue({receipt:bad,replayed:false});await error(t.session.submit(command,0),'invalid_response','uncertain',200);expect(t.session.hasPending()).toBe(true);t.enqueue({receipt,replayed:true});await t.session.retry();expect(t.newId).toHaveBeenCalledOnce();
  });
  it.each(['tenant','country','currency','revision','entity','ein','shape'])('rejects an invalid ready projection %s without caching it',async field=>{
    const t=fixture();const bad=structuredClone(state) as unknown as Record<string,unknown>;const profile=bad.configuration as Record<string,unknown>;if(field==='tenant')profile.organizationId='foreign';if(field==='country')profile.country='CH';if(field==='currency')profile.currency='CHF';if(field==='revision')bad.revision=0;if(field==='entity')bad.customers=[{id:'foreign',organizationId:'foreign'}];if(field==='ein')profile.ein='private-ein';if(field==='shape')bad.authority={private:'evidence'};
    t.enqueue({status:'ready',state:bad});await error(t.session.load(),'invalid_response','rejected',200);expect(t.session.hasPending()).toBe(false);
  });
  it.each(['tenant','country','currency','ein'])('rejects an invalid uninitialized configuration %s',async field=>{
    const t=fixture();const bad=structuredClone(configuration) as unknown as Record<string,unknown>;if(field==='tenant')bad.organizationId='foreign';if(field==='country')bad.country='CH';if(field==='currency')bad.currency='CHF';if(field==='ein')bad.ein='12-3456789';t.enqueue({status:'uninitialized',configuration:bad});await error(t.session.load(),'invalid_response','rejected',200);
  });
  it('rejects private or calculated input before fetch and measures the UTF-8 body limit',async()=>{
    const t=fixture();await error(t.session.submit({...command,role:'owner'} as ErpCommand,0),'invalid_request','rejected',422);expect(t.fetcher).not.toHaveBeenCalled();
    const customer={id:'customer',organizationId,kind:'business' as const,name:'Fictitious customer',billingAddress:configuration.address,paymentTermsDays:30};const estimate:ErpCommand={type:'save_estimate',id:'estimate',expectedEstimateRevision:0,customerId:customer.id,date:'2026-10-08',expiresAt:'2026-11-08',paymentTermsDays:30,lines:Array.from({length:100},(_,index)=>({id:`line-${index}`,description:'é'.repeat(2000),quantityUnits:'1',quantityScale:0,unitPrice:{currency:'USD',minorUnits:'100'},discountBasisPoints:0,taxTreatment:'taxable'})),notes:''};
    await error(t.session.submit(estimate,1),'request_too_large','rejected',413);expect(t.fetcher).not.toHaveBeenCalled();expect(t.session.hasPending()).toBe(false);
  });
  it('sends a strict command envelope without bearer tokens or authority, totals, invoice numbers or journals',async()=>{
    const t=fixture();t.enqueue({receipt,replayed:false});await t.session.submit(command,0);const options=t.fetcher.mock.calls[0][1]!;expect(new Headers(options.headers).get('Content-Type')).toBe('application/json');expect(new Headers(options.headers).has('Authorization')).toBe(false);expect(new Headers(options.headers).get('X-Zentra-Expected-User')).toBe('expected-auth-user');expect(JSON.parse(options.body as string)).toEqual({idempotencyKey:'stable-request',expectedRevision:0,command});
  });
  it('returns detached, deeply frozen read and receipt values',async()=>{
    const t=fixture();t.enqueue({status:'ready',state});const result=await t.session.load();expect(Object.isFrozen(result)).toBe(true);if(result.status==='ready'){expect(Object.isFrozen(result.state.configuration.address)).toBe(true);expect(()=>{(result.state.configuration.address as {line1:string}).line1='mutated';}).toThrow();}
    t.enqueue({receipt,replayed:false});const write=await t.session.submit(command,0);expect(Object.isFrozen(write.receipt)).toBe(true);expect(write.receipt).not.toBe(receipt);
  });
  it('does not send another request while a write is still in flight',async()=>{
    const t=fixture();let finish!:(response:Response)=>void;t.queue.push(()=>new Promise(resolve=>{finish=resolve;}));const pending=t.session.submit(command,0);await error(t.session.retry(),'pending_operation','rejected',409);await error(t.session.submit(command,0),'pending_operation','rejected',409);finish(Response.json({receipt,replayed:false}));await pending;expect(t.fetcher).toHaveBeenCalledOnce();
  });
  it.each(['fetch','body'] as const)('a bounded %s timeout aborts transport without claiming the POST failed',async stage=>{
    vi.useFakeTimers();try {
      const t=fixture();if(stage==='fetch')t.queue.push(()=>new Promise<Response>(()=>{}));else{const response=Response.json({receipt,replayed:false});vi.spyOn(response,'json').mockImplementation(()=>new Promise(()=>{}));t.queue.push(()=>response);}
      const writing=t.session.submit(command,0),assertion=error(writing,'response_timeout','uncertain',0);await vi.advanceTimersByTimeAsync(30000);await assertion;expect(t.session.hasPending()).toBe(true);expect(t.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
      t.enqueue({receipt,replayed:true});await t.session.retry();expect(t.newId).toHaveBeenCalledOnce();expect(t.fetcher.mock.calls[1][1]?.body).toBe(t.fetcher.mock.calls[0][1]?.body);expect(vi.getTimerCount()).toBe(0);
    }finally{vi.useRealTimers();}
  });
  it('a timed-out GET rejects without returning a previous financial snapshot',async()=>{
    vi.useFakeTimers();try{const t=fixture();t.queue.push(()=>new Promise<Response>(()=>{}));const assertion=error(t.session.load(),'response_timeout','rejected',0);await vi.advanceTimersByTimeAsync(30000);await assertion;expect(t.session.hasPending()).toBe(false);expect(t.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);}finally{vi.useRealTimers();}
  });
  it('disposal aborts late reads and writes and cannot resurrect pending RAM',async()=>{
    const t=fixture();let read!:(response:Response)=>void,write!:(response:Response)=>void;t.queue.push(()=>new Promise(resolve=>{read=resolve;}),()=>new Promise(resolve=>{write=resolve;}));const loading=t.session.load(),writing=t.session.submit(command,0);t.session.dispose();expect(t.session.hasPending()).toBe(false);for(const [,options] of t.fetcher.mock.calls)expect(options?.signal?.aborted).toBe(true);read(Response.json({status:'ready',state}));write(Response.json({receipt,replayed:false}));await error(loading,'session_disposed','unauthorized',0);await error(writing,'session_disposed','unauthorized',0);await error(t.session.retry(),'session_disposed','unauthorized',0);expect(t.fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed workspace identifiers and retry without an original pending operation',async()=>{
    expect(()=>createBrowserErpSession({organizationId:'../foreign'})).toThrow(BrowserErpError);const t=fixture();await error(t.session.retry(),'no_pending_operation','rejected',409);expect(t.fetcher).not.toHaveBeenCalled();
  });
  it('keeps the expected account header unchanged on retry and permits its omission for callers without a page actor',async()=>{
    const t=fixture();t.enqueue({error:'unauthorized'},401);await error(t.session.submit(command,0),'unauthorized','unauthorized',401);t.enqueue({receipt,replayed:true});await t.session.retry();for(const [,options] of t.fetcher.mock.calls)expect(new Headers(options?.headers).get('X-Zentra-Expected-User')).toBe('expected-auth-user');
    const fetcher=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>Response.json({status:'uninitialized',configuration}));await createBrowserErpSession({organizationId,fetch:fetcher}).load();expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has('X-Zentra-Expected-User')).toBe(false);
    expect(()=>createBrowserErpSession({organizationId,expectedUserId:'\nforged-header'})).toThrow(BrowserErpError);
  });
});
