import { minorInteger, validDate } from './accounting/ledger';
import { validateErpRequest } from './erp-request';
import { decimalToMoney, money } from './money';
import { vendorBillBalance } from './purchasing';
import type { ErpCommand, ErpState } from './runtime-types';
import type { Money } from './types';

export interface BrowserVendorDraft {
  kind: 'business' | 'individual'; name: string; country: 'US' | 'CH'; line1: string; line2: string;
  city: string; subdivision: string; postalCode: string; email: string; phone: string; contactName: string; paymentTermsDays: string;
}
export interface BrowserVendorBillDraft {
  vendorId: string; reference: string; sourceReference: string; date: string; accountingDate: string;
  dueDate: string; periodId: string; net: string; purchaseTax: string;
}
export interface BrowserVendorPaymentDraft {
  billId: string; amount: string; paymentDate: string; accountingDate: string; periodId: string; reference: string;
}
export const emptyBrowserVendor = (): BrowserVendorDraft => ({ kind: 'business', name: '', country: 'US', line1: '', line2: '', city: '', subdivision: '', postalCode: '', email: '', phone: '', contactName: '', paymentTermsDays: '' });
export const emptyBrowserVendorBill = (): BrowserVendorBillDraft => ({ vendorId: '', reference: '', sourceReference: '', date: '', accountingDate: '', dueDate: '', periodId: '', net: '', purchaseTax: '' });
export const emptyBrowserVendorPayment = (): BrowserVendorPaymentDraft => ({ billId: '', amount: '', paymentDate: '', accountingDate: '', periodId: '', reference: '' });

function text(value: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new TypeError('Invalid purchase field');
  return value.trim();
}
function checked<T extends ErpCommand>(organizationId: string, command: T): T {
  return validateErpRequest({ idempotencyKey: 'workbench-purchase-validation', expectedRevision: 0, command }, organizationId).command as T;
}
/** Manual USD inputs are exact cents; a blank tax field never means zero. */
export function browserPurchaseAmount(value: string, positive = false): Money {
  if (typeof value !== 'string' || !/^[0-9]{1,36}(?:\.[0-9]{1,2})?$/.test(value)) throw new TypeError('Invalid USD amount');
  const amount = decimalToMoney('USD', value), minor = minorInteger(amount.minorUnits);
  if (positive && minor === BigInt(0)) throw new TypeError('Positive amount required');
  return amount;
}
export function browserPurchaseTotal(draft: Pick<BrowserVendorBillDraft, 'net' | 'purchaseTax'>): Money {
  const total = (minorInteger(browserPurchaseAmount(draft.net).minorUnits) + minorInteger(browserPurchaseAmount(draft.purchaseTax).minorUnits)).toString();
  minorInteger(total);
  if (total === '0') throw new TypeError('Positive total required');
  return money('USD', total);
}
function date(value: string): void {
  if (value.startsWith('0000-') || !validDate(value)) throw new TypeError('Invalid civil date');
}
function period(state: ErpState, periodId: string, accountingDate: string): void {
  date(accountingDate);
  const found = state.ledger.periods.find(item => item.id === periodId);
  if (!found || found.status !== 'open' || accountingDate < found.start || accountingDate > found.end) throw new TypeError('Choose an open accounting period');
}
function workspace(organizationId: string, state: ErpState): void {
  if (state.configuration.organizationId !== organizationId || state.configuration.country !== 'US' || state.configuration.currency !== 'USD') throw new TypeError('Invalid purchase workspace');
}
export function buildBrowserVendorCommand(organizationId: string, draft: BrowserVendorDraft, id: string): Extract<ErpCommand, { type: 'save_vendor' }> {
  if (!/^[0-9]{1,3}$/.test(draft.paymentTermsDays) || Number(draft.paymentTermsDays) > 365) throw new TypeError('Invalid payment terms');
  const line2 = text(draft.line2, 200), email = text(draft.email, 254), phone = text(draft.phone, 80), contactName = text(draft.contactName, 160);
  return checked(organizationId, { type: 'save_vendor', vendor: {
    id, organizationId, kind: draft.kind, name: text(draft.name, 160),
    billingAddress: { country: draft.country, line1: text(draft.line1, 200), ...(line2 ? { line2 } : {}), city: text(draft.city, 120), subdivision: draft.subdivision, postalCode: text(draft.postalCode, 10) },
    ...(email ? { email } : {}), ...(phone ? { phone } : {}), ...(contactName ? { contactName } : {}), paymentTermsDays: Number(draft.paymentTermsDays),
  } });
}
/** Only user-entered facts are submitted. The server stamps approval, revision,
 * vendor snapshot and accounting entries after fresh financial admission. */
export function buildBrowserVendorBillCommand(organizationId: string, state: ErpState, draft: BrowserVendorBillDraft, id: string): Extract<ErpCommand, { type: 'record_vendor_bill' }> {
  workspace(organizationId, state);
  if (!state.vendors?.some(item => item.id === draft.vendorId && item.organizationId === organizationId)) throw new TypeError('Choose a saved vendor');
  date(draft.date); date(draft.dueDate); period(state, draft.periodId, draft.accountingDate);
  if (draft.dueDate < draft.date) throw new TypeError('Invalid due date');
  browserPurchaseTotal(draft);
  const reference = text(draft.reference, 500);
  if (state.vendorBills?.some(item => item.vendorId === draft.vendorId && item.reference === reference && item.date === draft.date)) throw new TypeError('Bill already recorded');
  return checked(organizationId, { type: 'record_vendor_bill', id, vendorId: draft.vendorId, reference, sourceReference: text(draft.sourceReference, 500), date: draft.date, accountingDate: draft.accountingDate, dueDate: draft.dueDate, periodId: draft.periodId, netMinor: browserPurchaseAmount(draft.net).minorUnits, purchaseTaxMinor: browserPurchaseAmount(draft.purchaseTax).minorUnits, expenseAccountId: 'purchases' });
}
export function buildBrowserVendorPaymentCommand(organizationId: string, state: ErpState, draft: BrowserVendorPaymentDraft, id: string): Extract<ErpCommand, { type: 'record_vendor_payment' }> {
  workspace(organizationId, state);
  const bill = state.vendorBills?.find(item => item.id === draft.billId && item.organizationId === organizationId);
  if (!bill) throw new TypeError('Choose a recorded bill');
  date(draft.paymentDate); period(state, draft.periodId, draft.accountingDate);
  const amount = browserPurchaseAmount(draft.amount, true), balance = vendorBillBalance(bill, (state.vendorPayments ?? []).filter(item => item.billId === bill.id));
  if (minorInteger(amount.minorUnits) > minorInteger(balance.minorUnits)) throw new TypeError('Payment exceeds recorded balance');
  return checked(organizationId, { type: 'record_vendor_payment', id, billId: draft.billId, amountMinor: amount.minorUnits, paymentDate: draft.paymentDate, accountingDate: draft.accountingDate, periodId: draft.periodId, reference: text(draft.reference, 500) });
}
