import type { BrowserUsFinancialPilotSession } from './browser-us-financial-pilot-session';
import type { UsFinancialPilotAccountingCommand } from './us-financial-pilot-accounting';
import { validateUsFinancialPilotAccountingRequest } from './us-financial-pilot-accounting';
import type { UsFinancialPilotAccountingAccount, UsFinancialPilotAccountingContext, UsFinancialPilotJournalDetail, UsFinancialPilotPeriodDetail } from './us-financial-pilot-accounting-projection';
import type { UsFinancialPilotOverview } from './us-financial-pilot-contract';

export class AccountingInputError extends Error { constructor(readonly code:string) { super(code);this.name='AccountingInputError'; } }
const invalid=(code:string):never=>{throw new AccountingInputError(code);};
export interface AccountingLineDraft { readonly accountId:string; readonly debit:string; readonly credit:string; readonly description:string }
export interface AccountingJournalDraft { readonly transactionDate:string; readonly accountingDate:string; readonly periodId:string; readonly description:string; readonly sourceReference:string; readonly lines:readonly AccountingLineDraft[]; readonly cashFlowCategory:''|'operating'|'investing'|'financing' }
/** Never coerce blank, signs, grouping, exponents, or floating point values. */
export function accountingAmount(value:string):string {
  if(typeof value!=='string'||value.length>39||!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(value))return invalid('accounting_amount');
  const [whole,fraction='']=value.split('.'),minor=(BigInt(whole)*BigInt(100)+BigInt(fraction.padEnd(2,'0'))).toString();
  if(minor.length>36)return invalid('accounting_amount');return minor;
}
export function accountingTotals(lines:readonly AccountingLineDraft[],accounts:readonly UsFinancialPilotAccountingAccount[]) {
  let debit=BigInt(0),credit=BigInt(0),cash=BigInt(0);
  for(const line of lines){const d=BigInt(accountingAmount(line.debit)),c=BigInt(accountingAmount(line.credit));debit+=d;credit+=c;if(accounts.find(a=>a.accountId===line.accountId)?.cash)cash+=d-c;}
  return {debitMinor:debit.toString(),creditMinor:credit.toString(),differenceMinor:(debit-credit).toString(),cashMinor:cash.toString()};
}
export function accountingCivilDate(value:string):boolean { if(!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(`${value}T00:00:00.000Z`);return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value; }
function required(value:string,max:number,code:string):string {if(!value||value!==value.trim()||value.length>max||Array.from(value).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))return invalid(code);return value;}
export function accountingJournalCommand(draft:AccountingJournalDraft,accounts:readonly UsFinancialPilotAccountingAccount[]):UsFinancialPilotAccountingCommand {
  if(!accountingCivilDate(draft.transactionDate)||!accountingCivilDate(draft.accountingDate))return invalid('accounting_date');
  required(draft.periodId,160,'accounting_period');required(draft.description.trim(),2000,'accounting_description');required(draft.sourceReference.trim(),160,'accounting_reference');
  if(draft.lines.length<2||draft.lines.length>1000)return invalid('accounting_line_count');
  const lines=draft.lines.map(line=>{if(!accounts.some(a=>a.accountId===line.accountId))return invalid('accounting_account');const debitMinor=accountingAmount(line.debit),creditMinor=accountingAmount(line.credit);if((debitMinor==='0')===(creditMinor==='0'))return invalid('accounting_line_side');const description=line.description.trim();if(description)required(description,2000,'accounting_line_description');return {accountId:line.accountId,debitMinor,creditMinor,...(description?{description}:{})};});
  const totals=accountingTotals(draft.lines,accounts);if(totals.debitMinor==='0'||totals.debitMinor!==totals.creditMinor)return invalid('accounting_balance');if(totals.cashMinor!=='0'&&!draft.cashFlowCategory)return invalid('accounting_cash');
  return {type:'post_manual_journal',transactionDate:draft.transactionDate,accountingDate:draft.accountingDate,periodId:draft.periodId,description:draft.description.trim(),sourceReference:draft.sourceReference.trim(),lines,...(draft.cashFlowCategory?{cashFlowCategory:draft.cashFlowCategory}:{})};
}
export interface AccountingReview { readonly snapshot:UsFinancialPilotOverview; readonly context:UsFinancialPilotAccountingContext; readonly period:UsFinancialPilotPeriodDetail|null; readonly source:UsFinancialPilotJournalDetail|null; readonly sourcePages:readonly UsFinancialPilotJournalDetail[]; readonly command:UsFinancialPilotAccountingCommand }
/** Every review is fresh. Draft amounts and the reversal's immutable source are
 * never replaced by a newer balance or a client-generated set of inverse lines. */
export async function reviewAccountingCommand(session:BrowserUsFinancialPilotSession,input:UsFinancialPilotAccountingCommand):Promise<AccountingReview> {
  const command=validateUsFinancialPilotAccountingRequest({consumer:'financial-pilot',schemaVersion:1,requestId:'00000000-0000-4000-8000-000000000001',expectedRevision:session.getState().snapshot?.revision??1,command:input}).command;
  const snapshot=await session.refresh();if(!snapshot)return invalid('read_required');
  const context=await session.readAccountingContext(snapshot.revision);let period:UsFinancialPilotPeriodDetail|null=null,source:UsFinancialPilotJournalDetail|null=null;const sourcePages:UsFinancialPilotJournalDetail[]=[];
  if(command.type==='post_manual_journal'){
    if(command.lines.some(line=>!context.accounts.some(a=>a.accountId===line.accountId)))return invalid('accounting_account');
    const cash=command.lines.reduce((sum,line)=>context.accounts.find(a=>a.accountId===line.accountId)?.cash?sum+BigInt(line.debitMinor)-BigInt(line.creditMinor):sum,BigInt(0));if(cash!==BigInt(0)&&!command.cashFlowCategory)return invalid('accounting_cash');
  }
  if(command.type==='post_manual_journal'||command.type==='reverse_manual_journal'){
    period=await session.readPeriod(command.periodId,snapshot.revision);if(period.period.status!=='open'||command.accountingDate<period.period.start||command.accountingDate>period.period.end)return invalid('accounting_period');
  }
  if(command.type==='reverse_manual_journal'){
    source=await session.readJournal(command.journalRevision,snapshot.revision);if(!source.canReverse)return invalid('accounting_source');sourcePages.push(source);
    let cursor=source.lines.nextCursor;while(cursor){if(sourcePages.length>=40)return invalid('financial_book_too_large');const page=await session.readJournal(command.journalRevision,snapshot.revision,cursor);sourcePages.push(page);cursor=page.lines.nextCursor;}
  }
  if(command.type==='close_period'){period=await session.readPeriod(command.periodId,snapshot.revision);if(!period.canClose||context.earliestOpenPeriod?.id!==command.periodId)return invalid('accounting_close_order');}
  if(command.type==='open_period'){if(context.periodCount>=100)return invalid('accounting_period_limit');if(command.start>command.end||context.latestPeriodEnd!==null&&command.start<=context.latestPeriodEnd)return invalid('accounting_period_order');}
  if(session.getState().snapshot?.revision!==snapshot.revision||session.getState().requiresRefresh)return invalid('financial_snapshot_changed');
  return {snapshot,context,period,source,sourcePages,command};
}
