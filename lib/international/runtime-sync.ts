import { canonicalErpJson, ErpError } from './erp-contract';
import { validateStoredErp } from './runtime-validation';
import { validateCompanyConfiguration } from './country-config';
import { parseInstant } from './localization';
import type { LedgerAuditEvent } from './accounting/ledger';
import type { Contact, Estimate, IssuedInvoice } from './invoicing';
import type { PostedJournal } from './accounting/ledger';
import type { ErpHeader, ErpReceipt, ErpRecordChange, ErpState } from './runtime-types';
import type { RecordedVendorBill, RecordedVendorPayment } from './purchasing';
import type { ErpSchemaVersion } from './erp-schema-capability';
import type { StoredProject } from './projects';
import { closeUsAccountingPeriod, openUsAccountingPeriod } from './accounting/us-journal';

export interface ErpRevision {readonly schemaVersion:ErpSchemaVersion; readonly organizationId:string; readonly revision:number;}
export interface ErpEvent extends ErpRevision {
  readonly header:ErpHeader;
  readonly changes:readonly ErpRecordChange[];
  readonly ledgerAudit:readonly LedgerAuditEvent[];
  readonly receipt:ErpReceipt;
  readonly actorId:string;
  readonly occurredAt:string;
}
export interface ErpDelta {
  readonly schemaVersion:ErpSchemaVersion;
  readonly organizationId:string;
  readonly fromRevision:number;
  readonly toRevision:number;
  readonly headRevision:number;
  readonly hasMore:boolean;
  readonly resetRequired:boolean;
  readonly events:readonly ErpEvent[];
}
export interface ErpSyncStore {
  readonly supportedSchemaVersion?:ErpSchemaVersion;
  revision:(organizationId:string)=>Promise<ErpRevision|null>;
  changes:(organizationId:string,afterRevision:number,limit:number)=>Promise<ErpDelta|null>;
}
const same=(a:unknown,b:unknown)=>canonicalErpJson(a)===canonicalErpJson(b);
function sameInstant(a:string,b:string):boolean{try{return parseInstant(a).getTime()===parseInstant(b).getTime();}catch{return false;}}
const purchasingActions=['save_vendor','record_vendor_bill','record_vendor_payment'];
const accountingActions=['upgrade_accounting','open_period','post_manual_journal','reverse_manual_journal'];
const actions=['initialize','refresh_configuration','save_customer','save_estimate','accept_estimate','issue_invoice','record_payment','close_period',...purchasingActions,'save_projects',...accountingActions];
function invalid():never{throw new ErpError('invalid_sync_state',503);}
function integer(value:unknown):value is number{return Number.isSafeInteger(value)&&(value as number)>=0&&(value as number)<Number.MAX_SAFE_INTEGER;}
function exactKeys(value:unknown,keys:readonly string[]):boolean{return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(k=>typeof k==='string'&&keys.includes(k));}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export function validateErpRevision(value:unknown,organizationId:string,supportedSchemaVersion:ErpSchemaVersion=1):ErpRevision{
  const r=value as ErpRevision;
  if(!r||![1,2,3,4].includes(r.schemaVersion)||r.organizationId!==organizationId||!integer(r.revision)||r.revision<1)return invalid();
  if(r.schemaVersion>supportedSchemaVersion)throw new ErpError('client_upgrade_required',409);
  return Object.freeze({schemaVersion:r.schemaVersion,organizationId:r.organizationId,revision:r.revision});
}
/** Bounded, tenant-scoped wire contract. Financial records are checked on application, too. */
export function validateErpDelta(value:unknown,organizationId:string,afterRevision:number,limit=100,supportedSchemaVersion:ErpSchemaVersion=1):ErpDelta{
  const d=value as ErpDelta;
  if(!integer(afterRevision)||!Number.isInteger(limit)||limit<1||limit>100||!exactKeys(d,['schemaVersion','organizationId','fromRevision','toRevision','headRevision','hasMore','resetRequired','events'])||![1,2,3,4].includes(d.schemaVersion)||d.organizationId!==organizationId||d.fromRevision!==afterRevision||!integer(d.toRevision)||!integer(d.headRevision)||d.toRevision<d.fromRevision||d.headRevision<d.toRevision||typeof d.hasMore!=='boolean'||typeof d.resetRequired!=='boolean'||!Array.isArray(d.events)||d.events.length>limit)return invalid();
  if(d.schemaVersion>supportedSchemaVersion)throw new ErpError('client_upgrade_required',409);
  if(d.resetRequired){if(d.events.length||d.toRevision!==d.fromRevision||d.hasMore)return invalid();return d;}
  if(d.events.length!==d.toRevision-d.fromRevision||d.hasMore!==(d.toRevision<d.headRevision)||(!d.events.length&&d.headRevision!==d.fromRevision))return invalid();
  for(let i=0;i<d.events.length;i++){
    const event=d.events[i];validateErpRevision(event,organizationId,supportedSchemaVersion);
    if(!exactKeys(event,['schemaVersion','organizationId','revision','header','changes','ledgerAudit','receipt','actorId','occurredAt'])||!exactKeys(event.header,['schemaVersion','revision','configuration','counters','ledger'])||!exactKeys(event.header.counters,event.schemaVersion>=3?['estimate','invoice','project']:['estimate','invoice'])||!integer(event.header.counters.estimate)||!integer(event.header.counters.invoice)||(event.schemaVersion>=3&&!integer(event.header.counters.project))||!exactKeys(event.header.ledger,['organizationId','currency','basis','revision','accounts','periods'])||!integer(event.header.ledger.revision)||!Array.isArray(event.header.ledger.accounts)||!Array.isArray(event.header.ledger.periods)||!event.header.configuration)return invalid();
    if(event.revision!==d.fromRevision+i+1||!event.header||event.header.revision!==event.revision||event.header.schemaVersion!==event.schemaVersion||event.schemaVersion>d.schemaVersion||event.header.configuration.organizationId!==organizationId||event.header.configuration.country!=='US'||!event.header.ledger||event.header.ledger.organizationId!==organizationId||event.header.ledger.currency!=='USD'||event.header.ledger.basis!==event.header.configuration.accountingBasis||!Array.isArray(event.changes)||event.changes.length>5000||!Array.isArray(event.ledgerAudit)||event.ledgerAudit.length>1000||typeof event.actorId!=='string'||!event.actorId||event.actorId.length>256)return invalid();
    try{parseInstant(event.occurredAt);validateCompanyConfiguration(event.header.configuration);}catch{return invalid();}
    const r=event.receipt;
    if(!exactKeys(r,['idempotencyKey','commandHash','revision','entityId','action'])||r.revision!==event.revision||!actions.includes(r.action)||typeof r.commandHash!=='string'||!/^[a-f0-9]{64}$/.test(r.commandHash)||typeof r.idempotencyKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,231}$/.test(r.idempotencyKey)||typeof r.entityId!=='string'||!r.entityId)return invalid();
    if(event.schemaVersion===1&&purchasingActions.includes(r.action))return invalid();
    if(event.schemaVersion<3&&r.action==='save_projects')return invalid();
    if(event.schemaVersion!==4&&accountingActions.includes(r.action))return invalid();
    const ids=new Set<string>();
    for(const change of event.changes){
      const kinds=event.schemaVersion>=3?['customer','estimate','invoice','journal','vendor','vendor_bill','vendor_payment','project']:event.schemaVersion===2?['customer','estimate','invoice','journal','vendor','vendor_bill','vendor_payment']:['customer','estimate','invoice','journal'];
      if(!exactKeys(change,['kind','id','payload'])||!kinds.includes(change.kind)||typeof change.id!=='string'||!change.id||change.id.length>(change.kind==='journal'?512:160))return invalid();
      const payload=change.payload as {id?:unknown;organizationId?:unknown};
      if(!payload||payload.id!==change.id||payload.organizationId!==organizationId||ids.has(`${change.kind}:${change.id}`))return invalid();ids.add(`${change.kind}:${change.id}`);
    }
  }
  return d;
}
function upsert<T extends {id:string}>(rows:readonly T[],value:T):readonly T[]{const index=rows.findIndex(r=>r.id===value.id);return index<0?[...rows,value]:rows.map((row,i)=>i===index?value:row);}
/** Apply to a private candidate. No partially applied batch escapes on an invalid event. */
export function applyErpDelta(current:ErpState|null,raw:unknown,organizationId:string,supportedSchemaVersion:ErpSchemaVersion=1):ErpState|null{
  if(current)validateStoredErp(current,organizationId);
  if(current&&current.schemaVersion>supportedSchemaVersion)throw new ErpError('client_upgrade_required',409);
  const delta=validateErpDelta(raw,organizationId,current?.revision??0,100,supportedSchemaVersion);
  if(delta.resetRequired)throw new ErpError('sync_reset_required',409);
  let candidate=current;
  for(const event of delta.events){
    if(!candidate&&event.revision!==1)return invalid();
    if(candidate){
      if(event.header.schemaVersion<candidate.schemaVersion||(event.header.schemaVersion>candidate.schemaVersion&&!(event.header.schemaVersion===2&&candidate.schemaVersion===1&&purchasingActions.includes(event.receipt.action))&&!(event.header.schemaVersion===3&&event.receipt.action==='save_projects')&&!(event.header.schemaVersion===4&&candidate.schemaVersion===3&&event.receipt.action==='upgrade_accounting')))return invalid();
      if(event.receipt.action==='upgrade_accounting'&&(candidate.schemaVersion!==3||event.schemaVersion!==4))return invalid();
      const before=candidate.configuration,after=event.header.configuration;
      if(before.country!==after.country||before.currency!==after.currency||before.accountingBasis!==after.accountingBasis||event.header.counters.estimate<candidate.counters.estimate||event.header.counters.invoice<candidate.counters.invoice)return invalid();
      if(event.receipt.action!=='refresh_configuration'&&!same(before,after))return invalid();
      if(!same(candidate.ledger.accounts,event.header.ledger.accounts))return invalid();
      let expectedPeriods=candidate.ledger.periods;
      try{
        const actor={organizationId,userId:event.actorId,role:'owner' as const,managementEntitled:true,timestamp:event.occurredAt};
        if(event.receipt.action==='open_period'){
          const p=event.header.ledger.periods.find(p=>p.id===event.receipt.entityId);if(!p)return invalid();
          expectedPeriods=openUsAccountingPeriod(candidate.ledger,{id:p.id,start:p.start,end:p.end},actor,candidate.ledger.revision).periods;
        }else if(event.receipt.action==='close_period')expectedPeriods=event.schemaVersion===4?closeUsAccountingPeriod(candidate.ledger,event.receipt.entityId,actor,candidate.ledger.revision).periods:candidate.ledger.periods.map(p=>p.id===event.receipt.entityId&&p.status==='open'?{...p,status:'closed'}:p);
      }catch{return invalid();}
      if(!same(expectedPeriods,event.header.ledger.periods))return invalid();
      const expectedCounters={estimate:candidate.counters.estimate+(event.receipt.action==='save_estimate'&&!candidate.estimates.some(e=>e.id===event.receipt.entityId)?1:0),invoice:candidate.counters.invoice+(event.receipt.action==='issue_invoice'?1:0),...(event.schemaVersion>=3?{project:(candidate.counters.project??0)+event.changes.filter(c=>c.kind==='project'&&!candidate?.projects?.some(p=>p.id===c.id)).length}:{})};
      if(!same(expectedCounters,event.header.counters))return invalid();
    }else if(event.receipt.action!=='initialize'||![1,4].includes(event.header.schemaVersion)||event.header.counters.estimate!==0||event.header.counters.invoice!==0||(event.schemaVersion===4&&(event.header.counters.project!==0||event.changes.length||event.ledgerAudit.length))){return invalid();
    }
    if(event.schemaVersion===4){
      const ledgerBefore=candidate?.ledger.revision??0;
      if(event.header.ledger.revision!==ledgerBefore+event.ledgerAudit.length)return invalid();
      for(let i=0;i<event.ledgerAudit.length;i++){
        const a=event.ledgerAudit[i];
        if(!exactKeys(a,['revision','action','actorId','timestamp','entityId'])||a.revision!==ledgerBefore+i+1||a.actorId!==event.actorId||!sameInstant(a.timestamp,event.occurredAt))return invalid();
      }
      if(event.receipt.action==='upgrade_accounting'&&(event.changes.length||event.ledgerAudit.length||event.receipt.entityId!==organizationId))return invalid();
      if(['open_period','close_period'].includes(event.receipt.action)&&(event.changes.length||event.ledgerAudit.length!==1||event.ledgerAudit[0].action!==(event.receipt.action==='open_period'?'period_opened':'period_closed')||event.ledgerAudit[0].entityId!==event.receipt.entityId))return invalid();
      if(['post_manual_journal','reverse_manual_journal'].includes(event.receipt.action)){
        if(event.changes.length!==1||event.changes[0].kind!=='journal'||event.changes[0].id!==event.receipt.entityId||event.ledgerAudit.length!==1||event.ledgerAudit[0].action!=='posted'||event.ledgerAudit[0].entityId!==event.receipt.entityId)return invalid();
        const entry=event.changes[0].payload as PostedJournal;
        if(entry.idempotencyKey!==event.receipt.idempotencyKey||entry.source?.type!==(event.receipt.action==='post_manual_journal'?'manual_journal':'manual_reversal'))return invalid();
      }
      for(const c of event.changes)if(c.kind==='journal'){
        const entry=c.payload as PostedJournal;if(entry.postedBy!==event.actorId||!sameInstant(entry.postedAt,event.occurredAt))return invalid();
        if((entry.source?.type==='manual_journal'&&event.receipt.action!=='post_manual_journal')||(entry.source?.type==='manual_reversal'&&event.receipt.action!=='reverse_manual_journal'))return invalid();
      }
    }
    let customers=candidate?.customers??[],estimates=candidate?.estimates??[],invoices=candidate?.invoices??[],entries=candidate?.ledger.entries??[];
    let vendors=candidate?.vendors??[],vendorBills=candidate?.vendorBills??[],vendorPayments=candidate?.vendorPayments??[];
    let projects=candidate?.projects??[];
    const projectChanges=event.changes.filter(change=>change.kind==='project');
    if(event.receipt.action==='save_projects'){
      if(projectChanges.length<1||projectChanges.length>1000||projectChanges.length!==event.changes.length||!projectChanges.some(change=>change.id===event.receipt.entityId)||event.ledgerAudit.length||!candidate||!same({...candidate.ledger,entries:undefined,audit:undefined},event.header.ledger))return invalid();
    }else if(projectChanges.length)return invalid();
    const purchaseKind=event.receipt.action==='save_vendor'?'vendor':event.receipt.action==='record_vendor_bill'?'vendor_bill':event.receipt.action==='record_vendor_payment'?'vendor_payment':null;
    const purchaseChanges=event.changes.filter(c=>['vendor','vendor_bill','vendor_payment'].includes(c.kind));
    if(purchaseKind){
      if(purchaseChanges.length!==1||purchaseChanges[0].kind!==purchaseKind||purchaseChanges[0].id!==event.receipt.entityId||event.changes.some(c=>c.kind!==purchaseKind&&c.kind!=='journal'))return invalid();
      if(purchaseKind==='vendor'&&(event.changes.length!==1||event.ledgerAudit.length!==0))return invalid();
    }else if(purchaseChanges.length)return invalid();
    for(const change of event.changes){
      if(change.kind==='customer')customers=upsert(customers,change.payload as Contact);
      else if(change.kind==='project'){
        const project=change.payload as StoredProject,old=projects.find(p=>p.id===change.id);
        if(project.revision!==(old?.revision??0)+1||!sameInstant(project.updatedAt,event.occurredAt)||(!old&&!sameInstant(project.createdAt,event.occurredAt))||old&&(project.number!==old.number||project.createdAt!==old.createdAt||((estimates.some(q=>q.projectId===old.id)||invoices.some(i=>i.projectId===old.id))&&project.customerId!==old.customerId)))return invalid();
        projects=upsert(projects,project);
      }else if(change.kind==='estimate'){
        const old=estimates.find(e=>e.id===change.id);
        const next=change.payload as Estimate;
        if(event.schemaVersion>=3&&event.receipt.action==='save_estimate'&&next.projectId&&!projects.some(p=>p.id===next.projectId&&p.status==='active'&&p.customerId===next.customer.id))return invalid();
        if(old&&invoices.some(i=>i.sourceEstimateId===old.id)&&!same(old,change.payload))return invalid();
        estimates=upsert(estimates,change.payload as Estimate);
      }else if(change.kind==='invoice'){
        const next=change.payload as IssuedInvoice,old=invoices.find(i=>i.id===change.id);
        if(old){
          if(!Array.isArray(next.payments)||!same({...old,payments:[]},{...next,payments:[]})||next.payments.length<old.payments.length||!same(next.payments.slice(0,old.payments.length),old.payments))return invalid();
        }
        invoices=upsert(invoices,next);
      }else if(change.kind==='vendor')vendors=upsert(vendors,change.payload as Contact);
      else if(change.kind==='vendor_bill'){
        const bill=change.payload as RecordedVendorBill;
        if(vendorBills.some(b=>b.id===change.id)||bill.recordedRevision!==event.revision||bill.validatedBy!==event.actorId||!sameInstant(bill.approvedAt,event.occurredAt)||!same(bill.vendorSnapshot,vendors.find(v=>v.id===bill.vendorId)))return invalid();
        vendorBills=[...vendorBills,bill];
      }else if(change.kind==='vendor_payment'){
        const payment=change.payload as RecordedVendorPayment;
        if(vendorPayments.some(p=>p.id===change.id)||payment.recordedRevision!==event.revision||payment.recordedBy!==event.actorId||payment.idempotencyKey!==event.receipt.idempotencyKey||!sameInstant(payment.recordedAt,event.occurredAt))return invalid();
        vendorPayments=[...vendorPayments,payment];
      }else if(change.kind==='journal'){
        if(entries.some(e=>e.id===change.id))return invalid();
        entries=[...entries,change.payload as PostedJournal];
      }else return invalid();
    }
    candidate={...event.header,customers,estimates,invoices,...(event.header.schemaVersion>=2?{vendors,vendorBills,vendorPayments}:{}),...(event.header.schemaVersion>=3?{projects}:{}),ledger:{...event.header.ledger,entries,audit:[...(candidate?.ledger.audit??[]),...event.ledgerAudit]}};
    validateStoredErp(candidate,organizationId);
  }
  return candidate===current?current:freeze(structuredClone(candidate));
}
