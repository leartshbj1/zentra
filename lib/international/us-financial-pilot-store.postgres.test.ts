import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createServer } from 'node:http';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
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
import type { UsFinancialCommitV5, UsFinancialReceiptV5 } from './us-financial-kernel-runtime';
import { createSupabaseUsFinancialTestFoundationV5 } from './us-financial-test-foundation';
import { createSupabaseUsFinancialPilotStore, readUsFinancialPilotPromotionStatus, readUsFinancialPilotScope, type UsFinancialPilotScope } from './us-financial-pilot-store';
import { createUsFinancialPilotHandlers } from './us-financial-pilot-server';
import { createBrowserUsFinancialPilotSession } from './browser-us-financial-pilot-session';

// Actual SQL and HTTP handlers on retained local NodeFS. Auth/D1 and all fiscal
// observations are explicitly synthetic. No provider/network calls. Serialized
// PGlite proves neither multi-connection races, crash recovery nor hosted SLA.
const directory=process.env.PGLITE_MODULE_DIR,enabled=Boolean(directory&&isAbsolute(directory));
type Sql={exec(sql:string):Promise<unknown>;query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[]}>};
type Db=Sql&{close():Promise<void>;transaction<T>(task:(tx:Sql)=>Promise<T>):Promise<T>};
let db:Db,PGlite:new(dataDir?:string)=>Db,dataDir:string;
const capability='postgres-test-financial-pilot-dto1',migration='20261010104148_international_us_financial_pilot_dto1';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const migrations=[
 '202609140100_company_profiles','202609140200_company_collaboration','202609200300_company_content',
 '20261007194528_international_workspace_country_config','20261007222349_international_us_erp_persistence','20261007224820_international_us_erp_delta_stream','20261007225725_international_us_erp_seller_snapshot','20261008001726_new_us_workspace_admission','20261008013200_international_tax_proof_allowlist',
 '20261008034422_international_us_seller_profile','20261008044402_international_us_tax_profile','20261008060826_international_us_tax_operations','20261008081825_international_us_purchasing_v2','20261008105120_international_us_projects_v3','20261008161118_international_us_journal_periods_v4','20261008172520_international_us_tax_invoice_capability_v2',
 '20261008184605_international_us_bank_reconciliation','20261008194930_international_us_supplier_proposals','20261008210008_international_us_automation_analysis','20261009215104_international_us_workspace_sync_heads','20261009222319_international_us_tax_test_merchant','20261009224607_international_us_tax_invoice_preparation','20261010005300_international_us_supplier_originals','20261010024618_international_us_supplier_original_hash_lookup','20261010054644_international_us_sales_orders','20261010075840_international_us_financial_test_foundation_v5','20261010083027_international_us_financial_test_settlement_v5','20261010085523_international_us_financial_test_commercial_v5','20261010091729_international_us_financial_test_purchasing_v5','20261010093930_international_us_financial_test_accounting_v5',
 '20261010100252_international_us_financial_test_invoicing_v5',
];
const parameters:Record<string,readonly string[]>={
 zentra_read_us_financial_invoicing_test_v5:['p_organization','p_actor','p_grant_version','p_capability'],zentra_us_financial_invoicing_test_receipt_v5:['p_organization','p_actor','p_grant_version','p_capability','p_idempotency_key'],zentra_append_us_financial_invoicing_test_v5:['p_organization','p_actor','p_grant_version','p_capability','p_expected_revision','p_previous_fingerprint','p_book','p_receipt'],
 zentra_read_us_financial_invoice_test_operation_v5:['p_organization','p_actor','p_grant_version','p_capability','p_idempotency_key','p_financial_command_hash','p_erp_command_hash'],zentra_preflight_us_financial_invoice_test_v5:['p_organization','p_actor','p_grant_version','p_capability','p_request','p_financial_command_hash','p_erp_command_hash','p_previous_fingerprint'],zentra_reserve_us_financial_invoice_test_v5:['p_organization','p_actor','p_grant_version','p_capability','p_preparation','p_resolved_body','p_resolved_sha256','p_params_body','p_params_sha256','p_provider_idempotency_key'],zentra_record_us_financial_invoice_test_calculation_v5:['p_organization','p_actor','p_grant_version','p_capability','p_operation_id','p_proof_body','p_proof_sha256','p_assessment'],
 zentra_read_us_financial_accounting_test_v5:['p_organization','p_actor','p_grant_version','p_capability'],zentra_us_financial_accounting_test_receipt_v5:['p_organization','p_actor','p_grant_version','p_capability','p_idempotency_key'],zentra_append_us_financial_accounting_test_v5:['p_organization','p_actor','p_grant_version','p_capability','p_expected_revision','p_previous_fingerprint','p_book','p_receipt'],
 zentra_read_us_financial_purchasing_test_v5:['p_organization','p_actor','p_grant_version','p_capability'],zentra_us_financial_purchasing_test_receipt_v5:['p_organization','p_actor','p_grant_version','p_capability','p_idempotency_key'],zentra_append_us_financial_purchasing_test_v5:['p_organization','p_actor','p_grant_version','p_capability','p_expected_revision','p_previous_fingerprint','p_book','p_receipt'],
 zentra_read_us_erp_v4:['p_organization'],zentra_us_erp_receipt_v4:['p_organization','p_idempotency_key'],zentra_commit_us_erp:['p_organization','p_expected_revision','p_header','p_changes','p_ledger_audit','p_receipt','p_actor'],
 zentra_read_us_financial_test_v5:['p_organization','p_actor','p_grant_version','p_capability'],zentra_us_financial_test_receipt_v5:['p_organization','p_actor','p_grant_version','p_capability','p_idempotency_key'],zentra_promote_us_financial_test_v5:['p_organization','p_actor','p_grant_version','p_capability','p_book','p_idempotency_key','p_command_hash'],
 zentra_read_us_financial_settlement_test_v5:['p_organization','p_actor','p_grant_version','p_capability'],zentra_us_financial_settlement_test_receipt_v5:['p_organization','p_actor','p_grant_version','p_capability','p_idempotency_key'],zentra_append_us_financial_settlement_test_v5:['p_organization','p_actor','p_grant_version','p_capability','p_expected_revision','p_previous_fingerprint','p_book','p_receipt'],
 zentra_read_us_financial_commercial_test_v5:['p_organization','p_actor','p_grant_version','p_capability'],zentra_us_financial_commercial_test_receipt_v5:['p_organization','p_actor','p_grant_version','p_capability','p_idempotency_key'],zentra_append_us_financial_commercial_test_v5:['p_organization','p_actor','p_grant_version','p_capability','p_expected_revision','p_previous_fingerprint','p_book','p_receipt'],
};

Object.assign(parameters,{
 zentra_us_financial_pilot_test_scope_v1:['p_organization','p_actor','p_capability','p_expected_grant_version','p_expected_opt_in_version'],
 zentra_us_financial_pilot_test_head_v1:['p_organization','p_actor','p_grant_version','p_opt_in_version','p_capability'],
 zentra_read_us_financial_pilot_test_v1:['p_organization','p_actor','p_grant_version','p_opt_in_version','p_capability'],
 zentra_us_financial_pilot_test_receipt_v1:['p_organization','p_actor','p_grant_version','p_opt_in_version','p_capability','p_idempotency_key'],
 zentra_append_us_financial_pilot_test_v1:['p_organization','p_actor','p_grant_version','p_opt_in_version','p_capability','p_expected_revision','p_previous_fingerprint','p_book','p_receipt'],
});
async function sql<T=Record<string,unknown>>(q:string,v:unknown[]=[],role='service_role'){return db.transaction(async tx=>{await tx.exec(`set local role ${role}`);return(await tx.query<T>(q,v)).rows;});}
async function result<T=unknown>(q:string,v:unknown[]=[]){return(await sql<{result:T}>(q,v))[0].result;}
const client:Pick<SupabaseServerClient,'rpc'|'select'>={
 async rpc<T>(name:string,input:Readonly<Record<string,unknown>>):Promise<T>{
  const keys=parameters[name];if(!keys)throw Error('Unexpected synthetic SQL RPC');
  try{return await result<T>(`select public.${name}(${keys.map((_,i)=>`$${i+1}`).join(',')}) result`,keys.map(k=>input[k]));}
  catch(error){if(process.env.ZENTRA_LOCAL_SQL_DEBUG==='1')console.error((error as Error).message,(error as {where?:string}).where);throw new SupabaseServerError(503,(error as {code:string}).code,'private SQL TEST');}
 },
 async select<T>(name:string,q?:Readonly<Record<string,string|number|boolean>>|URLSearchParams):Promise<T[]>{
  if(name!=='zentra_us_financial_test_heads'||!q||q instanceof URLSearchParams||q.select!=='organization_id'||q.limit!==1||typeof q.organization_id!=='string'||!q.organization_id.startsWith('eq.'))throw Error('Unexpected private marker query');
  return await sql<T>('select organization_id from public.zentra_us_financial_test_heads where organization_id=$1 limit 1',[q.organization_id.slice(3)]);
 },
};
async function fixture(options:{tax?:string;quantity?:string;scale?:number;discount?:number;unitPrice?:string;lines?:number;paid?:string;closed?:boolean;laterOpen?:boolean;periodCount?:number;unpromoted?:boolean;activeOrder?:boolean;confirmedOrder?:boolean;pendingTax?:boolean;shortPeriod?:boolean;projects?:boolean;baselinePurchases?:boolean}={}){
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
 await send({type:'initialize',periods:Array.from({length:options.periodCount??1},(_,i)=>({id:i===0?'year':`p-${i}`,start:`${year+i}-01-01`,end:options.shortPeriod&&i===0?day:`${year+i}-12-31`,status:'open' as const}))});
 await send({type:'save_customer',customer:{id:'customer',organizationId:org,kind:'business',name:'Synthetic Customer — no real transaction',billingAddress:config.address,paymentTermsDays:30}});
 if(options.projects){
  await send({type:'save_customer',customer:{id:'other-customer',organizationId:org,kind:'business',name:'Synthetic other customer',billingAddress:config.address,paymentTermsDays:30}});
  await send({type:'save_projects',projects:[['active-project','customer','active'],['archived-project','customer','archived'],['foreign-customer-project','other-customer','active']].map(([id,customerId,status])=>({id,customerId,status:status as 'active'|'archived',expectedProjectRevision:0,name:`Synthetic ${id}`,notes:'Synthetic local project',startDate:null,targetDate:null,budgetMinor:null,vendorBillIds:[]}))});
 }
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

 const baseline=(await erp.read(org))!;actor={...actor,timestamp:new Date().toISOString()};
 const policy:UsFinancialPolicyV5={version:'us-accrual-receivable-credit-v1',environment:'test',approval:{reference:'SYNTHETIC-LOCAL-PILOT-ONLY',reviewedBy:'synthetic-reviewer',reviewedAt:new Date(now.getTime()-2000).toISOString()}};
 await db.query('insert into public.zentra_us_financial_test_grants values($1,$2,$3,1,true,$4)',[org,user,'owner',policy]);
 const scope={organizationId:org,actor,policy,grantVersion:1},foundation=createSupabaseUsFinancialTestFoundationV5(client,scope,async()=>scope),initial=await promoteUsFinancialBookV5(baseline,policy,actor);
 if(!options.unpromoted)await foundation.promote({book:initial,idempotencyKey:'synthetic-promotion'});
 let pilotScope:UsFinancialPilotScope|undefined;
 const refresh=()=>{actor={...actor,timestamp:new Date().toISOString()};scope.actor=actor;return actor;};
 const capture=async(expected?:UsFinancialPilotScope)=>readUsFinancialPilotScope(client,refresh(),expected);
 const enable=async()=>{await db.query('insert into public.zentra_us_financial_pilot_test_opt_ins values($1,1,true)',[org]);pilotScope=await capture();return pilotScope;};
 const store=()=>{if(!pilotScope)throw Error('Synthetic opt-in must be explicit');return createSupabaseUsFinancialPilotStore(client,pilotScope,()=>capture(pilotScope));};
 const read=async()=>await store().read(org) as UsFinancialBookV5;
 const payment=(amountMinor='100'):Extract<UsFinancialOperationV5,{type:'customer_payment'}>=>({type:'customer_payment',idempotencyKey:randomUUID(),invoiceId:'invoice',amountMinor,paymentDate:day,accountingDate:day,periodId:'year',reference:'SYNTHETIC recorded receipt — no transfer'});
 const prepare=async(op:UsFinancialOperationV5,id:string=randomUUID(),beforeBook?:UsFinancialBookV5):Promise<UsFinancialCommitV5>=>{
  const before=beforeBook??await read();refresh();const after=await applyUsFinancialOperationV5(before,op,actor,id),{idempotencyKey,...rest}=op;
  const command=rest.type==='erp_command'?{type:'erp_command',request:rest.command}:rest.type==='customer_credit'?(()=>{const{taxProof:_proof,...fields}=rest;return{...fields,id};})():{...rest,id};
  const receipt:UsFinancialReceiptV5={idempotencyKey,commandHash:hash(canonicalErpJson([org,user,{idempotencyKey,expectedRevision:before.revision,command}])),revision:after.book.revision,entityId:id,action:op.type,actorId:user};
  return{organizationId:org,expectedRevision:before.revision,previousFingerprint:hash(canonicalErpJson(before)),book:after.book,receipt,actor};
 };
 const credit=async(before:UsFinancialBookV5):Promise<Extract<UsFinancialOperationV5,{type:'customer_credit'}>>=>{
  refresh();const input:UsFinancialCreditInputV5={type:'customer_credit',idempotencyKey:randomUUID(),invoiceId:'invoice',transactionDate:day,accountingDate:day,periodId:'year',reason:'SYNTHETIC correction only',selections:[{lineId:'line-0',quantityUnits:'1'}]},candidate=await buildUsFinancialCreditCandidateV5(before,input);
  const proof:UsFinancialTaxProofV5={schemaVersion:1,environment:'test',kind:'test_adjustment_authorization',invoiceFingerprint:candidate.invoiceFingerprint,allocationSha256:candidate.allocationSha256,reference:'SYNTHETIC no provider reversal',verifiedBy:'synthetic-reviewer',verifiedAt:actor.timestamp,providerAccountReference:'acct_SyntheticSettlement',originalTaxTransactionReference:'testtxn_Synthetic_invoice',adjustmentPlanReference:`synthetic-plan-${input.idempotencyKey}`,authorizedTaxMinor:candidate.allocation.taxMinor};
  await db.query('insert into public.zentra_us_financial_test_tax_plans values($1,$2,$3,$4)',[org,input.idempotencyKey,input.invoiceId,proof]);return{...input,taxProof:proof};
 };
 return{org,user,config,get actor(){return actor;},refresh,day,policy,scope,baseline,initial,foundation,enable,capture,store,read,payment,prepare,credit,get pilotScope(){return pilotScope;}};
}

type Fixture=Awaited<ReturnType<typeof fixture>>;
function http(f:Fixture,transport:Pick<SupabaseServerClient,'rpc'>=client){
 const auth={userId:f.user,entitled:true,role:'owner' as FinancialAuthority['role']};
 const handlers=createUsFinancialPilotHandlers({enabled:()=>true,authority:async(_req,org)=>{if(org!==f.org)throw new ErpError('tenant_mismatch',403);return{mode:'browser',actor:{...f.refresh(),userId:auth.userId,role:auth.role,managementEntitled:auth.entitled}};},configuration:async()=>f.config,scope:(a,expected)=>readUsFinancialPilotScope(client,a,expected),store:(scope,revalidate)=>createSupabaseUsFinancialPilotStore(transport,scope,revalidate),rateLimit:async()=>{},diagnostic:()=>{}});
 const request=(path='',body?:unknown)=>new Request(`https://synthetic.example.test/api/international/workspaces/${f.org}/financial-pilot/${path}`,{method:body===undefined?'GET':'POST',headers:{'X-Zentra-Financial-Pilot':'1','X-Zentra-Expected-User':f.user,...(body===undefined?{}:{Origin:'https://synthetic.example.test','Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const payment=(revision:number,amountMinor='100',requestId=randomUUID())=>({consumer:'financial-pilot',schemaVersion:1,requestId,expectedRevision:revision,command:{type:'customer_payment',invoiceId:'invoice',amountMinor,paymentDate:f.day,accountingDate:f.day,periodId:'year',reference:'SYNTHETIC HTTP receipt — no money moved'}});
 return{handlers,request,payment,auth};
}
const rawHead=(f:Fixture,version=1,optInVersion=1,cap=capability,a=f.actor)=>result('select public.zentra_us_financial_pilot_test_head_v1($1,$2,$3,$4,$5) result',[f.org,a,version,optInVersion,cap]);

describe.skipIf(!enabled)('private financial-pilot DTO1 — actual local PostgreSQL and HTTP handlers',()=>{
 beforeAll(async()=>{
  const require=createRequire(import.meta.url);({PGlite}=require(join(directory!,'dist/index.cjs')) as {PGlite:new(dataDir?:string)=>Db});dataDir=await mkdtemp(join(tmpdir(),'zentra-financial-pilot-dto1-'));db=new PGlite(dataDir);
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
  for(const name of migrations)await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
  await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}.sql`,import.meta.url),'utf8'));
 },30000);
 afterAll(async()=>{await db?.close();});
 it('adds the private pilot to 31 prior migrations without implicitly enabling it',async()=>{
  expect(migrations).toHaveLength(31);const f=await fixture();expect(await readUsFinancialPilotPromotionStatus(client,f.org)).toBe(true);
  await expect(f.capture()).rejects.toMatchObject({code:'financial_test_grant_required',status:403});await expect(rawHead(f)).rejects.toMatchObject({code:'PF005'});
  expect(await sql('select * from public.zentra_us_financial_pilot_test_opt_ins where organization_id=$1',[f.org])).toEqual([]);
 });
 it('captures authoritative scope and pins both living grant and opt-in versions',async()=>{
  const f=await fixture(),scope=await f.enable();expect(scope).toEqual({scope:{...f.scope,actor:scope.scope.actor},optInVersion:1});expect(await f.capture(scope)).toMatchObject({optInVersion:1,scope:{grantVersion:1,policy:f.policy}});
  await expect(result('select public.zentra_us_financial_pilot_test_scope_v1($1,$2,$3,1,null) result',[f.org,f.actor,capability])).rejects.toMatchObject({code:'PF004'});
 });
 it('reads only the financial cursor in head, with no replay or private fields',async()=>{
  const f=await fixture();await f.enable();const definition=(await db.query<{d:string}>("select pg_get_functiondef('public.zentra_us_settlement_book(text)'::regprocedure) d")).rows[0].d;
  await db.exec("create or replace function public.zentra_us_settlement_book(org text) returns jsonb language plpgsql volatile security invoker set search_path='' as $$begin raise exception using errcode='PF004',message='Synthetic replay is deliberately unavailable';end$$;");
  try{expect(await f.store().head()).toEqual({consumer:'financial-pilot',schemaVersion:1,organizationId:f.org,revision:f.initial.revision});await expect(f.read()).rejects.toMatchObject({code:'invalid_financial_private_data'});}finally{await db.exec(definition);}
 });
 it('uses the real engine and atomic pilot wrapper for payment, receipt, replay and head advancement',async()=>{
  const f=await fixture();await f.enable();const before=await f.store().head(),c=await f.prepare(f.payment('101'),'pilot-payment-test');await f.store().commit(c);
  expect(await f.store().head()).toMatchObject({revision:before.revision+1});expect(await f.store().receipt(f.org,c.receipt.idempotencyKey)).toEqual(c.receipt);expect(await f.store().commit(c)).toEqual(c.receipt);
  expect(await f.read()).toEqual(c.book);expect((await projectUsFinancialBookV5(c.book)).settlements[0]).toMatchObject({receivedMinor:'101',creditedMinor:'0',outstandingMinor:'29377'});
 });
 it('rejects missing/disabled/version-changed opt-in before read, receipt and even an exact append replay',async()=>{
  const f=await fixture(),scope=await f.enable(),c=await f.prepare(f.payment(),'recorded-payment');await f.store().commit(c);
  await db.query('update public.zentra_us_financial_pilot_test_opt_ins set enabled=false,version=2 where organization_id=$1',[f.org]);
  for(const task of [()=>f.store().head(),()=>f.store().read(f.org),()=>f.store().receipt(f.org,c.receipt.idempotencyKey),()=>f.store().commit(c)])await expect(task()).rejects.toMatchObject({code:'financial_test_grant_required',status:403});
  await db.query('update public.zentra_us_financial_pilot_test_opt_ins set enabled=true,version=3 where organization_id=$1',[f.org]);await expect(f.capture(scope)).rejects.toMatchObject({code:'financial_test_grant_changed'});expect(await f.capture()).toMatchObject({optInVersion:3});
 });
 it('enforces opt-in versions inside all wrappers even if the trusted pre/post callback is stale',async()=>{
  const f=await fixture(),scope=await f.enable(),c=await f.prepare(f.payment(),'not-recorded');const stale=createSupabaseUsFinancialPilotStore(client,scope,async()=>({...scope,scope:{...scope.scope,actor:f.refresh()}}));
  await db.query('update public.zentra_us_financial_pilot_test_opt_ins set enabled=false,version=2 where organization_id=$1',[f.org]);
  for(const task of [()=>stale.head(),()=>stale.read(f.org),()=>stale.receipt(f.org,c.receipt.idempotencyKey),()=>stale.commit(c)])await expect(task()).rejects.toMatchObject({code:'financial_test_grant_required'});
  expect(await result('select count(*)::int result from public.zentra_us_financial_test_events where organization_id=$1',[f.org])).toBe(0);
 });
 it('requires matching financial roles and live grants across tenants and after reactivation',async()=>{
  const a=await fixture(),b=await fixture();const scope=await a.enable();await b.enable();
  await expect(readUsFinancialPilotScope(client,{...a.actor,organizationId:b.org})).rejects.toMatchObject({code:'financial_test_grant_required'});
  await expect(rawHead(a,1,1,capability,{...a.actor,role:'member'})).rejects.toMatchObject({code:'PF005'});
  await expect(rawHead(a,1,1,capability,{...a.actor,managementEntitled:false})).rejects.toMatchObject({code:'PF005'});
  await db.query('update public.zentra_us_financial_test_grants set enabled=false,version=2 where organization_id=$1',[a.org]);await expect(a.capture(scope)).rejects.toMatchObject({code:'financial_test_grant_required'});
  await db.query('update public.zentra_us_financial_test_grants set enabled=true,version=3 where organization_id=$1',[a.org]);await expect(a.capture(scope)).rejects.toMatchObject({code:'financial_test_grant_changed'});expect(await a.capture()).toMatchObject({scope:{grantVersion:3}});
 });
 it('refuses policy drift and future actors under the same admitted PG locks',async()=>{
  const f=await fixture();await f.enable();await expect(rawHead(f,1,1,capability,{...f.actor,timestamp:new Date(Date.now()+86400000).toISOString()})).rejects.toMatchObject({code:'PF016'});
  await db.query('update public.zentra_us_financial_test_grants set version=2,policy=$2 where organization_id=$1',[f.org,{...f.policy,approval:{...f.policy.approval,reference:'SYNTHETIC changed policy'}}]);await expect(rawHead(f,2)).rejects.toMatchObject({code:'PF007'});
 });
 it('keeps the opt-in private and DB-owner administered despite service row-lock privileges',async()=>{
  const f=await fixture();await f.enable();await expect(sql('update public.zentra_us_financial_pilot_test_opt_ins set version=2 where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF003'});
  await expect(sql('delete from public.zentra_us_financial_pilot_test_opt_ins where organization_id=$1',[f.org])).rejects.toMatchObject({code:'42501'});
  await expect(sql('insert into public.zentra_us_financial_pilot_test_opt_ins values($1,1,true)',[randomUUID()])).rejects.toMatchObject({code:'42501'});
  await expect(db.exec('truncate public.zentra_us_financial_pilot_test_opt_ins')).rejects.toMatchObject({code:'PF003'});
  await expect(db.query('update public.zentra_us_financial_pilot_test_opt_ins set version=3 where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF006'});
  const rows=(await db.query<{name:string;invoker:boolean;anon:boolean;authenticated:boolean;service:boolean}>("select p.proname name,not p.prosecdef invoker,has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') authenticated,has_function_privilege('service_role',p.oid,'execute') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '%financial_pilot_test%' order by p.proname")).rows;
  expect(rows).toHaveLength(7);for(const row of rows)expect(row).toMatchObject({invoker:true,anon:false,authenticated:false,service:true});
 });
 it('retains promoted status when the pilot is closed and fails legacy reads rather than serving baseline',async()=>{
  const f=await fixture();expect(await readUsFinancialPilotPromotionStatus(client,f.org)).toBe(true);await expect(sql('select public.zentra_read_us_erp_v4($1)',[f.org])).rejects.toMatchObject({code:'PU008'});
  const g=await fixture({unpromoted:true});expect(await readUsFinancialPilotPromotionStatus(client,g.org)).toBe(false);
 });
 it('rejects foreign capabilities and non-READ-COMMITTED pilot transactions',async()=>{
  const f=await fixture();await f.enable();await expect(rawHead(f,1,1,'postgres-test-invoicing-v5')).rejects.toMatchObject({code:'PF009'});
  await expect(db.transaction(async tx=>{await tx.exec('set transaction isolation level repeatable read;set local role service_role');return tx.query('select public.zentra_us_financial_pilot_test_head_v1($1,$2,1,1,$3)',[f.org,f.actor,capability]);})).rejects.toMatchObject({code:'PF009'});
 });
 it('serves actual HTTP snapshot/payment/credit/reports from one real PG book to two independent callers',async()=>{
  const f=await fixture();await f.enable();const a=http(f),b=http(f);const initial=await a.handlers.SNAPSHOT(a.request(),f.org);expect(initial.status).toBe(200);const start=await initial.json() as {revision:number};
  const payment=a.payment(start.revision,'100');const submitted=await a.handlers.POST(a.request('',payment),f.org);expect(submitted.status).toBe(200);const receipt=await submitted.json() as {revision:number};expect(receipt.revision).toBe(start.revision+1);
  const secondHead=await b.handlers.HEAD(b.request(),f.org);expect(secondHead.status).toBe(200);expect(await secondHead.json()).toMatchObject({revision:receipt.revision});
  const c=await f.prepare(await f.credit(await f.read()),'synthetic-credited');await f.store().commit(c);
  const snapshot=await b.handlers.SNAPSHOT(b.request(),f.org);expect(snapshot.status).toBe(200);const current=await snapshot.json() as {revision:number;summary:{totalMinor:string;receivedMinor:string;creditedMinor:string;outstandingMinor:string}};
  expect(current.summary).toMatchObject({totalMinor:'29478',receivedMinor:'100',creditedMinor:'9826',outstandingMinor:'19552'});
  const rows=await a.handlers.INVOICES(a.request(`?revision=${current.revision}`),f.org);expect(rows.status).toBe(200);expect(await rows.json()).toMatchObject({revision:current.revision,items:[{receivedMinor:'100',creditedMinor:'9826'}]});
  const detail=await b.handlers.INVOICE(b.request(`?revision=${current.revision}`),f.org,'invoice');expect(detail.status).toBe(200);
  const reports=await a.handlers.REPORTS(a.request(`?revision=${current.revision}&from=${f.day.slice(0,4)}-01-01&to=${f.day.slice(0,4)}-12-31&asOf=${f.day}`),f.org);expect(reports.status).toBe(200);expect(await reports.json()).toMatchObject({revision:current.revision,currentReceivables:{summary:current.summary},trialBalance:{balanced:true}});
  const wire=JSON.stringify([await detail.json(),current]);for(const secret of ['schemaVersion":5','baseline','promotion','policy','taxcalc_','acct_','testtxn_','evidenceReference','idempotencyKey','commandHash','ein'])expect(wire).not.toContain(secret);
 },20000);
 it('returns snapshot_changed between HTTP pages, preserves exact replay and rejects cross-account/native requests',async()=>{
  const f=await fixture();await f.enable();const a=http(f),start=(await f.store().head()).revision,payment=a.payment(start),first=await a.handlers.POST(a.request('',payment),f.org);expect(first.status).toBe(200);
  const stale=await a.handlers.INVOICES(a.request(`?revision=${start}`),f.org);expect(stale.status).toBe(409);expect(await stale.json()).toEqual({error:'financial_snapshot_changed'});
  expect(await(await a.handlers.POST(a.request('',payment),f.org)).json()).toEqual(await first.json());
  a.auth.userId=randomUUID();const changed=await a.handlers.SNAPSHOT(a.request(),f.org);expect(changed.status).toBe(401);
  const device=new Request(a.request(),{headers:{'X-Zentra-Financial-Pilot':'1','X-Zentra-Expected-User':f.user,Authorization:'Bearer synthetic-native'}});expect((await a.handlers.HEAD(device,f.org)).status).toBe(403);
 },20000);
 it('recovers a lost HTTP response after real PG commit without duplicating the payment',async()=>{
  const f=await fixture();await f.enable();let lost=false;const a=http(f,{async rpc<T>(name:string,args:Readonly<Record<string,unknown>>):Promise<T>{const value=await client.rpc<T>(name,args);if(name==='zentra_append_us_financial_pilot_test_v1'&&!lost){lost=true;throw Error('SYNTHETIC response lost after committed SQL');}return value;}});
  const body=a.payment((await f.store().head()).revision,'123');expect((await a.handlers.POST(a.request('',body),f.org)).status).toBe(503);const next=await a.handlers.POST(a.request('',body),f.org);expect(next.status).toBe(200);const view=await projectUsFinancialBookV5(await f.read());expect(view.invoices[0].payments).toHaveLength(1);expect(view.settlements[0].receivedMinor).toBe('123');
 },20000);
 it('rejects HTTP authority/entitlement loss and malformed financial input without PG append',async()=>{
  const f=await fixture();await f.enable();const a=http(f),start=(await f.store().head()).revision,body=a.payment(start);
  const count=()=>result('select count(*)::int result from public.zentra_us_financial_test_events where organization_id=$1',[f.org]);
  const before=await count();for(const command of [{...body.command,amountMinor:'1.00'},{...body.command,taxProof:{secret:true}},{...body.command,actor:f.actor}])expect((await a.handlers.POST(a.request('',{...body,command}),f.org)).status).toBe(422);
  a.auth.entitled=false;expect((await a.handlers.SNAPSHOT(a.request(),f.org)).status).toBe(402);a.auth.entitled=true;a.auth.role='member';expect((await a.handlers.HEAD(a.request(),f.org)).status).toBe(403);expect(await count()).toBe(before);
 },20000);
 it('connects two cookie-bound client sessions over a real local HTTP socket to the same PG book',async()=>{
  const f=await fixture();await f.enable();const a=http(f),b=http(f);let origin='';const observed:string[]=[];
  // Cookies below model two admitted Auth/D1 sessions explicitly; they are not
  // real credentials. Browser transport, HTTP socket, handlers and PG are real.
  const server=createServer((incoming,outgoing)=>{void(async()=>{
   const selected=incoming.headers.cookie==='synthetic-session=A'?a:incoming.headers.cookie==='synthetic-session=B'?b:null;
   if(!selected){outgoing.writeHead(401,{'Content-Type':'application/json'});outgoing.end('{"error":"unauthorized"}');return;}
   const chunks:Buffer[]=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk));
   const headers=new Headers();for(const [key,value]of Object.entries(incoming.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
   const request=new Request(new URL(incoming.url??'/',origin),{method:incoming.method,headers,...(incoming.method==='POST'?{body:Buffer.concat(chunks)}:{})});
   const path=new URL(request.url).pathname.split('/').at(-1);observed.push(`${incoming.headers.cookie}:${path}`);
   const response=path==='head'?await selected.handlers.HEAD(request,f.org):path==='snapshot'?await selected.handlers.SNAPSHOT(request,f.org):path==='operations'?await selected.handlers.POST(request,f.org):path==='reports'?await selected.handlers.REPORTS(request,f.org):new Response(null,{status:404});
   outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
  })().catch(error=>{outgoing.writeHead(500,{'Content-Type':'application/json'});outgoing.end(JSON.stringify({error:error instanceof Error?'synthetic_socket_failure':'synthetic_unknown'}));});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('Synthetic HTTP socket unavailable');origin=`http://127.0.0.1:${address.port}`;
  const fetcher=(cookie:string):typeof fetch=>async(input,init)=>{const headers=new Headers(init?.headers);headers.set('Cookie',cookie);if(init?.method==='POST')headers.set('Origin',origin);const path=typeof input==='string'?input:input instanceof URL?input.href:input.url;return fetch(new URL(path,origin),{...init,headers});};
  const environment={isVisible:()=>true,isOnline:()=>true,subscribe:()=>()=>{}};
  const first=createBrowserUsFinancialPilotSession({organizationId:f.org,expectedUserId:f.user,fetch:fetcher('synthetic-session=A'),environment}),second=createBrowserUsFinancialPilotSession({organizationId:f.org,expectedUserId:f.user,fetch:fetcher('synthetic-session=B'),environment});
  try{
   const initial=await first.load();expect((await second.load()).revision).toBe(initial.revision);
   await first.recordPayment({type:'customer_payment',invoiceId:'invoice',amountMinor:'111',paymentDate:f.day,accountingDate:f.day,periodId:'year',reference:'SYNTHETIC socket payment — no transfer'},initial.revision);
   await second.refresh();expect(second.getState().snapshot?.summary).toMatchObject({receivedMinor:'111',creditedMinor:'0',outstandingMinor:'29367'});
   const credit=await f.prepare(await f.credit(await f.read()),'socket-credit');await f.store().commit(credit);await second.refresh();expect(second.getState().snapshot?.summary).toMatchObject({receivedMinor:'111',creditedMinor:'9826',outstandingMinor:'19541'});
   const rev=second.getState().snapshot!.revision;expect((await second.readReports({revision:rev,from:`${f.day.slice(0,4)}-01-01`,to:`${f.day.slice(0,4)}-12-31`,asOf:f.day})).currentReceivables.summary).toEqual(second.getState().snapshot?.summary);
   expect(observed).toContain('synthetic-session=A:operations');expect(observed.filter(item=>item==='synthetic-session=B:head')).toHaveLength(2);expect(observed.filter(item=>item==='synthetic-session=B:snapshot')).toHaveLength(3);
  }finally{first.dispose();second.dispose();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
 },20000);
 it('persists the admitted private scope, exact book, receipts and head across clean NodeFS close/reopen',async()=>{
  const f=await fixture();await f.enable();const c=await f.prepare(f.payment('99'),'reopen-payment');await f.store().commit(c);const before=await f.read(),head=await f.store().head();await db.close();db=new PGlite(dataDir);
  expect(await f.read()).toEqual(before);expect(await f.store().head()).toEqual(head);expect(await f.store().receipt(f.org,c.receipt.idempotencyKey)).toEqual(c.receipt);console.info(`Retained synthetic PostgreSQL dataDir: ${dataDir}`);
 });
});
