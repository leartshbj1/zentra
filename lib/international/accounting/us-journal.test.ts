import { describe, expect, it } from 'vitest';
import { createLedger, type FinancialAuthority, type Ledger } from './ledger';
import { usStarterChart } from '../countries/us/accounting';
import { balanceSheet, cashFlow } from './reports';
import { closeUsAccountingPeriod, openUsAccountingPeriod, postUsManualJournal, reverseUsManualJournal, validateUsManualJournalInput, validateUsManualReversalInput, validateUsOpenPeriodInput, type UsManualJournalInput } from './us-journal';

const actor:FinancialAuthority={organizationId:'us-journal-test',userId:'test-owner',role:'owner',managementEntitled:true,timestamp:'2026-10-08T12:00:00Z'};
function ledger(basis:'cash'|'accrual'='accrual'):Ledger{return createLedger({organizationId:actor.organizationId,currency:'USD',basis,accounts:usStarterChart,periods:[{id:'2026',start:'2026-01-01',end:'2026-12-31',status:'open'}]});}
function input():UsManualJournalInput{return {id:'capital',transactionDate:'2026-10-08',accountingDate:'2026-10-08',periodId:'2026',description:'Reviewed owner capital',sourceReference:'bank-reference-1',cashFlowCategory:'financing',lines:[{accountId:'cash',debitMinor:'9007199254740993',creditMinor:'0',description:'Exact cash'},{accountId:'equity',debitMinor:'0',creditMinor:'9007199254740993'}]};}

describe('isolated US journal facade',()=>{
  it.each(['cash','accrual'] as const)('posts exact capital, appends a future period, reverses and closes (%s)',basis=>{
    const original=ledger(basis);let book=postUsManualJournal(original,input(),'capital-key',actor,0);
    expect(original.revision).toBe(0);expect(book.entries[0].source).toEqual({type:'manual_journal',id:'bank-reference-1'});expect(balanceSheet(book,'2026-12-31').assetsMinor).toBe('9007199254740993');
    book=openUsAccountingPeriod(book,{id:'2027',start:'2027-01-01',end:'2027-12-31'},actor,1);expect(book.audit[1].action).toBe('period_opened');
    book=closeUsAccountingPeriod(book,'2026',actor,2);
    const correction={id:'capital-reversal',entryId:'capital',transactionDate:'2027-01-03',accountingDate:'2027-01-03',periodId:'2027',reason:'Reviewed capital correction'};
    book=reverseUsManualJournal(book,correction,'reversal-key',actor,3);expect(book.entries[1].lines).toEqual([{accountId:'cash',debitMinor:'0',creditMinor:'9007199254740993',description:'Exact cash'},{accountId:'equity',debitMinor:'9007199254740993',creditMinor:'0'}]);expect(book.entries[1].cashFlowCategory).toBe('financing');
    book=closeUsAccountingPeriod(book,'2027',actor,4);expect(balanceSheet(book,'2027-12-31').assetsMinor).toBe('0');expect(cashFlow(book,{start:'2026-01-01',end:'2027-12-31'}).netChangeMinor).toBe('0');
    expect(postUsManualJournal(book,input(),'capital-key',actor,0)).toBe(book);expect(reverseUsManualJournal(book,correction,'reversal-key',actor,0)).toBe(book);
    expect(()=>reverseUsManualJournal(book,{...correction,id:'another-reversal'},'different-key',actor,book.revision)).toThrow('ACCOUNTING_PERIOD_CLOSED');
    expect(book.audit.map(event=>event.action)).toEqual(['posted','period_opened','period_closed','posted','period_closed']);
  });
  it('refuses a second reversal even while the accounting period remains open',()=>{
    let book=postUsManualJournal(ledger(),input(),'capital-key',actor,0);const correction={id:'reverse-1',entryId:'capital',transactionDate:'2026-10-09',accountingDate:'2026-10-09',periodId:'2026',reason:'Correction'};
    book=reverseUsManualJournal(book,correction,'reverse-key',actor,1);expect(()=>reverseUsManualJournal(book,{...correction,id:'reverse-2'},'reverse-key-2',actor,2)).toThrow('INVALID_REVERSAL');expect(book.entries).toHaveLength(2);
  });
  it.each(['receivables','payables','tax-payable','deposits'])('excludes the %s subledger account',accountId=>{expect(()=>validateUsManualJournalInput({...input(),lines:[{accountId,debitMinor:'1',creditMinor:'0'},{accountId:'cash',debitMinor:'0',creditMinor:'1'}]})).toThrow('manual_account_forbidden');});
  it.each(['member','read_only'] as const)('denies %s financial operations',role=>{const a={...actor,role};expect(()=>postUsManualJournal(ledger(),input(),'key',a,0)).toThrow('FINANCIAL_PERMISSION_REQUIRED');expect(()=>openUsAccountingPeriod(ledger(),{id:'2027',start:'2027-01-01',end:'2027-12-31'},a,0)).toThrow('FINANCIAL_PERMISSION_REQUIRED');});
  it('rejects foreign tenants, missing entitlement and CHF without modifying the book',()=>{
    const book=ledger(),before=JSON.stringify(book);expect(()=>postUsManualJournal(book,input(),'key',{...actor,organizationId:'other'},0)).toThrow('TENANT_MISMATCH');expect(()=>postUsManualJournal(book,input(),'key',{...actor,managementEntitled:false},0)).toThrow('MANAGEMENT_ENTITLEMENT_REQUIRED');expect(()=>postUsManualJournal({...book,currency:'CHF'},input(),'key',actor,0)).toThrow('edition_unavailable');expect(JSON.stringify(book)).toBe(before);
  });
  it('rejects unknown accounts, unbalanced amounts and missing cash classification',()=>{
    const v=input();expect(()=>postUsManualJournal(ledger(),{...v,lines:[{...v.lines[0],accountId:'unknown'},v.lines[1]]},'key',actor,0)).toThrow('UNKNOWN_ACCOUNT');expect(()=>postUsManualJournal(ledger(),{...v,lines:[{...v.lines[0],debitMinor:'1'},v.lines[1]]},'key',actor,0)).toThrow('UNBALANCED_JOURNAL');const {cashFlowCategory:_category,...without}=v;expect(()=>postUsManualJournal(ledger(),without,'key',actor,0)).toThrow('CASH_FLOW_CLASSIFICATION_REQUIRED');
  });
  it.each(['01','1.5','-1','NaN','1'.repeat(37),1])('rejects malformed minor amount %s before posting',debitMinor=>{expect(()=>validateUsManualJournalInput({...input(),lines:[{...input().lines[0],debitMinor},input().lines[1]]})).toThrow('invalid_amount');});
  it.each(['0000-01-01','2026-02-30','2026-10-08T00:00:00Z'])('rejects noncivil/noncalendar date %s',start=>{expect(()=>validateUsOpenPeriodInput({id:'period',start,end:'2027-12-31'})).toThrow('invalid_date');});
  it('keeps existing period boundaries and applies chronological closure',()=>{
    const book=openUsAccountingPeriod(ledger(),{id:'2027',start:'2027-01-01',end:'2027-12-31'},actor,0);expect(()=>closeUsAccountingPeriod(book,'2027',actor,1)).toThrow('accounting_period_order_conflict');expect(()=>openUsAccountingPeriod(book,{id:'2026',start:'2028-01-01',end:'2028-12-31'},actor,1)).toThrow('period_already_exists');expect(()=>openUsAccountingPeriod(book,{id:'overlap',start:'2027-12-31',end:'2028-12-31'},actor,1)).toThrow('invalid_period');expect(()=>openUsAccountingPeriod(book,{id:'2028',start:'2028-01-01',end:'2028-12-31'},actor,0)).toThrow('revision_conflict');
    const closed=closeUsAccountingPeriod(book,'2026',actor,1);expect(()=>closeUsAccountingPeriod(closed,'2026',actor,2)).toThrow('accounting_period_closed');expect(book.periods[0].status).toBe('open');
  });
  it('bounds periods at 100 without manufacturing another period',()=>{
    const periods=Array.from({length:100},(_,i)=>({id:String(i),start:`${1900+i}-01-01`,end:`${1900+i}-12-31`,status:'open' as const}));const book=createLedger({...ledger(),periods});expect(()=>openUsAccountingPeriod(book,{id:'future',start:'2000-01-01',end:'2000-12-31'},actor,0)).toThrow('period_limit_reached');expect(book.periods).toHaveLength(100);
  });
  it('cannot reverse an operational or reversal source',()=>{
    const book=postUsManualJournal(ledger(),input(),'key',actor,0),correction={id:'reversed',entryId:'capital',transactionDate:'2026-10-09',accountingDate:'2026-10-09',periodId:'2026',reason:'Correction'};
    for(const type of ['customer_invoice','customer_payment','vendor_bill','vendor_payment','manual_reversal'])expect(()=>reverseUsManualJournal({...book,entries:[{...book.entries[0],source:{type,id:'source'}}]},correction,'reverse',actor,1)).toThrow('manual_journal_required');
    expect(()=>reverseUsManualJournal(book,{...correction,entryId:'missing'},'reverse',actor,1)).toThrow('entry_not_found');
  });
  it('snapshots own data without invoking getters and freezes nested input',()=>{
    let calls=0;const v={...input()};Object.defineProperty(v,'sourceReference',{enumerable:true,get(){calls++;return 'secret';}});expect(()=>validateUsManualJournalInput(v)).toThrow('invalid_request');expect(calls).toBe(0);
    const source={...input(),lines:input().lines.map(l=>({...l}))},copied=validateUsManualJournalInput(source);source.lines[0].debitMinor='1';expect(copied.lines[0].debitMinor).toBe('9007199254740993');expect(Object.isFrozen(copied.lines[0])).toBe(true);
  });
  it.each(['organizationId','role','postedAt','source','fingerprint','total'])('rejects injected private/calculated field %s',field=>{expect(()=>validateUsManualJournalInput({...input(),[field]:'forged'})).toThrow('invalid_request');});
  it('rejects NUL, lone surrogates, null optional fields, symbols and hidden data',()=>{
    for(const sourceReference of ['NUL\u0000ref','high\ud800','low\udfff','DEL\u007fref'])expect(()=>validateUsManualJournalInput({...input(),sourceReference})).toThrow('invalid_request');expect(()=>validateUsManualJournalInput({...input(),cashFlowCategory:null})).toThrow('invalid_request');expect(validateUsManualJournalInput({...input(),sourceReference:'😀'.repeat(80)}).sourceReference.length).toBe(160);expect(()=>validateUsManualJournalInput({...input(),sourceReference:'😀'.repeat(80)+'x'})).toThrow('invalid_request');
    const symbol={...input(),[Symbol('secret')]:'hidden'};expect(()=>validateUsManualJournalInput(symbol)).toThrow('invalid_request');const hidden={...input()};Object.defineProperty(hidden,'hidden',{value:'secret'});expect(()=>validateUsManualJournalInput(hidden)).toThrow('invalid_request');expect(()=>validateUsManualReversalInput({id:'new',entryId:'capital',transactionDate:'2026-10-08',accountingDate:'2026-10-08',periodId:'2026',reason:'why',lines:[]})).toThrow('invalid_request');
  });
});
