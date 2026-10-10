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
import { createSupabaseUsFinancialSettlementTestStoreV5 } from './us-financial-test-settlement';
import { createSupabaseUsFinancialCommercialTestStoreV5 } from './us-financial-test-commercial';
import { createSupabaseUsFinancialPurchasingTestStoreV5 } from './us-financial-test-purchasing';
import { createSupabaseUsFinancialAccountingTestStoreV5 } from './us-financial-test-accounting';

import { createSupabaseUsFinancialInvoicingTestStoreV5 } from './us-financial-test-invoicing';
import { createSupabaseUsFinancialInvoiceTestStoreV5 } from './us-financial-invoice-test-store';
import { financialInvoiceClassificationEvidenceV5, resolveUsFinancialInvoicePreparationV5, validateUsFinancialInvoiceContextV5, validateUsFinancialInvoicePreparationV5, validateUsFinancialInvoiceOperationV5, type UsFinancialInvoiceContextV5, type UsFinancialInvoicePreparationV5 } from './us-financial-invoice-test';
import { validateStoredStripeTaxCalculation } from './stripe-tax-calculation';

// Actual SQL on retained local NodeFS. All data and fiscal observations are
// visibly synthetic; no provider/network calls. Serialized PGlite proves neither
// multi-connection races nor crash recovery, D1 atomicity or a production SLA.
const directory=process.env.PGLITE_MODULE_DIR,enabled=Boolean(directory&&isAbsolute(directory));
type Sql={exec(sql:string):Promise<unknown>;query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[]}>};
type Db=Sql&{close():Promise<void>;transaction<T>(task:(tx:Sql)=>Promise<T>):Promise<T>};
let db:Db,PGlite:new(dataDir?:string)=>Db,dataDir:string;
const capability='postgres-test-invoicing-v5',migration='20261010100252_international_us_financial_test_invoicing_v5';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
type Fixture=Awaited<ReturnType<typeof fixture>>;
const operation=(command:ErpCommand,key:string=randomUUID()):UsFinancialOperationV5=>({type:'erp_command',idempotencyKey:key,command:command as Extract<UsFinancialOperationV5,{type:'erp_command'}>['command'],facts:{kind:'none'}});
let previousFixture:Fixture,previousBook:UsFinancialBookV5;

const migrations=[
 '202609140100_company_profiles','202609140200_company_collaboration','202609200300_company_content',
 '20261007194528_international_workspace_country_config','20261007222349_international_us_erp_persistence','20261007224820_international_us_erp_delta_stream','20261007225725_international_us_erp_seller_snapshot','20261008001726_new_us_workspace_admission','20261008013200_international_tax_proof_allowlist',
 '20261008034422_international_us_seller_profile','20261008044402_international_us_tax_profile','20261008060826_international_us_tax_operations','20261008081825_international_us_purchasing_v2','20261008105120_international_us_projects_v3','20261008161118_international_us_journal_periods_v4','20261008172520_international_us_tax_invoice_capability_v2',
 '20261008184605_international_us_bank_reconciliation','20261008194930_international_us_supplier_proposals','20261008210008_international_us_automation_analysis','20261009215104_international_us_workspace_sync_heads','20261009222319_international_us_tax_test_merchant','20261009224607_international_us_tax_invoice_preparation','20261010005300_international_us_supplier_originals','20261010024618_international_us_supplier_original_hash_lookup','20261010054644_international_us_sales_orders','20261010075840_international_us_financial_test_foundation_v5','20261010083027_international_us_financial_test_settlement_v5','20261010085523_international_us_financial_test_commercial_v5','20261010091729_international_us_financial_test_purchasing_v5','20261010093930_international_us_financial_test_accounting_v5',
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
async function sql<T=Record<string,unknown>>(q:string,v:unknown[]=[],role='service_role'){return db.transaction(async tx=>{await tx.exec(`set local role ${role}`);return(await tx.query<T>(q,v)).rows;});}
async function result<T=unknown>(q:string,v:unknown[]=[]){return(await sql<{result:T}>(q,v))[0].result;}
const client:Pick<SupabaseServerClient,'rpc'>={async rpc<T>(name:string,input:Readonly<Record<string,unknown>>):Promise<T>{
 const keys=parameters[name];if(!keys)throw Error('Unexpected synthetic SQL RPC');
 try{return await result<T>(`select public.${name}(${keys.map((_,i)=>`$${i+1}`).join(',')}) result`,keys.map(k=>input[k]));}
 catch(error){if(process.env.ZENTRA_LOCAL_SQL_DEBUG==='1')console.error((error as Error).message,(error as {where?:string}).where);throw new SupabaseServerError(503,(error as {code:string}).code,'private SQL TEST');}
}};
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
 if(options.baselinePurchases){
  const supplier={...(await erp.read(org))!.customers[0],id:'vendor',name:'Synthetic historical supplier'};await send({type:'save_vendor',vendor:supplier});await send({type:'save_vendor',vendor:supplier});
  await send({type:'record_vendor_bill',id:'bill',vendorId:'vendor',reference:'Synthetic historical bill',date:day,accountingDate:day,dueDate:day,periodId:'year',netMinor:'100',purchaseTaxMinor:'7',expenseAccountId:'purchases',sourceReference:'Synthetic historical declared original'});
  await send({type:'record_vendor_payment',id:'baseline-vendor-payment',billId:'bill',amountMinor:'50',paymentDate:day,accountingDate:day,periodId:'year',reference:'Synthetic historical payment'});
 }
 if(options.closed)await send({type:'close_period',periodId:'year'});
 if(options.laterOpen)await send({type:'open_period',id:'next',start:`${year+1}-01-01`,end:`${year+1}-12-31`});
 if(options.activeOrder||options.confirmedOrder){
  await send({type:'save_estimate',id:'ordered-quote',expectedEstimateRevision:0,customerId:'customer',date:day,expiresAt:day,paymentTermsDays:30,lines,notes:'Synthetic locked order source'});await send({type:'accept_estimate',estimateId:'ordered-quote',expectedEstimateRevision:1});
  const request={schemaVersion:1,idempotencyKey:'synthetic-sales-order',orderId:randomUUID(),expectedErpRevision:(await erp.read(org))!.revision,expectedHeadRevision:0,expectedOrderRevision:null,command:{type:'create_from_estimate',estimateId:'ordered-quote',expectedEstimateRevision:2,orderDate:day,customerReference:null}};
  await sql('select public.zentra_execute_us_sales_order($1,$2,4,$3,$4)',[org,{...actor,timestamp:new Date().toISOString()},request,hash(canonicalErpJson([org,user,request]))]);
  if(options.confirmedOrder){const confirm={...request,idempotencyKey:'synthetic-confirmation',expectedHeadRevision:1,expectedOrderRevision:1,command:{type:'confirm',reference:'Synthetic approved order'}};await sql('select public.zentra_execute_us_sales_order($1,$2,4,$3,$4)',[org,{...actor,timestamp:new Date().toISOString()},confirm,hash(canonicalErpJson([org,user,confirm]))]);}
 }
 const pendingKey=options.pendingTax?'synthetic-pending-tax':null;let pendingOperationId:string|null=null;
 if(pendingKey){
  await send({type:'save_estimate',id:'pending-quote',expectedEstimateRevision:0,customerId:'customer',date:day,expiresAt:day,paymentTermsDays:30,lines,notes:'Synthetic reserved source'});await send({type:'accept_estimate',estimateId:'pending-quote',expectedEstimateRevision:1});
  const pendingBefore=(await erp.read(org))!,estimate=pendingBefore.estimates.find(x=>x.id==='pending-quote')!,pendingCommand={type:'issue_invoice' as const,id:'pending-invoice',estimateId:'pending-quote',expectedEstimateRevision:2,date:day,accountingDate:day,dueDate:day,periodId:'year'},pendingRequest={idempotencyKey:pendingKey,expectedRevision:pendingBefore.revision,command:pendingCommand};pendingOperationId=randomUUID();
  const pending=await prepareStripeTaxResolvedRequest({organizationId:org,operationId:pendingOperationId,invoiceId:pendingCommand.id,actorUserId:user,erpIdempotencyKey:pendingKey,commandHash:hash(canonicalErpJson([org,user,pendingRequest])),expectedErpRevision:pendingBefore.revision,countryRevision:2,sellerRevision:1,taxFactsRevision:1,configuration:config,estimate,taxFacts:facts,binding,classifications:lines.map(l=>({lineId:l.id,taxCode:'txcd_10000000',kind:'service' as const,taxBehavior:'exclusive' as const,revision:1,evidenceReference:'Synthetic legacy pending classification'})),invoiceDate:day,taxDateInstant:day+'T12:00:00Z',taxDatePolicy:'caller_supplied_invoice_instant',now:new Date().toISOString(),addressSource:'billing'});
  await sql('select public.zentra_reserve_us_tax_operation($1,$2,$3::uuid,$4,$5,$6,$7,$8)',[org,actor,pendingOperationId,pending.resolvedBody,pending.resolvedSha256,pending.paramsBody,pending.paramsSha256,pending.idempotencyKey]);
 }
 const baseline=(await erp.read(org))!;actor={...actor,timestamp:new Date().toISOString()};
 const policy:UsFinancialPolicyV5={version:'us-accrual-receivable-credit-v1',environment:'test',approval:{reference:'SYNTHETIC-LOCAL-TEST-ONLY',reviewedBy:'synthetic-reviewer',reviewedAt:new Date(now.getTime()-2000).toISOString()}};
 await db.query('insert into public.zentra_us_financial_test_grants values($1,$2,$3,1,true,$4)',[org,user,'owner',policy]);
 const scope={organizationId:org,actor,policy,grantVersion:1},foundation=createSupabaseUsFinancialTestFoundationV5(client,scope,async()=>scope),initial=await promoteUsFinancialBookV5(baseline,policy,actor);
 if(!options.unpromoted)await foundation.promote({book:initial,idempotencyKey:'synthetic-promotion'});
 const settlement=createSupabaseUsFinancialSettlementTestStoreV5(client,scope,async()=>scope),commercialStore=createSupabaseUsFinancialCommercialTestStoreV5(client,scope,async()=>scope),purchasingStore=createSupabaseUsFinancialPurchasingTestStoreV5(client,scope,async()=>scope),accountingStore=createSupabaseUsFinancialAccountingTestStoreV5(client,scope,async()=>scope),store=createSupabaseUsFinancialInvoicingTestStoreV5(client,scope,async()=>scope);
 const read=()=>result<UsFinancialBookV5>('select public.zentra_read_us_financial_invoicing_test_v5($1,$2,1,$3) result',[org,actor,capability]);
 const payment=(amountMinor='100'):Extract<UsFinancialOperationV5,{type:'customer_payment'}>=>({type:'customer_payment',idempotencyKey:randomUUID(),invoiceId:'invoice',amountMinor,paymentDate:day,accountingDate:day,periodId:'year',reference:'Synthetic payment · référence "quoted"'});
 const authorize=async(book:UsFinancialBookV5,input:UsFinancialCreditInputV5,persist=true):Promise<Extract<UsFinancialOperationV5,{type:'customer_credit'}>>=>{
  const c=await buildUsFinancialCreditCandidateV5(book,input),common={schemaVersion:1 as const,environment:'test' as const,invoiceFingerprint:c.invoiceFingerprint,allocationSha256:c.allocationSha256,reference:'Synthetic authorization, no tax reversal executed',verifiedBy:'synthetic-test-reviewer',verifiedAt:actor.timestamp};
  const taxProof:UsFinancialTaxProofV5=c.allocation.taxMinor==='0'?{...common,kind:'historical_zero_tax'}:{...common,kind:'test_adjustment_authorization',providerAccountReference:'acct_SyntheticSettlement',originalTaxTransactionReference:`testtxn_Synthetic_${input.invoiceId}`,adjustmentPlanReference:`synthetic-plan-${input.idempotencyKey}`,authorizedTaxMinor:c.allocation.taxMinor};
  if(persist)await db.query('insert into public.zentra_us_financial_test_tax_plans values($1,$2,$3,$4)',[org,input.idempotencyKey,input.invoiceId,taxProof]);
  return{...input,taxProof};
 };
 const credit=(book:UsFinancialBookV5,quantities:readonly string[]=['1'],persist=true)=>authorize(book,{type:'customer_credit',idempotencyKey:randomUUID(),invoiceId:'invoice',transactionDate:day,accountingDate:day,periodId:'year',reason:'Synthetic customer credit — local tests only',selections:quantities.map((quantityUnits,i)=>({lineId:`line-${i}`,quantityUnits}))},persist);
 const prepare=async(op:UsFinancialOperationV5,id:string=randomUUID(),beforeBook?:UsFinancialBookV5):Promise<UsFinancialCommitV5>=>{
  const before=beforeBook??await read(),after=await applyUsFinancialOperationV5(before,op,actor,id),{idempotencyKey,...rest}=op;
  const command=rest.type==='erp_command'?{type:'erp_command',request:rest.command}:rest.type==='customer_credit'?(()=>{const{taxProof:_proof,...fields}=rest;return{...fields,id};})():{...rest,id};
  const receipt:UsFinancialReceiptV5={idempotencyKey,commandHash:hash(canonicalErpJson([org,user,{idempotencyKey,expectedRevision:before.revision,command}])),revision:after.book.revision,entityId:id,action:op.type,actorId:user};
  return{organizationId:org,expectedRevision:before.revision,previousFingerprint:hash(canonicalErpJson(before)),book:after.book,receipt,actor};
 };
 const append=(c:UsFinancialCommitV5,version=1)=>result<UsFinancialReceiptV5>('select public.zentra_append_us_financial_invoicing_test_v5($1,$2,$3,$4,$5,$6,$7,$8) result',[org,c.actor,version,capability,c.expectedRevision,c.previousFingerprint,c.book,c.receipt]);
 return{org,user,config,get actor(){return actor;},refresh(){actor={...actor,timestamp:new Date().toISOString()};scope.actor=actor;return actor;},day,policy,scope,pendingKey,pendingOperationId,baseline,initial,foundation,settlement,commercialStore,purchasingStore,accountingStore,store,read,payment,credit,authorize,prepare,append};
}
function lookup(p:UsFinancialInvoicePreparationV5){return{request:p.request,financialCommandHash:p.financialCommandHash,erpCommandHash:p.erpCommandHash};}
async function context(f:Fixture):Promise<UsFinancialInvoiceContextV5>{
 const now=new Date(),binding:StripeTaxTestBinding={organizationId:f.org,accountId:'acct_SyntheticSettlement',mode:'test',apiVersion:'2026-08-26.dahlia',revision:1,settingsSha256:hash('synthetic-settings'),registrationsSha256:hash('synthetic-registrations'),observedAt:new Date(now.getTime()-1000).toISOString(),validUntil:new Date(now.getTime()+119000).toISOString(),evidenceKind:'test_fixture',scope:'erp_invoice_tax'};
 const seller=(await sql<{profile:unknown}>('select profile from public.zentra_us_seller_profiles where organization_id=$1',[f.org]))[0].profile;
 const taxFacts=(await sql<{facts:unknown}>('select facts from public.zentra_us_tax_profiles where organization_id=$1',[f.org]))[0].facts;
 const count=(await db.query<{n:string}>('select coalesce(max(revision),0)+1 n from public.zentra_us_financial_invoice_test_contexts where organization_id=$1',[f.org])).rows[0].n;
 const payload={schemaVersion:1,organizationId:f.org,revision:Number(count),countryRevision:2,configuration:f.config,sellerRevision:1,seller,taxFactsRevision:1,taxFacts,binding,merchant:{credential:{reference:'SYNTHETIC-NO-SECRET',revision:1,accountId:binding.accountId},configurationFingerprint:hash('SYNTHETIC-LOCAL-CREDENTIAL-IDENTITY')},admittedBy:'Synthetic DB owner, no provider identity claim',admittedAt:now.toISOString()};
 const value=await validateUsFinancialInvoiceContextV5({...payload,contextSha256:hash(canonicalErpJson(payload))},f.org,true);await db.query('insert into public.zentra_us_financial_invoice_test_contexts values($1,$2,$3)',[f.org,value.revision,value]);return value;
}
async function acceptedQuote(f:Fixture,id='new-quote'){
 const base=f.baseline.estimates[0];for(const cmd of [{type:'save_estimate',id,expectedEstimateRevision:0,customerId:'customer',date:f.day,expiresAt:f.day,paymentTermsDays:30,lines:base.lines,notes:'Synthetic local invoice source'}, {type:'accept_estimate',estimateId:id,expectedEstimateRevision:1}] as ErpCommand[]){const c=await f.prepare(operation(cmd),id);await f.append(c);}return id;
}
async function reservation(f:Fixture,options:{quoteId?:string;invoiceId?:string;key?:string;operationId?:string;date?:string;periodId?:string;context?:UsFinancialInvoiceContextV5}={}){
 const invoiceId=options.invoiceId??'new-invoice',quoteId=options.quoteId??await acceptedQuote(f),ctx=options.context??await context(f),before=await f.read();f.refresh();
 const command:Extract<ErpCommand,{type:'issue_invoice'}>={type:'issue_invoice',id:invoiceId,estimateId:quoteId,expectedEstimateRevision:2,date:options.date??f.day,accountingDate:options.date??f.day,dueDate:options.date??f.day,periodId:options.periodId??'year'};
 const request={idempotencyKey:options.key??randomUUID(),expectedRevision:before.revision,command:{type:'erp_command' as const,request:command}},erpRequest={idempotencyKey:request.idempotencyKey,expectedRevision:request.expectedRevision,command},financialCommandHash=hash(canonicalErpJson([f.org,f.user,request])),erpCommandHash=hash(canonicalErpJson([f.org,f.user,erpRequest])),previousBookFingerprint=hash(canonicalErpJson(before));
 const fiscal=createSupabaseUsFinancialInvoiceTestStoreV5(client,f.scope,async()=>({...f.scope,actor:{...f.actor,timestamp:new Date().toISOString()}}),{allowTestFixtures:true});
 const review=await fiscal.preflight(f.actor,{request,financialCommandHash,erpCommandHash,previousBookFingerprint}),preparedAt=new Date().toISOString();
 expect(review.context).toEqual(ctx);
 const body={schemaVersion:1 as const,organizationId:f.org,actorId:f.user,request,financialCommandHash,erpRequest,erpCommandHash,previousBookFingerprint,context:ctx,estimate:review.estimate,estimateSha256:hash(canonicalErpJson(review.estimate)),classifications:await Promise.all(review.estimate.lines.map(async l=>({lineId:l.id,taxCode:'txcd_10000000',kind:'service' as const,taxBehavior:'exclusive' as const,revision:1,evidenceReference:await financialInvoiceClassificationEvidenceV5(f.org,f.user,financialCommandHash,l.id,'txcd_10000000')}))),taxDateInstant:`${command.date}T12:00:00Z`,addressSource:'billing' as const,preparedAt};
 const preparation:UsFinancialInvoicePreparationV5=await validateUsFinancialInvoicePreparationV5({...body,preparationSha256:hash(canonicalErpJson(body))},f.org,true),resolved=await resolveUsFinancialInvoicePreparationV5(preparation,options.operationId??randomUUID(),preparedAt),saved=await fiscal.reserve(f.actor,preparation,resolved);
 return{fiscal,preparation,resolved,saved,command,invoiceId,before};
}
async function calculation(f:Fixture,r:Awaited<ReturnType<typeof reservation>>,lineTax='2475'){
 const {resolved}=r,calculationId=`taxcalc_Synthetic${resolved.operationId.replaceAll('-','')}`,calculatedAt=new Date().toISOString(),expiresAt=new Date(Date.now()+60000).toISOString(),net=resolved.netTotalMinor,tax=(BigInt(lineTax)*BigInt(resolved.params.line_items.length)).toString();
 const proof:StripeTaxPrivateProof={schemaVersion:1,organizationId:f.org,operationId:resolved.operationId,provider:'stripe_tax',accountId:resolved.binding.accountId,mode:'test',apiVersion:resolved.binding.apiVersion,bindingRevision:resolved.binding.revision,resolvedSha256:resolved.resolvedSha256,paramsSha256:resolved.paramsSha256,settingsSha256:resolved.binding.settingsSha256,registrationsSha256:resolved.binding.registrationsSha256,evidenceKind:'test_fixture',calculationId,calculatedAt,expiresAt,taxDate:resolved.params.tax_date,currency:'USD',netMinor:net,taxMinor:tax,totalMinor:(BigInt(net)+BigInt(tax)).toString(),lines:resolved.params.line_items.map((l,i)=>({lineId:l.reference,providerLineId:`tax_li_Synthetic${i}`,netMinor:l.amount.toString(),quantity:l.quantity.toString(),taxCode:l.tax_code,taxMinor:lineTax,breakdowns:[{amountMinor:lineTax,taxableMinor:l.amount.toString(),taxabilityReason:'standard_rated' as const,sourcing:'destination' as const,jurisdiction:{country:'US' as const,state:'NY',level:'state',displayName:'Synthetic TEST jurisdiction'}}]}))};
 const source=buildTaxRequest(f.config,r.preparation.estimate,r.command.date),assessment:TaxAssessment={organizationId:f.org,country:'US',currency:'USD',documentId:source.documentId,documentRevision:source.documentRevision,fingerprint:source.fingerprint,source:'external-provider',providerReference:calculationId,determinedAt:calculatedAt,validUntil:expiresAt,lines:proof.lines.map(l=>({id:l.lineId,taxMinor:l.taxMinor,jurisdiction:'US-NY',evidenceReference:`${calculationId}:${l.providerLineId}`}))};
 const calculated=await validateStoredStripeTaxCalculation(resolved,{proofBody:canonicalErpJson(proof),proofSha256:hash(canonicalErpJson(proof)),assessment},calculatedAt);
 const saved=await r.fiscal.record(f.actor,r.saved,calculated);f.refresh();
 const op:UsFinancialOperationV5={type:'erp_command',idempotencyKey:r.preparation.request.idempotencyKey,command:r.command,facts:{kind:'invoice_issuance',sellerSnapshot:{organizationId:f.org,...r.preparation.context.seller},taxAssessment:assessment}};
 return{proof,assessment,calculated,saved,op,commit:await f.prepare(op,r.invoiceId)};
}
async function issue(f:Fixture,options:Parameters<typeof reservation>[1]={}){const r=await reservation(f,options),c=await calculation(f,r);await f.store.commit(c.commit);return{...r,...c};}

describe.skipIf(!enabled)('independent private US financial TEST invoice issuance',()=>{
 beforeAll(async()=>{
  const require=createRequire(import.meta.url);({PGlite}=require(join(directory!,'dist/index.cjs')) as {PGlite:new(dataDir?:string)=>Db});dataDir=await mkdtemp(join(tmpdir(),'zentra-invoicing-test-v5-'));db=new PGlite(dataDir);
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');for(const name of migrations)await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
  previousFixture=await fixture({pendingTax:true});const before=previousFixture.initial,credit=await previousFixture.credit(before),c=await previousFixture.prepare(credit,'prior-credit',before);await previousFixture.accountingStore.commit(c);const p=await previousFixture.prepare({...previousFixture.payment('1'),idempotencyKey:previousFixture.pendingKey!},'prior-cross-key',c.book);await previousFixture.accountingStore.commit(p);previousBook=p.book;
  await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}.sql`,import.meta.url),'utf8'));
 },30000);
 afterAll(async()=>{await db?.close();});
 it('installs additively on a real prior credit without rewriting book or cursor',async()=>{expect(migrations).toHaveLength(30);expect(await previousFixture.read()).toEqual(previousBook);});
 it('issues once, records two partial payments, then credits the exact remaining source on the same real ledger',async()=>{
  const f=await fixture(),i=await issue(f);expect(await f.store.read(f.org)).toEqual(i.commit.book);
  const before=await f.read();for(const amount of ['100','200']){const p={...f.payment(amount),invoiceId:i.invoiceId};await f.store.commit(await f.prepare(p,randomUUID()));}
  const c=await f.authorize(await f.read(),{type:'customer_credit',idempotencyKey:randomUUID(),invoiceId:i.invoiceId,transactionDate:f.day,accountingDate:f.day,periodId:'year',reason:'Synthetic credit of new invoice',selections:[{lineId:'line-0',quantityUnits:'1'}]});await f.store.commit(await f.prepare(c,'new-credit'));
  const view=await projectUsFinancialBookV5(await f.read()),invoice=view.invoices.find(x=>x.id===i.invoiceId)!;expect(invoice.payments.map(p=>p.amount.minorUnits)).toEqual(['100','200']);expect(view.credits.at(-1)?.allocation.totalMinor).toBe('9826');expect(view.settlements.find(x=>x.invoiceId===i.invoiceId)).toMatchObject({totalMinor:'29478',receivedMinor:'300',creditedMinor:'9826',outstandingMinor:'19352'});expect((await f.read()).baseline).toEqual(before.baseline);
 });
 it('returns exact original reservation/proof/append after later financial events without extending clocks',async()=>{
  const f=await fixture(),i=await issue(f);await f.append(await f.prepare(f.payment('100'),'later-payment'));
  const original=await i.fiscal.reserve(f.actor,i.preparation,i.resolved);expect(original.status).toBe('committed');expect(original.reservedAt).toBe(i.saved.reservedAt);expect(original.retryUntil).toBe(i.saved.retryUntil);expect(await f.store.commit(i.commit)).toEqual(i.commit.receipt);
  expect(await i.fiscal.read(f.actor,lookup(i.preparation))).toEqual(original);
 });
 it('continues a credit, manual journal, closed period and new open period into issuance and settlement',async()=>{
  const f=await fixture({shortPeriod:true});await f.append(await f.prepare(await f.credit(await f.read()),'old-credit'));
  const tomorrow=new Date(Date.parse(f.day+'T12:00:00Z')+86400000).toISOString().slice(0,10);
  const journal:ErpCommand={type:'post_manual_journal',id:'capital',transactionDate:f.day,accountingDate:f.day,periodId:'year',description:'Synthetic financing, no money moved',sourceReference:'Synthetic declared capital',cashFlowCategory:'financing',lines:[{accountId:'cash',debitMinor:'250',creditMinor:'0'},{accountId:'equity',debitMinor:'0',creditMinor:'250'}]};
  for(const [command,id] of [[journal,'capital'],[{type:'close_period',periodId:'year'},'year'],[{type:'open_period',id:'next',start:tomorrow,end:(Number(f.day.slice(0,4))+1)+'-12-31'},'next']] as const)await f.append(await f.prepare(operation(command),id));
  const i=await issue(f,{date:tomorrow,periodId:'next'});await f.append(await f.prepare({...f.payment('100'),invoiceId:i.invoiceId,paymentDate:tomorrow,accountingDate:tomorrow,periodId:'next'},'new-payment'));
  const credit=await f.authorize(await f.read(),{type:'customer_credit',idempotencyKey:randomUUID(),invoiceId:i.invoiceId,transactionDate:tomorrow,accountingDate:tomorrow,periodId:'next',reason:'Synthetic new-period credit',selections:[{lineId:'line-0',quantityUnits:'1'}]});await f.append(await f.prepare(credit,'next-credit'));
  const view=await projectUsFinancialBookV5(await f.read());expect(view.ledger.revision).toBe(view.ledger.audit.length);expect(view.ledger.periods.map(p=>p.status)).toEqual(['closed','open']);expect(view.ledger.audit.length-view.ledger.entries.length).toBe(2);expect(view.settlements.find(s=>s.invoiceId===i.invoiceId)).toMatchObject({receivedMinor:'100',creditedMinor:'9826',outstandingMinor:'19552'});expect(await f.store.read(f.org)).toEqual(await f.read());
 },20000);
 it('rejects customer invoice append lacking the durable original calculation with zero mutation',async()=>{
  const f=await fixture(),r=await reservation(f),c=await calculation(f,r);const before=await f.read();const bad=structuredClone(c.commit);const e=bad.book.events.at(-1)!;if(e.operation.type!=='erp_command'||e.operation.facts.kind!=='invoice_issuance')throw Error('invoice expected');Object.assign(e.operation.facts.taxAssessment,{providerReference:'taxcalc_Substituted'});await expect(f.append(bad)).rejects.toMatchObject({code:'PF004'});expect(await f.read()).toEqual(before);
 });
 it('preserves fixture provenance and rejects a fabricated provider observation in the calculation',async()=>{
  const f=await fixture(),r=await reservation(f),c=await calculation(f,r);expect(r.preparation.context.binding.evidenceKind).toBe('test_fixture');const bad={...c.proof,evidenceKind:'provider_observation'};await expect(result('select public.zentra_record_us_financial_invoice_test_calculation_v5($1,$2,1,$3,$4::uuid,$5,$6,$7) result',[f.org,f.actor,capability,r.resolved.operationId,canonicalErpJson(bad),hash(canonicalErpJson(bad)),c.assessment])).rejects.toMatchObject({code:'PF002'});
 });
 it('closes all old financial profiles before replay of an invoice-only tail',async()=>{
  const f=await fixture();await issue(f);for(const [suffix,cap] of [['accounting','accounting'],['purchasing','purchasing'],['commercial','commercial'],['settlement','settlement']] as const)await expect(result(`select public.zentra_read_us_financial_${suffix}_test_v5($1,$2,1,$3) result`,[f.org,f.actor,`postgres-test-${cap}-v5`])).rejects.toMatchObject({code:'PF008'});
 });
 it('rejects a stale book after calculation and leaves the stored pending operation intact',async()=>{
  const f=await fixture(),r=await reservation(f),c=await calculation(f,r);await f.append(await f.prepare(f.payment('1'),'concurrent-payment'));await expect(f.append(c.commit)).rejects.toMatchObject({code:'PF001'});expect((await r.fiscal.read(f.actor,lookup(r.preparation)))?.status).toBe('calculated');
 });
 it('denies revoked/version changed/foreign tenant and nonfinancial authority on reads and append',async()=>{
  const f=await fixture(),i=await issue(f);await db.query('update public.zentra_us_financial_test_grants set enabled=false,version=2 where organization_id=$1',[f.org]);await expect(f.append(i.commit)).rejects.toMatchObject({code:'PF005'});await expect(f.read()).rejects.toMatchObject({code:'PF005'});
  await db.query('update public.zentra_us_financial_test_grants set enabled=true,version=3 where organization_id=$1',[f.org]);await expect(f.read()).rejects.toMatchObject({code:'PF006'});for(const actor of [{...f.actor,role:'member'},{...f.actor,organizationId:randomUUID()}])await expect(result('select public.zentra_read_us_financial_invoicing_test_v5($1,$2,3,$3) result',[f.org,actor,capability])).rejects.toMatchObject({code:'PF005'});
 });
 it('keeps the context DB-owner-only and all fiscal/financial functions private invoker',async()=>{
  const f=await fixture(),ctx=await context(f);await expect(sql('insert into public.zentra_us_financial_invoice_test_contexts values($1,2,$2)',[f.org,{...ctx,revision:2}])).rejects.toMatchObject({code:'42501'});
  const rows=await db.query<{n:number}>('select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=\'public\' and (p.proname like \'zentra_us_invoicing_%\' or p.proname like \'%financial_invoice_test%\' or p.proname like \'%financial_invoicing_test%\') and (p.prosecdef or has_function_privilege(\'anon\',p.oid,\'EXECUTE\') or has_function_privilege(\'authenticated\',p.oid,\'EXECUTE\'))');expect(rows.rows[0].n).toBe(0);
 });
 it('requires a confirmed exact sales order before reserving, while an order-free source is admitted',async()=>{
  const f=await fixture({activeOrder:true}),before=await f.read();await expect(reservation(f,{quoteId:'ordered-quote'})).rejects.toMatchObject({code:'sales_order_confirmation_required'});expect(await f.read()).toEqual(before);
  const confirmed=await fixture({confirmedOrder:true}),i=await issue(confirmed,{quoteId:'ordered-quote'});expect((await projectUsFinancialBookV5(await confirmed.read())).invoices.at(-1)?.id).toBe(i.invoiceId);
  const source=i.preparation.estimate;await expect(result('select public.zentra_us_invoicing_source($1,$2,$3) result',[confirmed.org,{...source,notes:'Synthetic mismatched confirmation source'},confirmed.actor.timestamp])).rejects.toMatchObject({code:'PO011'});
 });
 it('fences every new mutation against invoice-reserved and legacy pending fiscal keys',async()=>{
  const f=await fixture(),r=await reservation(f),before=await f.read();await expect(f.append(await f.prepare({...f.payment('1'),idempotencyKey:r.preparation.request.idempotencyKey},'reused-prepared-key'))).rejects.toMatchObject({code:'PF002'});expect(await f.read()).toEqual(before);
  const legacy=await fixture({pendingTax:true}),legacyBefore=await legacy.read();await expect(legacy.append(await legacy.prepare({...legacy.payment('1'),idempotencyKey:legacy.pendingKey!},'legacy-reserved-key'))).rejects.toMatchObject({code:'PF002'});expect(await legacy.read()).toEqual(legacyBefore);
  await expect(reservation(legacy,{invoiceId:'pending-invoice'})).rejects.toMatchObject({code:'idempotency_conflict'});
  await expect(reservation(legacy,{quoteId:'new-quote',operationId:legacy.pendingOperationId!})).rejects.toMatchObject({code:'idempotency_conflict'});
 });
 it('reserves pending invoice and operation identities across requests',async()=>{
  const f=await fixture(),r=await reservation(f);await expect(reservation(f,{quoteId:r.command.estimateId,invoiceId:r.invoiceId})).rejects.toMatchObject({code:'idempotency_conflict'});
  const id=await acceptedQuote(f,'second-quote');await expect(reservation(f,{quoteId:id,invoiceId:'second-invoice',operationId:r.resolved.operationId})).rejects.toMatchObject({code:'idempotency_conflict'});
 });
 it('keeps an already valid historical fiscal-key collision readable and replayable after installation',async()=>{
  expect(previousBook.events.at(-1)?.operation.idempotencyKey).toBe(previousFixture.pendingKey);expect(await previousFixture.read()).toEqual(previousBook);
  const last=previousBook.events.at(-1)!,prefix={...previousBook,revision:last.revision-1,events:previousBook.events.slice(0,-1)},replay=await previousFixture.prepare(last.operation,last.id,prefix);expect(await previousFixture.append(replay)).toEqual(replay.receipt);
 });
 it('requires atomic operation registration and forbids calculated operations inserted directly',async()=>{
  const f=await fixture(),r=await reservation(f),c=await calculation(f,r),before=await f.read();
  await expect(sql('insert into public.zentra_us_financial_invoice_test_operations values($1,$2::uuid,$3,$4,$5,1)',[f.org,randomUUID(),'fabricated-op',{...c.saved,operationId:randomUUID()},f.actor])).rejects.toMatchObject({code:'PF004'});
  const g=await fixture(),q=await reservation(g);const other={...q.preparation,request:{...q.preparation.request,idempotencyKey:'other'}};await expect(sql('insert into public.zentra_us_financial_invoice_test_preparations values($1,$2,$3,$4,1)',[g.org,'other',other,g.actor])).rejects.toMatchObject({code:'PF004'});expect(await f.read()).toEqual(before);
 });
 it('rolls back direct invoice event, receipt and cursor unless its operation is atomically committed',async()=>{
  const f=await fixture(),r=await reservation(f),c=await calculation(f,r),e=c.commit.book.events.at(-1)!,before=await f.read();
  await expect(db.transaction(async tx=>{await tx.exec('set local role service_role');await tx.query('insert into public.zentra_us_financial_test_events values($1,$2,$3,1)',[f.org,e.revision,e]);await tx.query('insert into public.zentra_us_financial_test_receipts values($1,$2,$3,$4,$5)',[f.org,c.commit.receipt.idempotencyKey,'financial_v5',f.user,c.commit.receipt]);await tx.query('update public.zentra_us_financial_test_cursors set revision=$2,book_sha256=$3 where organization_id=$1',[f.org,c.commit.book.revision,hash(canonicalErpJson(c.commit.book))]);})).rejects.toMatchObject({code:'PF014'});expect(await f.read()).toEqual(before);expect((await r.fiscal.read(f.actor,lookup(r.preparation)))?.status).toBe('calculated');
 });
 it('rejects direct event use of a reserved fiscal key before any financial changes',async()=>{
  const f=await fixture(),r=await reservation(f),c=await f.prepare({...f.payment('1'),idempotencyKey:r.preparation.request.idempotencyKey},'direct-reused-key'),e=c.book.events.at(-1)!;await expect(sql('insert into public.zentra_us_financial_test_events values($1,$2,$3,1)',[f.org,e.revision,e])).rejects.toMatchObject({code:'PF002'});expect(await f.read()).toEqual(r.before);
 });
 it('rechecks live PO011 at append but never applies it to historical read, receipt or exact retry',async()=>{
  const f=await fixture(),i=await issue(f),g=await fixture(),r=await reservation(g),c=await calculation(g,r),definition=(await db.query<{d:string}>("select pg_get_functiondef('public.zentra_us_invoicing_source(text,jsonb,text)'::regprocedure) d")).rows[0].d;
  await db.exec("create or replace function public.zentra_us_invoicing_source(org text,estimate jsonb,issued_at text) returns void language plpgsql volatile security invoker set search_path='' as $$begin raise exception using errcode='PO011',message='Synthetic live source changed';end$$;");
  try{await expect(g.append(c.commit)).rejects.toMatchObject({code:'PO011'});expect(await f.store.commit(i.commit)).toEqual(i.commit.receipt);expect(await f.store.read(f.org)).toEqual(i.commit.book);expect((await i.fiscal.read(f.actor,lookup(i.preparation)))?.status).toBe('committed');}finally{await db.exec(definition);}
 });
 it('rejects inner/outer hash confusion before fiscal catalogue or reservation',async()=>{
  const f=await fixture(),r=await reservation(f);await expect(result('select public.zentra_preflight_us_financial_invoice_test_v5($1,$2,1,$3,$4,$5,$6,$7) result',[f.org,f.actor,capability,r.preparation.request,r.preparation.erpCommandHash,r.preparation.financialCommandHash,r.preparation.previousBookFingerprint])).rejects.toMatchObject({code:'PF002'});
 });
 it('corroborates proof order, account, canonical text and chronology independently in SQL',async()=>{
  const f=await fixture({lines:2}),r=await reservation(f),c=await calculation(f,r);
  const badProofs=[{...c.proof,accountId:'acct_ForeignSynthetic'},{...c.proof,calculatedAt:new Date(Date.parse(r.saved.reservedAt)-1).toISOString()},{...c.proof,lines:[...c.proof.lines].reverse()},{...c.proof,lines:c.proof.lines.map(l=>({...l,breakdowns:l.breakdowns.map(b=>({...b,jurisdiction:{...b.jurisdiction,displayName:' Noncanonical '}}))}))}];
  for(const proof of badProofs){const v={...c.saved,proofBody:canonicalErpJson(proof),proofSha256:hash(canonicalErpJson(proof))};expect(await result('select public.zentra_us_invoicing_operation_valid($1,$2) result',[v,f.org])).toBe(false);await expect(validateUsFinancialInvoiceOperationV5(v,f.org,true)).rejects.toBeDefined();}
  expect(await result('select public.zentra_us_invoicing_operation_valid($1,$2) result',[c.saved,f.org])).toBe(true);
 });
 it('rejects stale or widened context windows and preparations before their admitted observation',async()=>{
  const f=await fixture(),r=await reservation(f),ctx=r.preparation.context;const rehash=(v:Record<string,unknown>,field:string)=>{const copy={...v};delete copy[field];return{...copy,[field]:hash(canonicalErpJson(copy))};};
  for(const binding of [{...ctx.binding,validUntil:new Date(Date.parse(ctx.binding.observedAt)+120001).toISOString()},{...ctx.binding,observedAt:new Date(Date.parse(ctx.admittedAt)+1).toISOString()}]){const v=rehash({...ctx,binding},'contextSha256');expect(await result('select public.zentra_us_invoicing_context_valid($1,$2) result',[v,f.org])).toBe(false);}
  const p=rehash({...r.preparation,preparedAt:new Date(Date.parse(ctx.admittedAt)-1).toISOString()},'preparationSha256');expect(await result('select public.zentra_us_invoicing_preparation_valid($1,$2,$3) result',[p,f.org,f.user])).toBe(false);
  const zero={...r.saved,operationId:'00000000-0000-0000-0000-000000000000'};expect(await result('select public.zentra_us_invoicing_operation_valid($1,$2) result',[zero,f.org])).toBe(false);
 });
 it('keeps completed history available when a fresh context can no longer be obtained',async()=>{
  const f=await fixture(),i=await issue(f),definition=(await db.query<{d:string}>("select pg_get_functiondef('public.zentra_us_invoicing_context(text)'::regprocedure) d")).rows[0].d;
  await db.exec("create or replace function public.zentra_us_invoicing_context(org text) returns jsonb language plpgsql volatile security invoker set search_path='' as $$begin raise exception using errcode='PF014',message='Synthetic expired merchant observation';end$$;");
  try{expect(await f.store.commit(i.commit)).toEqual(i.commit.receipt);expect((await i.fiscal.read(f.actor,lookup(i.preparation)))?.status).toBe('committed');}finally{await db.exec(definition);}
 });
 it('blocks issuance when a current period closes after calculation',async()=>{
  const f=await fixture(),r=await reservation(f),c=await calculation(f,r);await f.append(await f.prepare(operation({type:'close_period',periodId:'year'}),'year'));await expect(f.append(c.commit)).rejects.toMatchObject({code:'PF001'});
  await expect(reservation(f,{quoteId:r.command.estimateId,invoiceId:'another-invoice'})).rejects.toMatchObject({code:'accounting_period_not_open'});
 });
 it('retains the same canonical book and committed operation after clean NodeFS close/reopen',async()=>{
  const f=await fixture(),i=await issue(f),before=await f.read();await db.close();db=new PGlite(dataDir);expect(await f.read()).toEqual(before);expect((await i.fiscal.read(f.actor,lookup(i.preparation)))?.receipt).toEqual(i.commit.receipt);console.info(`Retained synthetic PostgreSQL dataDir: ${dataDir}`);
 });
});
