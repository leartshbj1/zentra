import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErpError } from './erp-contract';
import type { ErpSchemaVersion } from './erp-schema-capability';

const fixture=vi.hoisted(()=>({env:{} as Record<string,string|undefined>,rpc:vi.fn(),rateLimit:vi.fn(async()=>undefined),erpEnabled:false,schema:vi.fn(async(_capability:ErpSchemaVersion):Promise<ErpSchemaVersion>=>4),authority:vi.fn(),configuration:vi.fn(),erpStore:vi.fn()}));
vi.mock('cloudflare:workers',()=>({env:fixture.env}));
vi.mock('../supabase-server-runtime',()=>({supabaseServerClient:()=>({rpc:fixture.rpc})}));
vi.mock('../account',()=>({enforceAccountRateLimit:fixture.rateLimit}));
vi.mock('./runtime-bindings',()=>({erpServerDependencies:{enabled:async()=>fixture.erpEnabled,authority:fixture.authority,configuration:fixture.configuration,store:fixture.erpStore},usPurchasingSchemaVersion:fixture.schema}));
import { usSalesOrderHandlers,usSalesOrderReadiness } from './us-sales-order-bindings';

const history='INTERNATIONAL_US_SALES_ORDERS_HISTORY_ENABLED',create='INTERNATIONAL_US_SALES_ORDERS_ENABLED';
const closed={available:false,newOrdersEnabled:false};
const org='10000000-0000-4000-8000-000000000001',userId='20000000-0000-4000-8000-000000000001';
function baseline(){fixture.erpEnabled=true;}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function pauseSchema(){
 const entered=deferred<void>(),answer=deferred<ErpSchemaVersion>();
 fixture.schema.mockImplementation(async()=>{entered.resolve();return answer.promise;});
 return{entered,answer};
}
function request(){return new Request(`https://zentra.test/api/international/workspaces/${org}/sales-orders?head=1`,{headers:{'X-Zentra-Erp-Schema-Version':'4','X-Zentra-Expected-User':userId}});}
beforeEach(()=>{for(const key of Object.keys(fixture.env))delete fixture.env[key];vi.resetAllMocks();fixture.erpEnabled=false;fixture.schema.mockResolvedValue(4);});
afterEach(()=>{vi.restoreAllMocks();});

describe('real US sales order readiness binding',()=>{
 it('defaults closed without touching Supabase, and an order flag alone never opens ERP',async()=>{
  expect(await usSalesOrderReadiness()).toEqual(closed);
  fixture.env[create]='true';expect(await usSalesOrderReadiness()).toEqual(closed);
  const response=await usSalesOrderHandlers.GET(request(),org);expect(response.status).toBe(404);expect(fixture.rpc).not.toHaveBeenCalled();
 });
 it.each([undefined,'false','TRUE','1','true '])('requires the exact order flag %j, even with actual schema4 ERP enabled',async value=>{
  baseline();fixture.env[create]=value;fixture.env[history]=value;expect(await usSalesOrderReadiness()).toEqual(closed);expect(fixture.rpc).not.toHaveBeenCalled();
 });
 it('retains history and cancellation readiness independently when new orders are paused',async()=>{
  baseline();fixture.env[history]='true';expect(await usSalesOrderReadiness()).toEqual({available:true,newOrdersEnabled:false});
  fixture.env[create]='true';expect(await usSalesOrderReadiness()).toEqual({available:true,newOrdersEnabled:true});
  fixture.env[create]='false';expect(await usSalesOrderReadiness()).toEqual({available:true,newOrdersEnabled:false});
 });
 it('allows a new-orders-only rollout without requiring the separate history flag',async()=>{
  baseline();fixture.env[create]='true';expect(await usSalesOrderReadiness()).toEqual({available:true,newOrdersEnabled:true});expect(fixture.rpc).not.toHaveBeenCalled();
 });
 it.each([history,create])('fails closed when the ERP runtime prerequisite is unavailable despite enabled %s',async orderFlag=>{
  fixture.env[orderFlag]='true';
  expect(await usSalesOrderReadiness()).toEqual(closed);expect(fixture.rpc).not.toHaveBeenCalled();
 });
 it.each([1,2,3] as const)('does not advertise orders through a schema%s port',async schema=>{
  baseline();fixture.env[create]='true';fixture.schema.mockResolvedValue(schema);
  expect(await usSalesOrderReadiness()).toEqual(closed);expect(fixture.schema).toHaveBeenCalledWith(4);expect(fixture.rpc).not.toHaveBeenCalled();
 });
 it.each([history,create,'ERP runtime'])('rechecks %s after awaiting schema instead of publishing stale readiness',async changed=>{
  baseline();fixture.env[changed===history?history:create]='true';const paused=pauseSchema(),pending=usSalesOrderReadiness();
  await paused.entered.promise;if(changed==='ERP runtime')fixture.erpEnabled=false;else fixture.env[changed]='false';paused.answer.resolve(4);
  expect(await pending).toEqual(closed);expect(fixture.rpc).not.toHaveBeenCalled();
 });
 it('preserves current history while a new-order gate closes during the schema wait',async()=>{
  baseline();fixture.env[history]='true';fixture.env[create]='true';const paused=pauseSchema(),pending=usSalesOrderReadiness();
  await paused.entered.promise;fixture.env[create]='false';paused.answer.resolve(4);
  expect(await pending).toEqual({available:true,newOrdersEnabled:false});
 });
 it('propagates a failed schema observation without returning a prior open readiness',async()=>{
  baseline();fixture.env[create]='true';expect(await usSalesOrderReadiness()).toMatchObject({available:true});
  fixture.schema.mockRejectedValue(new ErpError('service_unavailable',503));
  await expect(usSalesOrderReadiness()).rejects.toMatchObject({code:'service_unavailable'});expect(fixture.rpc).not.toHaveBeenCalled();
 });
});

describe('real US sales order handlers bind only current schema and private Supabase ports',()=>{
 function admitted(){
  baseline();fixture.env[history]='true';
  const actor={organizationId:org,userId,role:'owner' as const,managementEntitled:true,timestamp:'2026-10-10T06:00:00.000Z'};
  fixture.authority.mockResolvedValue({mode:'browser',actor});
  fixture.configuration.mockResolvedValue({schemaVersion:1,organizationId:org,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Fictitious Street',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:'accrual',invoiceNumberPrefix:'TEST',taxConfiguration:{status:'unconfigured'}});
  fixture.rpc.mockResolvedValue({schemaVersion:1,organizationId:org,headRevision:0,erpRevision:4});return actor;
 }
 it('constructs the schema4 RPC store lazily for a history-only compact head read',async()=>{
  const actor=admitted();expect(await usSalesOrderReadiness()).toEqual({available:true,newOrdersEnabled:false});const response=await usSalesOrderHandlers.GET(request(),org);
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({headRevision:0,erpRevision:4});
  expect(fixture.rpc).toHaveBeenCalledTimes(1);expect(fixture.rpc).toHaveBeenCalledWith('zentra_us_sales_order_head',{p_organization:org,p_actor:actor,p_supported_schema_version:4});
  expect(fixture.rateLimit).toHaveBeenCalledWith(expect.any(Request),'international-us-sales-orders-read',`${org}:${userId}`,3600);
 });
 it('refuses a request claiming schema4 if the actual accounting capability is paused',async()=>{
  admitted();fixture.schema.mockResolvedValue(3);const response=await usSalesOrderHandlers.GET(request(),org);
  expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:'sales_order_upgrade_required'});expect(fixture.rpc).not.toHaveBeenCalled();
 });
 it('never opens private RPC after the base ERP gate closes',async()=>{
  admitted();fixture.erpEnabled=false;const response=await usSalesOrderHandlers.GET(request(),org);
  expect(response.status).toBe(404);expect(fixture.rpc).not.toHaveBeenCalled();
 });
});
