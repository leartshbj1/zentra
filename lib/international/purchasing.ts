import type { VendorBill } from './accounting/postings';
import { validDate, type FinancialAuthority } from './accounting/ledger';
import { validateErpContact } from './contacts';
import { validateCompanyConfiguration } from './country-config';
import { ErpError } from './erp-contract';
import type { Contact } from './invoicing';
import { parseInstant } from './localization';
import { money } from './money';
import { snapshotPrivateJson } from './private-json';
import type { CompanyConfiguration, Money } from './types';

export type RecordedVendorBill = VendorBill & Readonly<{
  vendorSnapshot: Contact;
  periodId: string;
  approvedAt: string;
  approvalSource: 'manual_entry';
  sourceReference: string;
  recordedRevision: number;
}>;
export interface RecordedVendorPayment {
  readonly id: string;
  readonly organizationId: string;
  readonly billId: string;
  readonly idempotencyKey: string;
  readonly amount: Money;
  readonly paymentDate: string;
  readonly accountingDate: string;
  readonly periodId: string;
  readonly reference: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly recordedRevision: number;
}
export interface BillInput {
  readonly id: string;
  readonly vendorId: string;
  readonly reference: string;
  readonly date: string;
  readonly accountingDate: string;
  readonly dueDate: string;
  readonly periodId: string;
  readonly netMinor: string;
  readonly purchaseTaxMinor: string;
  readonly expenseAccountId: string;
  readonly sourceReference: string;
}
export interface PaymentInput {
  readonly id: string;
  readonly billId: string;
  readonly amountMinor: string;
  readonly paymentDate: string;
  readonly accountingDate: string;
  readonly periodId: string;
  readonly reference: string;
}

const billInputFields = ['id','vendorId','reference','date','accountingDate','dueDate','periodId','netMinor','purchaseTaxMinor','expenseAccountId','sourceReference'];
const paymentInputFields = ['id','billId','amountMinor','paymentDate','accountingDate','periodId','reference'];
const billFields = ['id','organizationId','vendorId','reference','date','accountingDate','dueDate','currency','net','tax','total','expenseAccountId','validatedBy','vendorSnapshot','periodId','approvedAt','approvalSource','sourceReference','recordedRevision'];
const paymentFields = ['id','organizationId','billId','idempotencyKey','amount','paymentDate','accountingDate','periodId','reference','recordedBy','recordedAt','recordedRevision'];
function fail(code = 'invalid_request', status = 422): never { throw new ErpError(code, status); }
function unavailable(): never { return fail('invalid_stored_state', 503); }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const data = value as Record<string, unknown>;
  if (Reflect.ownKeys(data).length !== fields.length || fields.some(key => !Object.hasOwn(data, key))) return fail();
  return data;
}
function snapshot(input: unknown): unknown {
  try { return snapshotPrivateJson(input); } catch { return fail(); }
}
function freeze<T>(input: T): T { return snapshotPrivateJson(input) as T; }
function text(input: unknown, maximum = 160): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maximum || Array.from(input).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return fail();
  return input;
}
function organization(input: unknown): string {
  const value = text(input, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) return fail();
  return value;
}
function date(input: unknown): string {
  if (typeof input !== 'string' || input.startsWith('0000-') || !validDate(input)) return fail('invalid_date');
  return input;
}
function timestamp(input: unknown): string {
  if (typeof input !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/.test(input)) return unavailable();
  try { parseInstant(input); } catch { return unavailable(); }
  return input;
}
function revision(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1 || (input as number) >= Number.MAX_SAFE_INTEGER) return unavailable();
  return input as number;
}
function minor(input: unknown, positive = false): string {
  if (typeof input !== 'string' || !(positive ? /^[1-9][0-9]{0,35}$/ : /^(?:0|[1-9][0-9]{0,35})$/).test(input)) return fail('invalid_amount');
  return input;
}
function usdAmount(input: unknown, positive = false): Money {
  const value = object(input, ['currency','minorUnits']);
  if (value.currency !== 'USD') return fail('invalid_amount');
  return money('USD', minor(value.minorUnits, positive));
}
function key(input: unknown): string {
  const value = text(input, 225);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) return fail();
  return value;
}
function configuration(input: CompanyConfiguration): CompanyConfiguration {
  let value: CompanyConfiguration;
  try { value = validateCompanyConfiguration(snapshot(input)); } catch (error) { if (error instanceof ErpError) throw error; return fail(); }
  if (value.country !== 'US' || value.currency !== 'USD') return fail('edition_unavailable', 409);
  return value;
}
function authority(input: FinancialAuthority, organizationId: string): FinancialAuthority {
  let value: Record<string, unknown>;
  try { value = object(snapshotPrivateJson(input), ['organizationId','userId','role','managementEntitled','timestamp']); } catch { return unavailable(); }
  if (value.organizationId !== organizationId) return fail('tenant_mismatch', 403);
  if (value.managementEntitled !== true) return fail('management_entitlement_required', 402);
  if (!['owner','admin','accountant'].includes(value.role as string)) return fail('financial_permission_required', 403);
  return freeze({ organizationId, userId: text(value.userId), role: value.role as FinancialAuthority['role'], managementEntitled: true, timestamp: timestamp(value.timestamp) });
}

/** Identical Contact rules to ERP customers, with detached own-data snapshots.
 * Vendor address country is explicit and may differ from the US workspace. */
export function validateVendor(input: unknown, organizationId: string): Contact {
  const org = organization(organizationId);
  try { return freeze(validateErpContact(snapshot(input), org)); }
  catch (error) { if (error instanceof ErpError) throw error; return fail(); }
}

/** Manual financial approval records facts; it does not grant tax/provider
 * configuration, infer a recoverable VAT credit, or mutate a ledger. */
export function recordVendorBill(config: CompanyConfiguration, vendor: Contact, input: BillInput, actor: FinancialAuthority, recordedRevision: number): RecordedVendorBill {
  const company = configuration(config), admitted = authority(actor, company.organizationId);
  const supplier = validateVendor(vendor, company.organizationId), data = object(snapshot(input), billInputFields);
  if (data.vendorId !== supplier.id) return fail('tenant_mismatch', 403);
  if (data.expenseAccountId !== 'purchases') return fail('purchase_account_required');
  const issuedDate = date(data.date), dueDate = date(data.dueDate);
  if (dueDate < issuedDate) return fail('invalid_date');
  const net = minor(data.netMinor), tax = minor(data.purchaseTaxMinor), total = minor((BigInt(net) + BigInt(tax)).toString(), true);
  return freeze({ id: text(data.id), organizationId: company.organizationId, vendorId: supplier.id, reference: text(data.reference, 500), date: issuedDate, accountingDate: date(data.accountingDate), dueDate, currency: 'USD', net: money('USD', net), tax: money('USD', tax), total: money('USD', total), expenseAccountId: 'purchases', validatedBy: admitted.userId, vendorSnapshot: supplier, periodId: text(data.periodId), approvedAt: admitted.timestamp, approvalSource: 'manual_entry', sourceReference: text(data.sourceReference, 500), recordedRevision: revision(recordedRevision) });
}

export function validateRecordedVendorBill(input: unknown, organizationId: string): RecordedVendorBill {
  try {
    const org = organization(organizationId), data = object(snapshotPrivateJson(input), billFields);
    if (data.organizationId !== org || data.currency !== 'USD' || data.approvalSource !== 'manual_entry' || data.expenseAccountId !== 'purchases') return unavailable();
    const supplier = validateVendor(data.vendorSnapshot, org);
    if (data.vendorId !== supplier.id) return unavailable();
    const net = usdAmount(data.net), tax = usdAmount(data.tax), total = usdAmount(data.total, true);
    if (BigInt(net.minorUnits) + BigInt(tax.minorUnits) !== BigInt(total.minorUnits)) return unavailable();
    const issuedDate = date(data.date), dueDate = date(data.dueDate);
    if (dueDate < issuedDate) return unavailable();
    return freeze({ id: text(data.id), organizationId: org, vendorId: supplier.id, reference: text(data.reference, 500), date: issuedDate, accountingDate: date(data.accountingDate), dueDate, currency: 'USD', net, tax, total, expenseAccountId: 'purchases', validatedBy: text(data.validatedBy), vendorSnapshot: supplier, periodId: text(data.periodId), approvedAt: timestamp(data.approvedAt), approvalSource: 'manual_entry', sourceReference: text(data.sourceReference, 500), recordedRevision: revision(data.recordedRevision) });
  } catch { return unavailable(); }
}

export function validateRecordedVendorPayment(input: unknown, organizationId: string): RecordedVendorPayment {
  try {
    const org = organization(organizationId), data = object(snapshotPrivateJson(input), paymentFields);
    if (data.organizationId !== org) return unavailable();
    return freeze({ id: text(data.id), organizationId: org, billId: text(data.billId), idempotencyKey: key(data.idempotencyKey), amount: usdAmount(data.amount, true), paymentDate: date(data.paymentDate), accountingDate: date(data.accountingDate), periodId: text(data.periodId), reference: text(data.reference, 500), recordedBy: text(data.recordedBy), recordedAt: timestamp(data.recordedAt), recordedRevision: revision(data.recordedRevision) });
  } catch { return unavailable(); }
}

/** Requires payments scoped to this one bill. The runtime owns receipt replay
 * and must explicitly recover an already-recorded payment, never append it. */
export function vendorBillBalance(bill: RecordedVendorBill, payments: readonly RecordedVendorPayment[]): Money {
  let detached: RecordedVendorBill;
  try { detached = snapshotPrivateJson(bill) as RecordedVendorBill; } catch { return unavailable(); }
  if (!detached || typeof detached !== 'object' || Array.isArray(detached)) return unavailable();
  const recorded = validateRecordedVendorBill(detached, detached.organizationId);
  let values: unknown;
  try { values = snapshotPrivateJson(payments); } catch { return unavailable(); }
  if (!Array.isArray(values)) return unavailable();
  const ids = new Set<string>(), keys = new Set<string>();
  let paid = BigInt(0);
  for (const input of values) {
    const payment = validateRecordedVendorPayment(input, recorded.organizationId);
    if (payment.billId !== recorded.id || ids.has(payment.id) || keys.has(payment.idempotencyKey)) return unavailable();
    ids.add(payment.id); keys.add(payment.idempotencyKey); paid += BigInt(payment.amount.minorUnits);
    if (paid > BigInt(recorded.total.minorUnits)) return unavailable();
  }
  return money('USD', (BigInt(recorded.total.minorUnits) - paid).toString());
}

export function recordVendorPayment(config: CompanyConfiguration, bill: RecordedVendorBill, existingPayments: readonly RecordedVendorPayment[], input: PaymentInput, actor: FinancialAuthority, recordedRevision: number, idempotencyKey: string): RecordedVendorPayment {
  const company = configuration(config), admitted = authority(actor, company.organizationId), recorded = validateRecordedVendorBill(bill, company.organizationId);
  const data = object(snapshot(input), paymentInputFields), id = text(data.id), paymentKey = key(idempotencyKey);
  if (data.billId !== recorded.id) return fail('tenant_mismatch', 403);
  let prior: readonly RecordedVendorPayment[];
  try { prior = snapshotPrivateJson(existingPayments) as readonly RecordedVendorPayment[]; } catch { return unavailable(); }
  const balance = vendorBillBalance(recorded, prior), amount = minor(data.amountMinor, true);
  if (prior.some(payment => payment.id === id || payment.idempotencyKey === paymentKey)) return fail('idempotency_conflict', 409);
  if (BigInt(amount) > BigInt(balance.minorUnits)) return fail('overpayment', 409);
  return freeze({ id, organizationId: company.organizationId, billId: recorded.id, idempotencyKey: paymentKey, amount: money('USD', amount), paymentDate: date(data.paymentDate), accountingDate: date(data.accountingDate), periodId: text(data.periodId), reference: text(data.reference, 500), recordedBy: admitted.userId, recordedAt: admitted.timestamp, recordedRevision: revision(recordedRevision) });
}
