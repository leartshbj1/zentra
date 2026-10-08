import { ErpError } from '../erp-contract';
import { snapshotPrivateJson } from '../private-json';
import { assertFinancialAuthority, closePeriod, postJournal, validDate, type CashFlowCategory, type FinancialAuthority, type JournalLine, type Ledger } from './ledger';

export interface UsOpenPeriodInput { readonly id: string; readonly start: string; readonly end: string; }
export interface UsManualJournalInput {
  readonly id: string;
  readonly transactionDate: string;
  readonly accountingDate: string;
  readonly periodId: string;
  readonly description: string;
  readonly sourceReference: string;
  readonly lines: readonly JournalLine[];
  readonly cashFlowCategory?: CashFlowCategory;
}
export interface UsManualReversalInput {
  readonly id: string;
  readonly entryId: string;
  readonly transactionDate: string;
  readonly accountingDate: string;
  readonly periodId: string;
  readonly reason: string;
}
export const US_MANUAL_EXCLUDED_ACCOUNTS: readonly string[] = Object.freeze(['receivables','payables','tax-payable','deposits']);
function fail(code='invalid_request',status=422): never { throw new ErpError(code,status); }
function snapshot(input:unknown):unknown { try{return snapshotPrivateJson(input);}catch{return fail();} }
function fields(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))return fail();
  const v=value as Record<string,unknown>;
  if(required.some(key=>!Object.hasOwn(v,key))||Object.keys(v).some(key=>![...required,...optional].includes(key)))return fail();
  return v;
}
function text(value:unknown,maximum=160):string {
  if(typeof value!=='string'||!value.trim()||value.length>maximum||Array.from(value).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))return fail();
  return value;
}
function date(value:unknown):string {if(typeof value!=='string'||value.startsWith('0000-')||!validDate(value))return fail('invalid_date');return value;}
function amount(value:unknown):string {if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,35})$/.test(value))return fail('invalid_amount');return value;}
export function validateUsOpenPeriodInput(input:unknown):UsOpenPeriodInput {
  const v=fields(snapshot(input),['id','start','end']);
  const result={id:text(v.id),start:date(v.start),end:date(v.end)};
  if(result.end<result.start)return fail('invalid_period');
  return Object.freeze(result);
}
export function validateUsManualJournalInput(input:unknown):UsManualJournalInput {
  const v=fields(snapshot(input),['id','transactionDate','accountingDate','periodId','description','sourceReference','lines'],['cashFlowCategory']);
  if(!Array.isArray(v.lines)||v.lines.length<2||v.lines.length>1000)return fail('invalid_request');
  const lines=v.lines.map(raw=>{
    const l=fields(raw,['accountId','debitMinor','creditMinor'],['description']);
    const accountId=text(l.accountId);
    if(US_MANUAL_EXCLUDED_ACCOUNTS.includes(accountId))return fail('manual_account_forbidden');
    return Object.freeze({accountId,debitMinor:amount(l.debitMinor),creditMinor:amount(l.creditMinor),...(Object.hasOwn(l,'description')?{description:text(l.description,2000)}:{})});
  });
  if(Object.hasOwn(v,'cashFlowCategory')&&!['operating','investing','financing'].includes(v.cashFlowCategory as string))return fail();
  return Object.freeze({id:text(v.id),transactionDate:date(v.transactionDate),accountingDate:date(v.accountingDate),periodId:text(v.periodId),description:text(v.description,2000),sourceReference:text(v.sourceReference),lines:Object.freeze(lines),...(Object.hasOwn(v,'cashFlowCategory')?{cashFlowCategory:v.cashFlowCategory as CashFlowCategory}:{})});
}
export function validateUsManualReversalInput(input:unknown):UsManualReversalInput {
  const v=fields(snapshot(input),['id','entryId','transactionDate','accountingDate','periodId','reason']);
  return Object.freeze({id:text(v.id),entryId:text(v.entryId),transactionDate:date(v.transactionDate),accountingDate:date(v.accountingDate),periodId:text(v.periodId),reason:text(v.reason,2000)});
}
function authority(ledger:Ledger,actor:FinancialAuthority):void {
  if(ledger.currency!=='USD')return fail('edition_unavailable',409);
  assertFinancialAuthority(ledger,actor);
}
function revision(ledger:Ledger,expected:number):void {if(!Number.isSafeInteger(expected)||expected!==ledger.revision||ledger.revision>=Number.MAX_SAFE_INTEGER-1)return fail('revision_conflict',409);}
export function openUsAccountingPeriod(ledger:Ledger,input:UsOpenPeriodInput,actor:FinancialAuthority,expectedLedgerRevision:number):Ledger {
  const v=validateUsOpenPeriodInput(input);authority(ledger,actor);revision(ledger,expectedLedgerRevision);
  if(ledger.periods.some(p=>p.id===v.id))return fail('period_already_exists',409);
  if(ledger.periods.length>=100)return fail('period_limit_reached',409);
  if(ledger.periods.some(p=>v.start<=p.end))return fail('invalid_period');
  const next=ledger.revision+1;
  return Object.freeze({...ledger,revision:next,periods:Object.freeze([...ledger.periods,Object.freeze({...v,status:'open' as const})]),audit:Object.freeze([...ledger.audit,Object.freeze({revision:next,action:'period_opened' as const,actorId:actor.userId,timestamp:actor.timestamp,entityId:v.id})])});
}
export function postUsManualJournal(ledger:Ledger,input:UsManualJournalInput,key:string,actor:FinancialAuthority,expectedLedgerRevision:number):Ledger {
  const v=validateUsManualJournalInput(input);authority(ledger,actor);
  if(ledger.revision>=Number.MAX_SAFE_INTEGER-1&&!ledger.entries.some(e=>e.idempotencyKey===key))return fail('revision_conflict',409);
  return postJournal(ledger,{id:v.id,idempotencyKey:key,organizationId:ledger.organizationId,currency:ledger.currency,basis:ledger.basis,transactionDate:v.transactionDate,accountingDate:v.accountingDate,periodId:v.periodId,description:v.description,source:{type:'manual_journal',id:v.sourceReference},lines:v.lines,...(v.cashFlowCategory?{cashFlowCategory:v.cashFlowCategory}:{})},actor,expectedLedgerRevision);
}
export function reverseUsManualJournal(ledger:Ledger,input:UsManualReversalInput,key:string,actor:FinancialAuthority,expectedLedgerRevision:number):Ledger {
  const v=validateUsManualReversalInput(input);authority(ledger,actor);
  if(ledger.revision>=Number.MAX_SAFE_INTEGER-1&&!ledger.entries.some(e=>e.idempotencyKey===key))return fail('revision_conflict',409);
  const original=ledger.entries.find(entry=>entry.id===v.entryId);
  if(!original)return fail('entry_not_found',404);
  if(original.source.type!=='manual_journal')return fail('manual_journal_required',409);
  const lines=original.lines.map(line=>Object.freeze({accountId:line.accountId,debitMinor:line.creditMinor,creditMinor:line.debitMinor,...(line.description!==undefined?{description:line.description}:{})}));
  validateUsManualJournalInput({id:v.id,transactionDate:v.transactionDate,accountingDate:v.accountingDate,periodId:v.periodId,description:v.reason,sourceReference:original.id,lines,...(original.cashFlowCategory?{cashFlowCategory:original.cashFlowCategory}:{})});
  return postJournal(ledger,{id:v.id,idempotencyKey:key,organizationId:ledger.organizationId,currency:ledger.currency,basis:ledger.basis,transactionDate:v.transactionDate,accountingDate:v.accountingDate,periodId:v.periodId,description:v.reason,source:{type:'manual_reversal',id:original.id},reversesEntryId:original.id,lines,...(original.cashFlowCategory?{cashFlowCategory:original.cashFlowCategory}:{})},actor,expectedLedgerRevision);
}
export function closeUsAccountingPeriod(ledger:Ledger,periodId:string,actor:FinancialAuthority,expectedLedgerRevision:number):Ledger {
  authority(ledger,actor);revision(ledger,expectedLedgerRevision);
  const target=ledger.periods.find(p=>p.id===periodId);
  if(!target)return fail('accounting_period_required',409);
  if(target.status==='closed')return fail('accounting_period_closed',409);
  if(ledger.periods.some(p=>p.status==='open'&&p.start<target.start))return fail('accounting_period_order_conflict',409);
  return closePeriod(ledger,periodId,actor,expectedLedgerRevision);
}
