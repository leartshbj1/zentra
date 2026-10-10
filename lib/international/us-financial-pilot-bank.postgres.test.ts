import { projectUsFinancialPilotBankStatement } from './us-financial-pilot-bank-projection';
import { createUsFinancialPilotBankHandlers } from './us-financial-pilot-bank-server';
import { applyUsBankCommand } from './us-bank-reconciliation';
import { createSupabaseUsBankStore } from './us-bank-store';
import type { UsBankRecord, UsBankRequest } from './us-bank-contract';import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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


// Actual 34 migrations, SQL and pilot HTTP handlers on retained NodeFS.
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
 zentra_commit_us_bank_reconciliation:['p_organization','p_actor','p_supported_schema_version','p_expected_erp_revision','p_expected_reconciliation_revision','p_record','p_receipt'],
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
async function fixture(options:{tax?:string;quantity?:string;scale?:number;discount?:number;unitPrice?:string;lines?:number;paid?:string;paymentCount?:number;closed?:boolean;laterOpen?:boolean;periodCount?:number;unpromoted?:boolean;activeOrder?:boolean;confirmedOrder?:boolean;pendingTax?:boolean;shortPeriod?:boolean;projects?:boolean;baselinePurchases?:boolean;collisionId?:string;purchasePaging?:boolean;journalPaging?:boolean;legacy?:boolean;legacyLargeVoid?:boolean}={}){
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
 const legacy:UsBankRecord[]=[];
 if(options.legacy||options.legacyLargeVoid){
  const oldStore=createSupabaseUsBankStore(client,{supportedSchemaVersion:4}),source=(await erp.read(org))!;
  const oldSend=async(id:string,command:UsBankRequest['command'])=>{actor={...actor,timestamp:new Date().toISOString()};const previous=legacy.find(r=>r.reconciliation.statement.id===id)??null,request:UsBankRequest={schemaVersion:1,idempotencyKey:'synthetic-legacy-bank-'+randomUUID(),reconciliationId:id,expectedErpRevision:source.revision,expectedReconciliationRevision:previous?.reconciliation.revision??null,command};const record=applyUsBankCommand(previous,request,source.ledger,actor,legacy);const receipt={schemaVersion:1 as const,organizationId:org,idempotencyKey:request.idempotencyKey,commandHash:hash(canonicalErpJson([org,user,request])),actorId:user,reconciliationId:id,action:command.type,revision:record.reconciliation.revision,erpRevision:source.revision};await oldStore.commit({actor,expectedErpRevision:source.revision,expectedReconciliationRevision:request.expectedReconciliationRevision,record,receipt});const i=legacy.findIndex(r=>r.reconciliation.statement.id===id);if(i<0)legacy.push(record);else legacy[i]=record;return record;};
  const movements=source.ledger.entries.map(e=>({e,minor:e.lines.filter(l=>l.accountId==='cash').reduce((n,l)=>n+BigInt(l.debitMinor)-BigInt(l.creditMinor),BigInt(0))})).filter(r=>r.minor!==BigInt(0));
  for(const kind of (options.legacyLargeVoid?['voided']:['completed','pending','voided']) as readonly ('completed'|'pending'|'voided')[]){const id=randomUUID(),date=kind==='completed'?day:`${year}-01-${kind==='pending'?'01':'02'}`,lines=options.legacyLargeVoid?Array.from({length:1000},(_,i)=>({id:id+':'+(i+1),date,amount:{currency:'USD' as const,minorUnits:'1'},reference:'漢'.repeat(256)})):kind==='completed'?movements.map((row,i)=>({id:id+':'+(i+1),date,amount:{currency:'USD' as const,minorUnits:row.minor.toString()},reference:'Synthetic frozen cash '+i})):[];const closing=lines.reduce((n,l)=>n+BigInt(l.amount.minorUnits),BigInt(0)).toString();await oldSend(id,{type:'create_statement',statement:{id,organizationId:org,currency:'USD',externalConnectionId:'manual-csv:legacy',cashAccountId:'cash',start:date,end:date,opening:{currency:'USD',minorUnits:'0'},closing:{currency:'USD',minorUnits:closing},lines}});if(kind==='completed'){if(movements.length)await oldSend(id,{type:'approve_match',id:randomUUID(),statementLineIds:lines.map(l=>l.id).sort(),ledgerEntryIds:movements.map(r=>r.e.id).sort()});await oldSend(id,{type:'complete'});}else if(kind==='voided')await oldSend(id,{type:'void_statement',reason:'Synthetic frozen unused review'});}
 }
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
 return{org,user,config,get actor(){return actor;},refresh,day,policy,scope,baseline,initial,foundation,enable,capture,store,read,payment,prepare,credit,get pilotScope(){return pilotScope;},legacy};
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
import { validateUsFinancialPilotAccountingReceipt, type UsFinancialPilotAccountingRequest, type UsFinancialPilotAccountingCommand } from './us-financial-pilot-accounting';
import { createUsFinancialPilotPurchasingHandlers } from './us-financial-pilot-purchasing-server';
import { validateUsFinancialPilotPurchasingReceipt, type UsFinancialPilotPurchasingRequest } from './us-financial-pilot-purchasing';
import { createUsFinancialPilotHandlers, type UsFinancialPilotDependencies } from './us-financial-pilot-server';
import { projectUsFinancialPilotReports } from './us-financial-pilot-reports';
import { buildUsFinancialPilotExportSnapshot } from './us-financial-pilot-export-projection';

const privateTables = ['zentra_us_erp_heads', 'zentra_us_erp_records', 'zentra_us_erp_receipts', 'zentra_us_erp_ledger_audit', 'zentra_us_financial_test_heads', 'zentra_us_financial_test_events', 'zentra_us_financial_test_receipts', 'zentra_us_financial_test_cursors', 'zentra_us_financial_test_tax_plans', 'zentra_us_financial_invoice_test_preparations', 'zentra_us_financial_invoice_test_operations', 'zentra_us_tax_operations'];
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
function assertMixedAmounts(view:Awaited<ReturnType<typeof projectUsFinancialBookV5>>,reports:Awaited<ReturnType<typeof projectUsFinancialPilotReports>>,exports:Awaited<ReturnType<typeof mixedExports>>,originalRevision:number){
 // Independent line accumulation: neither reporting nor export helpers are used
 // to derive these account balances and ordered cash movement expectations.
 const net=new Map(view.ledger.accounts.map(a=>[a.id,BigInt(0)]));for(const e of view.ledger.entries)for(const l of e.lines)net.set(l.accountId,net.get(l.accountId)!+BigInt(l.debitMinor)-BigInt(l.creditMinor));
 expect(Object.fromEntries([...net].map(([id,n])=>[id,n.toString()]))).toEqual({cash:'-57',receivables:'49030',inventory:'0','fixed-assets':'0',payables:'-57','tax-payable':'-4125',deposits:'0',equity:'0',sales:'-45005',purchases:'214','bank-fees':'0'});
 const tb=view.ledger.accounts.map(a=>{const n=net.get(a.id)!;return{accountId:a.id,code:a.code,name:a.name,type:a.type,debitMinor:(n>BigInt(0)?n:BigInt(0)).toString(),creditMinor:(n<BigInt(0)?-n:BigInt(0)).toString()};});expect(reports.trialBalance).toEqual({rows:tb,totalDebitMinor:'49244',totalCreditMinor:'49244',balanced:true});
 const bs=view.ledger.accounts.filter(a=>['asset','liability','equity'].includes(a.type)).map(a=>({accountId:a.id,name:a.name,type:a.type,amountMinor:(a.type==='asset'?net.get(a.id)!:-net.get(a.id)!).toString()})),pl=view.ledger.accounts.filter(a=>['income','expense'].includes(a.type)).map(a=>({accountId:a.id,name:a.name,type:a.type,amountMinor:(a.type==='expense'?net.get(a.id)!:-net.get(a.id)!).toString()}));
 expect(reports.balanceSheet).toEqual({rows:bs,assetsMinor:'48973',liabilitiesMinor:'4182',equityMinor:'0',unclosedEarningsMinor:'44791',balanced:true});expect(reports.profitAndLoss).toEqual({rows:pl,incomeMinor:'45005',expenseMinor:'214',profitMinor:'44791'});
 let running=BigInt(0);const gl=[...view.ledger.entries].sort((a,b)=>a.accountingDate.localeCompare(b.accountingDate)||a.revision-b.revision).flatMap(e=>e.lines.filter(l=>l.accountId==='cash').map(l=>{running+=BigInt(l.debitMinor)-BigInt(l.creditMinor);const source=e.source.type==='manual_journal'?{kind:'manual_journal',entityId:null,reference:e.source.id,journalRevision:null}:e.source.type==='manual_reversal'?{kind:'manual_reversal',entityId:null,reference:null,journalRevision:originalRevision}:e.source.type==='vendor_payment'?{kind:'vendor_payment',entityId:e.source.id,reference:view.vendorBills.find(b=>b.id===e.source.id)!.reference,journalRevision:null}:{kind:'customer_payment',entityId:e.source.id,reference:view.invoices.find(i=>i.id===e.source.id)!.number,journalRevision:null};return{journalRevision:e.revision,transactionDate:e.transactionDate,accountingDate:e.accountingDate,paymentDate:e.paymentDate??null,debitMinor:l.debitMinor,creditMinor:l.creditMinor,balanceMinor:running.toString(),source};}));
 expect(gl).toHaveLength(5);expect(reports.generalLedger!.movements.items).toEqual(gl);expect(reports.generalLedger).toMatchObject({openingMinor:'0',closingMinor:'-57',pageOpeningMinor:'0',pageClosingMinor:'-57'});
 const amounts=(index:number)=>exports[index].sections[0].totals.map(r=>r.minorUnits);expect(exports[0].sections[0].rows).toEqual(tb.map(r=>[r.code,r.name,r.type,r.debitMinor,r.creditMinor]));expect(amounts(0)).toEqual(['49244','49244']);
 expect(exports[1].sections[0].rows).toEqual(gl.map(r=>[String(r.journalRevision),r.transactionDate,r.accountingDate,r.paymentDate??'',r.source.reference??`#${r.source.journalRevision}`,r.debitMinor,r.creditMinor,r.balanceMinor]));expect(amounts(1)).toEqual(['0','-57']);expect(exports[2].sections[0].rows).toEqual([]);expect(amounts(2)).toEqual(['0','-57','0','0','-57','-57']);expect(exports[3].sections[0].rows).toEqual(bs.map(r=>[r.name,r.type,r.amountMinor]));expect(amounts(3)).toEqual(['48973','4182','0','44791']);expect(exports[4].sections[0].rows).toEqual(pl.map(r=>[r.name,r.type,r.amountMinor]));expect(amounts(4)).toEqual(['45005','214','44791']);
}


import { createSupabaseUsFinancialPilotBankStore } from './us-financial-pilot-bank-store';
import { applyUsFinancialPilotBank, buildUsFinancialPilotBankProof, executeUsFinancialPilotBank, type UsFinancialPilotBankRequest, type UsFinancialPilotBankCommit, type UsFinancialPilotBankRead } from './us-financial-pilot-bank';


const bankMigration='20261010155848_international_us_financial_pilot_bank_test_v1';
const bankCommon=['p_organization','p_actor','p_grant_version','p_opt_in_version','p_capability'];
Object.assign(parameters,{
 zentra_read_us_financial_pilot_bank_test_v1:bankCommon,
 zentra_us_financial_pilot_bank_test_head_v1:bankCommon,
 zentra_us_financial_pilot_bank_test_receipt_v1:[...bankCommon,'p_request_id'],
 zentra_commit_us_financial_pilot_bank_test_v1:[...bankCommon,'p_request','p_record','p_proof'],
});
const bankTables=['zentra_us_financial_bank_test_reconciliations','zentra_us_financial_bank_test_receipts','zentra_us_financial_bank_test_audit','zentra_us_financial_bank_test_entry_claims'];
async function bankState(f:Fixture){const rows=[];for(const table of bankTables)rows.push(await sql(`select to_jsonb(t) row from public.${table} t where organization_id=$1 order by to_jsonb(t)::text`,[f.org]));return canonicalErpJson(rows);}
function bankPort(f:Fixture){if(!f.pilotScope)throw Error('Explicit pilot opt-in required');return createSupabaseUsFinancialPilotBankStore(client,f.pilotScope,()=>f.capture(f.pilotScope));}
function bankInput(f:Fixture,read:UsFinancialPilotBankRead,command:UsFinancialPilotBankRequest['command'],r:number|null=null,requestId:string=randomUUID()):UsFinancialPilotBankRequest{return{consumer:'financial-pilot',schemaVersion:1,requestId,expectedRevision:read.book.revision,expectedBankRevision:read.register.bankRevision,expectedStatementRevision:r,command};}
async function bankCandidate(f:Fixture,input:UsFinancialPilotBankRequest,read?:UsFinancialPilotBankRead):Promise<UsFinancialPilotBankCommit>{const source=read??await bankPort(f).read(),actor=f.refresh(),record=applyUsFinancialPilotBank(input,await projectUsFinancialBookV5(source.book),source.register,actor),proof=await buildUsFinancialPilotBankProof(input,source.book,actor,record);return{request:input,record,proof};}
function bankRun(f:Fixture,input:UsFinancialPilotBankRequest,store=bankPort(f)){return executeUsFinancialPilotBank({organizationId:f.org,actor:f.refresh(),policy:f.policy,store,revalidate:async()=>({actor:f.refresh(),policy:f.policy})},input);}
async function bankHttp(f:Fixture,input:UsFinancialPilotBankRequest){const h=http(f),handlers=createUsFinancialPilotBankHandlers({...h.deps,store:(scope,revalidate)=>createSupabaseUsFinancialPilotBankStore(client,scope,revalidate)});const response=await handlers.POST(h.request('bank/operations',input),f.org);if(response.status!==200)throw Error('Synthetic bank HTTP '+response.status+' '+JSON.stringify(await response.json()));return response.json();}
async function rawBankCommit(f:Fixture,c:UsFinancialPilotBankCommit){return result('select public.zentra_commit_us_financial_pilot_bank_test_v1($1,$2,1,1,$3,$4,$5,$6) result',[f.org,c.proof.actor,'postgres-test-financial-pilot-dto1',c.request,c.record.record,c.proof]);}
type Mutable<T> = T extends readonly (infer V)[] ? Mutable<V>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const clone=<T>(value:T):Mutable<T>=>structuredClone(value) as Mutable<T>;
function rehash(c:Mutable<UsFinancialPilotBankCommit>){c.proof.request=c.request;c.proof.commandHash=hash(canonicalErpJson([c.proof.organizationId,c.proof.actor.userId,c.request]));return c;}
/** Bypass every TS validator while retaining coherent SQL candidates and bundles. */
async function directBundle(f:Fixture,c:UsFinancialPilotBankCommit,options:{receipt?:boolean;audit?:boolean;claim?:'missing'|'statement'|'match'|'cash'|'entry'}={}){
 return db.transaction(async tx=>{
  await tx.exec('set local role service_role');const p=c.proof,r=c.record.record,id=p.statementId;
  if(c.request.command.type==='create_statement')await tx.query('insert into public.zentra_us_financial_bank_test_reconciliations values($1,$2,$3,$4,$5,1,1)',[f.org,id,p.statementRevision,r,p]);
  else await tx.query('update public.zentra_us_financial_bank_test_reconciliations set revision=$3,payload=$4,proof=$5 where organization_id=$1 and id=$2',[f.org,id,p.statementRevision,r,p]);
  if(options.receipt!==false)await tx.query('insert into public.zentra_us_financial_bank_test_receipts values($1,$2,$3,$4,$5,$6,1,1)',[f.org,c.request.requestId,id,p.bankRevision,p.statementRevision,p]);
  if(options.audit!==false)await tx.query('insert into public.zentra_us_financial_bank_test_audit values($1,$2,$3,1,1)',[f.org,p.bankRevision,p]);
  if(c.request.command.type==='approve_match'&&options.claim!=='missing')for(const entry of r.reconciliation.matches.at(-1)!.ledgerEntryIds){let statement=id;if(options.claim==='statement')statement=(await tx.query<{id:string}>('select id from public.zentra_us_financial_bank_test_reconciliations where organization_id=$1 and id<>$2',[f.org,id])).rows[0].id;await tx.query('insert into public.zentra_us_financial_bank_test_entry_claims values($1,$2,$3,$4,$5,$6)',[f.org,options.claim==='entry'?'synthetic-false-entry':entry,options.claim==='cash'?'synthetic-false-cash':r.reconciliation.statement.cashAccountId,statement,options.claim==='match'?randomUUID():c.request.requestId,p.bankRevision]);}
 });
}
let bankRetained:{f:Fixture;read:UsFinancialPilotBankRead;requests:UsFinancialPilotBankRequest[];financial:string;bank:string;detail:unknown;reports:unknown;exports:unknown}|undefined;

describe.skipIf(!enabled)('private bank V5 review — actual 34-migration serialized PostgreSQL',()=>{
 beforeAll(async()=>{const require=createRequire(import.meta.url);({PGlite}=require(join(directory!,'dist/index.cjs')) as {PGlite:new(dataDir?:string)=>Db});dataDir=await mkdtemp(join(tmpdir(),'zentra-financial-pilot-bank-'));db=new PGlite(dataDir);await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');for(const name of [...migrations,migration,invoiceMigration,bankMigration])await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));},30000);
 afterAll(async()=>{await db?.close();});
 it('imports and voids an empty exact statement without changing financial bytes',async()=>{
  expect([...migrations,migration,invoiceMigration,bankMigration]).toHaveLength(34);const f=await fixture();await f.enable();const port=bankPort(f),read=await port.read(),financial=await state(f);
  expect(await port.head()).toMatchObject({revision:read.book.revision,bankRevision:0});
  const input=bankInput(f,read,{type:'create_statement',cashAccountId:'cash',start:f.day,end:f.day,openingMinor:'0',closingMinor:'0',lines:[]});
  expect((await bankRun(f,input)).receipt).toMatchObject({revision:read.book.revision,bankRevision:1,statementRevision:0});
  const next=await port.read();expect(next.register.records).toHaveLength(1);const voided=bankInput(f,next,{type:'void_statement',statementId:input.requestId,reason:'Synthetic unused import'},0);await bankRun(f,voided);
  expect((await port.read()).register.records[0].record.voided?.reason).toBe('Synthetic unused import');expect(await state(f)).toBe(financial);
  const before=await bankState(f);expect((await bankRun(f,input)).replayed).toBe(true);expect(await bankState(f)).toBe(before);
 },30000);
 it('reconciles real mixed V5 cash journals, preserves the financial book and distinguishes historical completion after a later journal',async()=>{
  const t=await httpFixture({baselinePurchases:true}),f=t.f;await issue(t);const h=http(f);await f.store().commit(await f.prepare(await f.credit(await f.read())));await f.store().commit(await f.prepare(f.payment('100')));
  const posted=await submit(f,journal(f),h),view=await projectUsFinancialBookV5(await f.read()),original=view.ledger.entries.find(e=>e.id===posted.entityId)!;await submit(f,reversal(f,original.revision),h);await submit(f,{type:'close_period',periodId:'year'},h);
  const year=Number(f.day.slice(0,4))+1,opened=await submit(f,{type:'open_period',start:`${year}-01-01`,end:`${year}-12-31`},h);
  const purchase:UsFinancialPilotPurchasingRequest={consumer:'financial-pilot',schemaVersion:1,requestId:randomUUID(),expectedRevision:(await f.read()).revision,command:{type:'record_vendor_bill',vendorId:'vendor',reference:'Synthetic new period bank original',date:`${year}-01-02`,accountingDate:`${year}-01-02`,dueDate:`${year}-01-02`,periodId:opened.entityId,netMinor:'100',purchaseTaxMinor:'7',sourceReference:'Synthetic original'}};
  const bought=validateUsFinancialPilotPurchasingReceipt(await(await h.purchasing.POST(h.request('purchasing/operations',purchase),f.org)).json(),f.org,purchase),paid:UsFinancialPilotPurchasingRequest={...purchase,requestId:randomUUID(),expectedRevision:bought.revision,command:{type:'record_vendor_payment',billId:bought.entityId,amountMinor:'107',paymentDate:`${year}-01-02`,accountingDate:`${year}-01-02`,periodId:opened.entityId,reference:'Synthetic actual book payment'}};expect((await h.purchasing.POST(h.request('purchasing/operations',paid),f.org)).status).toBe(200);
  const port=bankPort(f),before=await port.read(),current=await projectUsFinancialBookV5(before.book),financial=await state(f),from=`${year-1}-01-01`,to=`${year}-12-31`,reports=await projectUsFinancialPilotReports(before.book,{revision:before.book.revision,from,to,asOf:to,accountId:'cash'}),exports=await mixedExports(before.book,from,to);
  assertMixedAmounts(current,reports,exports,original.revision);
  const movements=current.ledger.entries.map(e=>({e,minor:e.lines.filter(l=>l.accountId==='cash').reduce((n,l)=>n+BigInt(l.debitMinor)-BigInt(l.creditMinor),BigInt(0))})).filter(r=>r.minor!==BigInt(0));expect(movements).toHaveLength(5);expect(movements.reduce((n,r)=>n+r.minor,BigInt(0))).toBe(BigInt(-57));expect(current.revision).not.toBe(current.ledger.revision);
  const imported=bankInput(f,before,{type:'create_statement',cashAccountId:'cash',start:from,end:to,openingMinor:'0',closingMinor:'-57',lines:movements.map((row,i)=>({date:row.e.paymentDate??row.e.transactionDate,amountMinor:row.minor.toString(),reference:'Synthetic exact cash '+i+' · Genève'}))});expect(await bankHttp(f,imported)).toMatchObject({revision:before.book.revision,bankRevision:1,statementRevision:0});
  const afterImport=await port.read(),matched=bankInput(f,afterImport,{type:'approve_match',statementId:imported.requestId,statementLineIds:movements.map((_,i)=>imported.requestId+':'+(i+1)),journalRevisions:movements.map(r=>r.e.revision)},0);await bankHttp(f,matched);
  const completed=bankInput(f,await port.read(),{type:'complete',statementId:imported.requestId},1);await bankHttp(f,completed);const completeRead=await port.read();expect(completeRead.register.bankRevision).toBe(3);expect(completeRead.register.records[0].record.reconciliation.completedLedgerRevision).toBe(current.ledger.revision);expect(await state(f)).toBe(financial);expect(await projectUsFinancialPilotReports(completeRead.book,{revision:before.book.revision,from,to,asOf:to,accountId:'cash'})).toEqual(reports);expect(await mixedExports(completeRead.book,from,to)).toEqual(exports);expect(reports.cashFlow).toEqual({status:'available',method:'direct',openingMinor:'0',operatingMinor:'-57',investingMinor:'0',financingMinor:'0',netChangeMinor:'-57',closingMinor:'-57'});
  const immutableBank=await bankState(f);await submit(f,journal(f,{transactionDate:f.day,accountingDate:`${year}-01-03`,periodId:opened.entityId,lines:[{accountId:'cash',debitMinor:'1',creditMinor:'0'},{accountId:'equity',debitMinor:'0',creditMinor:'1'}]}),h);expect(await bankState(f)).toBe(immutableBank);const later=await port.read(),detail=await projectUsFinancialPilotBankStatement(later.book,later.register,{revision:later.book.revision,bankRevision:3,statementId:imported.requestId,origin:'financial-v5'});expect(detail.statement.completion).toMatchObject({ledgerRevision:current.ledger.revision,source:{revision:before.book.revision,ledgerRevision:current.ledger.revision}});expect(detail.current).toEqual({outstandingLineCount:0,unmatchedMovementCount:1,beginningDifferenceMinor:'0',endingDifferenceMinor:'1',ready:false});expect(detail.cashChangedSinceCompletion).toBe(true);expect(JSON.stringify(detail)).not.toMatch(/commandHash|bookSha256|idempotencyKey/);
  const pending=bankInput(f,later,{type:'create_statement',cashAccountId:'cash',start:`${year+1}-01-01`,end:`${year+1}-01-01`,openingMinor:'0',closingMinor:'0',lines:[]});await bankHttp(f,pending);const voided=bankInput(f,await port.read(),{type:'void_statement',statementId:pending.requestId,reason:'Synthetic unused later import'},0);await bankHttp(f,voided);
  const final=await port.read(),bank=await bankState(f),finalFinancial=await state(f);for(const input of [imported,matched,completed,pending,voided])expect((await bankRun(f,input)).replayed).toBe(true);expect(await bankState(f)).toBe(bank);expect(await state(f)).toBe(finalFinancial);
  bankRetained={f,read:final,requests:[imported,matched,completed,pending,voided],financial:finalFinancial,bank,detail:await projectUsFinancialPilotBankStatement(final.book,final.register,{revision:final.book.revision,bankRevision:final.register.bankRevision,statementId:imported.requestId,origin:'financial-v5'}),reports:await projectUsFinancialPilotReports(final.book,{revision:final.book.revision,from,to,asOf:to,accountId:'cash'}),exports:await mixedExports(final.book,from,to)};
 },60000);
 it.each(['lostReply','late409'] as const)('recovers the original receipt after a real commit and %s with one write',async kind=>{
  const f=await fixture();await f.enable();const port=bankPort(f),read=await port.read(),input=bankInput(f,read,{type:'create_statement',cashAccountId:'cash',start:f.day,end:f.day,openingMinor:'0',closingMinor:'0',lines:[]});let writes=0;const store={...port,commit:async(c:UsFinancialPilotBankCommit)=>{writes++;await port.commit(c);if(kind==='late409')throw new ErpError('bank_revision_conflict',409);throw Error('Synthetic lost reply');}};expect((await bankRun(f,input,store)).replayed).toBe(true);expect(writes).toBe(1);expect((await port.head()).bankRevision).toBe(1);expect((await port.read()).register.operations).toHaveLength(1);
 },30000);
 it('keeps completed/pending/voided legacy history frozen and reserves IDs/content/overlap before new writes',async()=>{
  const f=await fixture({legacy:true,paid:'100',baselinePurchases:true});await f.enable();const port=bankPort(f),read=await port.read(),before=await bankState(f);expect(read.register.records.map(r=>r.origin)).toEqual(['legacy-frozen','legacy-frozen','legacy-frozen']);expect(read.register.operations).toEqual([]);const old=f.legacy.find(r=>r.voided)!,completed=f.legacy.find(r=>r.reconciliation.completedAt)!;
  const generic={type:'create_statement' as const,cashAccountId:'cash',start:f.day.slice(0,4)+'-03-01',end:f.day.slice(0,4)+'-03-01',openingMinor:'0',closingMinor:'0',lines:[]};
  for(const row of f.legacy)await expect(bankRun(f,bankInput(f,read,generic,null,row.reconciliation.statement.id))).rejects.toMatchObject({code:'bank_statement_duplicate'});
  await expect(bankRun(f,bankInput(f,read,generic))).rejects.toMatchObject({code:'bank_legacy_pending'});
  for(const row of read.register.records){const detail=await projectUsFinancialPilotBankStatement(read.book,read.register,{revision:read.book.revision,bankRevision:0,statementId:row.record.reconciliation.statement.id,origin:'legacy-frozen'});expect(detail.current).toBeNull();expect(detail.cashChangedSinceCompletion).toBeNull();expect(detail.statement.completion?.source??null).toBeNull();expect(detail.matches.items.every(m=>m.sourceRevision===null)).toBe(true);expect(JSON.stringify(detail)).not.toContain('bookSha256');}
  const s=completed.reconciliation.statement,duplicate=bankInput(f,read,{type:'create_statement',cashAccountId:'cash',start:s.start,end:s.end,openingMinor:s.opening.minorUnits,closingMinor:s.closing.minorUnits,lines:s.lines.map(l=>({date:l.date,amountMinor:l.amount.minorUnits,reference:l.reference}))});const q={...duplicate,command:{...duplicate.command,type:'create_statement' as const}};
  await expect(result('select public.zentra_us_pilot_bank_transition($1,$2,$3,$4,$5,false) result',[f.org,q,f.refresh(),(await projectUsFinancialBookV5(read.book)).ledger,read.register.records])).rejects.toMatchObject({code:'BQ012'});expect(await bankState(f)).toBe(before);
  const overlap={...q,command:{...q.command,openingMinor:'1',closingMinor:(BigInt(s.closing.minorUnits)+BigInt(1)).toString()}};await expect(result('select public.zentra_us_pilot_bank_transition($1,$2,$3,$4,$5,false) result',[f.org,overlap,f.refresh(),(await projectUsFinancialBookV5(read.book)).ledger,read.register.records])).rejects.toMatchObject({code:'BQ003'});
  const voidStatement=old.reconciliation.statement,voidDuplicate=bankInput(f,read,{type:'create_statement',cashAccountId:'cash',start:voidStatement.start,end:voidStatement.end,openingMinor:'0',closingMinor:'0',lines:[]});await expect(bankRun(f,voidDuplicate)).rejects.toMatchObject({code:'bank_legacy_pending'});await expect(result('select public.zentra_us_pilot_bank_transition($1,$2,$3,$4,$5,false) result',[f.org,voidDuplicate,f.refresh(),(await projectUsFinancialBookV5(read.book)).ledger,read.register.records])).rejects.toMatchObject({code:'BQ012'});
  // A pure independently derived new record cannot steal a frozen legacy
  // claim, even if a caller presents it alongside that completed record.
  const ledger=(await projectUsFinancialBookV5(read.book)).ledger,claimed=ledger.entries.find(e=>completed.reconciliation.matches.some(m=>m.ledgerEntryIds.includes(e.id)))!,cashMinor=claimed.lines.filter(l=>l.accountId==='cash').reduce((n,l)=>n+BigInt(l.debitMinor)-BigInt(l.creditMinor),BigInt(0)).toString(),shadow=bankInput(f,read,{type:'create_statement',cashAccountId:'cash',start:s.start,end:s.end,openingMinor:'0',closingMinor:cashMinor,lines:[{date:s.start,amountMinor:cashMinor,reference:'Synthetic claim collision challenge'}]}),derived=await result<UsBankRecord>('select public.zentra_us_pilot_bank_transition($1,$2,$3,$4,$5,true) result',[f.org,shadow,f.refresh(),ledger,[]]),claimRequest=bankInput(f,read,{type:'approve_match',statementId:shadow.requestId,statementLineIds:[shadow.requestId+':1'],journalRevisions:[claimed.revision]},0);await expect(result('select public.zentra_us_pilot_bank_transition($1,$2,$3,$4,$5,true) result',[f.org,claimRequest,f.refresh(),ledger,[...read.register.records,{origin:'financial-v5',record:derived}]])).rejects.toMatchObject({code:'BQ004'});
  await expect(client.rpc('zentra_read_us_erp_v4',{p_organization:f.org})).rejects.toBeInstanceOf(SupabaseServerError);await expect(sql('update public.zentra_us_bank_reconciliations set payload=payload where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PF008'});
 },30000);
 it('requires living grants and opt-in while allowing another current actor to read departed-actor history',async()=>{
  const f=await fixture();await f.enable();const port=bankPort(f),read=await port.read(),input=bankInput(f,read,{type:'create_statement',cashAccountId:'cash',start:f.day,end:f.day,openingMinor:'0',closingMinor:'0',lines:[]});await bankRun(f,input);const nextActor={...f.refresh(),userId:randomUUID(),role:'accountant' as const};await db.query('insert into public.zentra_us_financial_test_grants values($1,$2,$3,1,true,$4)',[f.org,nextActor.userId,'accountant',f.policy]);await db.query('update public.zentra_us_financial_test_grants set enabled=false,version=version+1 where organization_id=$1 and user_id=$2',[f.org,f.user]);const scope=await readUsFinancialPilotScope(client,nextActor),other=createSupabaseUsFinancialPilotBankStore(client,scope,()=>readUsFinancialPilotScope(client,{...nextActor,timestamp:new Date().toISOString()},scope));expect((await other.read()).register.operations[0].actor.userId).toBe(f.user);await expect(other.receipt(input.requestId)).rejects.toMatchObject({code:'bank_idempotency_conflict'});await expect(bankRun(f,input)).rejects.toMatchObject({code:'financial_test_grant_required'});await db.query('update public.zentra_us_financial_pilot_test_opt_ins set enabled=false,version=version+1 where organization_id=$1',[f.org]);await expect(other.head()).rejects.toMatchObject({code:'financial_test_grant_required'});
 },30000);
 it('fences fresh writes independently on financial, global bank and statement revisions',async()=>{
  const f=await fixture();await f.enable();const port=bankPort(f),initial=await port.read(),request=bankInput(f,initial,{type:'create_statement',cashAccountId:'cash',start:f.day,end:f.day,openingMinor:'0',closingMinor:'0',lines:[]}),candidate=await bankCandidate(f,request,initial);
  const winner=bankInput(f,initial,{type:'create_statement',cashAccountId:'cash',start:f.day.slice(0,4)+'-01-01',end:f.day.slice(0,4)+'-01-01',openingMinor:'0',closingMinor:'0',lines:[]});await bankRun(f,winner);const before=await bankState(f);await expect(rawBankCommit(f,candidate)).rejects.toMatchObject({code:'BQ001'});expect(await bankState(f)).toBe(before);
  const fresh=await port.read(),correct=await bankCandidate(f,bankInput(f,fresh,request.command),fresh);await port.commit(correct);const latest=await port.read(),voidRequest=bankInput(f,latest,{type:'void_statement',statementId:correct.request.requestId,reason:'Synthetic stale R challenge'},0),voidCandidate=clone(await bankCandidate(f,voidRequest,latest));voidCandidate.request.expectedStatementRevision=1;voidCandidate.proof.statementRevision=2;rehash(voidCandidate);const prior=await bankState(f);await expect(rawBankCommit(f,voidCandidate)).rejects.toMatchObject({code:'BQ001'});expect(await bankState(f)).toBe(prior);
  const next=await port.read(),third=await bankCandidate(f,bankInput(f,next,{type:'create_statement',cashAccountId:'cash',start:f.day.slice(0,4)+'-02-01',end:f.day.slice(0,4)+'-02-01',openingMinor:'0',closingMinor:'0',lines:[]}),next);await f.store().commit(await f.prepare(f.payment('1')));await expect(rawBankCommit(f,third)).rejects.toMatchObject({code:'PF001'});expect(await bankState(f)).toBe(prior);expect(await port.head()).toMatchObject({revision:next.book.revision+1,bankRevision:2});
 },30000);
 it('rejects coherent public-envelope/source tampering in SQL and preserves exact old receipts after later heads',async()=>{
  const f=await fixture();await f.enable();const port=bankPort(f),read=await port.read(),input=bankInput(f,read,{type:'create_statement',cashAccountId:'cash',start:f.day,end:f.day,openingMinor:'0',closingMinor:'0',lines:[]}),candidate=await bankCandidate(f,input,read),before=await bankState(f),financial=await state(f);
  for(const kind of ['hash','sourceHash','sourceLedger','clock','cash','schema','consumer','extra'] as const){const c=clone(candidate);let code='BQ010';
   if(kind==='hash'){c.proof.commandHash='0'.repeat(64);code='BQ002';}else if(kind==='sourceHash')c.proof.source.bookSha256='0'.repeat(64);else if(kind==='sourceLedger')c.proof.source.ledgerRevision++;else if(kind==='clock'){c.proof.actor.timestamp=new Date(Date.parse(read.book.promotion.actor.timestamp)-1).toISOString();code='PF016';}else if(kind==='cash'){c.request.command={...input.command,cashAccountId:'sales'} as typeof c.request.command;rehash(c);code='BQ005';}else{(c.request as unknown as Record<string,unknown>)[kind==='schema'?'schemaVersion':kind==='consumer'?'consumer':'extra']=null;rehash(c);code='BQ002';}
   await expect(rawBankCommit(f,c)).rejects.toMatchObject({code});expect(await bankState(f)).toBe(before);expect(await state(f)).toBe(financial);
  }
  await port.commit(candidate);const written=await bankState(f);for(const kind of ['F','B','row'] as const){const c=clone(candidate);if(kind==='F')c.request.expectedRevision++;else if(kind==='B')c.request.expectedBankRevision++;else (c.request.command as {closingMinor:string;openingMinor:string}).openingMinor=(c.request.command as {closingMinor:string}).closingMinor='1';rehash(c);await expect(rawBankCommit(f,c)).rejects.toMatchObject({code:'BQ002'});}expect(await bankState(f)).toBe(written);
  await f.store().commit(await f.prepare(f.payment('1')));expect(await port.commit(candidate)).toEqual(candidate.proof);expect(await port.receipt(input.requestId)).toEqual(candidate.proof);expect((await port.head()).revision).toBeGreaterThan(input.expectedRevision);expect(await bankState(f)).toBe(written);
 },30000);
 it('rolls back incomplete direct bundles and exact-count forged claim deltas',async()=>{
  const f=await fixture({paid:'100'});await f.enable();const port=bankPort(f),read=await port.read(),input=bankInput(f,read,{type:'create_statement',cashAccountId:'cash',start:f.day,end:f.day,openingMinor:'0',closingMinor:'100',lines:[{date:f.day,amountMinor:'100',reference:'Synthetic exact claim'}]}),candidate=await bankCandidate(f,input,read),empty=await bankState(f);
  for(const options of [{receipt:false,audit:false},{audit:false}]){await expect(directBundle(f,candidate,options)).rejects.toMatchObject({code:'BQ010'});expect(await bankState(f)).toBe(empty);}
  await port.commit(candidate);const second=bankInput(f,await port.read(),{type:'create_statement',cashAccountId:'cash',start:f.day.slice(0,4)+'-01-01',end:f.day.slice(0,4)+'-01-01',openingMinor:'0',closingMinor:'0',lines:[]});await bankRun(f,second);const source=await port.read(),view=await projectUsFinancialBookV5(source.book),cash=view.ledger.entries.find(e=>e.id==='baseline-payment')??view.ledger.entries.find(e=>e.lines.some(l=>l.accountId==='cash'&&l.debitMinor==='100'))!;
  const approval=bankInput(f,source,{type:'approve_match',statementId:input.requestId,statementLineIds:[input.requestId+':1'],journalRevisions:[cash.revision]},0),approved=await bankCandidate(f,approval,source),before=await bankState(f),financial=await state(f);
  for(const claim of ['missing','statement','match','cash','entry'] as const){await expect(directBundle(f,approved,{claim})).rejects.toMatchObject({code:'BQ010'});expect(await bankState(f)).toBe(before);expect(await state(f)).toBe(financial);}
  await port.commit(approved);expect((await sql('select * from public.zentra_us_financial_bank_test_entry_claims where organization_id=$1',[f.org]))).toHaveLength(1);
  const immutable=await bankState(f);for(const table of bankTables){await expect(db.query(`delete from public.${table} where organization_id=$1`,[f.org])).rejects.toMatchObject({code:'BQ010'});await expect(db.exec(`truncate public.${table} cascade`)).rejects.toMatchObject({code:'BQ010'});if(table!==bankTables[0])await expect(db.query(`update public.${table} set organization_id=organization_id where organization_id=$1`,[f.org])).rejects.toMatchObject({code:'BQ010'});}expect(await bankState(f)).toBe(immutable);
  for(const role of ['anon','authenticated'])await expect(sql('select public.zentra_us_financial_pilot_bank_test_head_v1($1,$2,1,1,$3)',[f.org,f.refresh(),'postgres-test-financial-pilot-dto1'],role)).rejects.toMatchObject({code:'42501'});
 },30000);
 it('reconstructs an earlier financial prefix and rejects a coherent match to a journal that did not exist there',async()=>{
  const f=await fixture();await f.enable();const port=bankPort(f),read=await port.read(),input=bankInput(f,read,{type:'create_statement',cashAccountId:'cash',start:f.day,end:f.day,openingMinor:'0',closingMinor:'1',lines:[{date:f.day,amountMinor:'1',reference:'Synthetic future source challenge'}]});await bankRun(f,input);const earlier=await port.read();
  const posted=await submit(f,journal(f,{transactionDate:f.day,lines:[{accountId:'cash',debitMinor:'1',creditMinor:'0'},{accountId:'equity',debitMinor:'0',creditMinor:'1'}]})),later=await port.read(),view=await projectUsFinancialBookV5(later.book),entry=view.ledger.entries.find(e=>e.id===posted.entityId)!;
  const request=bankInput(f,later,{type:'approve_match',statementId:input.requestId,statementLineIds:[input.requestId+':1'],journalRevisions:[entry.revision]},0),candidate=clone(await bankCandidate(f,request,later));candidate.request.expectedRevision=earlier.book.revision;candidate.proof.source={revision:earlier.book.revision,ledgerRevision:(await projectUsFinancialBookV5(earlier.book)).ledger.revision,bookSha256:hash(canonicalErpJson(earlier.book))};rehash(candidate);
  const prefixLedger=await result<{entries:{id:string}[]}>('select public.zentra_us_pilot_bank_proof($1,$2) result',[later.book,candidate.proof]);expect(prefixLedger.entries.some(e=>e.id===entry.id)).toBe(false);expect(candidate.record.record.reconciliation.matches[0].ledgerEntryIds).toEqual([entry.id]);
  const before=await bankState(f);await expect(result('select public.zentra_us_pilot_bank_transition($1,$2,$3,$4,$5,true) result',[f.org,candidate.request,candidate.proof.actor,prefixLedger,earlier.register.records])).rejects.toMatchObject({code:'BQ005'});await expect(directBundle(f,candidate)).rejects.toMatchObject({code:'PF001'});expect(await bankState(f)).toBe(before);
 },30000);
 it('rejects an otherwise valid Unicode append when the complete legacy-plus-new register would exceed its readable budget',async()=>{
  const f=await fixture({legacyLargeVoid:true});await f.enable();const port=bankPort(f),read=await port.read();expect(read.register.records).toHaveLength(1);expect(read.register.records[0].record.voided).toBeDefined();const input=bankInput(f,read,{type:'create_statement',cashAccountId:'cash',start:f.day,end:f.day,openingMinor:'0',closingMinor:'1000',lines:Array.from({length:1000},()=>({date:f.day,amountMinor:'1',reference:'漢'.repeat(256)}))}),candidate=await bankCandidate(f,input,read),before=await bankState(f),financial=await state(f);expect(new TextEncoder().encode(JSON.stringify(input)).length).toBeLessThan(1048576);
  await expect(bankRun(f,input)).rejects.toMatchObject({code:'bank_limit_reached'});await expect(rawBankCommit(f,candidate)).rejects.toMatchObject({code:'BQ009'});expect(await bankState(f)).toBe(before);expect(await state(f)).toBe(financial);expect(await port.read()).toEqual(read);
  const hundred=Array.from({length:100},(_,i)=>{const r=clone(read.register.records[0]);r.record.reconciliation.statement.id=randomUUID();r.record.reconciliation.statement.lines=[];r.record.reconciliation.statement.closing.minorUnits='0';r.record.voided!.reason='Synthetic capacity '+i;return r;});await expect(result('select public.zentra_us_pilot_bank_transition($1,$2,$3,$4,$5,true) result',[f.org,input,candidate.proof.actor,(await projectUsFinancialBookV5(read.book)).ledger,hundred])).rejects.toMatchObject({code:'BQ009'});
 },60000);
 it('cleanly closes NodeFS and reopens a new instance preserving full book/register/proofs and exact receipts',async()=>{
  if(!bankRetained)throw Error('Mixed bank recipe must execute');const {f,read,requests,financial,bank,detail,reports,exports}=bankRetained;await db.close();db=new PGlite(dataDir);const port=bankPort(f);expect(await port.read()).toEqual(read);expect(await state(f)).toBe(financial);expect(await bankState(f)).toBe(bank);expect(await projectUsFinancialPilotBankStatement(read.book,read.register,{revision:read.book.revision,bankRevision:read.register.bankRevision,statementId:requests[0].requestId,origin:'financial-v5'})).toEqual(detail);const from=f.day.slice(0,4)+'-01-01',to=(Number(f.day.slice(0,4))+1)+'-12-31';expect(await projectUsFinancialPilotReports(read.book,{revision:read.book.revision,from,to,asOf:to,accountId:'cash'})).toEqual(reports);expect(await mixedExports(read.book,from,to)).toEqual(exports);for(const input of requests)expect((await bankRun(f,input)).replayed).toBe(true);expect(await bankState(f)).toBe(bank);expect(await state(f)).toBe(financial);const recipe={scope:'LOCAL TEST; serialized PGlite; synthetic Auth/D1/tax; clean close/new instance only; no multiconnection/crash/performance claim',migrations:[...migrations,migration,invoiceMigration,bankMigration],organizationId:f.org,revision:read.book.revision,bankRevision:read.register.bankRevision,cleanCloseReopen:true,dataDir};await writeFile(join(dataDir,'synthetic-bank-recipe.json'),JSON.stringify(recipe));const recipeLabel=process.env.ZENTRA_US_BANK_RECIPE_LABEL==='regression'?'regression':'targeted';await writeFile(new URL('../../.qa/us-pilot-bank/postgres-recipe-'+recipeLabel+'.json',import.meta.url),JSON.stringify(recipe,null,2));console.info('Retained synthetic PostgreSQL bank dataDir: '+dataDir);
 },60000);});
