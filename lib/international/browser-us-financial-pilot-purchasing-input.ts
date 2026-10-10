import type { BrowserUsFinancialPilotSession } from './browser-us-financial-pilot-session';
import type { UsFinancialPilotOverview, UsFinancialPilotPage, UsFinancialPilotParty, UsFinancialPilotPeriodRow } from './us-financial-pilot-contract';
import type { UsFinancialPilotPurchasingCommand } from './us-financial-pilot-purchasing';
import type { UsFinancialPilotVendorBillDetail } from './us-financial-pilot-purchasing-projection';

/** Decimal drafts stay strings; blank purchase tax is never coerced to zero. */
export function purchasingAmount(value: string, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(value) || value.length > 39) throw new TypeError('invalid_purchasing_input');
  const [whole,fraction=''] = value.split('.'), result = (BigInt(whole)*BigInt(100)+BigInt(fraction.padEnd(2,'0'))).toString();
  if (result.length > 36 || positive && result === '0') throw new TypeError('invalid_purchasing_input'); return result;
}
export function purchasingTotal(net: string, tax: string): string { const total = (BigInt(purchasingAmount(net))+BigInt(purchasingAmount(tax))).toString(); if (total === '0' || total.length > 36) throw new TypeError('invalid_purchasing_input'); return total; }
export function purchasingDecimal(minor: string): string { if (!/^(0|[1-9][0-9]{0,35})$/.test(minor)) throw new TypeError('invalid_purchasing_input'); const n=BigInt(minor); return `${n/BigInt(100)}.${(n%BigInt(100)).toString().padStart(2,'0')}`; }

/** Read current sources for explicit human review; never mutate a draft or
 * construct a replacement request from a newer vendor or balance. */
export async function reviewPurchasingCommand(session:BrowserUsFinancialPilotSession,command:UsFinancialPilotPurchasingCommand):Promise<{snapshot:UsFinancialPilotOverview;vendor:UsFinancialPilotParty|null;bill:UsFinancialPilotVendorBillDetail|null;period:UsFinancialPilotPeriodRow|null}> {
  const current=await session.refresh();if(!current)throw {code:'read_required'};
  let vendor:UsFinancialPilotParty|null=null,bill:UsFinancialPilotVendorBillDetail|null=null,period:UsFinancialPilotPeriodRow|null=null;
  if(command.type==='save_vendor'&&command.vendorId)vendor=(await session.readVendor(command.vendorId,current.revision)).vendor;
  if(command.type==='record_vendor_bill')vendor=(await session.readVendor(command.vendorId,current.revision)).vendor;
  if(command.type==='record_vendor_payment'){bill=await session.readVendorBill(command.billId,current.revision);vendor=bill.vendor;if(BigInt(command.amountMinor)>BigInt(bill.bill.outstandingMinor))throw {code:'overpayment'};}
  if(command.type!=='save_vendor') {
    let page=current.periods,count=0;
    while(!page.items.some(p=>p.id===command.periodId)&&page.nextCursor){if(++count>100)throw {code:'financial_book_too_large'};page=await session.readList('periods',page.nextCursor,current.revision) as UsFinancialPilotPage<UsFinancialPilotPeriodRow>;}
    period=page.items.find(p=>p.id===command.periodId)??null;
    if(!period||period.status!=='open'||command.accountingDate<period.start||command.accountingDate>period.end)throw {code:'accounting_period_not_open'};
  }
  return {snapshot:current,vendor,bill,period};
}
