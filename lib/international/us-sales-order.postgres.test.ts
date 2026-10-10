import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { createSupabaseErpStore } from './runtime-store';
import { executeErp } from './runtime';
import { createSupabaseUsSalesOrderStore, usSalesOrderCommandIdentity } from './us-sales-order-store';
import { validateUsSalesOrderRequest, type UsSalesOrderCommand } from './us-sales-order-contract';
import type { FinancialAuthority } from './accounting/ledger';
import type { CompanyConfiguration } from './types';
import type { ErpCommand } from './runtime-types';
import { createSupabaseUsTaxMerchantStore } from './us-tax-merchant-store';
import { createUsTaxFinancialContextReader } from './us-tax-financial-context';
import { createSupabaseUsTaxInvoicePreparationStore } from './us-tax-invoice-preparation-store';
import { createSupabasePreparedUsTaxOperationStore } from './us-tax-prepared-operation-store';
import { executeUsTaxInvoiceTest } from './us-tax-invoice';
import type { ResolvedStripeTaxRequest } from './stripe-tax-resolved-request';
import type { StripeTaxCalculationObservation } from './stripe-tax-calculation';

const directory=process.env.PGLITE_MODULE_DIR,enabled=Boolean(directory&&isAbsolute(directory));
type Sql={exec(sql:string):Promise<unknown>;query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[]}>};
type Db=Sql&{close():Promise<void>;transaction<T>(task:(tx:Sql)=>Promise<T>):Promise<T>};let db:Db;
const migration='20261010054644_international_us_sales_orders';
const chOrg=randomUUID(),chUser=randomUUID();let chBefore:unknown;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const rpcQueries:Record<string,[string,string[]]>={
 zentra_read_us_erp_v4:['select public.zentra_read_us_erp_v4($1) result',['p_organization']],
 zentra_us_erp_receipt_v4:['select public.zentra_us_erp_receipt_v4($1,$2) result',['p_organization','p_idempotency_key']],
 zentra_commit_us_erp:['select public.zentra_commit_us_erp($1,$2,$3,$4,$5,$6,$7) result',['p_organization','p_expected_revision','p_header','p_changes','p_ledger_audit','p_receipt','p_actor']],
 zentra_us_sales_order_head:['select public.zentra_us_sales_order_head($1,$2,$3) result',['p_organization','p_actor','p_supported_schema_version']],
 zentra_us_sales_order_source:['select public.zentra_us_sales_order_source($1,$2,$3,$4) result',['p_organization','p_actor','p_supported_schema_version','p_estimate_id']],
 zentra_list_us_sales_orders:['select public.zentra_list_us_sales_orders($1,$2,$3,$4) result',['p_organization','p_actor','p_supported_schema_version','p_before_sequence']],
 zentra_read_us_sales_order:['select public.zentra_read_us_sales_order($1,$2,$3,$4) result',['p_organization','p_actor','p_supported_schema_version','p_order_id']],
 zentra_us_sales_order_receipt:['select public.zentra_us_sales_order_receipt($1,$2,$3,$4) result',['p_organization','p_actor','p_supported_schema_version','p_idempotency_key']],
 zentra_execute_us_sales_order:['select public.zentra_execute_us_sales_order($1,$2,$3,$4,$5) result',['p_organization','p_actor','p_supported_schema_version','p_request','p_command_hash']],
};
for(const [name,params] of Object.entries({
 zentra_read_us_seller_profile:['p_organization'],zentra_read_us_tax_profile:['p_organization'],zentra_read_us_tax_provider_binding:['p_organization'],
 zentra_read_us_tax_merchant_context:['p_organization','p_actor'],zentra_read_us_tax_merchant_credential:['p_organization','p_actor','p_binding_revision'],
 zentra_activate_us_tax_test_merchant:['p_organization','p_actor','p_request_id','p_context','p_credential','p_configuration_fingerprint','p_observation','p_valid_until'],
 zentra_read_us_tax_invoice_preparation:['p_organization','p_actor','p_erp_idempotency_key','p_command_hash','p_supported_schema_version'],
 zentra_create_us_tax_invoice_preparation:['p_organization','p_actor','p_preparation_body','p_preparation_sha256','p_supported_schema_version'],
 zentra_read_us_tax_operation:['p_organization','p_erp_idempotency_key','p_command_hash','p_actor'],
 zentra_reserve_us_tax_prepared_operation:['p_organization','p_actor','p_operation_id','p_resolved_body','p_resolved_sha256','p_params_body','p_params_sha256','p_provider_idempotency_key','p_supported_schema_version'],
 zentra_record_us_tax_prepared_calculation:['p_organization','p_operation_id','p_actor','p_proof_body','p_proof_sha256','p_assessment','p_supported_schema_version'],
 zentra_commit_us_tax_prepared_invoice_test:['p_organization','p_operation_id','p_expected_revision','p_header','p_changes','p_ledger_audit','p_receipt','p_actor','p_supported_schema_version'],
}))rpcQueries[name]=[`select public.${name}(${params.map((_,i)=>`$${i+1}`).join(',')}) result`,params];
async function sql<T=Record<string,unknown>>(query:string,values:unknown[]=[],role='service_role'){return db.transaction(async tx=>{await tx.exec(`set local role ${role}`);return(await tx.query<T>(query,values)).rows;});}
const client={async rpc<T>(name:string,input:Record<string,unknown>):Promise<T>{const spec=rpcQueries[name];if(!spec)throw new Error('Missing local SQL port');try{return(await sql<{result:T}>(spec[0],spec[1].map(k=>input[k])))[0].result;}catch(e){if(process.env.ZENTRA_LOCAL_SQL_DEBUG==='1')console.error('TEST SQL',(e as Error).message,(e as {where:string}).where);throw new SupabaseServerError(503,(e as {code:string}).code,'local-test');}},async select<T>(table:string,query:Record<string,string>):Promise<T>{
 if(table!=='zentra_workspace_country_configs'||!query.organization_id.startsWith('eq.'))throw Error('Unexpected local TEST select');
 return await sql('select organization_id,schema_version,config,country,currency,revision,updated_by,to_char(updated_at at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') updated_at from public.zentra_workspace_country_configs where organization_id=$1',[query.organization_id.slice(3)]) as T;
}} as Pick<SupabaseServerClient,'rpc'|'select'>;
async function fixture(basis:'cash'|'accrual'='accrual',withTax=false){
 const org=randomUUID(),userId=randomUUID();const actor:FinancialAuthority={organizationId:org,userId,role:'owner',managementEntitled:true,timestamp:withTax?new Date().toISOString():'2026-10-10T06:00:00.000Z'};
 let config:CompanyConfiguration={schemaVersion:1,organizationId:org,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Fictitious Street',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:basis,invoiceNumberPrefix:'TEST',taxConfiguration:{status:'unconfigured'},ein:'12-3456789'};
 await sql('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6)',[org,randomUUID(),userId,randomUUID(),JSON.stringify(config),hash(org)]);
 await sql('select public.zentra_put_us_seller_profile($1,$2,$3,$4,$5)',[org,userId,0,randomUUID(),{displayName:'Fictitious Seller',contactEmail:'seller@example.invalid'}]);
 const merchant={credential:{reference:'TEST-credential',revision:1,accountId:'acct_FictitiousOrders'},configurationFingerprint:hash('TEST-descriptor')};
 if(withTax){
  const facts={schemaVersion:1,legalName:'PRIVATE_FICTITIOUS_TEST_NAME',timeZone:config.timeZone,taxOrigin:{...config.address,line1:'9 Fictitious Private Origin'}};
  await sql('select public.zentra_put_us_tax_profile($1,$2,0,$3::uuid,$4::jsonb)',[org,userId,randomUUID(),facts]);
  const merchants=createSupabaseUsTaxMerchantStore(client),context=await merchants.readContext(actor),observedAt=new Date(Date.now()-10).toISOString();
  await merchants.activate(actor,{requestId:randomUUID(),context,...merchant,observation:{organizationId:org,accountId:merchant.credential.accountId,mode:'test',apiVersion:'2026-08-26.dahlia',settingsSha256:hash('TEST-settings'),registrationsSha256:hash('TEST-registrations'),observedAt,taxOrigin:facts.taxOrigin},validUntil:new Date(Date.parse(observedAt)+119_000).toISOString()});
  config={...config,taxConfiguration:{status:'configured'}};
 }
 const erp=createSupabaseErpStore(client,{supportedSchemaVersion:4}),store=createSupabaseUsSalesOrderStore(client);let n=0;
 const sendErp=async(command:ErpCommand)=>executeErp({store:erp,configuration:config,actor,revalidate:async()=>actor,taxProvider:async()=>null},{idempotencyKey:`erp-${++n}`,expectedRevision:(await erp.read(org))?.revision??0,command});
 await sendErp({type:'initialize',periods:[{id:'year',start:'2026-01-01',end:'2026-12-31',status:'open'}]});
 await sendErp({type:'save_customer',customer:{id:'customer',organizationId:org,kind:'business',name:'Fictitious Customer',billingAddress:config.address,paymentTermsDays:30}});
 const saveQuote=async(id='quote')=>sendErp({type:'save_estimate',id,expectedEstimateRevision:0,customerId:'customer',date:'2026-10-10',expiresAt:'2026-11-10',paymentTermsDays:30,notes:'Fictitious commercial terms\nSecond line',lines:[{id:'line',description:'Fictitious service',quantityUnits:withTax?'2':'3',quantityScale:0,unitPrice:{currency:'USD',minorUnits:withTax?'1000':'12345'},discountBasisPoints:withTax?0:1000,taxTreatment:'taxable'}]});
 const quote=async(id='quote')=>{await saveQuote(id);await sendErp({type:'accept_estimate',estimateId:id,expectedEstimateRevision:1});};
 await quote();
 const prepare=async(command:UsSalesOrderCommand={type:'create_from_estimate',estimateId:'quote',expectedEstimateRevision:2,orderDate:'2026-10-10',customerReference:null},orderId:string=randomUUID(),key:string=randomUUID())=>{
  const head=await store.head(actor),order=await store.read(actor,orderId);
  const request=validateUsSalesOrderRequest({schemaVersion:1,idempotencyKey:key,orderId,expectedErpRevision:head.erpRevision,expectedHeadRevision:head.headRevision,expectedOrderRevision:order?.order.revision??null,command},org);
  return{request,digest:hash(usSalesOrderCommandIdentity(org,userId,request))};
 };
 const send=async(command?:UsSalesOrderCommand,id?:string)=>{const r=await prepare(command,id);return{...await store.execute(actor,r.request,r.digest),request:r.request,digest:r.digest};};
 return{org,userId,actor,config,erp,store,sendErp,quote,saveQuote,prepare,send,merchant};
}
// Synthetic local TEST calculation, never a provider/network call or a claimed rate.
function observation(resolved:ResolvedStripeTaxRequest):StripeTaxCalculationObservation{
 const now=new Date().toISOString(),amount=resolved.params.line_items[0].amount,tax=160;
 return{accountId:resolved.binding.accountId,mode:'test',apiVersion:resolved.binding.apiVersion,evidenceKind:'provider_observation',observedAt:now,
 calculation:{id:'taxcalc_FictitiousOrders',object:'tax.calculation',amount_total:amount+tax,currency:'usd',customer:null,
 customer_details:{address:{...resolved.params.customer_details.address,line2:null},address_source:resolved.params.customer_details.address_source,ip_address:null,tax_ids:[],taxability_override:'none'},
 expires_at:Math.floor(Date.parse(now)/1000)+1800,tax_date:resolved.params.tax_date,livemode:false,shipping_cost:null,ship_from_details:null,tax_amount_exclusive:tax,tax_amount_inclusive:0,
 line_items:{object:'list',has_more:false,url:'/v1/tax/calculations/taxcalc_FictitiousOrders/line_items',data:[{id:'tax_li_FictitiousOrders',object:'tax.calculation_line_item',amount,amount_tax:tax,quantity:resolved.params.line_items[0].quantity,reference:'line',tax_code:resolved.params.line_items[0].tax_code,tax_behavior:'exclusive',livemode:false,product:null,
 tax_breakdown:[{amount:tax,taxable_amount:amount,taxability_reason:'standard_rated',sourcing:'destination',jurisdiction:{country:'US',state:'NY',level:'state',display_name:'Fictitious TEST state'},tax_rate_details:{tax_type:'sales_tax',display_name:'Fictitious TEST tax',percentage_decimal:'8.0'}}]}]},
 tax_breakdown:[{amount:tax,taxable_amount:amount,taxability_reason:'standard_rated',inclusive:false,tax_rate_details:{country:'US',state:'NY',tax_type:'sales_tax',percentage_decimal:'8.0',rate_type:'percentage',flat_amount:null}}]}};
}
describe.skipIf(!enabled)('US sales orders, real additive PostgreSQL commercial register',()=>{
 beforeAll(async()=>{
  const require=createRequire(import.meta.url),{PGlite}=require(join(directory!,'dist/index.cjs')) as {PGlite:new()=>Db};db=new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
  for(const name of ['202609140100_company_profiles','202609140200_company_collaboration','202609200300_company_content','20261007194528_international_workspace_country_config','20261007222349_international_us_erp_persistence','20261007224820_international_us_erp_delta_stream','20261007225725_international_us_erp_seller_snapshot','20261008001726_new_us_workspace_admission','20261008013200_international_tax_proof_allowlist','20261008034422_international_us_seller_profile','20261008044402_international_us_tax_profile','20261008060826_international_us_tax_operations','20261008081825_international_us_purchasing_v2','20261008105120_international_us_projects_v3','20261008161118_international_us_journal_periods_v4','20261008172520_international_us_tax_invoice_capability_v2','20261009222319_international_us_tax_test_merchant','20261009224607_international_us_tax_invoice_preparation'])await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
  await db.query('insert into public.zentra_workspaces(organization_id,updated_by) values($1,$2)',[chOrg,chUser]);
  await db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)',[chOrg,chUser,randomUUID(),{schemaVersion:1,organizationId:chOrg,country:'CH',currency:'CHF',language:'fr',timeZone:'Europe/Zurich',address:{country:'CH',line1:'1 Rue Fictive',city:'Genève',subdivision:'GE',postalCode:'1201'},accountingBasis:'accrual',invoiceNumberPrefix:'CH',taxConfiguration:{status:'unconfigured'}}]);
  chBefore=(await db.query('select to_jsonb(w) workspace,to_jsonb(c) country from public.zentra_workspaces w join public.zentra_workspace_country_configs c using(organization_id) where organization_id=$1',[chOrg])).rows;
  await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}.sql`,import.meta.url),'utf8'));
 },30000);
 afterAll(async()=>{await db?.close();});
 it.each(['cash','accrual'] as const)('creates, confirms and cancels without changing %s accounting or ERP history',async basis=>{
  const f=await fixture(basis),before=await f.erp.read(f.org),created=await f.send(),id=created.receipt.orderId;
  expect(created.receipt).toMatchObject({revision:1,headRevision:1,sequence:1});
  const record=await f.store.read(f.actor,id);expect(record?.order).toMatchObject({number:'SO-000001',state:'draft',sourceEstimate:before!.estimates[0]});expect(record?.order.companyConfiguration).not.toHaveProperty('ein');
  await f.send({type:'confirm',reference:'Internal review TEST'},id);await f.send({type:'cancel',reason:'Fictitious duplicate request'},id);
  expect((await f.store.read(f.actor,id))?.order).toMatchObject({revision:3,state:'cancelled',confirmation:{reference:'Internal review TEST'},cancellation:{reason:'Fictitious duplicate request'}});
  expect(await f.erp.read(f.org)).toEqual(before);
  expect(await sql('select head_revision from public.zentra_us_sales_order_audit where organization_id=$1 order by head_revision',[f.org])).toEqual([{head_revision:1},{head_revision:2},{head_revision:3}]);
 });
 it('replays exact receipt after unrelated ERP changes and refuses changed canonical identity',async()=>{
  const f=await fixture(),made=await f.send();await f.sendErp({type:'open_period',id:'next',start:'2027-01-01',end:'2027-12-31'});
  expect(await f.store.execute(f.actor,made.request,made.digest)).toEqual({receipt:made.receipt,replayed:true});
  const changed={...made.request,command:{...made.request.command,customerReference:'Changed'}};
  await expect(f.store.execute(f.actor,changed,hash(usSalesOrderCommandIdentity(f.org,f.userId,changed)))).rejects.toMatchObject({code:'sales_order_idempotency_conflict'});
 });
 it('fences head, source, ERP and order revisions and creates no partial rows',async()=>{
  const f=await fixture(),a=await f.prepare(),b=await f.prepare();await f.store.execute(f.actor,a.request,a.digest);
  await expect(f.store.execute(f.actor,b.request,b.digest)).rejects.toMatchObject({code:'sales_order_revision_conflict'});
  const duplicate=await f.prepare();await expect(f.store.execute(f.actor,duplicate.request,duplicate.digest)).rejects.toMatchObject({code:'sales_order_already_exists'});
  const stale=await f.prepare({type:'confirm',reference:'Internal'},a.request.orderId);await f.sendErp({type:'open_period',id:'next',start:'2027-01-01',end:'2027-12-31'});
  await expect(f.store.execute(f.actor,stale.request,stale.digest)).rejects.toMatchObject({code:'sales_order_erp_revision_conflict'});
  expect((await f.store.list(f.actor)).total).toBe(1);
 });
 it('freezes the accepted source until explicit cancellation, then retains old immutable snapshot and increments number',async()=>{
  const f=await fixture(),created=await f.send(),book=(await f.erp.read(f.org))!,estimate=book.estimates[0];
  const edit:ErpCommand={type:'save_estimate',id:estimate.id,expectedEstimateRevision:estimate.revision,customerId:estimate.customer.id,date:estimate.date,expiresAt:estimate.expiresAt,paymentTermsDays:30,notes:'Changed after order',lines:estimate.lines};
  await expect(f.sendErp(edit)).rejects.toMatchObject({code:'sales_order_source_locked'});
  await f.send({type:'cancel',reason:'Replace commercial terms'},created.receipt.orderId);await f.sendErp(edit);await f.sendErp({type:'accept_estimate',estimateId:'quote',expectedEstimateRevision:3});
  const next=await f.send({type:'create_from_estimate',estimateId:'quote',expectedEstimateRevision:4,orderDate:'2026-10-10',customerReference:'PO fictitious'});
  expect(next.receipt.sequence).toBe(2);expect((await f.store.read(f.actor,created.receipt.orderId))?.order.sourceEstimate.notes).toBe(estimate.notes);
 });
 it.each(['owner','admin','accountant','member'] as const)('allows commercial %s without adding financial permissions',async role=>{
  const f=await fixture(),r=await f.prepare();const actor={...f.actor,role};const result=await f.store.execute(actor,r.request,r.digest);expect(result.receipt.actorId).toBe(f.userId);
 });
 it('allows read_only reading but no mutation/receipt replay, and rechecks entitlement and tenant',async()=>{
  const f=await fixture(),made=await f.send(),readOnly={...f.actor,role:'read_only' as const};expect((await f.store.list(readOnly)).total).toBe(1);expect(await f.store.read(readOnly,made.receipt.orderId)).not.toBeNull();
  for(const actor of [readOnly,{...f.actor,managementEntitled:false},{...f.actor,organizationId:randomUUID()}])await expect(f.store.execute(actor,made.request,made.digest)).rejects.toBeTruthy();
  const other=await fixture();expect(await other.store.read(other.actor,made.receipt.orderId)).toBeNull();expect((await other.store.list(other.actor)).total).toBe(0);
 });
 it.each(['anon','authenticated'])('keeps register and RPC private from %s',async role=>{
  const f=await fixture();await expect(sql('select * from public.zentra_us_sales_orders',[],role)).rejects.toMatchObject({code:'42501'});
  await expect(sql(rpcQueries.zentra_list_us_sales_orders[0],[f.org,f.actor,4,null],role)).rejects.toMatchObject({code:'42501'});
 });
 it('rejects privileged fabricated update, orphan receipt and truncate while preserving audited state',async()=>{
  const f=await fixture(),made=await f.send();const record=(await f.store.read(f.actor,made.receipt.orderId))!;
  await expect(sql('update public.zentra_us_sales_orders set payload=$3 where organization_id=$1 and id=$2',[f.org,made.receipt.orderId,{...record.order,number:'SO-forged'}])).rejects.toMatchObject({code:'PO014'});
  const pending=await f.prepare({type:'confirm',reference:'Internal isolated receipt'},made.receipt.orderId),receipt={...made.receipt,idempotencyKey:pending.request.idempotencyKey,commandHash:pending.digest,action:'confirm',revision:2,headRevision:2};
  await expect(sql('insert into public.zentra_us_sales_order_receipts values($1,$2,2,$3,$4,$5)',[f.org,pending.request.idempotencyKey,f.actor,pending.request,receipt])).rejects.toMatchObject({code:'PO014'});
  await expect(db.exec('truncate public.zentra_us_sales_orders cascade')).rejects.toMatchObject({code:'PO014'});
  expect(await f.store.read(f.actor,made.receipt.orderId)).toEqual(record);
 });
 it('paginates 26 real orders in stable descending sequence without loading source lines',async()=>{
  const f=await fixture();await f.send();for(let i=2;i<=26;i++){const id=`quote-${i}`;await f.quote(id);await f.send({type:'create_from_estimate',estimateId:id,expectedEstimateRevision:2,orderDate:'2026-10-10',customerReference:null});}
  const page=await f.store.list(f.actor);expect(page.orders).toHaveLength(25);expect(page.total).toBe(26);expect(page.orders[0].sequence).toBe(26);expect(page.nextBeforeSequence).toBe(2);expect(page.orders[0]).not.toHaveProperty('sourceEstimate');
  const next=await f.store.list(f.actor,page.nextBeforeSequence);expect(next.orders.map(o=>o.sequence)).toEqual([1]);expect(next.nextBeforeSequence).toBeNull();
  expect(await f.store.source({...f.actor,role:'read_only'},'quote')).toMatchObject({status:'accepted',estimateRevision:2,activeOrderId:next.orders[0].id,invoiceId:null});
  expect(await f.store.source(f.actor,'missing')).toMatchObject({status:'missing',estimateRevision:null,activeOrderId:null,invoiceId:null});
 },30000);
 it('runs the real invoice guard for draft, exact confirmed and wrong-revision commercial sources',async()=>{
  const f=await fixture(),made=await f.send(),record=(await f.store.read(f.actor,made.receipt.orderId))!,source=record.order.sourceEstimate;
  // A disposable table invokes the same installed trigger with only its required fields.
  // This proves the guard, not hosted fiscal issuance or a fabricated invoice record.
  await db.exec('create temporary table order_invoice_guard_test(organization_id text,kind text,id text,payload jsonb);create trigger guard before insert or update on order_invoice_guard_test for each row execute function public.zentra_guard_us_sales_order_source();');
  const invoice={id:'invoice',sourceEstimateId:source.id,sourceEstimateRevision:source.revision,customer:source.customer,lines:source.lines,notes:source.notes,issuedAt:f.actor.timestamp};
  await expect(db.query("insert into order_invoice_guard_test values($1,'invoice','invoice',$2)",[f.org,invoice])).rejects.toMatchObject({code:'PO011'});
  await f.send({type:'confirm',reference:'Internal confirmation only'},made.receipt.orderId);
  await db.query("insert into order_invoice_guard_test values($1,'invoice','invoice',$2)",[f.org,invoice]);
  await expect(db.query("insert into order_invoice_guard_test values($1,'invoice','invoice2',$2)",[f.org,{...invoice,sourceEstimateRevision:3}])).rejects.toMatchObject({code:'PO011'});
  await db.exec('drop table order_invoice_guard_test');
 });
 it('fails closed for malformed direct SQL requests and wrong native schema without changing records',async()=>{
  const f=await fixture(),prepared=await f.prepare(),before=await f.store.head(f.actor);
  for(const bad of [null,{}, {...prepared.request,command:{...prepared.request.command,customerReference:undefined}}, {...prepared.request,command:{type:'confirm',reference:null}}, {...prepared.request,command:{type:'confirm',reference:''}}]){
   expect((await sql<{valid:boolean}>('select public.zentra_us_sales_order_request_valid($1) valid',[bad]))[0].valid).toBe(false);
   await expect(sql(rpcQueries.zentra_execute_us_sales_order[0],[f.org,f.actor,4,bad,hash('invalid')])).rejects.toMatchObject({code:'PO004'});
  }
  await expect(sql(rpcQueries.zentra_execute_us_sales_order[0],[f.org,f.actor,3,prepared.request,prepared.digest])).rejects.toMatchObject({code:'PO005'});
  expect(await f.store.head(f.actor)).toEqual(before);expect((await f.store.list(f.actor)).orders).toEqual([]);
 });
 it.each(['cash','accrual'] as const)('issues a confirmed order through actual prepared TEST tax and ERP %s stores once, then fences cancellation',async basis=>{
  const f=await fixture(basis,true),made=await f.send(),before=await f.erp.read(f.org);await f.send({type:'confirm',reference:'Internal commercial review TEST'},made.receipt.orderId);
  expect(await f.erp.read(f.org)).toEqual(before);
  const now=()=>new Date().toISOString(),revalidate=async()=>({...f.actor,timestamp:now()}),day=new Intl.DateTimeFormat('en-CA',{timeZone:f.config.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const request={idempotencyKey:'TEST-order-invoice',expectedRevision:before!.revision,command:{type:'issue_invoice' as const,id:'invoice',estimateId:'quote',expectedEstimateRevision:2,date:day,accountingDate:day,dueDate:day,periodId:'year'}};
  const contexts=createUsTaxFinancialContextReader(client,{revalidate,now}),context=await contexts.read(await revalidate()),estimate=before!.estimates[0];
  const preparations=createSupabaseUsTaxInvoicePreparationStore(client,{supportedSchemaVersion:4}),prepared=await preparations.create(f.actor,{request,context,merchant:f.merchant,estimate,classifications:[{lineId:'line',taxCode:'txcd_99999999',kind:'service',taxBehavior:'exclusive'}],taxDateInstant:new Date(Math.floor(Date.now()/1000)*1000).toISOString(),addressSource:'billing'});
  const operations=createSupabasePreparedUsTaxOperationStore(client,{supportedSchemaVersion:4}),calculate=vi.fn(async(resolved:ResolvedStripeTaxRequest)=>observation(resolved));
  const dependencies={erp:{store:f.erp,configuration:f.config,actor:f.actor,revalidate},contexts,operations,gateway:{verify:vi.fn(async()=>undefined),calculate},classifications:async()=>prepared.classifications,transactionLocation:async()=>({taxDateInstant:prepared.taxDateInstant,addressSource:prepared.addressSource}),operationId:()=>randomUUID(),now};
  const result=await executeUsTaxInvoiceTest(dependencies,request),book=(await f.erp.read(f.org))!,record=(await f.store.read(f.actor,made.receipt.orderId))!;
  expect(result.replayed).toBe(false);expect(book.invoices).toHaveLength(1);expect(book.invoices[0].total.minorUnits).toBe('2160');
  expect(book.ledger.entries).toHaveLength(basis==='cash'?0:1);
  expect(record.invoice).toMatchObject({id:'invoice',number:book.invoices[0].number,sourceEstimateRevision:2});expect(record.order.state).toBe('confirmed');
  expect((await f.store.list(f.actor)).orders[0].invoice).toEqual(record.invoice);
  expect(await f.store.source(f.actor,'quote')).toMatchObject({status:'accepted',estimateRevision:2,activeOrderId:made.receipt.orderId,invoiceId:'invoice'});
  await expect(f.send({type:'cancel',reason:'Cannot remove an invoiced order'},made.receipt.orderId)).rejects.toMatchObject({code:'sales_order_already_invoiced'});
  expect((await executeUsTaxInvoiceTest(dependencies,request)).replayed).toBe(true);expect(calculate).toHaveBeenCalledTimes(1);expect(await f.erp.read(f.org)).toEqual(book);
 });
 it('leaves pre-existing CH workspace and country configuration unchanged and rejects US admission for CH',async()=>{
  const actor:FinancialAuthority={organizationId:chOrg,userId:chUser,role:'owner',managementEntitled:true,timestamp:new Date().toISOString()};
  await expect(sql(rpcQueries.zentra_list_us_sales_orders[0],[chOrg,actor,4,null])).rejects.toMatchObject({code:'PO005'});
  expect((await db.query('select to_jsonb(w) workspace,to_jsonb(c) country from public.zentra_workspaces w join public.zentra_workspace_country_configs c using(organization_id) where organization_id=$1',[chOrg])).rows).toEqual(chBefore);
 });
});
