import { postCustomerInvoice, postVendorBill, postVendorPayment } from './accounting/postings';
import { closeUsAccountingPeriod, openUsAccountingPeriod, postUsManualJournal, reverseUsManualJournal } from './accounting/us-journal';
import type { FinancialAuthority, Ledger } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import { validateErpRequest } from './erp-request';
import { taxAssessmentProof, validatePublicSellerSnapshot } from './invoicing';
import { money } from './money';
import { snapshotPrivateJson } from './private-json';
import { executeErp } from './runtime';
import { applyErpDelta } from './runtime-sync';
import type { ErpCommit, ErpState, ErpStore } from './runtime-types';
import { validateStoredErp } from './runtime-validation';
import type { UsFinancialBookViewV5, UsFinancialErpCommandV5, UsFinancialErpEventV5, UsFinancialErpOperationV5 } from './us-financial-kernel-types';

const same=(a:unknown,b:unknown)=>canonicalErpJson(a)===canonicalErpJson(b);
const fail=(code='invalid_financial_erp_command',status=422):never=>{throw new ErpError(code,status);};
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))return fail();
  return value as Record<string,unknown>;
}
export function validateUsFinancialErpOperationV5(value:unknown,organizationId:string):UsFinancialErpOperationV5{
  let copied:unknown;try{copied=snapshotPrivateJson(value);}catch{return fail();}
  const raw=exact(copied,['type','idempotencyKey','command','facts']);
  if(raw.type!=='erp_command')return fail();
  if(typeof raw.idempotencyKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(raw.idempotencyKey))return fail();
  const request=validateErpRequest({idempotencyKey:raw.idempotencyKey,expectedRevision:0,command:raw.command},organizationId);
  if(['initialize','upgrade_accounting','refresh_configuration','record_payment'].includes(request.command.type))return fail('financial_erp_command_unavailable',409);
  if(!same(request.command,raw.command))return fail();
  const command=request.command as UsFinancialErpCommandV5;
  if(command.type!=='issue_invoice'){
    const facts=exact(raw.facts,['kind']);if(facts.kind!=='none')return fail();
    return Object.freeze({type:'erp_command',idempotencyKey:request.idempotencyKey,command,facts:Object.freeze({kind:'none'})});
  }
  const facts=exact(raw.facts,['kind','sellerSnapshot','taxAssessment']);
  if(facts.kind!=='invoice_issuance')return fail('invoice_issuance_facts_required',409);
  let sellerSnapshot:ReturnType<typeof validatePublicSellerSnapshot>,taxAssessment:ReturnType<typeof taxAssessmentProof>;
  try{
    const assessment=exact(facts.taxAssessment,['organizationId','country','currency','documentId','documentRevision','fingerprint','source','providerReference','determinedAt','validUntil','lines']);
    if(!Array.isArray(assessment.lines))return fail('invalid_financial_issuance_facts');
    assessment.lines.forEach(line=>exact(line,['id','taxMinor','jurisdiction','evidenceReference']));
    sellerSnapshot=validatePublicSellerSnapshot(facts.sellerSnapshot,organizationId);
    taxAssessment=taxAssessmentProof(facts.taxAssessment as Parameters<typeof taxAssessmentProof>[0]);
  }catch{return fail('invalid_financial_issuance_facts');}
  if(!same(sellerSnapshot,facts.sellerSnapshot)||!same(taxAssessment,facts.taxAssessment))return fail();
  return Object.freeze({type:'erp_command',idempotencyKey:request.idempotencyKey,command,facts:Object.freeze({kind:'invoice_issuance',sellerSnapshot,taxAssessment})});
}
export function usFinancialErpEntityIdV5(command:UsFinancialErpCommandV5,organizationId:string):string{
  if(command.type==='save_customer')return command.customer.id;
  if(command.type==='save_vendor')return command.vendor.id;
  if(command.type==='save_projects')return command.projects[0]?.id??fail();
  if(command.type==='accept_estimate')return command.estimateId;
  if(command.type==='close_period')return command.periodId;
  void organizationId;
  return command.id;
}
/** Deliberately not exported: this gross-AR projection is not a usable ERP
 * store, reporting model or public response. It exists for one local command. */
function compatibility(current:UsFinancialBookViewV5):ErpState{
  const creditIds=new Set(current.credits.map(c=>c.id));
  const removed=new Set(current.ledger.entries.filter(e=>e.source.type==='customer_credit').map(e=>{
    if(!creditIds.has(e.source.id))return fail('invalid_financial_book',503);return e.id;
  }));
  if(removed.size!==creditIds.size)return fail('invalid_financial_book',503);
  const audit=current.ledger.audit.filter(a=>!(a.action==='posted'&&removed.has(a.entityId))).map((a,i)=>({...a,revision:i+1}));
  const revisions=new Map(audit.filter(a=>a.action==='posted').map(a=>[a.entityId,a.revision]));
  const entries=current.ledger.entries.filter(e=>!removed.has(e.id)).map(e=>({...e,revision:revisions.get(e.id)??fail('invalid_financial_book',503)}));
  return validateStoredErp({schemaVersion:4,revision:current.revision,configuration:current.configuration,counters:current.counters,
    customers:current.customers,estimates:current.estimates,invoices:current.invoices,vendors:current.vendors,vendorBills:current.vendorBills,vendorPayments:current.vendorPayments,projects:current.projects,
    ledger:{...current.ledger,revision:audit.length,entries,audit}},current.organizationId);
}
function actualEffects(current:UsFinancialBookViewV5,after:ErpState,op:UsFinancialErpOperationV5,actor:FinancialAuthority):Ledger{
  const command=op.command,config=current.configuration,ledger=current.ledger;
  switch(command.type){
    case 'issue_invoice':return postCustomerInvoice(config,ledger,after.invoices.find(i=>i.id===command.id)??fail(),command.periodId,actor);
    case 'record_vendor_bill':return postVendorBill(config,ledger,after.vendorBills?.find(b=>b.id===command.id)??fail(),command.periodId,actor);
    case 'record_vendor_payment':{
      const bill=current.vendorBills.find(b=>b.id===command.billId),payment=after.vendorPayments?.find(p=>p.id===command.id);
      if(!bill||!payment)return fail();
      const paidBefore=money('USD',current.vendorPayments.filter(p=>p.billId===bill.id).reduce((n,p)=>n+BigInt(p.amount.minorUnits),BigInt(0)).toString());
      return postVendorPayment(config,ledger,bill,{id:payment.id,idempotencyKey:payment.idempotencyKey,paymentDate:payment.paymentDate,accountingDate:payment.accountingDate,periodId:payment.periodId,amount:payment.amount,paidBefore,cashFlowCategory:'operating'},actor);
    }
    case 'post_manual_journal':{const {type:_type,...input}=command;return postUsManualJournal(ledger,input,op.idempotencyKey,actor,ledger.revision);}
    case 'reverse_manual_journal':{const {type:_type,...input}=command;return reverseUsManualJournal(ledger,input,op.idempotencyKey,actor,ledger.revision);}
    case 'open_period':{const {type:_type,...input}=command;return openUsAccountingPeriod(ledger,input,actor,ledger.revision);}
    case 'close_period':return closeUsAccountingPeriod(ledger,command.periodId,actor,ledger.revision);
    default:return ledger;
  }
}
/** Invoke the existing ERP engine only against private derived memory. Every
 * actual journal/period effect is independently admitted on the V5 ledger. */
export async function transitionUsFinancialErpV5(current:UsFinancialBookViewV5,op:UsFinancialErpOperationV5,actor:FinancialAuthority,id:string):Promise<{event:UsFinancialErpEventV5;state:ErpState;ledger:Ledger}>{
  const before=compatibility(current),request={idempotencyKey:op.idempotencyKey,expectedRevision:current.revision,command:op.command};
  if(id!==usFinancialErpEntityIdV5(op.command,current.organizationId))return fail('financial_entity_conflict',409);
  let captured:Readonly<{commit:ErpCommit;state:ErpState}>|null=null;
  const store:ErpStore={supportedSchemaVersion:4,read:async org=>org===current.organizationId?before:fail('tenant_mismatch',403),receipt:async()=>null,commit:async commit=>{
    if(captured||commit.organizationId!==current.organizationId||commit.expectedRevision!==current.revision||!same(commit.actor,actor)||commit.receipt.entityId!==id)return fail('invalid_financial_erp_commit',503);
    const state=applyErpDelta(before,{schemaVersion:4,organizationId:current.organizationId,fromRevision:current.revision,toRevision:current.revision+1,headRevision:current.revision+1,hasMore:false,resetRequired:false,
      events:[{schemaVersion:4,organizationId:current.organizationId,revision:current.revision+1,header:commit.header,changes:commit.changes,ledgerAudit:commit.ledgerAudit,receipt:commit.receipt,actorId:actor.userId,occurredAt:actor.timestamp}]},current.organizationId,4);
    if(!state)return fail();captured=Object.freeze({commit,state});return commit.receipt;
  }};
  await executeErp({store,configuration:current.configuration,actor,revalidate:async()=>actor,
    taxProvider:async()=>op.facts.kind==='invoice_issuance'?{id:'private-recorded-issuance-facts',calculate:async()=>op.facts.kind==='invoice_issuance'?op.facts.taxAssessment:fail()}:null,
    seller:async()=>op.facts.kind==='invoice_issuance'?op.facts.sellerSnapshot:null},request);
  const result=captured as Readonly<{commit:ErpCommit;state:ErpState}>|null;
  if(!result)return fail('invalid_financial_erp_commit',503);
  const ledger=actualEffects(current,result.state,op,actor),postings=ledger.entries.slice(current.ledger.entries.length),audit=ledger.audit.slice(current.ledger.audit.length);
  const projectedPostings=result.state.ledger.entries.slice(before.ledger.entries.length);
  const content=(rows:readonly {revision:number}[])=>rows.map(({revision:_revision,...row})=>row);
  if(!same(content(postings),content(projectedPostings))||!same(content(audit),content(result.commit.ledgerAudit))||!same(ledger.periods,result.state.ledger.periods))return fail('invalid_financial_erp_effect',503);
  const event:UsFinancialErpEventV5=Object.freeze({revision:current.revision+1,id,operation:op,actor,commit:result.commit,effects:Object.freeze({postings:Object.freeze(postings),audit:Object.freeze(audit)})});
  return Object.freeze({event,state:result.state,ledger});
}
