import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { createSupabaseUsSalesOrderStore, usSalesOrderCommandIdentity, US_SALES_ORDER_SQL_ERRORS } from './us-sales-order-store';
import type { UsSalesOrderRequest } from './us-sales-order-contract';
const org='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000001';
const actor:FinancialAuthority={organizationId:org,userId:'actor',role:'member',managementEntitled:true,timestamp:'2026-10-10T06:00:00.000Z'};
const request:UsSalesOrderRequest={schemaVersion:1,idempotencyKey:'order-test',orderId:id,expectedErpRevision:10,expectedHeadRevision:0,expectedOrderRevision:null,command:{type:'create_from_estimate',estimateId:'quote',expectedEstimateRevision:2,orderDate:'2026-10-10',customerReference:null}};
const receipt={schemaVersion:1,organizationId:org,idempotencyKey:'order-test',commandHash:'a'.repeat(64),actorId:'actor',orderId:id,action:'create_from_estimate',revision:1,headRevision:1,erpRevision:10,sequence:1};
function fixture(result:unknown){const rpc=vi.fn(async(_name:string,_input:Record<string,unknown>)=>result),store=createSupabaseUsSalesOrderStore({rpc:rpc as never});return{rpc,store};}
describe('US sales order privileged RPC boundary',()=>{
 it('uses captured actor/capability, compact head and fixed cursor page',async()=>{
  const f=fixture({schemaVersion:1,organizationId:org,headRevision:0,erpRevision:10});expect(await f.store.head(actor)).toMatchObject({headRevision:0});expect(f.rpc.mock.calls[0]).toEqual(['zentra_us_sales_order_head',{p_organization:org,p_actor:actor,p_supported_schema_version:4}]);
  const page=fixture({schemaVersion:1,organizationId:org,headRevision:0,erpRevision:10,total:0,orders:[],nextBeforeSequence:null});await page.store.list(actor,42);expect(page.rpc.mock.calls[0][1]).toMatchObject({p_before_sequence:42});
 });
 it('reads exactly one source identity and refuses an unscoped or mismatched projection',async()=>{
  const source={schemaVersion:1,organizationId:org,erpRevision:10,estimateId:'quote',estimateRevision:2,activeOrderId:id,invoiceId:null,status:'accepted'},f=fixture(source);
  expect(await f.store.source({...actor,role:'read_only'},'quote')).toEqual(source);expect(f.rpc.mock.calls[0]).toEqual(['zentra_us_sales_order_source',{p_organization:org,p_actor:{...actor,role:'read_only'},p_supported_schema_version:4,p_estimate_id:'quote'}]);
  await expect(f.store.source(actor,' quote')).rejects.toMatchObject({status:422});await expect(f.store.source(actor,'different')).rejects.toMatchObject({code:'invalid_sales_order_record'});
 });
 it('sends only command and exact hash, never a caller-provided state, number or ledger',async()=>{
  const f=fixture({receipt,replayed:false});expect(await f.store.execute(actor,request,'a'.repeat(64))).toEqual({receipt,replayed:false});expect(f.rpc.mock.calls[0]).toEqual(['zentra_execute_us_sales_order',{p_organization:org,p_actor:actor,p_supported_schema_version:4,p_request:request,p_command_hash:'a'.repeat(64)}]);expect(usSalesOrderCommandIdentity(org,'actor',request)).toContain('create_from_estimate');
 });
 it.each([1,2,3,5])('refuses captured capability%s before calling RPC',async cap=>{
  const rpc=vi.fn(),store=createSupabaseUsSalesOrderStore({rpc:rpc as never},{supportedSchemaVersion:cap});await expect(store.head(actor)).rejects.toMatchObject({code:'sales_order_upgrade_required'});expect(rpc).not.toHaveBeenCalled();
 });
 it('refuses read_only mutations, entitlement loss, invalid cursor and invalid id before RPC',async()=>{
  const f=fixture(null);await expect(f.store.execute({...actor,role:'read_only'},request,'a'.repeat(64))).rejects.toMatchObject({status:403});await expect(f.store.head({...actor,managementEntitled:false})).rejects.toMatchObject({status:403});await expect(f.store.list(actor,0)).rejects.toMatchObject({status:422});await expect(f.store.read(actor,'../private')).rejects.toMatchObject({status:422});expect(f.rpc).not.toHaveBeenCalled();
 });
 it.each(['actorId','action','revision','headRevision','erpRevision','orderId','commandHash','idempotencyKey'] as const)('rejects mismatched receipt%s',async field=>{
  const wrong={...receipt,[field]:typeof receipt[field]==='number'?99:'different'},f=fixture({receipt:wrong,replayed:true});await expect(f.store.execute(actor,request,'a'.repeat(64))).rejects.toMatchObject({code:'invalid_sales_order_record'});
 });
 it('fences receipt actor and preserves exact nullable absence',async()=>{
  const empty=fixture(null);expect(await empty.store.read(actor,id)).toBeNull();expect(await empty.store.receipt(actor,'order-test')).toBeNull();
  const wrong=fixture({...receipt,actorId:'other'});await expect(wrong.store.receipt(actor,'order-test')).rejects.toMatchObject({code:'sales_order_idempotency_conflict'});
 });
 it.each(Object.entries(US_SALES_ORDER_SQL_ERRORS))('maps known SQL error%s without provider messages',async(sqlCode,[code,status])=>{
  const store=createSupabaseUsSalesOrderStore({rpc:async()=>{throw new SupabaseServerError(503,sqlCode,'secret provider details');}});await expect(store.head(actor)).rejects.toMatchObject({code,status});
 });
 it('does not expose unknown SQL/debug payloads',async()=>{
  const store=createSupabaseUsSalesOrderStore({rpc:async()=>{throw new SupabaseServerError(503,'XX123','password=secret');}});await expect(store.head(actor)).rejects.toMatchObject({code:'service_unavailable',message:'service_unavailable'});
 });
});
