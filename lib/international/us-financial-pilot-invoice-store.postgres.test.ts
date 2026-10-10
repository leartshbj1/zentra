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
import type { UsFinancialCommitV5, UsFinancialReceiptV5 } from './us-financial-kernel-runtime';
import { createSupabaseUsFinancialTestFoundationV5 } from './us-financial-test-foundation';
import { createSupabaseUsFinancialPilotStore, readUsFinancialPilotScope, type UsFinancialPilotScope } from './us-financial-pilot-store';

import { createUsFinancialPilotCommercialHandlers } from './us-financial-pilot-commercial-server';

import { validateUsFinancialPilotCommercialReceipt, type UsFinancialPilotCommercialRequest } from './us-financial-pilot-commercial';
import { createUsFinancialPilotInvoiceHandlers, type UsFinancialPilotInvoiceDependencies } from './us-financial-pilot-invoice-server';
import { createSupabaseUsFinancialPilotInvoiceStore } from './us-financial-pilot-invoice-store';
import { validateUsFinancialInvoiceContextV5 } from './us-financial-invoice-test';
import { validateUsFinancialPilotInvoicePreview, type UsFinancialPilotInvoiceRequest } from './us-financial-pilot-invoice';
import { STRIPE_TAX_API_VERSION, type ResolvedStripeTaxRequest } from './stripe-tax-resolved-request';
import type { StripeTaxCalculationObservation } from './stripe-tax-calculation';


// Actual 33 migrations, SQL and pilot HTTP handlers on retained NodeFS.
// Auth/D1 and all fiscal
// observations are explicitly synthetic. No provider/network calls. Serialized
// PGlite proves neither multi-connection races, crash recovery nor hosted SLA.
const directory=process.env.PGLITE_MODULE_DIR,enabled=Boolean(directory&&isAbsolute(directory));
type Sql={exec(sql:string):Promise<unknown>;query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[]}>};
type Db=Sql&{close():Promise<void>;transaction<T>(task:(tx:Sql)=>Promise<T>):Promise<T>};
let db!:Db;let PGlite:new(dataDir?:string)=>Db,dataDir:string;
const migration='20261010104148_international_us_financial_pilot_dto1';
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
async function fixture(options:{tax?:string;quantity?:string;scale?:number;discount?:number;unitPrice?:string;lines?:number;paid?:string;paymentCount?:number;closed?:boolean;laterOpen?:boolean;periodCount?:number;unpromoted?:boolean;activeOrder?:boolean;confirmedOrder?:boolean;pendingTax?:boolean;shortPeriod?:boolean;projects?:boolean;baselinePurchases?:boolean;collisionId?:string}={}){
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
 await send({type:'save_estimate',id:'quote',expectedEstimateRevision:0,customerId:'customer',date:day,expiresAt:`${year}-12-31`,paymentTermsDays:30,notes:'Synthetic local-only terms · Genève · Zürich',lines});await send({type:'accept_estimate',estimateId:'quote',expectedEstimateRevision:1});
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
 for(let i=0;i<(options.paymentCount??0);i++)await send({type:'record_payment',id:`baseline-history-${i}`,invoiceId:'invoice',amountMinor:'1',paymentDate:day,accountingDate:day,periodId:'year',reference:`Synthetic baseline receipt ${i}, no money moved`});

 if(options.baselinePurchases){
  await send({type:'save_vendor',vendor:{id:'vendor',organizationId:org,kind:'business',name:'Synthetic vendor — local tests',billingAddress:config.address,paymentTermsDays:30}});
  await send({type:'record_vendor_bill',id:'bill',vendorId:'vendor',reference:'Synthetic historical supplier bill',date:day,accountingDate:day,dueDate:day,periodId:'year',netMinor:'100',purchaseTaxMinor:'7',expenseAccountId:'purchases',sourceReference:'Synthetic declared original'});
  await send({type:'record_vendor_payment',id:'baseline-vendor-payment',billId:'bill',amountMinor:'50',paymentDate:day,accountingDate:day,periodId:'year',reference:'Synthetic declared payment'});
 }
 if(options.activeOrder){
  await send({type:'save_estimate',id:'ordered-quote',expectedEstimateRevision:0,customerId:'customer',date:day,expiresAt:day,paymentTermsDays:30,notes:'Synthetic locked source',lines});
  await send({type:'accept_estimate',estimateId:'ordered-quote',expectedEstimateRevision:1});
  const request={schemaVersion:1,idempotencyKey:'synthetic-sales-order',orderId:randomUUID(),expectedErpRevision:(await erp.read(org))!.revision,expectedHeadRevision:0,expectedOrderRevision:null,command:{type:'create_from_estimate',estimateId:'ordered-quote',expectedEstimateRevision:2,orderDate:day,customerReference:null}};
  await sql('select public.zentra_execute_us_sales_order($1,$2,4,$3,$4)',[org,{...actor,timestamp:new Date().toISOString()},request,hash(canonicalErpJson([org,user,request]))]);
 }
 if(options.collisionId)await send({type:'save_customer',customer:{id:options.collisionId,organizationId:org,kind:'business',name:'Synthetic existing legacy customer — preserve me',billingAddress:config.address,paymentTermsDays:15}});
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
 const credit=async(before:UsFinancialBookV5,invoiceId='invoice',transactionDate=day,periodId='year'):Promise<Extract<UsFinancialOperationV5,{type:'customer_credit'}>>=>{
  refresh();const input:UsFinancialCreditInputV5={type:'customer_credit',idempotencyKey:randomUUID(),invoiceId,transactionDate,accountingDate:transactionDate,periodId,reason:'SYNTHETIC correction only',selections:[{lineId:'line-0',quantityUnits:'1'}]},candidate=await buildUsFinancialCreditCandidateV5(before,input);
  const proof:UsFinancialTaxProofV5={schemaVersion:1,environment:'test',kind:'test_adjustment_authorization',invoiceFingerprint:candidate.invoiceFingerprint,allocationSha256:candidate.allocationSha256,reference:'SYNTHETIC no provider reversal',verifiedBy:'synthetic-reviewer',verifiedAt:actor.timestamp,providerAccountReference:'acct_SyntheticSettlement',originalTaxTransactionReference:`testtxn_Synthetic_${invoiceId}`,adjustmentPlanReference:`synthetic-plan-${input.idempotencyKey}`,authorizedTaxMinor:candidate.allocation.taxMinor};
  await db.query('insert into public.zentra_us_financial_test_tax_plans values($1,$2,$3,$4)',[org,input.idempotencyKey,input.invoiceId,proof]);return{...input,taxProof:proof};
 };
 return{org,user,config,get actor(){return actor;},refresh,day,policy,scope,baseline,initial,foundation,enable,capture,store,read,payment,prepare,credit,get pilotScope(){return pilotScope;}};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const invoiceMigration = '20261010131903_international_us_financial_pilot_invoice_dto1';
const invoiceRpcParameters: Record<string, readonly string[]> = {
  zentra_us_financial_pilot_invoice_test_context_v1: [],
  zentra_read_us_financial_pilot_invoice_test_operation_v1: ['p_idempotency_key', 'p_financial_command_hash', 'p_erp_command_hash'],
  zentra_preflight_us_financial_pilot_invoice_test_v1: ['p_request', 'p_financial_command_hash', 'p_erp_command_hash', 'p_previous_fingerprint'],
  zentra_reserve_us_financial_pilot_invoice_test_v1: ['p_preparation', 'p_resolved_body', 'p_resolved_sha256', 'p_params_body', 'p_params_sha256', 'p_provider_idempotency_key'],
  zentra_record_us_financial_pilot_invoice_test_calculation_v1: ['p_operation_id', 'p_proof_body', 'p_proof_sha256', 'p_assessment'],
};
for (const [name, fields] of Object.entries(invoiceRpcParameters)) parameters[name] = ['p_organization', 'p_actor', 'p_grant_version', 'p_opt_in_version', 'p_capability', ...fields];

async function invoiceContext(f: Fixture) {
  const stamp = new Date(), binding: StripeTaxTestBinding = { organizationId: f.org, accountId: 'acct_SyntheticSettlement', mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, revision: 1,
    settingsSha256: hash('synthetic-settings'), registrationsSha256: hash('synthetic-registrations'), observedAt: new Date(stamp.getTime() - 1000).toISOString(), validUntil: new Date(stamp.getTime() + 119000).toISOString(), evidenceKind: 'test_fixture', scope: 'erp_invoice_tax' };
  const seller = (await sql<{ profile: unknown }>('select profile from public.zentra_us_seller_profiles where organization_id=$1', [f.org]))[0].profile;
  const taxFacts = (await sql<{ facts: unknown }>('select facts from public.zentra_us_tax_profiles where organization_id=$1', [f.org]))[0].facts;
  const payload = { schemaVersion: 1, organizationId: f.org, revision: 1, countryRevision: 2, configuration: f.config, sellerRevision: 1, seller, taxFactsRevision: 1, taxFacts, binding,
    merchant: { credential: { reference: 'SYNTHETIC-NO-SECRET', revision: 1, accountId: binding.accountId }, configurationFingerprint: hash('SYNTHETIC-LOCAL-CREDENTIAL-IDENTITY') }, admittedBy: 'Synthetic DB owner, no provider identity claim', admittedAt: stamp.toISOString() };
  const value = await validateUsFinancialInvoiceContextV5({ ...payload, contextSha256: hash(canonicalErpJson(payload)) }, f.org, true);
  await db.query('insert into public.zentra_us_financial_invoice_test_contexts values($1,$2,$3)', [f.org, 1, value]); return value;
}
function observation(r: ResolvedStripeTaxRequest, now: string): StripeTaxCalculationObservation {
  const line = r.params.line_items[0], tax = 2475;
  return { accountId: r.binding.accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, evidenceKind: 'test_fixture', observedAt: now,
    calculation: { id: 'taxcalc_SyntheticV5', object: 'tax.calculation', amount_total: line.amount + tax, currency: 'usd', customer: null,
      customer_details: { address: { ...r.params.customer_details.address, line2: null }, address_source: r.params.customer_details.address_source, ip_address: null, tax_ids: [], taxability_override: 'none' },
      expires_at: Math.floor(Date.parse(now) / 1000) + 3600, tax_date: r.params.tax_date, livemode: false, shipping_cost: null, ship_from_details: null, tax_amount_exclusive: tax, tax_amount_inclusive: 0,
      line_items: { object: 'list', has_more: false, url: '/v1/tax/calculations/taxcalc_SyntheticV5/line_items', data: [{ id: 'tax_li_SyntheticV5', object: 'tax.calculation_line_item', amount: line.amount, amount_tax: tax, quantity: line.quantity, reference: line.reference, tax_code: line.tax_code, tax_behavior: 'exclusive', livemode: false, product: null,
        tax_breakdown: [{ amount: tax, taxable_amount: line.amount, taxability_reason: 'standard_rated', sourcing: 'destination', jurisdiction: { country: 'US', state: 'NY', level: 'state', display_name: 'Synthetic jurisdiction' }, tax_rate_details: { tax_type: 'sales_tax', display_name: 'Synthetic tax', percentage_decimal: '8.25' } }] }] },
      tax_breakdown: [{ amount: tax, taxable_amount: line.amount, taxability_reason: 'standard_rated', inclusive: false, tax_rate_details: { country: 'US', state: 'NY', tax_type: 'sales_tax', percentage_decimal: '8.25', rate_type: 'percentage', flat_amount: null } }],
    } };
}
async function httpFixture() {
  const f = await fixture(); await f.enable(); const context = await invoiceContext(f);
  let calculations = 0, merchantEnabled = true;
  const merchant = { ...context.merchant, observe: async () => { throw Error('No context provisioning'); }, gateway: { verify: async () => {}, calculate: async (r: ResolvedStripeTaxRequest) => { calculations++; return observation(r, new Date().toISOString()); } },
    catalogue: { readTaxCode: async (id: string) => ({ id, name: 'Synthetic service', description: 'Synthetic test catalogue only' }), listTaxCodes: async () => ({ taxCodes: [{ id: 'txcd_10000000', name: 'Synthetic service', description: 'Synthetic test catalogue only' }], hasMore: false, nextCursor: null }) } };
  const deps: UsFinancialPilotInvoiceDependencies = { enabled: () => true, authority: async () => ({ mode: 'browser', actor: f.refresh() }), configuration: async () => f.config,
    scope: (actor, expected) => readUsFinancialPilotScope(client, actor, expected), store: (scope, revalidate) => createSupabaseUsFinancialPilotStore(client, scope, revalidate),
    invoiceStore: (scope, revalidate) => createSupabaseUsFinancialPilotInvoiceStore(client, scope, revalidate, { allowTestFixtures: true }), merchant: async () => merchantEnabled ? merchant : null,
    operationId: randomUUID, now: () => new Date().toISOString(), allowTestFixtures: true, rateLimit: async () => {}, diagnostic: () => {} };
  const request = (path: string, body?: unknown) => new Request(`https://synthetic.example.test/api/international/workspaces/${f.org}/financial-pilot/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Sec-Fetch-Site': 'same-origin', Origin: 'https://synthetic.example.test', 'Content-Type': 'application/json', 'X-Zentra-Financial-Pilot': '1', 'X-Zentra-Expected-User': f.user }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const commercial = createUsFinancialPilotCommercialHandlers(deps);
  const quoteRequest: UsFinancialPilotCommercialRequest = { consumer: 'financial-pilot', schemaVersion: 1, requestId: randomUUID(), expectedRevision: (await f.read()).revision,
    command: { type: 'save_estimate', estimateId: null, expectedEstimateRevision: 0, customerId: 'customer', projectId: null, date: f.day, expiresAt: f.day, paymentTermsDays: 30,
      lines: [{ id: null, description: 'Synthetic invoice path', quantityUnits: '3', quantityScale: 0, unitPriceMinor: '10001', discountBasisPoints: 1000, taxTreatment: 'taxable' }], notes: 'Synthetic local invoice terms' } };
  const quoteResponse = await commercial.POST(request('commercial/operations', quoteRequest), f.org); expect(quoteResponse.status).toBe(200);
  const quoteReceipt = validateUsFinancialPilotCommercialReceipt(await quoteResponse.json(), f.org, quoteRequest);
  const acceptance: UsFinancialPilotCommercialRequest = { consumer: 'financial-pilot', schemaVersion: 1, requestId: randomUUID(), expectedRevision: quoteReceipt.revision, command: { type: 'accept_estimate', estimateId: quoteReceipt.entityId, expectedEstimateRevision: 1 } };
  expect((await commercial.POST(request('commercial/operations', acceptance), f.org)).status).toBe(200);
  const current = await projectUsFinancialBookV5(await f.read()), quote = current.estimates.find(e => e.id === quoteReceipt.entityId)!;
  const selected: UsFinancialPilotInvoiceRequest = { consumer: 'financial-pilot', schemaVersion: 1, requestId: randomUUID(), expectedRevision: current.revision,
    command: { type: 'issue_invoice', estimateId: quote.id, expectedEstimateRevision: quote.revision, date: f.day, accountingDate: f.day, dueDate: f.day, periodId: 'year' },
    choices: { classifications: quote.lines.map(l => ({ lineId: l.id, taxCode: 'txcd_10000000', confirmedService: true })), taxDateInstant: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), addressSource: 'billing' } };
  return { f, context, deps, request, selected, handlers: () => createUsFinancialPilotInvoiceHandlers(deps), get calculations() { return calculations; }, closeMerchant() { merchantEnabled = false; } };
}

describe.skipIf(!enabled)('pilot invoice HTTP and opt-in wrappers — actual local PostgreSQL, synthetic Auth/tax provider', () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url); ({ PGlite } = require(join(directory!, 'dist/index.cjs')) as { PGlite: new(dataDir?: string) => Db });
    dataDir = await mkdtemp(join(tmpdir(), 'zentra-financial-pilot-invoice-')); db = new PGlite(dataDir);
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    for (const name of [...migrations, migration, invoiceMigration]) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
  }, 30000);
  afterAll(async () => { await db?.close(); });
  it('prepares from the current accepted quote, reviews tax, issues and replays after a later payment on one book', async () => {
    expect([...migrations, migration, invoiceMigration]).toHaveLength(33);
    const t = await httpFixture(), before = await t.f.read(), response = await t.handlers().PREPARE(t.request('invoices/prepare', t.selected), t.f.org);
    expect(response.status).toBe(200); const preview = validateUsFinancialPilotInvoicePreview(await response.json(), t.f.org, t.selected);
    expect(await t.f.read()).toEqual(before); expect(t.calculations).toBe(1); expect(preview).toMatchObject({ netMinor: '27003', taxMinor: '2475', totalMinor: '29478', financialStatus: 'not_issued' });
    const issueBody = { request: t.selected, reviewId: preview.reviewId }, issued = await t.handlers().ISSUE(t.request('invoices/issue', issueBody), t.f.org);
    expect(issued.status).toBe(200); const receipt = await issued.json(), view = await projectUsFinancialBookV5(await t.f.read());
    expect(view.invoices).toHaveLength(2); expect(view.invoices[1].number).toBe('SYNTHETIC-000002'); expect(view.invoices[1].total.minorUnits).toBe('29478');
    const payment = await t.f.prepare(t.f.payment('100')); await t.f.store().commit(payment); t.closeMerchant();
    const replay = await t.handlers().ISSUE(t.request('invoices/issue', issueBody), t.f.org); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(receipt); expect(t.calculations).toBe(1);
    const retained = await t.f.read(); await db.close(); db = new PGlite(dataDir); expect(await t.f.read()).toEqual(retained);
    expect((await t.handlers().ISSUE(t.request('invoices/issue', issueBody), t.f.org)).status).toBe(200);
    console.info('Retained synthetic PostgreSQL invoice dataDir: ' + dataDir);
  }, 30000);
  it.each(Object.keys(invoiceRpcParameters))('checks wrong opt-in and revoked opt-in before every %s fiscal operation', async name => {
    const f = await fixture(); await f.enable();
    const args: Record<string, unknown> = { p_organization: f.org, p_actor: f.refresh(), p_grant_version: 1, p_opt_in_version: 2, p_capability: 'postgres-test-financial-pilot-dto1',
      p_idempotency_key: 'synthetic', p_financial_command_hash: '0'.repeat(64), p_erp_command_hash: '0'.repeat(64), p_previous_fingerprint: '0'.repeat(64), p_operation_id: randomUUID(),
      p_request: {}, p_preparation: {}, p_resolved_body: '{}', p_resolved_sha256: '0'.repeat(64), p_params_body: '{}', p_params_sha256: '0'.repeat(64), p_provider_idempotency_key: 'synthetic', p_proof_body: '{}', p_proof_sha256: '0'.repeat(64), p_assessment: {} };
    await expect(client.rpc(name, args)).rejects.toMatchObject({ code: 'PF006' });
    await db.query('update public.zentra_us_financial_pilot_test_opt_ins set enabled=false,version=2 where organization_id=$1', [f.org]);
    await expect(client.rpc(name, args)).rejects.toMatchObject({ code: 'PF005' });
    const count = (await db.query<{ count: number }>('select count(*)::int count from public.zentra_us_financial_invoice_test_operations where organization_id=$1', [f.org])).rows[0].count; expect(count).toBe(0);
  });
  it('keeps new fiscal RPCs invoker-only and unavailable to browser roles', async () => {
    for (const name of Object.keys(invoiceRpcParameters)) {
      const flags = (await db.query<{ prosecdef: boolean; proconfig: string[] }>('select prosecdef,proconfig from pg_proc where proname=$1', [name])).rows[0]; expect(flags.prosecdef).toBe(false); expect(flags.proconfig).toContain('search_path=""');
      for (const role of ['anon', 'authenticated']) expect((await db.query<{ allowed: boolean }>('select has_function_privilege($1,oid,\'EXECUTE\') allowed from pg_proc where proname=$2', [role, name])).rows[0].allowed).toBe(false);
    }
  });
  it('refuses changed historical choices after actual SQL commit without another calculation or event', async () => {
    const t = await httpFixture(), preparation = await t.handlers().PREPARE(t.request('invoices/prepare', t.selected), t.f.org); expect(preparation.status).toBe(200); const preview = validateUsFinancialPilotInvoicePreview(await preparation.json());
    expect((await t.handlers().ISSUE(t.request('invoices/issue', { request: t.selected, reviewId: preview.reviewId }), t.f.org)).status).toBe(200); const before = await t.f.read();
    const changed = { ...t.selected, choices: { ...t.selected.choices, taxDateInstant: new Date(Date.parse(t.selected.choices.taxDateInstant) + 1000).toISOString() } };
    const response = await t.handlers().ISSUE(t.request('invoices/issue', { request: changed, reviewId: preview.reviewId }), t.f.org); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'tax_preparation_conflict' }); expect(await t.f.read()).toEqual(before); expect(t.calculations).toBe(1);
  });
});


