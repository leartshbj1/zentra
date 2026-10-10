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
import { getUsExportFonts } from './export-fonts';
import { buildUsFinancialPilotExportSnapshot } from './us-financial-pilot-export-projection';
import { createUsFinancialPilotExportHandlers, type UsFinancialPilotExportDependencies } from './us-financial-pilot-export-server';
import { renderUsFinancialPilotExportCsv, renderUsFinancialPilotExportPdf } from './us-financial-pilot-export-renderer';
import { projectUsFinancialPilotReports } from './us-financial-pilot-reports';
import { PDFDocument } from 'pdf-lib';
import { usFinancialErpEntityIdV5 } from './us-financial-kernel-erp';
import { createSupabaseUsFinancialInvoiceTestStoreV5 } from './us-financial-invoice-test-store';
import { financialInvoiceClassificationEvidenceV5, resolveUsFinancialInvoicePreparationV5, validateUsFinancialInvoiceContextV5, validateUsFinancialInvoicePreparationV5, type UsFinancialInvoiceContextV5, type UsFinancialInvoicePreparationV5 } from './us-financial-invoice-test';
import { validateStoredStripeTaxCalculation } from './stripe-tax-calculation';

// Actual existing32 migrations, SQL and export HTTP handlers on retained NodeFS.
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
async function fixture(options:{tax?:string;quantity?:string;scale?:number;discount?:number;unitPrice?:string;lines?:number;paid?:string;paymentCount?:number;closed?:boolean;laterOpen?:boolean;periodCount?:number;unpromoted?:boolean;activeOrder?:boolean;confirmedOrder?:boolean;pendingTax?:boolean;shortPeriod?:boolean;projects?:boolean;baselinePurchases?:boolean}={}){
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

type Fixture=Awaited<ReturnType<typeof fixture>>;
const retained=new Map<string,{f:Fixture;book:UsFinancialBookV5;bytes:Uint8Array}>();
const privateTables=['zentra_us_financial_test_heads','zentra_us_financial_test_events','zentra_us_financial_test_receipts','zentra_us_financial_test_cursors','zentra_us_financial_test_tax_plans','zentra_us_financial_invoice_test_preparations','zentra_us_financial_invoice_test_operations','zentra_us_tax_operations'];
async function state(f:Fixture){const rows=[];for(const table of privateTables)rows.push(await sql(`select to_jsonb(t) record from public.${table} t where organization_id=$1 order by to_jsonb(t)::text`,[f.org]));return canonicalErpJson(rows);}
function http(f:Fixture,overrides:Partial<UsFinancialPilotExportDependencies>={}){
  const auth={userId:f.user,role:'owner' as FinancialAuthority['role'],entitled:true};
  const deps:UsFinancialPilotExportDependencies={enabled:()=>true,authority:async(_request,org)=>{if(org!==f.org)throw new ErpError('tenant_mismatch',403);return{mode:'browser',actor:{...f.refresh(),userId:auth.userId,role:auth.role,managementEntitled:auth.entitled}};},configuration:async()=>f.config,scope:(actor,expected)=>readUsFinancialPilotScope(client,actor,expected),store:(scope,revalidate)=>createSupabaseUsFinancialPilotStore(client,scope,revalidate),rateLimit:async()=>{},fonts:getUsExportFonts,...overrides};
  const handlers=createUsFinancialPilotExportHandlers(deps);
  const request=(revision:number,format='pdf',language='en',extra='',headers:Record<string,string>={})=>new Request(`https://synthetic.example.test/api/international/workspaces/${f.org}/financial-pilot/exports/?revision=${revision}&format=${format}&language=${language}${extra}`,{headers:{Origin:'https://synthetic.example.test','X-Zentra-Financial-Pilot':'1','X-Zentra-Expected-User':f.user,...headers}});
  const invoice=(revision:number,language='en')=>handlers.INVOICE(request(revision,'pdf',language),f.org,'invoice');
  return{auth,deps,handlers,request,invoice};
}
async function append(f:Fixture,operation:UsFinancialOperationV5,id?:string){const commit=await f.prepare(operation,id??(operation.type==='erp_command'?usFinancialErpEntityIdV5(operation.command,f.org):randomUUID()));await f.store().commit(commit);return commit;}

const operation=(command:ErpCommand):UsFinancialOperationV5=>({type:'erp_command',idempotencyKey:randomUUID(),command:command as Extract<UsFinancialOperationV5,{type:'erp_command'}>['command'],facts:{kind:'none'}});
async function context(f:Fixture):Promise<UsFinancialInvoiceContextV5>{
 const now=new Date(),binding:StripeTaxTestBinding={organizationId:f.org,accountId:'acct_SyntheticSettlement',mode:'test',apiVersion:'2026-08-26.dahlia',revision:1,settingsSha256:hash('synthetic-settings'),registrationsSha256:hash('synthetic-registrations'),observedAt:new Date(now.getTime()-1000).toISOString(),validUntil:new Date(now.getTime()+119000).toISOString(),evidenceKind:'test_fixture',scope:'erp_invoice_tax'};
 const seller=(await sql<{profile:unknown}>('select profile from public.zentra_us_seller_profiles where organization_id=$1',[f.org]))[0].profile;
 const taxFacts=(await sql<{facts:unknown}>('select facts from public.zentra_us_tax_profiles where organization_id=$1',[f.org]))[0].facts;
 const count=(await db.query<{n:string}>('select coalesce(max(revision),0)+1 n from public.zentra_us_financial_invoice_test_contexts where organization_id=$1',[f.org])).rows[0].n;
 const payload={schemaVersion:1,organizationId:f.org,revision:Number(count),countryRevision:2,configuration:f.config,sellerRevision:1,seller,taxFactsRevision:1,taxFacts,binding,merchant:{credential:{reference:'SYNTHETIC-NO-SECRET',revision:1,accountId:binding.accountId},configurationFingerprint:hash('SYNTHETIC-LOCAL-CREDENTIAL-IDENTITY')},admittedBy:'Synthetic DB owner, no provider identity claim',admittedAt:now.toISOString()};
 const value=await validateUsFinancialInvoiceContextV5({...payload,contextSha256:hash(canonicalErpJson(payload))},f.org,true);await db.query('insert into public.zentra_us_financial_invoice_test_contexts values($1,$2,$3)',[f.org,value.revision,value]);return value;
}
async function acceptedQuote(f:Fixture,id='new-quote'){
 const base=f.baseline.estimates[0];for(const cmd of [{type:'save_estimate',id,expectedEstimateRevision:0,customerId:'customer',date:f.day,expiresAt:f.day,paymentTermsDays:30,lines:base.lines,notes:'Synthetic local invoice source'}, {type:'accept_estimate',estimateId:id,expectedEstimateRevision:1}] as ErpCommand[]){const c=await f.prepare(operation(cmd),id);await f.store().commit(c);}return id;
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
async function issue(f:Fixture,options:Parameters<typeof reservation>[1]={}){const r=await reservation(f,options),c=await calculation(f,r);await f.store().commit(c.commit);return{...r,...c};}

describe.skipIf(!enabled)('financial pilot exports —32 existing migrations, real local PostgreSQL and synthetic HTTP authority',()=>{
 beforeAll(async()=>{
  const require=createRequire(import.meta.url);({PGlite}=require(join(directory!,'dist/index.cjs')) as {PGlite:new(dataDir?:string)=>Db});dataDir=await mkdtemp(join(tmpdir(),'zentra-financial-pilot-exports-'));db=new PGlite(dataDir);
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
  for(const name of [...migrations,migration])await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
 },30000);
 afterAll(async()=>{await db?.close();});
 it('uses32 existing migrations without introducing export persistence, receipts or an ERP4 fallback',async()=>{
  expect([...migrations,migration]).toHaveLength(32);const f=await fixture();await f.enable();const before=await state(f),book=await f.read(),r=await http(f).invoice(book.revision);
  expect(r.status).toBe(200);const bytes=new Uint8Array(await r.arrayBuffer()),pdf=await PDFDocument.load(bytes);expect(pdf.getPage(0).getSize()).toEqual({width:612,height:792});expect(await state(f)).toBe(before);expect(await f.read()).toEqual(book);
  await expect(client.rpc('zentra_read_us_erp_v4',{p_organization:f.org})).rejects.toMatchObject({code:'PU008'});
 });
 it('exports original107, received50, credited35 and outstanding22 from the same admitted V5 book',async()=>{
  const f=await fixture({quantity:'3',unitPrice:'100',discount:6667,tax:'7'});await f.enable();await append(f,f.payment('50'),'synthetic-received50');await append(f,await f.credit(await f.read()),'synthetic-credit35');const book=await f.read(),view=await projectUsFinancialBookV5(book);
  expect(view.settlements[0]).toMatchObject({totalMinor:'107',receivedMinor:'50',creditedMinor:'35',outstandingMinor:'22'});const snapshot=await buildUsFinancialPilotExportSnapshot(book,{kind:'invoice',invoiceId:'invoice',revision:book.revision,format:'pdf',language:'en'});
  expect(snapshot.sections.find(section=>section.kind==='invoice_lines')?.totals).toEqual(expect.arrayContaining([{label:'total',minorUnits:'107'},{label:'received',minorUnits:'50'},{label:'credited',minorUnits:'35'},{label:'outstanding',minorUnits:'22'}]));
  const before=await state(f),h=http(f),pdf=await h.invoice(book.revision);expect(pdf.status).toBe(200);const bytes=new Uint8Array(await pdf.arrayBuffer());expect(pdf.headers.get('X-Zentra-Content-SHA256')).toBe(createHash('sha256').update(bytes).digest('hex'));
  const csv=await h.handlers.REPORT(h.request(book.revision,'csv','en'),f.org,'receivables');expect(csv.status).toBe(200);const text=await csv.text();expect(text).toContain('1.07');expect(text).toContain('0.50');expect(text).toContain('0.35');expect(text).toContain('0.22');expect(text).not.toContain('0.85');expect(await state(f)).toBe(before);
  retained.set('exact-settlement',{f,book,bytes});
 });
 it('exports every payment and ledger movement beyond the25-row browser page',async()=>{
  const f=await fixture({paymentCount:25});await f.enable();await append(f,f.payment('1'),'synthetic-tail-history-26');const book=await f.read(),snapshot=await buildUsFinancialPilotExportSnapshot(book,{kind:'invoice',invoiceId:'invoice',revision:book.revision,format:'pdf',language:'fr'});
  expect(snapshot.sections.find(section=>section.kind==='payments')?.rows).toHaveLength(26);expect(snapshot.sections.find(section=>section.kind==='payments')?.totals).toEqual([{label:'received',minorUnits:'26'}]);const h=http(f),pdf=await h.invoice(book.revision,'fr');expect(pdf.status).toBe(200);expect((await PDFDocument.load(await pdf.arrayBuffer())).getPageCount()).toBeGreaterThan(1);
  const ledger=await buildUsFinancialPilotExportSnapshot(book,{kind:'report',reportType:'general_ledger',revision:book.revision,format:'csv',language:'en',from:f.day,to:f.day,accountId:'cash'});expect(ledger.sections[0].rows).toHaveLength(26);expect(new Set(ledger.sections[0].rows.map(row=>canonicalErpJson(row))).size).toBe(26);
 },30000);
 it('keeps exact large decimal money and emitted discounts without using floating point',async()=>{
  const f=await fixture();await f.enable();await append(f,{type:'erp_command',idempotencyKey:randomUUID(),command:{type:'post_manual_journal',id:'large-exact-journal',transactionDate:f.day,accountingDate:f.day,periodId:'year',description:'Synthetic large exact opening capital',lines:[{accountId:'cash',debitMinor:'900719925474099301',creditMinor:'0'},{accountId:'equity',debitMinor:'0',creditMinor:'900719925474099301'}],cashFlowCategory:'financing',sourceReference:'Synthetic declared original'},facts:{kind:'none'}});const book=await f.read(),s=await buildUsFinancialPilotExportSnapshot(book,{kind:'report',reportType:'general_ledger',accountId:'cash',from:f.day,to:f.day,revision:book.revision,language:'en',format:'csv'}),csv=renderUsFinancialPilotExportCsv(s);expect(csv).toContain('9007199254740993.01');expect(s.sections[0].rows[0]).toContain('900719925474099301');
 });
 it('reconciles purchases, credits, manual reversal and accounting periods against actual ledger reports',async()=>{
  const f=await fixture({baselinePurchases:true,periodCount:2});await f.enable();await append(f,f.payment('1000'),'synthetic-customer-receipt');await append(f,await f.credit(await f.read()),'synthetic-credit');
  const manual={type:'post_manual_journal' as const,id:'manual',transactionDate:f.day,accountingDate:f.day,periodId:'year',description:'Synthetic manual classification',lines:[{accountId:'cash',debitMinor:'100',creditMinor:'0'},{accountId:'sales',debitMinor:'0',creditMinor:'100'}],cashFlowCategory:'operating' as const,sourceReference:'Synthetic journal source'};
  await append(f,{type:'erp_command',idempotencyKey:randomUUID(),command:manual,facts:{kind:'none'}});
  const posted=await projectUsFinancialBookV5(await f.read()),entry=posted.ledger.entries.find(row=>row.source.type==='manual_journal');if(!entry)throw Error('Synthetic manual entry missing');
  await append(f,{type:'erp_command',idempotencyKey:randomUUID(),command:{type:'reverse_manual_journal',id:'manual-reversal',entryId:entry.id,transactionDate:f.day,accountingDate:f.day,periodId:'year',reason:'Synthetic reversal'},facts:{kind:'none'}});
  await append(f,{type:'erp_command',idempotencyKey:randomUUID(),command:{type:'close_period',periodId:'year'},facts:{kind:'none'}});const book=await f.read(),view=await projectUsFinancialBookV5(book);expect(view.ledger.revision).toBeGreaterThan(view.ledger.entries.length);
  const asOf=f.day,from=f.day,to=f.day,reports=await projectUsFinancialPilotReports(book,{revision:book.revision,from,to,asOf}),balance=await buildUsFinancialPilotExportSnapshot(book,{kind:'report',reportType:'trial_balance',revision:book.revision,format:'csv',language:'en',asOf});
  expect(balance.ledgerRevision).toBe(reports.ledgerRevision);expect(balance.sections[0].totals.map(t=>t.minorUnits)).toEqual([reports.trialBalance.totalDebitMinor,reports.trialBalance.totalCreditMinor]);expect(reports.trialBalance.balanced).toBe(true);
  for(const selector of [{kind:'report' as const,reportType:'profit_loss' as const,from,to},{kind:'report' as const,reportType:'balance_sheet' as const,asOf},{kind:'report' as const,reportType:'cash_flow' as const,from,to},{kind:'report' as const,reportType:'general_ledger' as const,from,to,accountId:'payables'}]){const s=await buildUsFinancialPilotExportSnapshot(book,{...selector,revision:book.revision,language:'de',format:'csv'});expect(s.ledgerRevision).toBe(view.ledger.revision);expect(renderUsFinancialPilotExportCsv(s)).not.toContain('providerReference');}
 });
 it('refuses a revoked opt-in or grant during actual rendering without returning a late PDF',async()=>{
  for(const table of ['zentra_us_financial_pilot_test_opt_ins','zentra_us_financial_test_grants']){
    const f=await fixture();await f.enable();const book=await f.read(),before=book.revision;const h=http(f,{render:async(snapshot,format,fonts)=>{const bytes=format==='pdf'?await renderUsFinancialPilotExportPdf(snapshot,fonts!):renderUsFinancialPilotExportCsv(snapshot);await db.query(`update public.${table} set enabled=false,version=2 where organization_id=$1`,[f.org]);return bytes;}}),r=await h.invoice(before);expect(r.status).toBe(403);expect(r.headers.has('Content-Disposition')).toBe(false);expect(await r.text()).not.toContain('providerReference');expect(await result('select revision::int result from public.zentra_us_financial_test_cursors where organization_id=$1',[f.org])).toBe(before);
  }
 });
 it('rejects a head change caused by a real PG payment during rendering',async()=>{
  const f=await fixture();await f.enable();const before=await f.read(),h=http(f,{render:async(snapshot,format,fonts)=>{const bytes=format==='pdf'?await renderUsFinancialPilotExportPdf(snapshot,fonts!):renderUsFinancialPilotExportCsv(snapshot);await append(f,f.payment('1'),'synthetic-concurrent-receipt');return bytes;}}),r=await h.invoice(before.revision);expect(r.status).toBe(409);expect(await r.json()).toEqual({error:'financial_snapshot_changed'});expect((await f.read()).events).toHaveLength(1);
 });
 it('checks effective synthetic Auth/D1 session and tenant after the last real PG scope await',async()=>{
  const f=await fixture();await f.enable();let lost=false,headRead=false;const h=http(f,{authority:async(_req,org)=>{if(lost)throw new ErpError('session_changed',401);if(org!==f.org)throw new ErpError('tenant_mismatch',403);return{mode:'browser',actor:f.refresh()};},store:(scope,revalidate)=>{const store=createSupabaseUsFinancialPilotStore(client,scope,revalidate);return{...store,head:async()=>{const head=await store.head();headRead=true;return head;}};},scope:async(actor,expected)=>{const scope=await readUsFinancialPilotScope(client,actor,expected);if(headRead)lost=true;return scope;}}),book=await f.read(),before=await state(f),r=await h.invoice(book.revision);expect(r.status).toBe(401);expect(await r.json()).toEqual({error:'session_changed'});expect(await state(f)).toBe(before);
 });
 it('does not disclose private financial, provider, grant or policy material in CSV, headers or errors',async()=>{
  const f=await fixture();await f.enable();const book=await f.read(),h=http(f),r=await h.handlers.REPORT(h.request(book.revision,'csv','it'),f.org,'receivables');expect(r.status).toBe(200);const publicData=await r.text()+JSON.stringify([...r.headers]);for(const secret of ['SYNTHETIC PRIVATE TEST NAME','acct_SyntheticSettlement','taxcalc_SyntheticSettlement','synthetic-plan-','grantVersion','optInVersion','idempotencyKey','"baseline"','SYNTHETIC-LOCAL-PILOT-ONLY'])expect(publicData).not.toContain(secret);
  const denied=await h.handlers.INVOICE(h.request(book.revision,'pdf','en','',{Authorization:'Bearer synthetic'}),f.org,'invoice');expect(denied.status).toBe(403);expect(Object.keys(await denied.json() as object)).toEqual(['error']);expect((await h.handlers.INVOICE(h.request(book.revision),randomUUID(),'invoice')).status).toBe(403);
 });
 it('exports a newly issued V5 invoice after a closed and reopened period, then two payments and a credit',async()=>{
  const f=await fixture({shortPeriod:true});await f.enable();await append(f,await f.credit(await f.read()),'prior-credit');
  await append(f,{type:'erp_command',idempotencyKey:randomUUID(),command:{type:'close_period',periodId:'year'},facts:{kind:'none'}});
  const tomorrow=new Date(Date.parse(f.day+'T12:00:00Z')+86400000).toISOString().slice(0,10);
  await append(f,{type:'erp_command',idempotencyKey:randomUUID(),command:{type:'open_period',id:'next',start:tomorrow,end:(Number(f.day.slice(0,4))+1)+'-12-31'},facts:{kind:'none'}});
  const issued=await issue(f,{date:tomorrow,periodId:'next'});
  for(const amount of ['100','200'])await append(f,{...f.payment(amount),invoiceId:issued.invoiceId,paymentDate:tomorrow,accountingDate:tomorrow,periodId:'next'});
  await append(f,await f.credit(await f.read(),issued.invoiceId,tomorrow,'next'),'issued-credit');
  const book=await f.read(),view=await projectUsFinancialBookV5(book);expect(view.settlements.find(x=>x.invoiceId===issued.invoiceId)).toMatchObject({totalMinor:'29478',receivedMinor:'300',creditedMinor:'9826',outstandingMinor:'19352'});
  expect(view.ledger.periods.map(p=>p.status)).toEqual(['closed','open']);expect(book.baseline).toEqual(f.baseline);const before=await state(f),h=http(f),r=await h.handlers.INVOICE(h.request(book.revision),f.org,issued.invoiceId);
  expect(r.status).toBe(200);expect((await PDFDocument.load(await r.arrayBuffer())).getPage(0).getSize()).toEqual({width:612,height:792});
  const report=await h.handlers.REPORT(h.request(book.revision,'csv','en'),f.org,'receivables');expect(report.status).toBe(200);expect(await report.text()).toContain('193.52');expect(await state(f)).toBe(before);
 },30000);
 it('persists the exact book and read-only exports across clean NodeFS close/reopen',async()=>{
  const saved=retained.get('exact-settlement');if(!saved)throw Error('Prior exact-settlement recipe must execute');await db.close();db=new PGlite(dataDir);const before=await state(saved.f);expect(await saved.f.read()).toEqual(saved.book);const r=await http(saved.f).invoice(saved.book.revision);expect(r.status).toBe(200);expect((await PDFDocument.load(await r.arrayBuffer())).getPage(0).getSize()).toEqual({width:612,height:792});expect(await state(saved.f)).toBe(before);
  await writeFile(join(dataDir,'synthetic-export-recipe.json'),JSON.stringify({scope:'LOCAL TEST only; serialized PGlite and synthetic Auth/D1',migrations:32,organizationId:saved.f.org,revision:saved.book.revision,cleanCloseReopen:true}));console.log('Retained synthetic PostgreSQL export dataDir: '+dataDir);
 });
});

