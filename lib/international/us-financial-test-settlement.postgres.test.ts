import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson } from './erp-contract';
import { buildTaxRequest, estimateTotals, type TaxAssessment } from './invoicing';
import { executeErp } from './runtime';
import { createSupabaseErpStore } from './runtime-store';
import type { ErpCommand, ErpCommit } from './runtime-types';
import type { CompanyConfiguration } from './types';
import { prepareStripeTaxResolvedRequest, type StripeTaxTestBinding } from './stripe-tax-resolved-request';
import type { StripeTaxPrivateProof } from './stripe-tax-calculation';
import type { UsTaxFacts } from './us-tax-profile';
import { applyUsFinancialOperationV5, buildUsFinancialCreditCandidateV5, projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import type { UsFinancialBookV5, UsFinancialCreditInputV5, UsFinancialOperationV5, UsFinancialPolicyV5, UsFinancialTaxProofV5 } from './us-financial-kernel-types';
import { executeUsFinancialKernelV5, type UsFinancialCommitV5, type UsFinancialReceiptV5 } from './us-financial-kernel-runtime';
import { createSupabaseUsFinancialTestFoundationV5 } from './us-financial-test-foundation';
import { createSupabaseUsFinancialSettlementTestStoreV5 } from './us-financial-test-settlement';

// Actual private SQL guards and real ERP4 issuance chain on retained local
// NodeFS. Every account, invoice, approval and tax observation is synthetic.
// No external provider/network operation. Serialized PGlite is not proof of
// multi-connection concurrency, D1 atomicity, crash recovery or production SLA.
const directory=process.env.PGLITE_MODULE_DIR,enabled=Boolean(directory&&isAbsolute(directory));
type Sql={exec(sql:string):Promise<unknown>;query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[]}>};
type Db=Sql&{close():Promise<void>;transaction<T>(task:(tx:Sql)=>Promise<T>):Promise<T>};
let db:Db,PGlite:new(dataDir?:string)=>Db,dataDir:string;
const capability='postgres-test-settlement-v5',migration='20261010083027_international_us_financial_test_settlement_v5';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
function receiptFor(book:UsFinancialBookV5):UsFinancialReceiptV5{
 const e=book.events.at(-1)!;if(e.operation.type==='erp_command')throw Error('Synthetic receipt excludes ERP');const{idempotencyKey,...rest}=e.operation;
 const command=rest.type==='customer_credit'?(()=>{const{taxProof:_proof,...fields}=rest;return{...fields,id:e.id};})():{...rest,id:e.id};
 return{idempotencyKey,commandHash:hash(canonicalErpJson([e.actor.organizationId,e.actor.userId,{idempotencyKey,expectedRevision:e.revision-1,command}])),revision:e.revision,entityId:e.id,action:e.operation.type,actorId:e.actor.userId};
}
function copy<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}
type Mutable<T>=T extends object?{-readonly[K in keyof T]:Mutable<T[K]>}:T;
const migrations=[
 '202609140100_company_profiles','202609140200_company_collaboration','202609200300_company_content',
 '20261007194528_international_workspace_country_config','20261007222349_international_us_erp_persistence','20261007224820_international_us_erp_delta_stream','20261007225725_international_us_erp_seller_snapshot','20261008001726_new_us_workspace_admission','20261008013200_international_tax_proof_allowlist',
 '20261008034422_international_us_seller_profile','20261008044402_international_us_tax_profile','20261008060826_international_us_tax_operations','20261008081825_international_us_purchasing_v2','20261008105120_international_us_projects_v3','20261008161118_international_us_journal_periods_v4','20261008172520_international_us_tax_invoice_capability_v2',
 '20261008184605_international_us_bank_reconciliation','20261008194930_international_us_supplier_proposals','20261008210008_international_us_automation_analysis','20261009215104_international_us_workspace_sync_heads','20261009222319_international_us_tax_test_merchant','20261009224607_international_us_tax_invoice_preparation','20261010005300_international_us_supplier_originals','20261010024618_international_us_supplier_original_hash_lookup','20261010054644_international_us_sales_orders','20261010075840_international_us_financial_test_foundation_v5',
];
const parameters:Record<string,readonly string[]>={
 zentra_read_us_erp_v4:['p_organization'],zentra_us_erp_receipt_v4:['p_organization','p_idempotency_key'],zentra_commit_us_erp:['p_organization','p_expected_revision','p_header','p_changes','p_ledger_audit','p_receipt','p_actor'],
 zentra_read_us_financial_test_v5:['p_organization','p_actor','p_grant_version','p_capability'],zentra_us_financial_test_receipt_v5:['p_organization','p_actor','p_grant_version','p_capability','p_idempotency_key'],zentra_promote_us_financial_test_v5:['p_organization','p_actor','p_grant_version','p_capability','p_book','p_idempotency_key','p_command_hash'],
 zentra_read_us_financial_settlement_test_v5:['p_organization','p_actor','p_grant_version','p_capability'],zentra_us_financial_settlement_test_receipt_v5:['p_organization','p_actor','p_grant_version','p_capability','p_idempotency_key'],zentra_append_us_financial_settlement_test_v5:['p_organization','p_actor','p_grant_version','p_capability','p_expected_revision','p_previous_fingerprint','p_book','p_receipt'],
};
async function sql<T=Record<string,unknown>>(q:string,v:unknown[]=[],role='service_role'){return db.transaction(async tx=>{await tx.exec(`set local role ${role}`);return(await tx.query<T>(q,v)).rows;});}
async function result<T=unknown>(q:string,v:unknown[]=[]){return(await sql<{result:T}>(q,v))[0].result;}
const client:Pick<SupabaseServerClient,'rpc'>={async rpc<T>(name:string,input:Readonly<Record<string,unknown>>):Promise<T>{
 const keys=parameters[name];if(!keys)throw Error('Unexpected synthetic SQL RPC');
 try{return await result<T>(`select public.${name}(${keys.map((_,i)=>`$${i+1}`).join(',')}) result`,keys.map(k=>input[k]));}
 catch(error){if(process.env.ZENTRA_LOCAL_SQL_DEBUG==='1')console.error((error as Error).message,(error as {where?:string}).where);throw new SupabaseServerError(503,(error as {code:string}).code,'private SQL TEST');}
}};
async function fixture(options:{tax?:string;quantity?:string;scale?:number;discount?:number;unitPrice?:string;lines?:number;paid?:string;closed?:boolean;unpromoted?:boolean}={}){
 const org=randomUUID(),user=randomUUID(),now=new Date(),day=now.toISOString().slice(0,10),year=now.getUTCFullYear();
 const config:CompanyConfiguration={schemaVersion:1,organizationId:org,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'1 Synthetic Example Street',city:'Brooklyn',postalCode:'11201',subdivision:'NY'},accountingBasis:'accrual',invoiceNumberPrefix:'SYNTHETIC',taxConfiguration:{status:'configured'}};
 let actor:FinancialAuthority={organizationId:org,userId:user,role:'owner',managementEntitled:true,timestamp:now.toISOString()};
 await sql('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6)',[org,randomUUID(),user,randomUUID(),{...config,taxConfiguration:{status:'unconfigured'}},hash(org)]);
 await sql('select public.zentra_put_workspace_country_config($1,$2,1,$3::uuid,$4)',[org,user,randomUUID(),config]);
 const seller={displayName:'Synthetic Seller — local tests only',contactEmail:'synthetic@example.test'};
 await sql('select public.zentra_put_us_seller_profile($1,$2,0,$3::uuid,$4)',[org,user,randomUUID(),seller]);
 const facts:UsTaxFacts={schemaVersion:1,legalName:'SYNTHETIC PRIVATE TEST NAME',timeZone:config.timeZone,taxOrigin:config.address};
 await sql('select public.zentra_put_us_tax_profile($1,$2,0,$3::uuid,$4)',[org,user,randomUUID(),facts]);
 const binding:StripeTaxTestBinding={organizationId:org,accountId:'acct_SyntheticSettlement',mode:'test',apiVersion:'2026-08-26.dahlia',revision:1,settingsSha256:hash('synthetic-settings'),registrationsSha256:hash('synthetic-registrations'),observedAt:new Date(now.getTime()-1000).toISOString(),validUntil:new Date(now.getTime()+3600000).toISOString(),evidenceKind:'test_fixture',scope:'erp_invoice_tax'};
 await sql('select public.zentra_put_us_tax_provider_binding($1,$2,0,$3::uuid,$4)',[org,user,randomUUID(),binding]);
 const erp=createSupabaseErpStore(client,{supportedSchemaVersion:4});let n=0;
 const deps={store:erp,configuration:config,actor,revalidate:async()=>({...actor,timestamp:new Date().toISOString()}),taxProvider:async()=>null,seller:async()=>({organizationId:org,...seller})};
 const send=async(command:ErpCommand)=>executeErp(deps,{idempotencyKey:`synthetic-${++n}`,expectedRevision:(await erp.read(org))?.revision??0,command});
 await send({type:'initialize',periods:[{id:'year',start:`${year}-01-01`,end:`${year}-12-31`,status:'open'}]});
 await send({type:'save_customer',customer:{id:'customer',organizationId:org,kind:'business',name:'Synthetic Customer — no real transaction',billingAddress:config.address,paymentTermsDays:30}});
 const lines=Array.from({length:options.lines??1},(_,i)=>({id:`line-${i}`,description:`Synthetic service ${i}`,quantityUnits:options.quantity??'3',quantityScale:options.scale??0,unitPrice:{currency:'USD' as const,minorUnits:options.unitPrice??'10001'},discountBasisPoints:options.discount??1000,taxTreatment:'taxable' as const}));
 await send({type:'save_estimate',id:'quote',expectedEstimateRevision:0,customerId:'customer',date:day,expiresAt:`${year}-12-31`,paymentTermsDays:30,notes:'Synthetic local-only terms · Genève · 東京 · 🌍',lines});await send({type:'accept_estimate',estimateId:'quote',expectedEstimateRevision:1});
 const before=(await erp.read(org))!,key='synthetic-invoice',operationId=randomUUID(),source=buildTaxRequest(config,before.estimates[0],day),net=estimateTotals(before.estimates[0]).net.minorUnits,lineTax=options.tax??'2475',tax=(BigInt(lineTax)*BigInt(lines.length)).toString();
 const calculatedAt=new Date().toISOString(),expiresAt=new Date(now.getTime()+1800000).toISOString(),calculationId='taxcalc_SyntheticSettlement';
 const assessment:TaxAssessment={organizationId:org,country:'US',currency:'USD',documentId:source.documentId,documentRevision:source.documentRevision,fingerprint:source.fingerprint,source:'external-provider',providerReference:calculationId,determinedAt:calculatedAt,validUntil:expiresAt,lines:lines.map((l,i)=>({id:l.id,taxMinor:lineTax,jurisdiction:'US-NY',evidenceReference:`${calculationId}:tax_li_Synthetic${i}`}))};
 let captured:ErpCommit|undefined;
 await expect(executeErp({...deps,taxProvider:async()=>({id:'synthetic-no-network',calculate:async()=>assessment}),store:{...erp,commit:async input=>{captured=input;throw Error('synthetic_capture_only');}}},{idempotencyKey:key,expectedRevision:before.revision,command:{type:'issue_invoice',id:'invoice',estimateId:'quote',expectedEstimateRevision:2,date:day,accountingDate:day,dueDate:day,periodId:'year'}})).rejects.toThrow('synthetic_capture_only');
 if(!captured)throw Error('Missing synthetic invoice candidate');const commit=captured;
 const resolved=await prepareStripeTaxResolvedRequest({organizationId:org,operationId,invoiceId:'invoice',actorUserId:user,erpIdempotencyKey:key,commandHash:commit.receipt.commandHash,expectedErpRevision:before.revision,countryRevision:2,sellerRevision:1,taxFactsRevision:1,configuration:config,estimate:before.estimates[0],taxFacts:facts,binding,classifications:lines.map(l=>({lineId:l.id,taxCode:'txcd_10000000',kind:'service' as const,taxBehavior:'exclusive' as const,revision:1,evidenceReference:'Synthetic classification, no live provider'})),invoiceDate:day,taxDateInstant:`${day}T12:00:00Z`,taxDatePolicy:'caller_supplied_invoice_instant',now:new Date().toISOString(),addressSource:'billing'});
 const proof:StripeTaxPrivateProof={schemaVersion:1,organizationId:org,operationId,provider:'stripe_tax',accountId:binding.accountId,mode:'test',apiVersion:binding.apiVersion,bindingRevision:1,resolvedSha256:resolved.resolvedSha256,paramsSha256:resolved.paramsSha256,settingsSha256:binding.settingsSha256,registrationsSha256:binding.registrationsSha256,evidenceKind:'test_fixture',calculationId,calculatedAt,expiresAt,taxDate:resolved.params.tax_date,currency:'USD',netMinor:net,taxMinor:tax,totalMinor:(BigInt(net)+BigInt(tax)).toString(),lines:lines.map((l,i)=>({lineId:l.id,providerLineId:`tax_li_Synthetic${i}`,netMinor:resolved.params.line_items[i].amount.toString(),quantity:resolved.params.line_items[i].quantity.toString(),taxCode:'txcd_10000000',taxMinor:lineTax,breakdowns:[{amountMinor:lineTax,taxableMinor:resolved.params.line_items[i].amount.toString(),taxabilityReason:'standard_rated' as const,sourcing:'destination' as const,jurisdiction:{country:'US' as const,state:'NY',level:'state',displayName:'Synthetic TEST jurisdiction'}}]}))};
 await sql('select public.zentra_reserve_us_tax_operation($1,$2,$3::uuid,$4,$5,$6,$7,$8)',[org,actor,operationId,resolved.resolvedBody,resolved.resolvedSha256,resolved.paramsBody,resolved.paramsSha256,resolved.idempotencyKey]);
 await sql('select public.zentra_record_us_tax_calculation($1,$2::uuid,$3,$4,$5,$6)',[org,operationId,actor,canonicalErpJson(proof),hash(canonicalErpJson(proof)),assessment]);
 await sql('select public.zentra_commit_us_tax_invoice_test_v2($1,$2::uuid,$3,$4,$5,$6,$7,$8,4)',[org,operationId,commit.expectedRevision,commit.header,commit.changes,commit.ledgerAudit,commit.receipt,commit.actor]);
 if(options.paid)await send({type:'record_payment',id:'baseline-payment',invoiceId:'invoice',amountMinor:options.paid,paymentDate:day,accountingDate:day,periodId:'year',reference:'Synthetic baseline payment, no money moved'});
 if(options.closed)await send({type:'close_period',periodId:'year'});
 const baseline=(await erp.read(org))!;actor={...actor,timestamp:new Date().toISOString()};
 const policy:UsFinancialPolicyV5={version:'us-accrual-receivable-credit-v1',environment:'test',approval:{reference:'SYNTHETIC-LOCAL-TEST-ONLY',reviewedBy:'synthetic-reviewer',reviewedAt:new Date(now.getTime()-2000).toISOString()}};
 await db.query('insert into public.zentra_us_financial_test_grants values($1,$2,$3,1,true,$4)',[org,user,'owner',policy]);
 const scope={organizationId:org,actor,policy,grantVersion:1},foundation=createSupabaseUsFinancialTestFoundationV5(client,scope,async()=>scope),initial=await promoteUsFinancialBookV5(baseline,policy,actor);
 if(!options.unpromoted)await foundation.promote({book:initial,idempotencyKey:'synthetic-promotion'});
 const store=createSupabaseUsFinancialSettlementTestStoreV5(client,scope,async()=>scope);
 const read=()=>result<UsFinancialBookV5>('select public.zentra_read_us_financial_settlement_test_v5($1,$2,1,$3) result',[org,actor,capability]);
 const payment=(amountMinor='100'):UsFinancialOperationV5=>({type:'customer_payment',idempotencyKey:randomUUID(),invoiceId:'invoice',amountMinor,paymentDate:day,accountingDate:day,periodId:'year',reference:'Synthetic payment · référence "quoted"'});
 const authorize=async(book:UsFinancialBookV5,input:UsFinancialCreditInputV5,persist=true):Promise<Extract<UsFinancialOperationV5,{type:'customer_credit'}>>=>{
  const c=await buildUsFinancialCreditCandidateV5(book,input),common={schemaVersion:1 as const,environment:'test' as const,invoiceFingerprint:c.invoiceFingerprint,allocationSha256:c.allocationSha256,reference:'Synthetic authorization, no tax reversal executed',verifiedBy:'synthetic-test-reviewer',verifiedAt:actor.timestamp};
  const taxProof:UsFinancialTaxProofV5=c.allocation.taxMinor==='0'?{...common,kind:'historical_zero_tax'}:{...common,kind:'test_adjustment_authorization',providerAccountReference:'acct_SyntheticSettlement',originalTaxTransactionReference:'testtxn_SyntheticInvoice',adjustmentPlanReference:`synthetic-plan-${input.idempotencyKey}`,authorizedTaxMinor:c.allocation.taxMinor};
  if(persist)await db.query('insert into public.zentra_us_financial_test_tax_plans values($1,$2,$3,$4)',[org,input.idempotencyKey,input.invoiceId,taxProof]);
  return{...input,taxProof};
 };
 const credit=(book:UsFinancialBookV5,quantities:readonly string[]=['1'],persist=true)=>authorize(book,{type:'customer_credit',idempotencyKey:randomUUID(),invoiceId:'invoice',transactionDate:day,accountingDate:day,periodId:'year',reason:'Synthetic customer credit — local tests only',selections:quantities.map((quantityUnits,i)=>({lineId:`line-${i}`,quantityUnits}))},persist);
 const prepare=async(op:UsFinancialOperationV5,id:string=randomUUID(),beforeBook?:UsFinancialBookV5):Promise<UsFinancialCommitV5>=>{
  const before=beforeBook??await read(),after=await applyUsFinancialOperationV5(before,op,actor,id),{idempotencyKey,...rest}=op;
  if(rest.type==='erp_command')throw Error('Synthetic helper excludes ERP');const command=rest.type==='customer_credit'?(()=>{const{taxProof:_proof,...fields}=rest;return{...fields,id};})():{...rest,id};
  const receipt:UsFinancialReceiptV5={idempotencyKey,commandHash:hash(canonicalErpJson([org,user,{idempotencyKey,expectedRevision:before.revision,command}])),revision:after.book.revision,entityId:id,action:op.type,actorId:user};
  return{organizationId:org,expectedRevision:before.revision,previousFingerprint:hash(canonicalErpJson(before)),book:after.book,receipt,actor};
 };
 const append=(c:UsFinancialCommitV5,version=1)=>result<UsFinancialReceiptV5>('select public.zentra_append_us_financial_settlement_test_v5($1,$2,$3,$4,$5,$6,$7,$8) result',[org,c.actor,version,capability,c.expectedRevision,c.previousFingerprint,c.book,c.receipt]);
 return{org,user,config,actor,day,policy,scope,baseline,initial,foundation,store,read,payment,credit,authorize,prepare,append};
}
describe.skipIf(!enabled)('independent private US financial TEST PostgreSQL settlement',()=>{
 beforeAll(async()=>{
  const require=createRequire(import.meta.url);({PGlite}=require(join(directory!,'dist/index.cjs')) as {PGlite:new(dataDir?:string)=>Db});dataDir=await mkdtemp(join(tmpdir(),'zentra-settlement-test-v5-'));db=new PGlite(dataDir);
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
  for(const name of [...migrations,migration])await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
 },30000);
 afterAll(async()=>{await db?.close();});
 it('reconstructs and persists a real ERP4 invoice payment through adapter and private SQL',async()=>{
  const f=await fixture(),commit=await f.prepare(f.payment());expect(await f.store.commit(commit)).toEqual(commit.receipt);expect(await f.read()).toEqual(commit.book);expect(await f.store.receipt(f.org,commit.receipt.idempotencyKey)).toEqual(commit.receipt);
  const view=await projectUsFinancialBookV5(await f.read());expect(view.settlements[0]).toMatchObject({receivedMinor:'100',creditedMinor:'0',outstandingMinor:'29378'});
 });
 it('executes runtime credit then payment against one SQL book and preserves exact durable retry',async()=>{
  const f=await fixture();
  const deps={configuration:f.config,actor:f.actor,policy:f.policy,store:f.store,revalidate:async()=>({configuration:f.config,actor:f.actor,policy:f.policy}),resolveTax:async(input:Parameters<Parameters<typeof executeUsFinancialKernelV5>[0]['resolveTax']>[0])=>{
   const operation=await f.authorize(input.book,{type:'customer_credit',idempotencyKey:input.idempotencyKey,invoiceId:'invoice',transactionDate:f.day,accountingDate:f.day,periodId:'year',reason:'Synthetic runtime credit',selections:[{lineId:'line-0',quantityUnits:'1'}]});return operation.taxProof;
  }};
  const request={idempotencyKey:'synthetic-runtime-credit',expectedRevision:f.initial.revision,command:{type:'customer_credit' as const,id:'credit',invoiceId:'invoice',transactionDate:f.day,accountingDate:f.day,periodId:'year',reason:'Synthetic runtime credit',selections:[{lineId:'line-0',quantityUnits:'1'}]}};
  const credited=await executeUsFinancialKernelV5(deps,request);expect(await executeUsFinancialKernelV5(deps,request)).toEqual(credited);
  const b=await f.read(),view=await projectUsFinancialBookV5(b);expect(view.settlements[0]).toMatchObject({creditedMinor:'9826',receivedMinor:'0',outstandingMinor:'19652'});
  const {idempotencyKey,...payment}=f.payment('19652');const paid=await executeUsFinancialKernelV5(deps,{idempotencyKey,expectedRevision:b.revision,command:{...payment,id:'payment'}});
  expect(paid.revision).toBe(b.revision+1);expect((await projectUsFinancialBookV5(await f.read())).settlements[0]).toMatchObject({receivedMinor:'19652',creditedMinor:'9826',outstandingMinor:'0',status:'settled_with_credit'});
  expect(await executeUsFinancialKernelV5(deps,request)).toEqual(credited);
 });
 it.each([{quantity:'3',scale:0,discount:1000},{quantity:'300',scale:2,discount:3333},{quantity:'3',scale:0,discount:0}])('allocates exact cumulative discounted net and historical tax for $quantity/$scale',async options=>{
  const f=await fixture(options),slice=options.scale===0?'1':'100';let previous=f.initial;const totals:bigint[]=[];
  for(let i=0;i<3;i++){const c=await f.prepare(await f.credit(previous,[slice]),`credit-${i}`,previous);await f.append(c);const e=c.book.events.at(-1)!;if(!('record' in e)||e.operation.type!=='customer_credit')throw Error('Credit required');totals.push(BigInt((e.record as {allocation:{totalMinor:string}}).allocation.totalMinor));previous=c.book;}
  expect(totals.reduce((a,b)=>a+b,BigInt(0)).toString()).toBe(f.baseline.invoices[0].total.minorUnits);expect(await f.read()).toEqual(previous);expect((await projectUsFinancialBookV5(previous)).settlements[0].status).toBe('credited');
 });
 it('preserves source line order despite reversed selections and accepts historical zero-tax authorization only on zero-tax lines',async()=>{
  const f=await fixture({lines:2,tax:'0'}),op=await f.credit(f.initial,['1','2']);
  const reversed={...op,selections:[...op.selections].reverse()},c=await f.prepare(reversed);await f.store.commit(c);
  expect((await projectUsFinancialBookV5(await f.read())).credits[0].allocation.lines.map(l=>l.lineId)).toEqual(['line-0','line-1']);
 });
 it('allocates the last exact cents as 35,37,35 instead of repeating a rounded first slice',async()=>{
  const f=await fixture({unitPrice:'100',discount:6667,tax:'7'});let b=f.initial;const totals:string[]=[];
  for(let i=0;i<3;i++){const c=await f.prepare(await f.credit(b),`synthetic-credit-${i}`,b);await f.append(c);b=c.book;const e=c.book.events.at(-1)!;if(!('record' in e))throw Error('Credit required');totals.push((e.record as {allocation:{totalMinor:string}}).allocation.totalMinor);}
  expect(totals).toEqual(['35','37','35']);expect((await projectUsFinancialBookV5(await f.read())).settlements[0]).toMatchObject({creditedMinor:'107',outstandingMinor:'0'});
 });
 it('reconstructs outstanding 22 after payment50 and credit35 and refuses a subsequent payment23 or credit37',async()=>{
  const f=await fixture({unitPrice:'100',discount:6667,tax:'7',paid:'50'}),c=await f.prepare(await f.credit(f.initial));await f.append(c);const b=await f.read();
  expect((await projectUsFinancialBookV5(b)).settlements[0]).toMatchObject({receivedMinor:'50',creditedMinor:'35',outstandingMinor:'22'});
  const bad=copy(await f.prepare(f.payment('1'))) as Mutable<UsFinancialCommitV5>,e=bad.book.events.at(-1)!;if(e.operation.type!=='customer_payment')throw Error('Payment required');e.operation.amountMinor='23';bad.receipt=receiptFor(bad.book);await expect(f.append(bad)).rejects.toMatchObject({code:'PF013'});
  const next={...c.book.events[0].operation,idempotencyKey:randomUUID()};await expect(result('select public.zentra_us_settlement_transition($1,$2,$3,$4) result',[b,next,f.actor,'synthetic-second-credit'])).rejects.toMatchObject({code:'PF013'});expect(await f.read()).toEqual(b);
 });
 it('rejects zero-tax authority when only a rounded slice is zero but the historical line tax is positive',async()=>{
  const f=await fixture({tax:'1'}),input={type:'customer_credit' as const,idempotencyKey:randomUUID(),invoiceId:'invoice',transactionDate:f.day,accountingDate:f.day,periodId:'year',reason:'Synthetic rounded-zero tax slice',selections:[{lineId:'line-0',quantityUnits:'1'}]},candidate=await buildUsFinancialCreditCandidateV5(f.initial,input);
  expect(candidate.allocation.taxMinor).toBe('0');const op={...input,taxProof:{schemaVersion:1,environment:'test',kind:'historical_zero_tax',invoiceFingerprint:candidate.invoiceFingerprint,allocationSha256:candidate.allocationSha256,reference:'Synthetic unqualified zero-tax authority',verifiedBy:'synthetic-reviewer',verifiedAt:f.actor.timestamp}};
  await expect(result('select public.zentra_us_settlement_transition($1,$2,$3,$4) result',[f.initial,op,f.actor,'synthetic-zero-tax-credit'])).rejects.toMatchObject({code:'PF014'});expect(await f.read()).toEqual(f.initial);
 });
 it('counts baseline payments before credits and rejects overpayment after a credit',async()=>{
  const f=await fixture({paid:'1000'}),c=await f.prepare(await f.credit(f.initial));await f.append(c);const b=await f.read(),view=await projectUsFinancialBookV5(b);expect(view.settlements[0]).toMatchObject({receivedMinor:'1000',creditedMinor:'9826',outstandingMinor:'18652'});
  const payment=await f.prepare(f.payment('1')),bad=copy(payment) as Mutable<UsFinancialCommitV5>,e=bad.book.events.at(-1)!;
  if(e.operation.type!=='customer_payment')throw Error('Payment required');e.operation.amountMinor='18653';bad.receipt=receiptFor(bad.book);
  await expect(f.append(bad)).rejects.toMatchObject({code:'PF013'});expect(await f.read()).toEqual(b);
 });
 it('requires an immutable DB-owner TEST plan instead of trusting valid-looking fiscal JSON',async()=>{
  const f=await fixture(),op=await f.credit(f.initial,['1'],false),c=await f.prepare(op);
  await expect(f.append(c)).rejects.toMatchObject({code:'PF014'});expect(await f.read()).toEqual(f.initial);
  await expect(sql('insert into public.zentra_us_financial_test_tax_plans values($1,$2,$3,$4)',[f.org,op.idempotencyKey,op.invoiceId,op.taxProof])).rejects.toMatchObject({code:'42501'});
  await db.query('insert into public.zentra_us_financial_test_tax_plans values($1,$2,$3,$4)',[f.org,op.idempotencyKey,op.invoiceId,op.taxProof]);await f.append(c);
  await expect(db.query('update public.zentra_us_financial_test_tax_plans set invoice_id=invoice_id where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF003'});
  await expect(db.exec('truncate public.zentra_us_financial_test_tax_plans cascade')).rejects.toMatchObject({code:'PF003'});
 });
 it.each(['record','posting','receipt','prefix','fingerprint','actor','fiscal'])('refuses forged %s without changing any financial row',async target=>{
  const f=await fixture(),c=await f.prepare(await f.credit(f.initial)),bad=copy(c) as Mutable<UsFinancialCommitV5>,e=bad.book.events.at(-1)!;
  if(!('record' in e)||e.operation.type!=='customer_credit')throw Error('Credit required');
  if(target==='record')(e.record as {allocation:{totalMinor:string}}).allocation.totalMinor='1';
  if(target==='posting'){e.posting.lines[0].debitMinor='1';e.posting.lines[e.posting.lines.length-1].creditMinor='1';}
  if(target==='receipt')bad.receipt.commandHash='0'.repeat(64);
  if(target==='prefix')bad.book.baseline.customers[0].name='Foreign altered baseline';
  if(target==='fingerprint')bad.previousFingerprint='0'.repeat(64);
  if(target==='actor')e.actor.userId=randomUUID();
  if(target==='fiscal')e.operation.taxProof.reference='Unprovisioned different fiscal authorization';
  await expect(f.append(bad)).rejects.toMatchObject({code:target==='fingerprint'?'PF001':target==='fiscal'?'PF014':'PF004'});expect(await f.read()).toEqual(f.initial);
  expect((await sql('select * from public.zentra_us_financial_test_events where organization_id=$1',[f.org]))).toEqual([]);
 });
 it('preserves exact old retry envelopes after later events and refuses conflicting key reuse',async()=>{
  const f=await fixture(),first=await f.prepare(f.payment('100'));await f.append(first);const second=await f.prepare(f.payment('200'));await f.append(second);expect(await f.append(first)).toEqual(first.receipt);
  const conflict=copy(first) as Mutable<UsFinancialCommitV5>,e=conflict.book.events.at(-1)!;if(e.operation.type!=='customer_payment')throw Error('Payment required');e.operation.reference='Different request';conflict.receipt=receiptFor(conflict.book);
  await expect(f.append(conflict)).rejects.toMatchObject({code:'PF002'});expect(await f.read()).toEqual(second.book);
 });
 it('rejects stale CAS and preserves legacy/promotion idempotency reservations',async()=>{
  const f=await fixture(),first=await f.prepare(f.payment('100')),stale=await f.prepare(f.payment('200'));await f.append(first);await expect(f.append(stale)).rejects.toMatchObject({code:'PF001'});
  for(const key of ['synthetic-1','synthetic-promotion']){const other=await f.prepare({...f.payment(),idempotencyKey:key});await expect(f.append(other)).rejects.toMatchObject({code:'PF002'});}
  expect(await f.read()).toEqual(first.book);
 });
 it('rolls back individually valid direct events/receipts when the cursor or receipt set is incomplete',async()=>{
  const f=await fixture(),c=await f.prepare(f.payment()),event=c.book.events.at(-1)!;
  await expect(sql('insert into public.zentra_us_financial_test_events values($1,$2,$3,1)',[f.org,c.book.revision,event])).rejects.toMatchObject({code:'PF004'});
  await expect(db.transaction(async tx=>{await tx.exec('set local role service_role');await tx.query('insert into public.zentra_us_financial_test_events values($1,$2,$3,1)',[f.org,c.book.revision,event]);await tx.query('insert into public.zentra_us_financial_test_receipts values($1,$2,$3,$4,$5)',[f.org,c.receipt.idempotencyKey,'financial_v5',f.user,c.receipt]);})).rejects.toMatchObject({code:'PF004'});
  await expect(sql('update public.zentra_us_financial_test_cursors set revision=revision+1 where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF004'});
  expect(await f.read()).toEqual(f.initial);expect(await f.append(c)).toEqual(c.receipt);
 });
 it('requires promotion and settlement in separate committed transactions and rolls back both otherwise',async()=>{
  const f=await fixture({unpromoted:true}),c=await f.prepare(f.payment(),'synthetic-payment',f.initial),promotionHash=hash(canonicalErpJson([f.org,f.user,{type:'promote_financial_book',idempotencyKey:'synthetic-promotion',baselineRevision:f.initial.baseline.revision,baselineSha256:f.initial.promotion.baselineSha256,policy:f.policy}]));
  await expect(db.transaction(async tx=>{await tx.exec('set local role service_role');await tx.query('select public.zentra_promote_us_financial_test_v5($1,$2,1,$3,$4,$5,$6)',[f.org,f.actor,'postgres-test-foundation-v5',f.initial,'synthetic-promotion',promotionHash]);await tx.query('select public.zentra_append_us_financial_settlement_test_v5($1,$2,1,$3,$4,$5,$6,$7)',[f.org,c.actor,capability,c.expectedRevision,c.previousFingerprint,c.book,c.receipt]);})).rejects.toMatchObject({code:'PF004'});
  expect(await result('select public.zentra_read_us_erp_v4($1) result',[f.org])).toEqual(f.baseline);expect(await f.read()).toBeNull();
  await f.foundation.promote({book:f.initial,idempotencyKey:'synthetic-promotion'});expect(await f.append(c)).toEqual(c.receipt);
 });
 it('rejects malformed pure actor shapes and cash movements missing a cash-flow classification',async()=>{
  const f=await fixture(),op=await f.credit(f.initial);
  for(const actor of [{...f.actor,role:null},{...f.actor,userId:null},{...f.actor,managementEntitled:false},{...f.actor,extra:'secret'}])await expect(result('select public.zentra_us_settlement_transition($1,$2,$3,$4) result',[f.initial,op,actor,'synthetic-credit'])).rejects.toMatchObject({code:'PF004'});
  const altered=copy(f.initial) as Mutable<UsFinancialBookV5>,receivables=altered.baseline.ledger.accounts.find(a=>a.id==='receivables')!;receivables.cash=true;
  await expect(result('select public.zentra_us_settlement_transition($1,$2,$3,$4) result',[altered,op,f.actor,'synthetic-credit'])).rejects.toMatchObject({code:'PF004'});expect(await f.read()).toEqual(f.initial);
 });
 it('refuses audit actors beyond the local TEST clock tolerance before any write while historical retries remain usable',async()=>{
  const f=await fixture(),c=copy(await f.prepare(f.payment())) as Mutable<UsFinancialCommitV5>,future=new Date(Date.now()+86400000).toISOString();c.actor.timestamp=future;c.book.events.at(-1)!.actor.timestamp=future;
  await expect(f.append(c)).rejects.toMatchObject({code:'PF016'});await expect(result('select public.zentra_read_us_financial_settlement_test_v5($1,$2,1,$3) result',[f.org,c.actor,capability])).rejects.toMatchObject({code:'PF016'});expect(await f.read()).toEqual(f.initial);
 });
 it('requires live matching grant versions on direct event insert, append, reads and retries',async()=>{
  const f=await fixture(),c=await f.prepare(f.payment());
  await expect(sql('insert into public.zentra_us_financial_test_events values($1,$2,$3,null)',[f.org,c.book.revision,c.book.events.at(-1)])).rejects.toMatchObject({code:'PF006'});
  await expect(f.append(c,2)).rejects.toMatchObject({code:'PF006'});await f.append(c);
  await db.query('update public.zentra_us_financial_test_grants set enabled=false,version=2 where organization_id=$1',[f.org]);
  await expect(f.read()).rejects.toMatchObject({code:'PF005'});await expect(f.append(c)).rejects.toMatchObject({code:'PF005'});
  await db.query('update public.zentra_us_financial_test_grants set enabled=true,version=3 where organization_id=$1',[f.org]);
  await expect(f.append(c)).rejects.toMatchObject({code:'PF006'});expect(await f.append(c,3)).toEqual(c.receipt);
 });
 it('refuses old foundation readers/replays once settlement exists while its append stays closed',async()=>{
  const f=await fixture(),c=await f.prepare(f.payment());await f.append(c);
  await expect(f.foundation.read()).rejects.toMatchObject({code:'financial_upgrade_required'});await expect(f.foundation.receipt('synthetic-promotion')).rejects.toMatchObject({code:'financial_upgrade_required'});
  await expect(f.foundation.promote({book:f.initial,idempotencyKey:'synthetic-promotion'})).rejects.toMatchObject({code:'financial_upgrade_required'});
  await expect(result('select public.zentra_append_us_financial_test_v5($1,$2,1,$3,$4,$5,$6,$7) result',[f.org,f.actor,'postgres-test-foundation-v5',c.expectedRevision,c.previousFingerprint,c.book,c.receipt])).rejects.toMatchObject({code:'PF010'});
 });
 it('rejects reversed financial clocks and closed accounting periods independently of posting balance',async()=>{
  const f=await fixture(),c=copy(await f.prepare(f.payment())) as Mutable<UsFinancialCommitV5>,early=new Date(Date.parse(f.actor.timestamp)-10_000).toISOString();c.actor.timestamp=early;c.book.events.at(-1)!.actor.timestamp=early;
  await expect(f.append(c)).rejects.toMatchObject({code:'PF016'});
  const closed=await fixture({closed:true}),base=await f.prepare(f.payment()),bad={...base,organizationId:closed.org,actor:closed.actor,expectedRevision:closed.initial.revision,previousFingerprint:hash(canonicalErpJson(closed.initial)),book:{...closed.initial,revision:closed.initial.revision+1,events:[{...base.book.events.at(-1)!,revision:closed.initial.revision+1,actor:closed.actor}]}};bad.receipt=receiptFor(bad.book);
  await expect(closed.append(bad)).rejects.toMatchObject({code:'PF015'});
 });
 it('keeps ERP commands and public/foreign capabilities closed',async()=>{
  const f=await fixture(),c=await f.prepare(f.payment());
  await expect(result('select public.zentra_read_us_financial_settlement_test_v5($1,$2,1,$3) result',[f.org,f.actor,'memory-test-v5'])).rejects.toMatchObject({code:'PF009'});
  for(const role of ['anon','authenticated'])for(const q of ['select * from public.zentra_us_financial_test_cursors','select * from public.zentra_us_financial_test_tax_plans','select public.zentra_read_us_financial_settlement_test_v5(null,null,null,null)'])await expect(sql(q,[],role)).rejects.toMatchObject({code:'42501'});
  const bad=copy(c) as Mutable<UsFinancialCommitV5>;(bad.book.events.at(-1)! as unknown as {operation:unknown}).operation={type:'erp_command',idempotencyKey:randomUUID(),command:{type:'save_customer'},facts:{kind:'none'}};
  await expect(sql('insert into public.zentra_us_financial_test_events values($1,$2,$3,1)',[f.org,bad.book.revision,bad.book.events.at(-1)])).rejects.toMatchObject({code:'PF010'});
 });
 it('never converts exact 36-digit integers or cumulative ratios to floating point',async()=>{
  const original='999999999999999999999999999999999999',qty='999999999999999999999999999999999999';
  expect((await sql<{minor:string;rounded:string}>('select public.zentra_us_settlement_minor(to_jsonb($1::text))::text minor,public.zentra_us_settlement_round($2::numeric*$3::numeric,$4::numeric)::text rounded',[original,original,qty,qty]))[0]).toEqual({minor:original,rounded:original});
  for(const bad of ['00','01','-1','1.1','1e3','1'.repeat(37)])await expect(sql('select public.zentra_us_settlement_minor(to_jsonb($1::text))',[bad])).rejects.toMatchObject({code:'PF004'});
 });
 it('recovers exact credit/payment tail, receipts and frozen baseline after clean NodeFS reopen',async()=>{
  const f=await fixture(),credit=await f.prepare(await f.credit(f.initial));await f.append(credit);const payment=await f.prepare(f.payment('50'));await f.append(payment);
  await db.close();db=new PGlite(dataDir);expect(await f.read()).toEqual(payment.book);expect(await f.append(credit)).toEqual(credit.receipt);expect(await f.store.receipt(f.org,payment.receipt.idempotencyKey)).toEqual(payment.receipt);
  await expect(sql('update public.zentra_us_financial_test_heads set revision=revision+1 where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF003'});
  await expect(sql('update public.zentra_us_financial_test_events set payload=payload where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF003'});
 },30000);
});
