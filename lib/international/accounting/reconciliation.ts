import { money } from '../money';
import type { Currency, Money } from '../types';
import { assertFinancialAuthority, LedgerError, validDate, type FinancialAuthority, type Ledger } from './ledger';

/** Bank connection IDs are opaque references; no routing/account numbers or credentials here. */
export type BankStatement = Readonly<{id:string;organizationId:string;externalConnectionId:string;currency:Currency;cashAccountId:string;start:string;end:string;opening:Money;closing:Money;lines:readonly StatementLine[]}>;
export type StatementLine=Readonly<{id:string;date:string;amount:Money;reference:string}>;
export type ReconciliationMatch=Readonly<{id:string;idempotencyKey:string;statementLineIds:readonly string[];ledgerEntryIds:readonly string[];fingerprint:string;approvedBy:string;approvedAt:string}>;
export type Reconciliation=Readonly<{organizationId:string;statement:BankStatement;revision:number;matches:readonly ReconciliationMatch[];completedAt?:string;completedBy?:string;completedLedgerRevision?:number}>;
const text=(value:string)=>{if(typeof value!=='string'||!value.trim()||value.length>256||Array.from(value).some(char=>char.charCodeAt(0)<32)) throw new LedgerError('INVALID_BANK_REFERENCE');};
function signedAmount(value:Money,currency:Currency):bigint {
  if(value.currency!==currency || typeof value.minorUnits!=='string' || !/^-?(0|[1-9][0-9]{0,35})$/.test(value.minorUnits)) throw new LedgerError('INVALID_STATEMENT_AMOUNT');
  return BigInt(money(currency,value.minorUnits).minorUnits);
}
function compatible(state:Reconciliation,ledger:Ledger,actor:FinancialAuthority) {
  assertFinancialAuthority(ledger,actor);
  if(state.organizationId!==ledger.organizationId || state.statement.organizationId!==ledger.organizationId) throw new LedgerError('TENANT_MISMATCH');
  if(state.statement.currency!==ledger.currency) throw new LedgerError('CURRENCY_MISMATCH');
  if(!ledger.accounts.some(account=>account.id===state.statement.cashAccountId && account.cash)) throw new LedgerError('CASH_ACCOUNT_REQUIRED');
}
export function createReconciliation(statement:BankStatement,ledger:Ledger,actor:FinancialAuthority):Reconciliation {
  const state={organizationId:statement.organizationId,statement,revision:0,matches:[]};compatible(state,ledger,actor);
  text(statement.id);text(statement.externalConnectionId);
  if(!validDate(statement.start)||!validDate(statement.end)||statement.start>statement.end) throw new LedgerError('INVALID_STATEMENT_PERIOD');
  if(statement.lines.length>10000) throw new LedgerError('STATEMENT_TOO_LARGE');
  const ids=new Set<string>();let movement=BigInt(0);
  for(const line of statement.lines) {text(line.id);text(line.reference);if(ids.has(line.id)) throw new LedgerError('DUPLICATE_STATEMENT_LINE');ids.add(line.id);if(!validDate(line.date)||line.date<statement.start||line.date>statement.end) throw new LedgerError('INVALID_STATEMENT_DATE');const amount=signedAmount(line.amount,statement.currency);if(amount===BigInt(0)) throw new LedgerError('INVALID_STATEMENT_AMOUNT');movement+=amount;}
  if(signedAmount(statement.opening,statement.currency)+movement!==signedAmount(statement.closing,statement.currency)) throw new LedgerError('STATEMENT_BALANCE_MISMATCH');
  return Object.freeze({...state,statement:Object.freeze({...statement,opening:Object.freeze({...statement.opening}),closing:Object.freeze({...statement.closing}),lines:Object.freeze(statement.lines.map(line=>Object.freeze({...line,amount:Object.freeze({...line.amount})})))}),matches:Object.freeze([])});
}
/** Exact amount matching with explicit human approval. No fuzzy auto-posting of differences. */
export function approveReconciliationMatch(state:Reconciliation,ledger:Ledger,input:Pick<ReconciliationMatch,'id'|'idempotencyKey'|'statementLineIds'|'ledgerEntryIds'>,actor:FinancialAuthority,expectedRevision:number):Reconciliation {
  compatible(state,ledger,actor);text(input.id);text(input.idempotencyKey);
  const statementIds=[...input.statementLineIds].sort(),entryIds=[...input.ledgerEntryIds].sort();
  if(!statementIds.length||!entryIds.length||statementIds.length>1000||entryIds.length>1000||new Set(statementIds).size!==statementIds.length||new Set(entryIds).size!==entryIds.length) throw new LedgerError('INVALID_RECONCILIATION_MATCH');
  const fingerprint=JSON.stringify([state.organizationId,state.statement.id,state.statement.currency,state.statement.cashAccountId,statementIds,entryIds]);
  const previous=state.matches.find(match=>match.idempotencyKey===input.idempotencyKey);
  if(previous) {if(previous.id!==input.id||previous.fingerprint!==fingerprint) throw new LedgerError('IDEMPOTENCY_CONFLICT');return state;}
  if(state.completedAt) throw new LedgerError('RECONCILIATION_CLOSED');
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==state.revision||state.revision>=Number.MAX_SAFE_INTEGER) throw new LedgerError('REVISION_CONFLICT');
  if(state.matches.some(match=>match.id===input.id||match.statementLineIds.some(id=>statementIds.includes(id))||match.ledgerEntryIds.some(id=>entryIds.includes(id)))) throw new LedgerError('RECONCILIATION_ALREADY_MATCHED');
  let bank=BigInt(0),book=BigInt(0);
  for(const id of statementIds) {const line=state.statement.lines.find(candidate=>candidate.id===id);if(!line) throw new LedgerError('STATEMENT_LINE_REQUIRED');bank+=BigInt(line.amount.minorUnits);}
  for(const id of entryIds) {const entry=ledger.entries.find(candidate=>candidate.id===id);if(!entry) throw new LedgerError('LEDGER_ENTRY_REQUIRED');const bankDate=entry.paymentDate??entry.transactionDate;if(bankDate<state.statement.start||bankDate>state.statement.end) throw new LedgerError('INVALID_STATEMENT_DATE');const movement=entry.lines.filter(line=>line.accountId===state.statement.cashAccountId).reduce((sum,line)=>sum+BigInt(line.debitMinor)-BigInt(line.creditMinor),BigInt(0));if(movement===BigInt(0)) throw new LedgerError('CASH_MOVEMENT_REQUIRED');book+=movement;}
  if(bank!==book) throw new LedgerError('RECONCILIATION_AMOUNT_MISMATCH');
  const match=Object.freeze({...input,statementLineIds:Object.freeze(statementIds),ledgerEntryIds:Object.freeze(entryIds),fingerprint,approvedBy:actor.userId,approvedAt:actor.timestamp});
  return Object.freeze({...state,revision:state.revision+1,matches:Object.freeze([...state.matches,match])});
}
export function reconciliationStatus(state:Reconciliation,ledger:Ledger) {
  if(state.organizationId!==ledger.organizationId||state.statement.currency!==ledger.currency) throw new LedgerError('TENANT_MISMATCH');
  const ids=new Set(state.matches.flatMap(match=>match.statementLineIds));
  const outstanding=state.statement.lines.filter(line=>!ids.has(line.id));
  // Reconciliation dates follow the bank transaction/payment date; accounting dates remain distinct.
  const movements=ledger.entries.map(entry=>({id:entry.id,date:entry.paymentDate??entry.transactionDate,amount:entry.lines.filter(line=>line.accountId===state.statement.cashAccountId).reduce((sum,line)=>sum+BigInt(line.debitMinor)-BigInt(line.creditMinor),BigInt(0))}));
  const opening=movements.filter(row=>row.date<state.statement.start).reduce((sum,row)=>sum+row.amount,BigInt(0));
  const closing=movements.filter(row=>row.date<=state.statement.end).reduce((sum,row)=>sum+row.amount,BigInt(0));
  const entryIds=new Set(state.matches.flatMap(match=>match.ledgerEntryIds));
  const unmatchedBook=movements.filter(row=>row.date>=state.statement.start&&row.date<=state.statement.end&&row.amount!==BigInt(0)&&!entryIds.has(row.id)).map(row=>row.id);
  const beginningDifference=opening-BigInt(state.statement.opening.minorUnits),endingDifference=closing-BigInt(state.statement.closing.minorUnits);
  return {outstandingStatementLineIds:outstanding.map(line=>line.id),unmatchedBookEntryIds:unmatchedBook,beginningDifferenceMinor:beginningDifference.toString(),endingDifferenceMinor:endingDifference.toString(),ready:outstanding.length===0 && unmatchedBook.length===0 && beginningDifference===BigInt(0) && endingDifference===BigInt(0)};
}
export function completeReconciliation(state:Reconciliation,ledger:Ledger,actor:FinancialAuthority,expectedRevision:number):Reconciliation {
  compatible(state,ledger,actor);
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==state.revision||state.revision>=Number.MAX_SAFE_INTEGER) throw new LedgerError('REVISION_CONFLICT');
  if(state.completedAt) {if(state.completedLedgerRevision!==ledger.revision) throw new LedgerError('RECONCILIATION_LEDGER_CHANGED');return state;}
  if(!reconciliationStatus(state,ledger).ready) throw new LedgerError('RECONCILIATION_INCOMPLETE');
  return Object.freeze({...state,revision:state.revision+1,completedAt:actor.timestamp,completedBy:actor.userId,completedLedgerRevision:ledger.revision});
}
