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
import { usFinancialErpEntityIdV5 } from './us-financial-kernel-erp';
import { createUsFinancialPilotCommercialHandlers } from './us-financial-pilot-commercial-server';
import { createUsFinancialPilotHandlers, type UsFinancialPilotDependencies } from './us-financial-pilot-server';
import { validateUsFinancialPilotCommercialReceipt, type UsFinancialPilotCommercialCommand, type UsFinancialPilotCommercialRequest } from './us-financial-pilot-commercial';
import { validateUsFinancialPilotEstimateDetail } from './us-financial-pilot-commercial-projection';

// Actual existing32 migrations, SQL and commercial HTTP handlers on retained NodeFS.
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

type Fixture=Awaited<ReturnType<typeof fixture>>;
const privateTables=['zentra_us_financial_test_heads','zentra_us_financial_test_events','zentra_us_financial_test_receipts','zentra_us_financial_test_cursors','zentra_us_financial_test_tax_plans','zentra_us_financial_invoice_test_preparations','zentra_us_financial_invoice_test_operations','zentra_us_tax_operations'];
async function state(f:Fixture){const rows=[];for(const table of privateTables)rows.push(await sql(`select to_jsonb(t) record from public.${table} t where organization_id=$1 order by to_jsonb(t)::text`,[f.org]));return canonicalErpJson(rows);}
function http(f:Fixture,overrides:Partial<UsFinancialPilotDependencies>={}){
 const auth={userId:f.user,role:'owner' as FinancialAuthority['role'],entitled:true};
 const deps:UsFinancialPilotDependencies={enabled:()=>true,authority:async(_request,org)=>{if(org!==f.org)throw new ErpError('tenant_mismatch',403);return{mode:'browser',actor:{...f.refresh(),userId:auth.userId,role:auth.role,managementEntitled:auth.entitled}};},configuration:async()=>f.config,scope:(actor,expected)=>readUsFinancialPilotScope(client,actor,expected),store:(scope,revalidate)=>createSupabaseUsFinancialPilotStore(client,scope,revalidate),rateLimit:async()=>{},diagnostic:()=>{},...overrides};
 const commercial=createUsFinancialPilotCommercialHandlers(deps),pilot=createUsFinancialPilotHandlers(deps);
 const request=(path:string,body?:unknown,headers:Record<string,string>={})=>new Request(`https://synthetic.example.test/api/international/workspaces/${f.org}/financial-pilot/${path}`,{method:body===undefined?'GET':'POST',headers:{'Sec-Fetch-Site':'same-origin',Origin:'https://synthetic.example.test','Content-Type':'application/json','X-Zentra-Financial-Pilot':'1','X-Zentra-Expected-User':f.user,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const post=(input:UsFinancialPilotCommercialRequest)=>commercial.POST(request('commercial/operations',input),f.org);
 const detail=(id:string,revision:number)=>commercial.ESTIMATE(request(`estimates/${encodeURIComponent(id)}?revision=${revision}`),f.org,id);
 return{auth,deps,commercial,pilot,request,post,detail};
}
function customer(f:Fixture):Extract<UsFinancialPilotCommercialCommand,{type:'create_customer'}>{return{type:'create_customer',customer:{kind:'business',name:'Synthetic new PME client',billingAddress:f.config.address,shippingAddress:null,email:'synthetic-customer@example.test',phone:'+1 555 0100',contactName:'Synthetic interlocutor',paymentTermsDays:15}};}
function quote(f:Fixture,fields:Partial<Extract<UsFinancialPilotCommercialCommand,{type:'save_estimate'}>>={}):Extract<UsFinancialPilotCommercialCommand,{type:'save_estimate'}>{return{type:'save_estimate',estimateId:null,expectedEstimateRevision:0,customerId:'customer',projectId:null,date:f.day,expiresAt:f.day,paymentTermsDays:30,lines:[{id:null,description:'Synthetic service · Genève · Zürich',quantityUnits:'333',quantityScale:2,unitPriceMinor:'10001',discountBasisPoints:1250,taxTreatment:'taxable'}],notes:'Synthetic terms\nNo real commercial transaction',...fields};}
const envelope=(revision:number,command:UsFinancialPilotCommercialCommand,requestId:string=randomUUID()):UsFinancialPilotCommercialRequest=>({consumer:'financial-pilot',schemaVersion:1,requestId,expectedRevision:revision,command});
async function receipt(response:Response,f:Fixture,input:UsFinancialPilotCommercialRequest){expect(response.status).toBe(200);return validateUsFinancialPilotCommercialReceipt(await response.json(),f.org,input);}
async function append(f:Fixture,operation:UsFinancialOperationV5){const id=operation.type==='erp_command'?usFinancialErpEntityIdV5(operation.command,f.org):randomUUID(),commit=await f.prepare(operation,id);await f.store().commit(commit);return commit;}
let retained:{f:Fixture;book:UsFinancialBookV5;estimateId:string}|undefined;

describe.skipIf(!enabled)('commercial HTTP → actual local PostgreSQL — synthetic Auth/D1, existing32 migrations',()=>{
 beforeAll(async()=>{
  const require=createRequire(import.meta.url);({PGlite}=require(join(directory!,'dist/index.cjs')) as {PGlite:new(dataDir?:string)=>Db});dataDir=await mkdtemp(join(tmpdir(),'zentra-financial-pilot-commercial-'));db=new PGlite(dataDir);
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
  for(const name of [...migrations,migration])await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
 },30000);
 afterAll(async()=>{await db?.close();});
 it('creates a customer, edits the same quote twice and accepts it through two HTTP sessions on one book',async()=>{
  expect([...migrations,migration]).toHaveLength(32);const f=await fixture();await f.enable();const a=http(f),b=http(f),ledger=canonicalErpJson((await projectUsFinancialBookV5(await f.read())).ledger);
  const c=envelope((await f.read()).revision,customer(f)),created=await receipt(await a.post(c),f,c);const q=envelope(created.revision,quote(f,{customerId:created.entityId})),saved=await receipt(await a.post(q),f,q);
  let detail=validateUsFinancialPilotEstimateDetail(await(await b.detail(saved.entityId,saved.revision)).json(),f.org,saved.revision,saved.entityId);expect(detail.estimate).toMatchObject({number:'EST-000002',revision:1,status:'draft',netMinor:'29140'});expect(detail.customer.id).toBe(created.entityId);
  const stable=detail.lines[0].id;
  for(let n=1;n<=2;n++){const edited=envelope(detail.revision,quote(f,{estimateId:saved.entityId,expectedEstimateRevision:detail.estimate.revision,customerId:created.entityId,lines:[{...q.command.type==='save_estimate'?q.command.lines[0]:quote(f).lines[0],id:stable,description:`Synthetic edit ${n}`,unitPriceMinor:n===2?'9007199254740993':'10002'}],notes:`Synthetic edit ${n}`}));await receipt(await (n===1?a:b).post(edited),f,edited);detail=validateUsFinancialPilotEstimateDetail(await(await a.detail(saved.entityId,edited.expectedRevision+1)).json(),f.org);expect(detail.lines[0].id).toBe(stable);expect(detail.estimate.number).toBe('EST-000002');}
  const accept=envelope(detail.revision,{type:'accept_estimate',estimateId:saved.entityId,expectedEstimateRevision:detail.estimate.revision});await receipt(await b.post(accept),f,accept);const book=await f.read(),view=await projectUsFinancialBookV5(book);expect(view.estimates.find(e=>e.id===saved.entityId)).toMatchObject({status:'accepted',revision:4});expect(canonicalErpJson(view.ledger)).toBe(ledger);expect(book.events).toHaveLength(5);expect(book.events.every(e=>'effects' in e&&e.operation.type==='erp_command'&&e.effects.postings.length===0&&e.effects.audit.length===0)).toBe(true);
  const observed=await b.pilot.HEAD(b.request('head'),f.org);expect(await observed.json()).toMatchObject({revision:book.revision});retained={f,book,estimateId:saved.entityId};
 },30000);
 it('rejects two stale-session writes and a stale quote version without effects',async()=>{
  const f=await fixture();await f.enable();const a=http(f),b=http(f),rev=(await f.read()).revision,q=envelope(rev,quote(f));const made=await receipt(await a.post(q),f,q),before=await state(f);
  const stale=await b.post(envelope(rev,customer(f)));expect(stale.status).toBe(409);expect(await stale.json()).toEqual({error:'revision_conflict'});
  const wrong=await b.post(envelope(made.revision,{type:'accept_estimate',estimateId:made.entityId,expectedEstimateRevision:2}));expect(wrong.status).toBe(409);expect(await wrong.json()).toEqual({error:'estimate_revision_conflict'});expect(await state(f)).toBe(before);
  expect((await a.detail(made.entityId,rev)).status).toBe(409);
 });
 it('recovers a lost committed reply after an intervening real payment, preserving exact IDs and numbering',async()=>{
  const f=await fixture();await f.enable();let drop=true;const lost=http(f,{store:(scope,revalidate)=>{const real=createSupabaseUsFinancialPilotStore(client,scope,revalidate);return{...real,commit:async input=>{const r=await real.commit(input);if(drop){drop=false;throw Error('Synthetic lost HTTP reply after PG commit');}return r;}};} });const q=envelope((await f.read()).revision,quote(f));expect((await lost.post(q)).status).toBe(503);const advanced=http(f),book=await f.read(),payment={consumer:'financial-pilot',schemaVersion:1,requestId:randomUUID(),expectedRevision:book.revision,command:{type:'customer_payment',invoiceId:'invoice',amountMinor:'100',paymentDate:f.day,accountingDate:f.day,periodId:'year',reference:'Synthetic recorded receipt — no money moved'}};
  expect((await advanced.pilot.POST(advanced.request('operations',payment),f.org)).status).toBe(200);const retried=await receipt(await lost.post(q),f,q);expect(retried.revision).toBe(q.expectedRevision+1);const view=await projectUsFinancialBookV5(await f.read());expect(view.estimates.filter(e=>e.id===retried.entityId)).toHaveLength(1);expect(view.estimates.at(-1)?.number).toBe('EST-000002');expect((await f.read()).events).toHaveLength(2);expect(view.invoices[0].payments).toHaveLength(1);
 });
 it('rejects another payload under the same UUID without changing the durable receipt',async()=>{
  const f=await fixture();await f.enable();const h=http(f),q=envelope((await f.read()).revision,quote(f));await receipt(await h.post(q),f,q);const before=await state(f),response=await h.post({...q,command:{...quote(f),notes:'Changed payload'}});expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'idempotency_conflict'});expect(await state(f)).toBe(before);
 });
 it.each([1,2])('preserves receipt precedence when another HTTP invocation commits after probe%s before source read',async probe=>{
  const f=await fixture();await f.enable();const original=http(f),q=envelope((await f.read()).revision,quote(f));let probes=0;const retry=http(f,{store:(scope,revalidate)=>{const real=createSupabaseUsFinancialPilotStore(client,scope,revalidate);return{...real,receipt:async(org,key)=>{const found=await real.receipt(org,key);if(++probes===probe)await receipt(await original.post(q),f,q);return found;}};}});
  await receipt(await retry.post(q),f,q);expect((await f.read()).events).toHaveLength(1);expect((await projectUsFinancialBookV5(await f.read())).estimates.at(-1)?.number).toBe('EST-000002');
 });
 it('rejects forged or foreign line IDs before PG commit and preserves a real retained ID',async()=>{
  const f=await fixture();await f.enable();const h=http(f),revision=(await f.read()).revision,original=quote(f),create=envelope(revision,original),before=await state(f);
  const forged=await h.post(envelope(revision,{...original,lines:[{...original.lines[0],id:'line-0'}]}));expect(forged.status).toBe(422);expect(await state(f)).toBe(before);
  const made=await receipt(await h.post(create),f,create),detail=validateUsFinancialPilotEstimateDetail(await(await h.detail(made.entityId,made.revision)).json(),f.org),edit={...original,estimateId:made.entityId,expectedEstimateRevision:1};const stateBefore=await state(f);
  const foreign=await h.post(envelope(made.revision,{...edit,lines:[{...original.lines[0],id:'line-0'}]}));expect(foreign.status).toBe(422);expect(await state(f)).toBe(stateBefore);
  const valid=envelope(made.revision,{...edit,lines:[{...original.lines[0],id:detail.lines[0].id,description:'Synthetic retained line'}]});await receipt(await h.post(valid),f,valid);expect(validateUsFinancialPilotEstimateDetail(await(await h.detail(made.entityId,valid.expectedRevision+1)).json(),f.org).lines[0].id).toBe(detail.lines[0].id);
 });
 it('preserves an existing customer even when its legacy ID collides with the new deterministic create ID',async()=>{
  const requestId=randomUUID(),id=`pilot-customer:${requestId}`,f=await fixture({collisionId:id});await f.enable();const h=http(f),input=envelope((await f.read()).revision,customer(f),requestId),before=await state(f),response=await h.post(input);expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'customer_already_exists'});expect(await state(f)).toBe(before);expect((await projectUsFinancialBookV5(await f.read())).customers.find(c=>c.id===id)?.name).toContain('preserve me');
 });
 it('keeps issued estimates locked and enforces real PO008 on an active pre-promotion order',async()=>{
  const f=await fixture({activeOrder:true});await f.enable();const h=http(f),revision=(await f.read()).revision,before=await state(f);
  for(const command of [{type:'accept_estimate',estimateId:'quote',expectedEstimateRevision:2},{...quote(f),estimateId:'quote',expectedEstimateRevision:2}] as UsFinancialPilotCommercialCommand[]){const r=await h.post(envelope(revision,command));expect(r.status).toBe(409);expect(await r.json()).toEqual({error:'issued_estimate_locked'});}
  const response=await h.post(envelope(revision,{...quote(f),estimateId:'ordered-quote',expectedEstimateRevision:2}));expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'sales_order_source_locked'});expect(await state(f)).toBe(before);
 });
 it('does not reapply live source admission to historical detail or an exact retry',async()=>{
  const f=await fixture();await f.enable();const h=http(f),q=envelope((await f.read()).revision,quote(f)),r=await receipt(await h.post(q),f,q),before=await state(f),definition=(await db.query<{definition:string}>("select pg_get_functiondef('public.zentra_us_commercial_source(text,jsonb)'::regprocedure) definition")).rows[0].definition;
  try{await db.exec("create or replace function public.zentra_us_commercial_source(org text,op jsonb) returns void language plpgsql volatile security invoker set search_path='' as $$ begin raise exception using errcode='PO008',message='Synthetic new-operation refusal';end $$;");expect((await h.detail(r.entityId,r.revision)).status).toBe(200);expect(await receipt(await h.post(q),f,q)).toEqual(r);const next=await h.post(envelope(r.revision,{type:'accept_estimate',estimateId:r.entityId,expectedEstimateRevision:1}));expect(next.status).toBe(409);expect(await next.json()).toEqual({error:'sales_order_source_locked'});expect(await state(f)).toBe(before);}finally{await db.exec(definition);}
 });
 it.each(['grant','optIn'] as const)('revokes %s during the actual private read and withholds the document',async kind=>{
  const f=await fixture();await f.enable();let revoke=true;const h=http(f,{store:(scope,revalidate)=>{const real=createSupabaseUsFinancialPilotStore(client,scope,revalidate);return{...real,read:async org=>{const b=await real.read(org);if(revoke){revoke=false;await db.query(`update public.${kind==='grant'?'zentra_us_financial_test_grants':'zentra_us_financial_pilot_test_opt_ins'} set enabled=false,version=version+1 where organization_id=$1`,[f.org]);}return b;}};}}),before=await state(f),response=await h.detail('quote',f.initial.revision);expect(response.status).toBe(403);expect(Object.keys(await response.json() as object)).toEqual(['error']);expect(await state(f)).toBe(before);
 });
 it('does not leak data to another tenant, switched user, role or native credential',async()=>{
  const f=await fixture(),other=await fixture();await f.enable();await other.enable();const h=http(f),before=await state(f);
  const foreign=await h.commercial.ESTIMATE(h.request(`estimates/quote?revision=${f.initial.revision}`),other.org,'quote');expect(foreign.status).toBe(403);h.auth.userId=other.user;expect((await h.detail('quote',f.initial.revision)).status).toBe(401);h.auth.userId=f.user;h.auth.role='member';expect((await h.detail('quote',f.initial.revision)).status).toBe(403);h.auth.role='owner';const native=await h.commercial.POST(h.request('commercial/operations',envelope(f.initial.revision,customer(f)),{Authorization:'Bearer synthetic'}),f.org);expect(native.status).toBe(403);expect(await state(f)).toBe(before);
 });
 it('keeps credit/payment history and current receivables while commercial events leave the ledger unchanged',async()=>{
  const f=await fixture();await f.enable();const before=await f.read();await append(f,await f.credit(before));await append(f,f.payment('100'));const existing=await f.read(),ledger=canonicalErpJson((await projectUsFinancialBookV5(existing)).ledger),h=http(f),q=envelope(existing.revision,quote(f));await receipt(await h.post(q),f,q);const book=await f.read(),view=await projectUsFinancialBookV5(book);expect(canonicalErpJson(view.ledger)).toBe(ledger);expect(view.invoices[0].payments).toHaveLength(1);expect(view.credits).toHaveLength(1);expect(book.baseline).toEqual(f.baseline);
 });
 it('reopens actual NodeFS storage and reads the same accepted quote and unchanged book',async()=>{
  if(!retained)throw Error('Prior commercial recipe must execute');const {f,book,estimateId}=retained;await db.close();db=new PGlite(dataDir);const before=await state(f);expect(await f.read()).toEqual(book);const h=http(f),r=await h.detail(estimateId,book.revision);expect(r.status).toBe(200);expect(validateUsFinancialPilotEstimateDetail(await r.json(),f.org,book.revision,estimateId).estimate.status).toBe('accepted');expect(await state(f)).toBe(before);
  await writeFile(join(dataDir,'synthetic-commercial-recipe.json'),JSON.stringify({scope:'LOCAL TEST only; serialized PGlite, synthetic Auth/D1/fiscal observations; Request/Response handlers, not two visual browsers',migrations:32,organizationId:f.org,revision:book.revision,cleanCloseReopen:true}));console.log('Retained synthetic PostgreSQL commercial dataDir: '+dataDir);
 });
});

