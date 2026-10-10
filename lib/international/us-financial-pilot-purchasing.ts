import { validDate } from './accounting/ledger';
import { validateErpContact } from './contacts';
import { canonicalErpJson, ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import type { UsFinancialPilotCommercialCustomer } from './us-financial-pilot-commercial';
import { validateUsFinancialRequestV5, type UsFinancialRequestV5 } from './us-financial-kernel-runtime';

/** Editable facts only. Organization, accounts, approval and IDs belong to the server. */
export const US_FINANCIAL_PILOT_PURCHASING_MAX_BODY_BYTES = 262_144;
export type UsFinancialPilotPurchasingVendor = UsFinancialPilotCommercialCustomer;
export type UsFinancialPilotPurchasingCommand =
  | Readonly<{ type: 'save_vendor'; vendorId: string | null; vendor: UsFinancialPilotPurchasingVendor }>
  | Readonly<{ type: 'record_vendor_bill'; vendorId: string; reference: string; date: string; accountingDate: string; dueDate: string; periodId: string; netMinor: string; purchaseTaxMinor: string; sourceReference: string }>
  | Readonly<{ type: 'record_vendor_payment'; billId: string; amountMinor: string; paymentDate: string; accountingDate: string; periodId: string; reference: string }>;
export interface UsFinancialPilotPurchasingRequest {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly requestId: string; readonly expectedRevision: number;
  readonly command: UsFinancialPilotPurchasingCommand;
}
export interface UsFinancialPilotPurchasingReceipt {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly organizationId: string; readonly revision: number;
  readonly entityId: string; readonly action: UsFinancialPilotPurchasingCommand['type']; readonly requestId: string;
}
const invalid = (): never => { throw new ErpError('invalid_financial_pilot_request', 422); };
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return invalid();
  return value;
}
function integer(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER ? value : invalid(); }
function uuid(value: unknown): string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ? value : invalid(); }
function date(value: unknown): string { return typeof value === 'string' && !value.startsWith('0000-') && validDate(value) ? value : invalid(); }
function minor(value: unknown, positive = false): string { return typeof value === 'string' && (positive ? /^[1-9][0-9]{0,35}$/ : /^(0|[1-9][0-9]{0,35})$/).test(value) ? value : invalid(); }
function vendor(value: unknown): UsFinancialPilotPurchasingVendor {
  const v = exact(value, ['kind', 'name', 'billingAddress', 'shippingAddress', 'email', 'phone', 'contactName', 'paymentTermsDays']);
  const contact = validateErpContact({ id: 'public-validation', organizationId: 'public-validation', kind: v.kind, name: v.name, billingAddress: v.billingAddress,
    ...(v.shippingAddress === null ? {} : { shippingAddress: v.shippingAddress }), ...(v.email === null ? {} : { email: v.email }),
    ...(v.phone === null ? {} : { phone: v.phone }), ...(v.contactName === null ? {} : { contactName: v.contactName }), paymentTermsDays: v.paymentTermsDays }, 'public-validation');
  return Object.freeze({ kind: contact.kind, name: contact.name, billingAddress: contact.billingAddress, shippingAddress: contact.shippingAddress ?? null,
    email: contact.email ?? null, phone: contact.phone ?? null, contactName: contact.contactName ?? null, paymentTermsDays: contact.paymentTermsDays });
}
export function validateUsFinancialPilotPurchasingRequest(value: unknown): UsFinancialPilotPurchasingRequest {
  try {
    const captured = snapshotPrivateJson(value);
    if (new TextEncoder().encode(JSON.stringify(captured)).byteLength > US_FINANCIAL_PILOT_PURCHASING_MAX_BODY_BYTES) return invalid();
    const r = exact(captured, ['consumer', 'schemaVersion', 'requestId', 'expectedRevision', 'command']);
    if (r.consumer !== 'financial-pilot' || r.schemaVersion !== 1) return invalid();
    const requestId = uuid(r.requestId), expectedRevision = integer(r.expectedRevision), raw = r.command as Record<string, unknown>;
    let command: UsFinancialPilotPurchasingCommand;
    if (raw?.type === 'save_vendor') {
      const c = exact(raw, ['type', 'vendorId', 'vendor']);
      command = Object.freeze({ type: 'save_vendor', vendorId: c.vendorId === null ? null : text(c.vendorId), vendor: vendor(c.vendor) });
    } else if (raw?.type === 'record_vendor_bill') {
      const c = exact(raw, ['type', 'vendorId', 'reference', 'date', 'accountingDate', 'dueDate', 'periodId', 'netMinor', 'purchaseTaxMinor', 'sourceReference']);
      const documentDate = date(c.date), dueDate = date(c.dueDate), netMinor = minor(c.netMinor), purchaseTaxMinor = minor(c.purchaseTaxMinor);
      if (dueDate < documentDate) return invalid();
      minor((BigInt(netMinor) + BigInt(purchaseTaxMinor)).toString(), true);
      command = Object.freeze({ type: 'record_vendor_bill', vendorId: text(c.vendorId), reference: text(c.reference, 500), date: documentDate,
        accountingDate: date(c.accountingDate), dueDate, periodId: text(c.periodId), netMinor, purchaseTaxMinor, sourceReference: text(c.sourceReference, 500) });
    } else if (raw?.type === 'record_vendor_payment') {
      const c = exact(raw, ['type', 'billId', 'amountMinor', 'paymentDate', 'accountingDate', 'periodId', 'reference']);
      command = Object.freeze({ type: 'record_vendor_payment', billId: text(c.billId), amountMinor: minor(c.amountMinor, true), paymentDate: date(c.paymentDate),
        accountingDate: date(c.accountingDate), periodId: text(c.periodId), reference: text(c.reference, 500) });
    } else return invalid();
    return Object.freeze({ consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision, command });
  } catch { return invalid(); }
}
/** Identity only. Create collision and edit existence checks remain server checks. */
export function usFinancialPilotPurchasingEntityId(value: UsFinancialPilotPurchasingRequest): string {
  const r = validateUsFinancialPilotPurchasingRequest(value), c = r.command;
  return c.type === 'save_vendor' ? c.vendorId ?? `pilot-vendor:${r.requestId}` : c.type === 'record_vendor_bill' ? `pilot-vendor-bill:${r.requestId}` : `pilot-vendor-payment:${r.requestId}`;
}
export function buildUsFinancialPilotPurchasingRequest(value: unknown, organizationId: string): UsFinancialRequestV5 {
  try {
    const r = validateUsFinancialPilotPurchasingRequest(value), c = r.command, id = usFinancialPilotPurchasingEntityId(r);
    text(organizationId, 128);
    const command = c.type === 'save_vendor' ? { type: 'save_vendor' as const, vendor: { id, organizationId, kind: c.vendor.kind, name: c.vendor.name, billingAddress: c.vendor.billingAddress,
      ...(c.vendor.shippingAddress === null ? {} : { shippingAddress: c.vendor.shippingAddress }), ...(c.vendor.email === null ? {} : { email: c.vendor.email }),
      ...(c.vendor.phone === null ? {} : { phone: c.vendor.phone }), ...(c.vendor.contactName === null ? {} : { contactName: c.vendor.contactName }), paymentTermsDays: c.vendor.paymentTermsDays } }
      : c.type === 'record_vendor_bill' ? { ...c, id, expenseAccountId: 'purchases' } : { ...c, id };
    const built = validateUsFinancialRequestV5({ idempotencyKey: `pilot:purchasing:${r.requestId}`, expectedRevision: r.expectedRevision,
      command: { type: 'erp_command', request: command } }, organizationId);
    if (built.command.type !== 'erp_command' || canonicalErpJson(built.command.request) !== canonicalErpJson(command)) return invalid();
    return built;
  } catch { return invalid(); }
}
export function validateUsFinancialPilotPurchasingReceipt(value: unknown, organizationId: string, expected?: UsFinancialPilotPurchasingRequest): UsFinancialPilotPurchasingReceipt {
  try {
    const r = exact(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'entityId', 'action', 'requestId']);
    const requestId = uuid(r.requestId), revision = integer(r.revision), entityId = text(r.entityId);
    if (r.consumer !== 'financial-pilot' || r.schemaVersion !== 1 || r.organizationId !== organizationId || !['save_vendor', 'record_vendor_bill', 'record_vendor_payment'].includes(r.action as string)) return invalid();
    if (r.action === 'record_vendor_bill' && entityId !== `pilot-vendor-bill:${requestId}`) return invalid();
    if (r.action === 'record_vendor_payment' && entityId !== `pilot-vendor-payment:${requestId}`) return invalid();
    if (expected) {
      const request = validateUsFinancialPilotPurchasingRequest(expected);
      if (requestId !== request.requestId || r.action !== request.command.type || revision !== request.expectedRevision + 1 || entityId !== usFinancialPilotPurchasingEntityId(request)) return invalid();
    }
    return Object.freeze({ consumer: 'financial-pilot', schemaVersion: 1, organizationId, revision, entityId, action: r.action as UsFinancialPilotPurchasingCommand['type'], requestId });
  } catch { throw new ErpError('invalid_financial_pilot_response', 503); }
}
