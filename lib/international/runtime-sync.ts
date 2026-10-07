import { canonicalErpJson, ErpError } from './erp-contract';
import { validateStoredErp } from './runtime-validation';
import { validateCompanyConfiguration } from './country-config';
import { parseInstant } from './localization';
import type { LedgerAuditEvent } from './accounting/ledger';
import type { Contact, Estimate, IssuedInvoice } from './invoicing';
import type { PostedJournal } from './accounting/ledger';
import type { ErpHeader, ErpReceipt, ErpRecordChange, ErpState } from './runtime-types';

export interface ErpRevision {readonly schemaVersion:1; readonly organizationId:string; readonly revision:number;}
export interface ErpEvent extends ErpRevision {
  readonly header:ErpHeader;
  readonly changes:readonly ErpRecordChange[];
  readonly ledgerAudit:readonly LedgerAuditEvent[];
  readonly receipt:ErpReceipt;
  readonly actorId:string;
  readonly occurredAt:string;
}
export interface ErpDelta {
  readonly schemaVersion:1;
  readonly organizationId:string;
  readonly fromRevision:number;
  readonly toRevision:number;
  readonly headRevision:number;
  readonly hasMore:boolean;
  readonly resetRequired:boolean;
  readonly events:readonly ErpEvent[];
}
export interface ErpSyncStore {
  revision:(organizationId:string)=>Promise<ErpRevision|null>;
  changes:(organizationId:string,afterRevision:number,limit:number)=>Promise<ErpDelta|null>;
}
const same=(a:unknown,b:unknown)=>canonicalErpJson(a)===canonicalErpJson(b);
const actions=['initialize','refresh_configuration','save_customer','save_estimate','accept_estimate','issue_invoice','record_payment','close_period'];
function invalid():never{throw new ErpError('invalid_sync_state',503);}
function integer(value:unknown):value is number{return Number.isSafeInteger(value)&&(value as number)>=0&&(value as number)<Number.MAX_SAFE_INTEGER;}
function exactKeys(value:unknown,keys:readonly string[]):boolean{return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(k=>typeof k==='string'&&keys.includes(k));}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export function validateErpRevision(value:unknown,organizationId:string):ErpRevision{
  const r=value as ErpRevision;
  if(!r||r.schemaVersion!==1||r.organizationId!==organizationId||!integer(r.revision)||r.revision<1)return invalid();
  return Object.freeze({schemaVersion:1,organizationId:r.organizationId,revision:r.revision});
}
/** Bounded, tenant-scoped wire contract. Financial records are checked on application, too. */
export function validateErpDelta(value:unknown,organizationId:string,afterRevision:number,limit=100):ErpDelta{
  const d=value as ErpDelta;
  if(!integer(afterRevision)||!Number.isInteger(limit)||limit<1||limit>100||!exactKeys(d,['schemaVersion','organizationId','fromRevision','toRevision','headRevision','hasMore','resetRequired','events'])||d.schemaVersion!==1||d.organizationId!==organizationId||d.fromRevision!==afterRevision||!integer(d.toRevision)||!integer(d.headRevision)||d.toRevision<d.fromRevision||d.headRevision<d.toRevision||typeof d.hasMore!=='boolean'||typeof d.resetRequired!=='boolean'||!Array.isArray(d.events)||d.events.length>limit)return invalid();
  if(d.resetRequired){if(d.events.length||d.toRevision!==d.fromRevision||d.hasMore)return invalid();return d;}
  if(d.events.length!==d.toRevision-d.fromRevision||d.hasMore!==(d.toRevision<d.headRevision)||(!d.events.length&&d.headRevision!==d.fromRevision))return invalid();
  for(let i=0;i<d.events.length;i++){
    const event=d.events[i];validateErpRevision(event,organizationId);
    if(!exactKeys(event,['schemaVersion','organizationId','revision','header','changes','ledgerAudit','receipt','actorId','occurredAt'])||!exactKeys(event.header,['schemaVersion','revision','configuration','counters','ledger'])||!exactKeys(event.header.counters,['estimate','invoice'])||!integer(event.header.counters.estimate)||!integer(event.header.counters.invoice)||!exactKeys(event.header.ledger,['organizationId','currency','basis','revision','accounts','periods'])||!integer(event.header.ledger.revision)||!Array.isArray(event.header.ledger.accounts)||!Array.isArray(event.header.ledger.periods)||!event.header.configuration)return invalid();
    if(event.revision!==d.fromRevision+i+1||!event.header||event.header.revision!==event.revision||event.header.schemaVersion!==1||event.header.configuration.organizationId!==organizationId||event.header.configuration.country!=='US'||!event.header.ledger||event.header.ledger.organizationId!==organizationId||event.header.ledger.currency!=='USD'||event.header.ledger.basis!==event.header.configuration.accountingBasis||!Array.isArray(event.changes)||event.changes.length>5000||!Array.isArray(event.ledgerAudit)||event.ledgerAudit.length>1000||typeof event.actorId!=='string'||!event.actorId||event.actorId.length>256)return invalid();
    try{parseInstant(event.occurredAt);validateCompanyConfiguration(event.header.configuration);}catch{return invalid();}
    const r=event.receipt;
    if(!exactKeys(r,['idempotencyKey','commandHash','revision','entityId','action'])||r.revision!==event.revision||!actions.includes(r.action)||typeof r.commandHash!=='string'||!/^[a-f0-9]{64}$/.test(r.commandHash)||typeof r.idempotencyKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,231}$/.test(r.idempotencyKey)||typeof r.entityId!=='string'||!r.entityId)return invalid();
    const ids=new Set<string>();
    for(const change of event.changes){
      if(!exactKeys(change,['kind','id','payload'])||!['customer','estimate','invoice','journal'].includes(change.kind)||typeof change.id!=='string'||!change.id||change.id.length>(change.kind==='journal'?512:160))return invalid();
      const payload=change.payload as {id?:unknown;organizationId?:unknown};
      if(!payload||payload.id!==change.id||payload.organizationId!==organizationId||ids.has(`${change.kind}:${change.id}`))return invalid();ids.add(`${change.kind}:${change.id}`);
    }
  }
  return d;
}
function upsert<T extends {id:string}>(rows:readonly T[],value:T):readonly T[]{const index=rows.findIndex(r=>r.id===value.id);return index<0?[...rows,value]:rows.map((row,i)=>i===index?value:row);}
/** Apply to a private candidate. No partially applied batch escapes on an invalid event. */
export function applyErpDelta(current:ErpState|null,raw:unknown,organizationId:string):ErpState|null{
  if(current)validateStoredErp(current,organizationId);
  const delta=validateErpDelta(raw,organizationId,current?.revision??0);
  if(delta.resetRequired)throw new ErpError('sync_reset_required',409);
  let candidate=current;
  for(const event of delta.events){
    if(!candidate&&event.revision!==1)return invalid();
    if(candidate){
      const before=candidate.configuration,after=event.header.configuration;
      if(before.country!==after.country||before.currency!==after.currency||before.accountingBasis!==after.accountingBasis||event.header.counters.estimate<candidate.counters.estimate||event.header.counters.invoice<candidate.counters.invoice)return invalid();
      if(event.receipt.action!=='refresh_configuration'&&!same(before,after))return invalid();
      if(!same(candidate.ledger.accounts,event.header.ledger.accounts))return invalid();
      const expectedPeriods=event.receipt.action==='close_period'?candidate.ledger.periods.map(p=>p.id===event.receipt.entityId&&p.status==='open'?{...p,status:'closed'}:p):candidate.ledger.periods;
      if(!same(expectedPeriods,event.header.ledger.periods))return invalid();
      const expectedCounters={estimate:candidate.counters.estimate+(event.receipt.action==='save_estimate'&&!candidate.estimates.some(e=>e.id===event.receipt.entityId)?1:0),invoice:candidate.counters.invoice+(event.receipt.action==='issue_invoice'?1:0)};
      if(!same(expectedCounters,event.header.counters))return invalid();
    }else if(event.receipt.action!=='initialize'||event.header.counters.estimate!==0||event.header.counters.invoice!==0){return invalid();
    }
    let customers=candidate?.customers??[],estimates=candidate?.estimates??[],invoices=candidate?.invoices??[],entries=candidate?.ledger.entries??[];
    for(const change of event.changes){
      if(change.kind==='customer')customers=upsert(customers,change.payload as Contact);
      else if(change.kind==='estimate'){
        const old=estimates.find(e=>e.id===change.id);
        if(old&&invoices.some(i=>i.sourceEstimateId===old.id)&&!same(old,change.payload))return invalid();
        estimates=upsert(estimates,change.payload as Estimate);
      }else if(change.kind==='invoice'){
        const next=change.payload as IssuedInvoice,old=invoices.find(i=>i.id===change.id);
        if(old){
          if(!Array.isArray(next.payments)||!same({...old,payments:[]},{...next,payments:[]})||next.payments.length<old.payments.length||!same(next.payments.slice(0,old.payments.length),old.payments))return invalid();
        }
        invoices=upsert(invoices,next);
      }else{
        if(entries.some(e=>e.id===change.id))return invalid();
        entries=[...entries,change.payload as PostedJournal];
      }
    }
    candidate={...event.header,customers,estimates,invoices,ledger:{...event.header.ledger,entries,audit:[...(candidate?.ledger.audit??[]),...event.ledgerAudit]}};
    validateStoredErp(candidate,organizationId);
  }
  return candidate===current?current:freeze(structuredClone(candidate));
}
