import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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
async function fixture(options:{tax?:string;quantity?:string;scale?:number;discount?:number;unitPrice?:string;lines?:number;paid?:string;paymentCount?:number;closed?:boolean;laterOpen?:boolean;periodCount?:number;unpromoted?:boolean;activeOrder?:boolean;confirmedOrder?:boolean;pendingTax?:boolean;shortPeriod?:boolean;projects?:boolean;baselinePurchases?:boolean;collisionId?:string;purchasePaging?:boolean;journalPaging?:boolean}={}){
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
 if(options.purchasePaging){
  await send({type:'save_vendor',vendor:{id:'paging-vendor',organizationId:org,kind:'business',name:'Synthetic pagination supplier',billingAddress:config.address,paymentTermsDays:30}});
  for(let i=0;i<26;i++)await send({type:'record_vendor_bill',id:'paging-bill-'+i,vendorId:'paging-vendor',reference:'Synthetic pagination original '+i,date:day,accountingDate:day,dueDate:day,periodId:'year',netMinor:'10000',purchaseTaxMinor:'725',expenseAccountId:'purchases',sourceReference:'Synthetic manual original note'});
  for(let i=0;i<26;i++)await send({type:'record_vendor_payment',id:'paging-payment-'+i,billId:'paging-bill-0',amountMinor:'1',paymentDate:day,accountingDate:day,periodId:'year',reference:'Synthetic already-made paging payment '+i});
 }
 if(options.activeOrder){
  await send({type:'save_estimate',id:'ordered-quote',expectedEstimateRevision:0,customerId:'customer',date:day,expiresAt:day,paymentTermsDays:30,notes:'Synthetic locked source',lines});
  await send({type:'accept_estimate',estimateId:'ordered-quote',expectedEstimateRevision:1});
  const request={schemaVersion:1,idempotencyKey:'synthetic-sales-order',orderId:randomUUID(),expectedErpRevision:(await erp.read(org))!.revision,expectedHeadRevision:0,expectedOrderRevision:null,command:{type:'create_from_estimate',estimateId:'ordered-quote',expectedEstimateRevision:2,orderDate:day,customerReference:null}};
  await sql('select public.zentra_execute_us_sales_order($1,$2,4,$3,$4)',[org,{...actor,timestamp:new Date().toISOString()},request,hash(canonicalErpJson([org,user,request]))]);
 }
 if(options.collisionId)await send({type:'post_manual_journal',id:options.collisionId,transactionDate:day,accountingDate:day,periodId:'year',description:'Synthetic legacy journal collision',sourceReference:'Preserve legacy original',lines:[{accountId:'purchases',debitMinor:'1',creditMinor:'0'},{accountId:'equity',debitMinor:'0',creditMinor:'1'}]});
 if(options.journalPaging)for(let i=0;i<26;i++)await send({type:'post_manual_journal',id:'paging-journal-'+i,transactionDate:day,accountingDate:day,periodId:'year',description:'Synthetic historic manual journal '+i,sourceReference:'Declared historic source '+i,lines:Array.from({length:i===0?28:2},(_,ordinal)=>({accountId:ordinal%2===0?'purchases':'equity',debitMinor:ordinal%2===0?'1':'0',creditMinor:ordinal%2===0?'0':'1',description:'Synthetic historic line '+ordinal}))});
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
async function httpFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options); await f.enable(); const context = await invoiceContext(f);
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

import { createUsFinancialPilotAccountingHandlers } from './us-financial-pilot-accounting-server';
import { buildUsFinancialPilotAccountingRequest, validateUsFinancialPilotAccountingReceipt, usFinancialPilotAccountingEntityId, type UsFinancialPilotAccountingRequest, type UsFinancialPilotAccountingCommand } from './us-financial-pilot-accounting';
import { validateUsFinancialPilotAccountingContext, validateUsFinancialPilotJournalDetail, validateUsFinancialPilotPeriodDetail, financialPilotJournalLinesCursor } from './us-financial-pilot-accounting-projection';
import { createUsFinancialPilotPurchasingHandlers } from './us-financial-pilot-purchasing-server';
import { validateUsFinancialPilotPurchasingReceipt, type UsFinancialPilotPurchasingRequest } from './us-financial-pilot-purchasing';
import { createUsFinancialPilotHandlers, type UsFinancialPilotDependencies } from './us-financial-pilot-server';
import { executeUsFinancialKernelV5 } from './us-financial-kernel-runtime';
import { projectUsFinancialPilotReports } from './us-financial-pilot-reports';
import { buildUsFinancialPilotExportSnapshot } from './us-financial-pilot-export-projection';

const privateTables = ['zentra_us_financial_test_heads', 'zentra_us_financial_test_events', 'zentra_us_financial_test_receipts', 'zentra_us_financial_test_cursors', 'zentra_us_financial_test_tax_plans', 'zentra_us_financial_invoice_test_preparations', 'zentra_us_financial_invoice_test_operations', 'zentra_us_tax_operations'];
async function state(f: Fixture) { const rows = []; for (const table of privateTables) rows.push(await sql(`select to_jsonb(t) record from public.${table} t where organization_id=$1 order by to_jsonb(t)::text`, [f.org])); return canonicalErpJson(rows); }
function http(f: Fixture, overrides: Partial<UsFinancialPilotDependencies> = {}) {
  const auth = { userId: f.user, role: 'owner' as FinancialAuthority['role'], entitled: true };
  const deps: UsFinancialPilotDependencies = { enabled: () => true, authority: async (_request, org) => { if (org !== f.org) throw new ErpError('tenant_mismatch', 403); return { mode: 'browser', actor: { ...f.refresh(), userId: auth.userId, role: auth.role, managementEntitled: auth.entitled } }; }, configuration: async () => f.config, scope: (actor, expected) => readUsFinancialPilotScope(client, actor, expected), store: (scope, revalidate) => createSupabaseUsFinancialPilotStore(client, scope, revalidate), rateLimit: async () => {}, diagnostic: () => {}, ...overrides };
  const accounting = createUsFinancialPilotAccountingHandlers(deps), purchasing = createUsFinancialPilotPurchasingHandlers(deps), pilot = createUsFinancialPilotHandlers(deps);
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`https://synthetic.example.test/api/international/workspaces/${f.org}/financial-pilot/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Sec-Fetch-Site': 'same-origin', Origin: 'https://synthetic.example.test', 'Content-Type': 'application/json', 'X-Zentra-Financial-Pilot': '1', 'X-Zentra-Expected-User': f.user, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const post = (input: UsFinancialPilotAccountingRequest) => accounting.POST(request('accounting/operations', input), f.org);
  const context = (revision: number) => accounting.CONTEXT(request(`accounting/context?revision=${revision}`), f.org);
  const journal = (journalRevision: number, revision: number, cursor?: string) => accounting.JOURNAL(request(`journals/${journalRevision}?revision=${revision}${cursor ? '&lineCursor=' + encodeURIComponent(cursor) : ''}`), f.org, String(journalRevision));
  const period = (periodId: string, revision: number) => accounting.PERIOD(request(`periods/${encodeURIComponent(periodId)}?revision=${revision}`), f.org, periodId);
  return { auth, deps, accounting, purchasing, pilot, request, post, context, journal, period };
}
const envelope = (revision: number, command: UsFinancialPilotAccountingCommand, requestId = randomUUID()): UsFinancialPilotAccountingRequest => ({ consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision: revision, command });
function journal(f: Fixture, fields: Partial<Extract<UsFinancialPilotAccountingCommand, { type: 'post_manual_journal' }>> = {}): Extract<UsFinancialPilotAccountingCommand, { type: 'post_manual_journal' }> { return { type: 'post_manual_journal', transactionDate: `${f.day.slice(0, 4)}-01-01`, accountingDate: f.day, periodId: 'year', description: 'Synthetic declared cash contribution', sourceReference: 'Synthetic manual original reference', lines: [{ accountId: 'cash', debitMinor: '9007199254740993', creditMinor: '0', description: 'Exact synthetic amount' }, { accountId: 'equity', debitMinor: '0', creditMinor: '9007199254740993' }], cashFlowCategory: 'financing', ...fields }; }
const reversal = (f: Fixture, journalRevision: number): UsFinancialPilotAccountingCommand => ({ type: 'reverse_manual_journal', journalRevision, transactionDate: `${f.day.slice(0, 4)}-01-01`, accountingDate: f.day, periodId: 'year', reason: 'Synthetic reversal; no external transaction' });
async function receipt(response: Response, f: Fixture, input: UsFinancialPilotAccountingRequest) { expect(response.status).toBe(200); return validateUsFinancialPilotAccountingReceipt(await response.json(), f.org, input); }
async function submit(f: Fixture, command: UsFinancialPilotAccountingCommand, h = http(f)) { const input = envelope((await f.read()).revision, command); return receipt(await h.post(input), f, input); }
async function internal(f: Fixture, command: ErpCommand) { return executeUsFinancialKernelV5({ configuration: f.config, actor: f.refresh(), policy: f.policy, store: f.store(), resolveTax: async () => { throw Error('No accounting provider'); }, revalidate: async () => ({ configuration: f.config, actor: f.refresh(), policy: f.policy }) }, { idempotencyKey: 'synthetic-internal-' + randomUUID(), expectedRevision: (await f.read()).revision, command: { type: 'erp_command', request: command } }); }
async function issue(t: Awaited<ReturnType<typeof httpFixture>>) { const prepared = await t.handlers().PREPARE(t.request('invoices/prepare', t.selected), t.f.org); expect(prepared.status).toBe(200); const preview = validateUsFinancialPilotInvoicePreview(await prepared.json(), t.f.org, t.selected); expect((await t.handlers().ISSUE(t.request('invoices/issue', { request: t.selected, reviewId: preview.reviewId }), t.f.org)).status).toBe(200); }
async function mixedExports(book: UsFinancialBookV5, from: string, to: string) {
  return Promise.all([
    buildUsFinancialPilotExportSnapshot(book, { format: 'csv', kind: 'report', reportType: 'trial_balance', revision: book.revision, language: 'en', asOf: to }),
    buildUsFinancialPilotExportSnapshot(book, { format: 'csv', kind: 'report', reportType: 'general_ledger', revision: book.revision, language: 'en', from, to, accountId: 'cash' }),
    buildUsFinancialPilotExportSnapshot(book, { format: 'csv', kind: 'report', reportType: 'cash_flow', revision: book.revision, language: 'en', from, to }),
    buildUsFinancialPilotExportSnapshot(book, { format: 'csv', kind: 'report', reportType: 'balance_sheet', revision: book.revision, language: 'en', asOf: to }),
    buildUsFinancialPilotExportSnapshot(book, { format: 'csv', kind: 'report', reportType: 'profit_loss', revision: book.revision, language: 'en', from, to }),
  ]);
}
let retained: { f: Fixture; book: UsFinancialBookV5; requests: UsFinancialPilotAccountingRequest[]; originalRevision: number; reports: unknown; exports: unknown; detail: unknown } | undefined;

describe.skipIf(!enabled)('accounting HTTP and sole cumulative pilot store — actual local PostgreSQL', () => {
  beforeAll(async () => { const require = createRequire(import.meta.url); ({ PGlite } = require(join(directory!, 'dist/index.cjs')) as { PGlite: new(dataDir?: string) => Db }); dataDir = await mkdtemp(join(tmpdir(), 'zentra-financial-pilot-accounting-')); db = new PGlite(dataDir); await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;'); for (const name of [...migrations, migration, invoiceMigration]) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8')); }, 30000);
  afterAll(async () => { await db?.close(); });

  it('continues real invoice V5, commerce, credits, customer/vendor payments through journal/reverse/close/open and new-period purchasing', async () => {
    expect([...migrations, migration, invoiceMigration]).toHaveLength(33);
    const t = await httpFixture({ baselinePurchases: true }), f = t.f; await issue(t); const h = http(f), immutableBaseline = canonicalErpJson(f.initial);
    await f.store().commit(await f.prepare(await f.credit(await f.read()))); await f.store().commit(await f.prepare(f.payment('100')));
    const before = await projectUsFinancialBookV5(await f.read()), counters = canonicalErpJson(before.counters), invoices = canonicalErpJson(before.invoices), post = envelope(before.revision, journal(f));
    const posted = await receipt(await h.post(post), f, post), sourceView = await projectUsFinancialBookV5(await f.read()), original = sourceView.ledger.entries.find(e => e.id === posted.entityId)!;
    expect(original.revision).not.toBe(posted.revision); expect(sourceView.credits).toHaveLength(1); expect(sourceView.invoices.find(i => i.id === 'invoice')!.payments).toHaveLength(1); expect(sourceView.vendorPayments).toHaveLength(1); expect(sourceView.invoices).toHaveLength(2);
    const snapshot = canonicalErpJson(original), reverse = envelope(posted.revision, reversal(f, original.revision)), reversed = await receipt(await h.post(reverse), f, reverse), close = envelope(reversed.revision, { type: 'close_period', periodId: 'year' }); await receipt(await h.post(close), f, close);
    const year = Number(f.day.slice(0, 4)) + 1, open = envelope((await f.read()).revision, { type: 'open_period', start: `${year}-01-01`, end: `${year}-12-31` }), opened = await receipt(await h.post(open), f, open);
    const purchase: UsFinancialPilotPurchasingRequest = { consumer: 'financial-pilot', schemaVersion: 1, requestId: randomUUID(), expectedRevision: opened.revision, command: { type: 'record_vendor_bill', vendorId: 'vendor', reference: 'Synthetic new period original', date: `${year}-01-02`, accountingDate: `${year}-01-02`, dueDate: `${year}-01-02`, periodId: opened.entityId, netMinor: '100', purchaseTaxMinor: '7', sourceReference: 'Declared synthetic original' } };
    const boughtResponse = await h.purchasing.POST(h.request('purchasing/operations', purchase), f.org); expect(boughtResponse.status).toBe(200); const bought = validateUsFinancialPilotPurchasingReceipt(await boughtResponse.json(), f.org, purchase);
    const payment: UsFinancialPilotPurchasingRequest = { ...purchase, requestId: randomUUID(), expectedRevision: bought.revision, command: { type: 'record_vendor_payment', billId: bought.entityId, amountMinor: '107', paymentDate: `${year}-01-02`, accountingDate: `${year}-01-02`, periodId: opened.entityId, reference: 'Synthetic already-made payment' } }; expect((await h.purchasing.POST(h.request('purchasing/operations', payment), f.org)).status).toBe(200);
    await submit(f, { type: 'close_period', periodId: opened.entityId }, h);
    const book = await f.read(), view = await projectUsFinancialBookV5(book), entry = view.ledger.entries.find(e => e.id === reversed.entityId)!;
    expect(canonicalErpJson(view.ledger.entries.find(e => e.id === original.id))).toBe(snapshot); expect(entry.reversesEntryId).toBe(original.id); expect(entry.lines).toEqual(original.lines.map(l => ({ ...l, debitMinor: l.creditMinor, creditMinor: l.debitMinor }))); expect(entry.cashFlowCategory).toBe('financing'); expect(canonicalErpJson(view.counters)).toBe(counters); expect(canonicalErpJson(view.invoices)).toBe(invoices); expect(canonicalErpJson(f.initial)).toBe(immutableBaseline);
    expect(view.ledger.audit).toHaveLength(view.ledger.revision); expect(book.revision).toBe(before.revision + 7); expect(view.ledger.revision).toBe(before.ledger.revision + 7); expect(view.ledger.entries).toHaveLength(before.ledger.entries.length + 4);
    const detail = validateUsFinancialPilotJournalDetail(await (await h.journal(original.revision, book.revision)).json(), f.org); expect(detail.canReverse).toBe(false); expect(detail.journal.reversedByJournalRevision).toBe(entry.revision); expect(detail.journal.debitMinor).toBe('9007199254740993');
    const context = validateUsFinancialPilotAccountingContext(await (await h.context(book.revision)).json(), f.org); expect(context.accounts).toHaveLength(7); expect(context.accounts.find(a => a.accountId === 'cash')?.cash).toBe(true); expect(context.earliestOpenPeriod).toBeNull(); expect(context.periodCount).toBe(2);
    const from = `${year - 1}-01-01`, to = `${year}-12-31`, reports = await projectUsFinancialPilotReports(book, { revision: book.revision, from, to, asOf: to, accountId: 'cash' }); expect(reports.trialBalance.balanced).toBe(true); expect(reports.balanceSheet.balanced).toBe(true); expect(reports.cashFlow.status).toBe('available'); expect(reports.generalLedger?.movements.items.some(row => row.journalRevision === original.revision)).toBe(true);
    // Independently accumulate the immutable lines, without invoking reporting
    // helpers, to check every public amount and ordered cash movement.
    const net = new Map(view.ledger.accounts.map(account => [account.id, BigInt(0)]));
    for (const entry of view.ledger.entries) for (const line of entry.lines) net.set(line.accountId, net.get(line.accountId)! + BigInt(line.debitMinor) - BigInt(line.creditMinor));
    const expectedTb = view.ledger.accounts.map(account => { const balance = net.get(account.id)!; return { accountId: account.id, code: account.code, name: account.name, type: account.type, debitMinor: (balance > BigInt(0) ? balance : BigInt(0)).toString(), creditMinor: (balance < BigInt(0) ? -balance : BigInt(0)).toString() }; });
    expect(reports.trialBalance.rows).toEqual(expectedTb);
    const expectedTbDebit = expectedTb.reduce((sum, row) => sum + BigInt(row.debitMinor), BigInt(0)).toString(), expectedTbCredit = expectedTb.reduce((sum, row) => sum + BigInt(row.creditMinor), BigInt(0)).toString();
    expect(reports.trialBalance.totalDebitMinor).toBe(expectedTbDebit); expect(reports.trialBalance.totalCreditMinor).toBe(expectedTbCredit);
    const byType = (type: string) => view.ledger.accounts.filter(account => account.type === type).reduce((sum, account) => sum + net.get(account.id)!, BigInt(0));
    const assets = byType('asset').toString(), liabilities = (-byType('liability')).toString(), equity = (-byType('equity')).toString(), income = (-byType('income')).toString(), expense = byType('expense').toString(), profit = (BigInt(income) - BigInt(expense)).toString();
    const expectedBs = view.ledger.accounts.filter(account => ['asset', 'liability', 'equity'].includes(account.type)).map(account => ({ accountId: account.id, name: account.name, type: account.type, amountMinor: (account.type === 'asset' ? net.get(account.id)! : -net.get(account.id)!).toString() }));
    const expectedPl = view.ledger.accounts.filter(account => ['income', 'expense'].includes(account.type)).map(account => ({ accountId: account.id, name: account.name, type: account.type, amountMinor: (account.type === 'expense' ? net.get(account.id)! : -net.get(account.id)!).toString() }));
    expect(reports.balanceSheet).toEqual({ rows: expectedBs, assetsMinor: assets, liabilitiesMinor: liabilities, equityMinor: equity, unclosedEarningsMinor: profit, balanced: true });
    expect(reports.profitAndLoss).toEqual({ rows: expectedPl, incomeMinor: income, expenseMinor: expense, profitMinor: profit });
    // The manual financing entries cancel exactly, including amounts >2^53.
    // Remaining cash is the actual 100 receipt minus the 50 and107 payments.
    expect(reports.cashFlow).toEqual({ status: 'available', method: 'direct', openingMinor: '0', operatingMinor: '-57', investingMinor: '0', financingMinor: '0', netChangeMinor: '-57', closingMinor: '-57' }); expect(net.get('cash')).toBe(BigInt(-57));
    let running = BigInt(0);
    const expectedGl = [...view.ledger.entries].sort((a, b) => a.accountingDate.localeCompare(b.accountingDate) || a.revision - b.revision).flatMap(entry => entry.lines.filter(line => line.accountId === 'cash').map(line => {
      running += BigInt(line.debitMinor) - BigInt(line.creditMinor);
      const source = entry.source.type === 'manual_journal' ? { kind: 'manual_journal', entityId: null, reference: entry.source.id, journalRevision: null }
        : entry.source.type === 'manual_reversal' ? { kind: 'manual_reversal', entityId: null, reference: null, journalRevision: original.revision }
        : entry.source.type === 'vendor_payment' ? { kind: 'vendor_payment', entityId: entry.source.id, reference: view.vendorBills.find(bill => bill.id === entry.source.id)!.reference, journalRevision: null }
        : { kind: 'customer_payment', entityId: entry.source.id, reference: view.invoices.find(invoice => invoice.id === entry.source.id)!.number, journalRevision: null };
      return { journalRevision: entry.revision, transactionDate: entry.transactionDate, accountingDate: entry.accountingDate, paymentDate: entry.paymentDate ?? null, debitMinor: line.debitMinor, creditMinor: line.creditMinor, balanceMinor: running.toString(), source };
    }));
    expect(expectedGl).toHaveLength(5); expect(reports.generalLedger!.movements.items).toEqual(expectedGl); expect(reports.generalLedger).toMatchObject({ openingMinor: '0', closingMinor: '-57', pageOpeningMinor: '0', pageClosingMinor: '-57' });
    const exports = await mixedExports(book, from, to), amounts = (index: number) => exports[index].sections[0].totals.map(row => row.minorUnits);
    expect(exports[0].sections[0].rows).toEqual(expectedTb.map(row => [row.code, row.name, row.type, row.debitMinor, row.creditMinor])); expect(amounts(0)).toEqual([expectedTbDebit, expectedTbCredit]);
    expect(exports[1].sections[0].rows).toEqual(expectedGl.map(row => [String(row.journalRevision), row.transactionDate, row.accountingDate, row.paymentDate ?? '', row.source.reference ?? `#${row.source.journalRevision}`, row.debitMinor, row.creditMinor, row.balanceMinor])); expect(amounts(1)).toEqual(['0', '-57']);
    expect(exports[2].sections[0].rows).toEqual([]); expect(amounts(2)).toEqual(['0', '-57', '0', '0', '-57', '-57']);
    expect(exports[3].sections[0].rows).toEqual(expectedBs.map(row => [row.name, row.type, row.amountMinor])); expect(amounts(3)).toEqual([assets, liabilities, equity, profit]);
    expect(exports[4].sections[0].rows).toEqual(expectedPl.map(row => [row.name, row.type, row.amountMinor])); expect(amounts(4)).toEqual([income, expense, profit]);
    const beforeRetry = await state(f); for (const input of [post, reverse, close, open]) expect(await receipt(await h.post(input), f, input)).toMatchObject({ revision: input.expectedRevision + 1 }); expect(await state(f)).toBe(beforeRetry);
    for (const name of ['zentra_read_us_financial_accounting_test_v5', 'zentra_read_us_financial_purchasing_test_v5', 'zentra_read_us_financial_commercial_test_v5', 'zentra_read_us_financial_settlement_test_v5']) await expect(client.rpc(name, { p_organization: f.org, p_actor: f.refresh(), p_grant_version: 1, p_capability: name.includes('accounting') ? 'postgres-test-accounting-v5' : name.includes('purchasing') ? 'postgres-test-purchasing-v5' : name.includes('commercial') ? 'postgres-test-commercial-v5' : 'postgres-test-settlement-v5' })).rejects.toBeInstanceOf(SupabaseServerError);
    expect(JSON.stringify(detail)).not.toMatch(/idempotencyKey|commandHash|fingerprint|grantVersion/); retained = { f, book, requests: [post, reverse, close, open], originalRevision: original.revision, reports, exports, detail };
  }, 60000);

  it('refuses wrong original kinds, repeated reversals, dates outside a period and period closure order without effects', async () => {
    const f = await fixture({ baselinePurchases: true }); await f.enable(); const h = http(f), view = await projectUsFinancialBookV5(await f.read());
    for (const entry of view.ledger.entries) { const before = await state(f), r = await h.post(envelope(view.revision, reversal(f, entry.revision))); expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: 'manual_journal_required' }); expect(await state(f)).toBe(before); }
    const posted = await submit(f, journal(f), h), original = (await projectUsFinancialBookV5(await f.read())).ledger.entries.find(e => e.id === posted.entityId)!; await submit(f, reversal(f, original.revision), h); const before = await state(f), again = await h.post(envelope((await f.read()).revision, reversal(f, original.revision))); expect(again.status).toBe(409); expect(await again.json()).toEqual({ error: 'invalid_reversal' }); expect(await state(f)).toBe(before);
    const outside = await h.post(envelope((await f.read()).revision, journal(f, { accountingDate: '1900-01-01' }))); expect(outside.status).toBe(409); expect(await outside.json()).toEqual({ error: 'accounting_period_required' });
    const year = Number(f.day.slice(0, 4)) + 1, later = await submit(f, { type: 'open_period', start: `${year}-01-01`, end: `${year}-12-31` }, h), order = await h.post(envelope(later.revision, { type: 'close_period', periodId: later.entityId })); expect(order.status).toBe(409); expect(await order.json()).toEqual({ error: 'accounting_period_order_conflict' });
    await submit(f, { type: 'close_period', periodId: 'year' }, h); const closedState = await state(f), closed = await h.post(envelope((await f.read()).revision, journal(f))); expect(closed.status).toBe(409); expect(await closed.json()).toEqual({ error: 'accounting_period_closed' }); expect(await state(f)).toBe(closedState);
  }, 30000);

  it('preserves deterministic ID collisions, stale CAS and UUID substitutions without rebase', async () => {
    const requestId = randomUUID(), f = await fixture({ collisionId: 'pilot-journal:' + requestId }); await f.enable(); const h = http(f), before = await state(f), collision = await h.post(envelope((await f.read()).revision, journal(f), requestId)); expect(collision.status).toBe(409); expect(await collision.json()).toEqual({ error: 'entry_id_conflict' }); expect(await state(f)).toBe(before);
    const input = envelope((await f.read()).revision, journal(f)), made = await receipt(await h.post(input), f, input); for (const changed of [{ ...input, expectedRevision: made.revision }, { ...input, command: journal(f, { description: 'UUID replacement' }) }]) { const r = await h.post(changed); expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: 'idempotency_conflict' }); }
    const stale = await h.post(envelope(input.expectedRevision, journal(f))); expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: 'revision_conflict' }); expect((await f.read()).events).toHaveLength(1);
    const periodRequestId = randomUUID(), year = Number(f.day.slice(0, 4)) + 1; await internal(f, { type: 'open_period', id: 'pilot-period:' + periodRequestId, start: `${year}-01-01`, end: `${year}-12-31` }); const periodState = await state(f), periodCollision = await h.post(envelope((await f.read()).revision, { type: 'open_period', start: `${year + 1}-01-01`, end: `${year + 1}-12-31` }, periodRequestId)); expect(periodCollision.status).toBe(409); expect(await periodCollision.json()).toEqual({ error: 'period_already_exists' }); expect(await state(f)).toBe(periodState);
  });

  it.each(['lostReply', 'late409'] as const)('recovers actually appended reversal after %s, later closure and unrelated source changes', async kind => {
    const f = await fixture(); await f.enable(); const made = await submit(f, journal(f)), source = (await projectUsFinancialBookV5(await f.read())).ledger.entries.find(e => e.id === made.entityId)!, input = envelope(made.revision, reversal(f, source.revision)); let once = true;
    const h = http(f, { store: (scope, revalidate) => { const real = createSupabaseUsFinancialPilotStore(client, scope, revalidate); return { ...real, commit: async commit => { const r = await real.commit(commit); if (once) { once = false; if (kind === 'late409') throw new ErpError('financial_source_changed', 409); throw Error('Synthetic reply lost after actual PostgreSQL commit'); } return r; } }; } });
    expect((await h.post(input)).status).toBe(kind === 'late409' ? 409 : 503); await submit(f, { type: 'close_period', periodId: 'year' }); const before = await state(f), recovered = await receipt(await h.post(input), f, input); expect(recovered.revision).toBe(input.expectedRevision + 1); expect(await state(f)).toBe(before); expect((await f.read()).events).toHaveLength(3);
  });

  it('recovers exact reversal committed after first probe before source read and bounds stale CAS recovery', async () => {
    const f = await fixture(); await f.enable(); const made = await submit(f, journal(f)), source = (await projectUsFinancialBookV5(await f.read())).ledger.entries.find(e => e.id === made.entityId)!, input = envelope(made.revision, reversal(f, source.revision)), first = http(f); let once = true;
    const h = http(f, { store: (scope, revalidate) => { const real = createSupabaseUsFinancialPilotStore(client, scope, revalidate); return { ...real, read: async org => { if (once) { once = false; await receipt(await first.post(input), f, input); await submit(f, { type: 'close_period', periodId: 'year' }, first); } return real.read(org); } }; } }); expect((await h.post(input)).status).toBe(200); expect((await f.read()).events).toHaveLength(3);
    const other = await fixture(); await other.enable(); let attempts = 0; const cas = http(other, { store: (scope, revalidate) => ({ ...createSupabaseUsFinancialPilotStore(client, scope, revalidate), commit: async () => { attempts++; throw new ErpError('revision_conflict', 409); } }) }); expect((await cas.post(envelope((await other.read()).revision, journal(other)))).status).toBe(409); expect(attempts).toBe(2); expect((await other.read()).events).toHaveLength(0);
  });

  it('reprobes source-not-found after actual original/reversal commits while a previously captured read resolves', async () => {
    const f = await fixture(); await f.enable(); const first = http(f), input = envelope(f.initial.revision + 1, reversal(f, f.initial.baseline.ledger.revision + 1)); let once = true;
    const h = http(f, { store: (scope, revalidate) => { const real = createSupabaseUsFinancialPilotStore(client, scope, revalidate); return { ...real, read: async org => { if (once) { once = false; const captured = await real.read(org); await submit(f, journal(f), first); await receipt(await first.post(input), f, input); await submit(f, { type: 'close_period', periodId: 'year' }, first); return captured; } return real.read(org); } }; } });
    await receipt(await h.post(input), f, input); expect((await f.read()).events).toHaveLength(3);
  });

  it.each(['grant', 'optIn'] as const)('withholds success and rejected private data after actual %s revocation', async kind => {
    const f = await fixture(); await f.enable(); const before = await state(f); let once = true;
    const h = http(f, { store: (scope, revalidate) => { const real = createSupabaseUsFinancialPilotStore(client, scope, revalidate); return { ...real, read: async org => { const book = await real.read(org); if (once) { once = false; await db.query(`update public.${kind === 'grant' ? 'zentra_us_financial_test_grants' : 'zentra_us_financial_pilot_test_opt_ins'} set enabled=false,version=version+1 where organization_id=$1`, [f.org]); } return book; } }; } }); const r = await h.context(f.initial.revision); expect(r.status).toBe(403); expect(Object.keys(await r.json() as object)).toEqual(['error']); expect(await state(f)).toBe(before);
  });

  it('requires current tenant, user, financial role and browser credentials and living wrapper versions', async () => {
    const f = await fixture(); await f.enable(); const h = http(f), before = await state(f); h.auth.userId = randomUUID(); expect((await h.context(f.initial.revision)).status).toBe(401); h.auth.userId = f.user; h.auth.role = 'member'; expect((await h.context(f.initial.revision)).status).toBe(403); h.auth.role = 'owner'; expect((await h.accounting.POST(h.request('accounting/operations', envelope(f.initial.revision, journal(f)), { Authorization: 'Bearer synthetic' }), f.org)).status).toBe(403); const foreign = randomUUID(); expect((await h.accounting.CONTEXT(new Request(h.request('accounting/context?revision=' + f.initial.revision).url.replace(f.org, foreign), { headers: h.request('accounting/context').headers }), foreign)).status).toBe(403);
    for (const name of ['zentra_read_us_financial_pilot_test_v1', 'zentra_us_financial_pilot_test_receipt_v1', 'zentra_append_us_financial_pilot_test_v1']) { const args = { p_organization: f.org, p_actor: f.refresh(), p_grant_version: 1, p_opt_in_version: 2, p_capability: 'postgres-test-financial-pilot-dto1', p_idempotency_key: 'synthetic', p_expected_revision: f.initial.revision, p_previous_fingerprint: '0'.repeat(64), p_book: {}, p_receipt: {} }; await expect(client.rpc(name, args)).rejects.toMatchObject({ code: 'PF006' }); await expect(client.rpc(name, { ...args, p_grant_version: 2, p_opt_in_version: 1 })).rejects.toMatchObject({ code: 'PF006' }); }
    expect(await state(f)).toBe(before);
  });

  it('SQL itself rejects forged unbalanced/unknown/forbidden/source/period/reversal effects and stale CAS', async () => {
    const f = await fixture(); await f.enable(); const input = envelope(f.initial.revision, journal(f)), native = buildUsFinancialPilotAccountingRequest(input, f.org); if (native.command.type !== 'erp_command') throw Error('fixture');
    const candidate = await f.prepare({ type: 'erp_command', idempotencyKey: native.idempotencyKey, command: native.command.request, facts: { kind: 'none' } }, usFinancialPilotAccountingEntityId(input)), before = await state(f);
    // Call the real pilot SQL wrapper while retaining its original TEST-only
    // error code/message locally, so domain rejection cannot be confused with
    // an earlier actor/hash envelope rejection.
    const append = (book: unknown, selectedReceipt: UsFinancialReceiptV5 = candidate.receipt, expectedRevision = candidate.expectedRevision) => result('select public.zentra_append_us_financial_pilot_test_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) result', [f.org, candidate.actor, 1, 1, 'postgres-test-financial-pilot-dto1', expectedRevision, candidate.previousFingerprint, book, selectedReceipt]);
    const rejectionMessages = { unbalanced: 'Balanced classified purchasing effect required', unknown: 'Exact exclusive purchasing lines required', forbidden: 'Exact permitted manual journal line required', period: 'Open purchasing period required', source: 'Uncorroborated invoicing event', reversal: 'Original manual journal required' };
    for (const change of ['unbalanced', 'unknown', 'forbidden', 'period', 'source', 'reversal'] as const) {
      const forged = JSON.parse(JSON.stringify(candidate.book)) as UsFinancialBookV5, event = forged.events.at(-1)!; if (event.operation.type !== 'erp_command' || !('effects' in event)) throw Error('fixture'); const command = event.operation.command as unknown as Record<string, unknown>, posting = event.effects.postings[0] as unknown as Record<string, unknown>;
      if (change === 'unbalanced') (command.lines as { debitMinor: string }[])[0].debitMinor = '2'; else if (change === 'unknown' || change === 'forbidden') (command.lines as { accountId: string }[])[0].accountId = change === 'unknown' ? 'unknown' : 'receivables'; else if (change === 'period') command.periodId = 'missing'; else if (change === 'source') posting.source = { type: 'customer_invoice', id: 'invoice' }; else { for (const key of Object.keys(command)) delete command[key]; Object.assign(command, { type: 'reverse_manual_journal', id: event.id, entryId: f.initial.baseline.ledger.entries[0].id, transactionDate: f.day, accountingDate: f.day, periodId: 'year', reason: 'Synthetic forged subregister reversal' }); }
      const erpRequest = { idempotencyKey: native.idempotencyKey, expectedRevision: candidate.expectedRevision, command }, financialRequest = { ...erpRequest, command: { type: 'erp_command', request: command } }, coherentReceipt = { ...candidate.receipt, commandHash: hash(canonicalErpJson([f.org, f.user, financialRequest])) };
      Object.assign(event.commit.receipt as unknown as Record<string, unknown>, { commandHash: hash(canonicalErpJson([f.org, f.user, erpRequest])), action: command.type });
      await expect(append(forged, coherentReceipt)).rejects.toMatchObject({ code: change === 'period' ? 'PF015' : 'PF004', message: rejectionMessages[change] }); expect(await state(f)).toBe(before);
    }
    await expect(append(candidate.book, candidate.receipt, candidate.expectedRevision - 1)).rejects.toMatchObject({ code: 'PF001', message: 'Financial revision changed' }); expect(await state(f)).toBe(before);
    expect(await append(candidate.book)).toEqual(candidate.receipt); expect(await f.read()).toEqual(candidate.book);
  });

  it('reads persisted journals/lines and earliest period beyond page one after a real V5 invoice, with scoped canonical cursors', async () => {
    const t = await httpFixture({ journalPaging: true, periodCount: 26 }); await issue(t); const f = t.f, h = http(f), book = await f.read(), view = await projectUsFinancialBookV5(book), source = view.ledger.entries.find(e => e.id === 'paging-journal-0')!;
    const page = await h.pilot.LIST(h.request('lists/journals?revision=' + book.revision), f.org, 'journals'); expect(page.status).toBe(200); expect((await page.json() as { items: { journalRevision: number }[] }).items.some(row => row.journalRevision === source.revision)).toBe(false);
    const detail = validateUsFinancialPilotJournalDetail(await (await h.journal(source.revision, book.revision)).json(), f.org, book.revision, source.revision); expect(detail.lines.items).toHaveLength(25); expect(detail.lineCount).toBe(28); expect(detail.journal.debitMinor).toBe('14'); const rest = validateUsFinancialPilotJournalDetail(await (await h.journal(source.revision, book.revision, detail.lines.nextCursor!)).json(), f.org, book.revision, source.revision, detail.lines.nextCursor); expect(rest.lines.items).toHaveLength(3); expect(rest.lines.items.map(l => l.ordinal)).toEqual([26, 27, 28]); expect(rest.journal).toEqual(detail.journal);
    expect((await h.journal(source.revision + 1, book.revision, detail.lines.nextCursor!)).status).toBe(422); expect((await h.journal(source.revision, book.revision, financialPilotJournalLinesCursor(book.revision - 1, 25, source.revision))).status).toBe(422); expect((await h.accounting.CONTEXT(h.request(`accounting/context?revision=${book.revision}&lineCursor=x`), f.org)).status).toBe(422);
    const context = validateUsFinancialPilotAccountingContext(await (await h.context(book.revision)).json(), f.org); expect(context.periodCount).toBe(26); expect(context.earliestOpenPeriod?.id).toBe('year'); expect(validateUsFinancialPilotPeriodDetail(await (await h.period('year', book.revision)).json(), f.org).canClose).toBe(true); expect(validateUsFinancialPilotPeriodDetail(await (await h.period('p-25', book.revision)).json(), f.org).canClose).toBe(false);
  }, 60000);

  it('admits 100 persisted periods and refuses the 101st without mutating the book', async () => {
    const f = await fixture({ periodCount: 100 }); await f.enable(); const h = http(f), context = validateUsFinancialPilotAccountingContext(await (await h.context(f.initial.revision)).json(), f.org); expect(context.periodCount).toBe(100); expect(context.earliestOpenPeriod?.id).toBe('year'); const year = Number(f.day.slice(0, 4)) + 100, before = await state(f), r = await h.post(envelope(f.initial.revision, { type: 'open_period', start: `${year}-01-01`, end: `${year}-12-31` })); expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: 'period_limit_reached' }); expect(await state(f)).toBe(before);
  }, 30000);

  it('cleanly closes NodeFS and reopens a new instance with identical book/reports/details and all exact historical receipts', async () => {
    if (!retained) throw Error('Prior mixed accounting recipe must execute'); const { f, book, requests, originalRevision, reports, exports, detail } = retained;
    await db.close(); db = new PGlite(dataDir); expect(await f.read()).toEqual(book); const h = http(f), before = await state(f); expect(await (await h.journal(originalRevision, book.revision)).json()).toEqual(detail);
    const year = Number(f.day.slice(0, 4)) + 1, from = `${year - 1}-01-01`, to = `${year}-12-31`; expect(await projectUsFinancialPilotReports(await f.read(), { revision: book.revision, from, to, asOf: to, accountId: 'cash' })).toEqual(reports);
    expect(await mixedExports(await f.read(), from, to)).toEqual(exports);
    for (const request of requests) await receipt(await h.post(request), f, request); expect(await state(f)).toBe(before);
    const recipe = { scope: 'LOCAL TEST only; serialized PGlite; synthetic Auth/D1/tax observations; actual Request/Response handlers and 33 migrations; clean close/new instance, no multiconnection/crash/performance/SLA claim', migrations: [...migrations, migration, invoiceMigration], organizationId: f.org, revision: book.revision, cleanCloseReopen: true, dataDir };
    await writeFile(join(dataDir, 'synthetic-accounting-recipe.json'), JSON.stringify(recipe)); await writeFile(new URL('../../.qa/us-pilot-accounting/postgres-recipe.json', import.meta.url), JSON.stringify(recipe, null, 2)); console.info('Retained synthetic PostgreSQL accounting dataDir: ' + dataDir);
  }, 30000);
});

