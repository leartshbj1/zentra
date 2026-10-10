import { minorInteger, validDate } from './accounting/ledger';
import { validateErpContact } from './contacts';
import { canonicalErpJson, ErpError } from './erp-contract';
import { validateErpRequest } from './erp-request';
import { lineTotals, type SalesLine } from './invoicing';
import { money } from './money';
import { snapshotPrivateJson } from './private-json';
import type { CompanyAddress } from './types';
import type { UsFinancialRequestV5 } from './us-financial-kernel-runtime';

/** A presentation command, never an authority, invoice or public ERP5 request. */
export const US_FINANCIAL_PILOT_COMMERCIAL_MAX_BODY_BYTES = 262_144;
export const US_FINANCIAL_PILOT_COMMERCIAL_MAX_LINES = 100;
export interface UsFinancialPilotCommercialCustomer {
  readonly kind: 'individual' | 'business'; readonly name: string; readonly billingAddress: CompanyAddress;
  readonly shippingAddress: CompanyAddress | null; readonly email: string | null; readonly phone: string | null;
  readonly contactName: string | null; readonly paymentTermsDays: number;
}
export interface UsFinancialPilotCommercialLine {
  readonly id: string | null; readonly description: string; readonly quantityUnits: string; readonly quantityScale: number;
  readonly unitPriceMinor: string; readonly discountBasisPoints: number; readonly taxTreatment: SalesLine['taxTreatment'];
}
export type UsFinancialPilotCommercialCommand =
  | Readonly<{ type: 'create_customer'; customer: UsFinancialPilotCommercialCustomer }>
  | Readonly<{ type: 'save_estimate'; estimateId: string | null; expectedEstimateRevision: number; customerId: string; projectId: string | null;
      date: string; expiresAt: string; paymentTermsDays: number; lines: readonly UsFinancialPilotCommercialLine[]; notes: string }>
  | Readonly<{ type: 'accept_estimate'; estimateId: string; expectedEstimateRevision: number }>;
export interface UsFinancialPilotCommercialRequest {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly requestId: string; readonly expectedRevision: number;
  readonly command: UsFinancialPilotCommercialCommand;
}
export interface UsFinancialPilotCommercialReceipt {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly organizationId: string; readonly revision: number;
  readonly entityId: string; readonly action: UsFinancialPilotCommercialCommand['type'];
}
const invalid = (): never => { throw new ErpError('invalid_financial_pilot_request', 422); };
const uuid = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ? value : invalid();
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 160, multiline = false, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) || Array.from(value).some(character => {
    const code = character.charCodeAt(0); return code === 127 || (code < 32 && !(multiline && [9, 10, 13].includes(code)));
  })) return invalid();
  return value;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER - 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid();
  return value;
}
function date(value: unknown): string { return typeof value === 'string' && !value.startsWith('0000-') && validDate(value) ? value : invalid(); }
function customer(input: unknown): UsFinancialPilotCommercialCustomer {
  const c = exact(input, ['kind', 'name', 'billingAddress', 'shippingAddress', 'email', 'phone', 'contactName', 'paymentTermsDays']);
  const contact = validateErpContact({ id: 'public-validation', organizationId: 'public-validation', kind: c.kind, name: c.name, billingAddress: c.billingAddress,
    ...(c.shippingAddress === null ? {} : { shippingAddress: c.shippingAddress }), ...(c.email === null ? {} : { email: c.email }),
    ...(c.phone === null ? {} : { phone: c.phone }), ...(c.contactName === null ? {} : { contactName: c.contactName }), paymentTermsDays: c.paymentTermsDays }, 'public-validation');
  return Object.freeze({ kind: contact.kind, name: contact.name, billingAddress: contact.billingAddress, shippingAddress: contact.shippingAddress ?? null,
    email: contact.email ?? null, phone: contact.phone ?? null, contactName: contact.contactName ?? null, paymentTermsDays: contact.paymentTermsDays });
}
function line(input: unknown): UsFinancialPilotCommercialLine {
  const v = exact(input, ['id', 'description', 'quantityUnits', 'quantityScale', 'unitPriceMinor', 'discountBasisPoints', 'taxTreatment']);
  const id = v.id === null ? null : text(v.id), description = text(v.description, 4000, true);
  if (typeof v.quantityUnits !== 'string' || typeof v.unitPriceMinor !== 'string') return invalid();
  const quantityUnits = minorInteger(v.quantityUnits).toString(), unitPriceMinor = minorInteger(v.unitPriceMinor).toString();
  if (quantityUnits === '0' || !['taxable', 'non_taxable', 'exempt'].includes(v.taxTreatment as string)) return invalid();
  const quantityScale = integer(v.quantityScale, 0, 6), discountBasisPoints = integer(v.discountBasisPoints, 0, 10000), taxTreatment = v.taxTreatment as SalesLine['taxTreatment'];
  const totals = lineTotals({ id: id ?? 'new-line', description, quantityUnits, quantityScale, unitPrice: money('USD', unitPriceMinor), discountBasisPoints, taxTreatment }, 'USD');
  Object.values(totals).forEach(total => minorInteger(total.minorUnits));
  return Object.freeze({ id, description, quantityUnits, quantityScale, unitPriceMinor, discountBasisPoints, taxTreatment });
}
export function validateUsFinancialPilotCommercialRequest(value: unknown): UsFinancialPilotCommercialRequest {
  try {
    const captured = snapshotPrivateJson(value);
    if (new TextEncoder().encode(JSON.stringify(captured)).byteLength > US_FINANCIAL_PILOT_COMMERCIAL_MAX_BODY_BYTES) return invalid();
    const r = exact(captured, ['consumer', 'schemaVersion', 'requestId', 'expectedRevision', 'command']);
    if (r.consumer !== 'financial-pilot' || r.schemaVersion !== 1) return invalid();
    const requestId = uuid(r.requestId), expectedRevision = integer(r.expectedRevision, 1), raw = r.command as Record<string, unknown>;
    let command: UsFinancialPilotCommercialCommand;
    if (raw?.type === 'create_customer') { const c = exact(raw, ['type', 'customer']); command = Object.freeze({ type: 'create_customer', customer: customer(c.customer) }); }
    else if (raw?.type === 'accept_estimate') {
      const c = exact(raw, ['type', 'estimateId', 'expectedEstimateRevision']);
      command = Object.freeze({ type: 'accept_estimate', estimateId: text(c.estimateId), expectedEstimateRevision: integer(c.expectedEstimateRevision, 1) });
    } else if (raw?.type === 'save_estimate') {
      const c = exact(raw, ['type', 'estimateId', 'expectedEstimateRevision', 'customerId', 'projectId', 'date', 'expiresAt', 'paymentTermsDays', 'lines', 'notes']);
      const estimateId = c.estimateId === null ? null : text(c.estimateId), expectedEstimateRevision = integer(c.expectedEstimateRevision);
      if ((estimateId === null) !== (expectedEstimateRevision === 0) || !Array.isArray(c.lines) || !c.lines.length || c.lines.length > US_FINANCIAL_PILOT_COMMERCIAL_MAX_LINES) return invalid();
      const lines = Object.freeze(c.lines.map(line)), effectiveIds = lines.map((item, index) => item.id ?? `pilot-line:${requestId}:${index}`);
      if (estimateId === null && lines.some(item => item.id !== null)) return invalid();
      if (new Set(effectiveIds).size !== lines.length) return invalid();
      const subtotal = lines.reduce((n, item) => n + BigInt(lineTotals({ ...item, id: item.id ?? 'new-line', unitPrice: money('USD', item.unitPriceMinor) }, 'USD').gross.minorUnits), BigInt(0));
      minorInteger(subtotal.toString());
      const documentDate = date(c.date), expiresAt = date(c.expiresAt); if (expiresAt < documentDate) return invalid();
      command = Object.freeze({ type: 'save_estimate', estimateId, expectedEstimateRevision, customerId: text(c.customerId), projectId: c.projectId === null ? null : text(c.projectId),
        date: documentDate, expiresAt, paymentTermsDays: integer(c.paymentTermsDays, 0, 365), lines, notes: text(c.notes, 20_000, true, true) });
    } else return invalid();
    return Object.freeze({ consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision, command });
  } catch { return invalid(); }
}
/** Deterministic identity only; existence, revision and membership are server checks. */
export function usFinancialPilotCommercialEntityId(input: UsFinancialPilotCommercialRequest): string {
  const request = validateUsFinancialPilotCommercialRequest(input), command = request.command;
  return command.type === 'create_customer' ? `pilot-customer:${request.requestId}` : command.type === 'save_estimate' ? command.estimateId ?? `pilot-estimate:${request.requestId}` : command.estimateId;
}
export function buildUsFinancialPilotCommercialRequest(value: unknown, organizationId: string): UsFinancialRequestV5 {
  try {
    const request = validateUsFinancialPilotCommercialRequest(value), id = usFinancialPilotCommercialEntityId(request), c = request.command;
    text(organizationId, 128);
    const command = c.type === 'create_customer' ? { type: 'save_customer' as const, customer: { id, organizationId, kind: c.customer.kind, name: c.customer.name, billingAddress: c.customer.billingAddress,
      ...(c.customer.shippingAddress === null ? {} : { shippingAddress: c.customer.shippingAddress }), ...(c.customer.email === null ? {} : { email: c.customer.email }),
      ...(c.customer.phone === null ? {} : { phone: c.customer.phone }), ...(c.customer.contactName === null ? {} : { contactName: c.customer.contactName }), paymentTermsDays: c.customer.paymentTermsDays } }
      : c.type === 'save_estimate' ? { type: 'save_estimate' as const, id, expectedEstimateRevision: c.expectedEstimateRevision, customerId: c.customerId, ...(c.projectId === null ? {} : { projectId: c.projectId }),
        date: c.date, expiresAt: c.expiresAt, paymentTermsDays: c.paymentTermsDays, lines: c.lines.map((item, index) => ({ id: item.id ?? `pilot-line:${request.requestId}:${index}`, description: item.description,
          quantityUnits: item.quantityUnits, quantityScale: item.quantityScale, unitPrice: money('USD', item.unitPriceMinor), discountBasisPoints: item.discountBasisPoints, taxTreatment: item.taxTreatment })), notes: c.notes }
      : { type: 'accept_estimate' as const, estimateId: c.estimateId, expectedEstimateRevision: c.expectedEstimateRevision };
    const privateRequest = validateErpRequest({ idempotencyKey: `pilot:commercial:${request.requestId}`, expectedRevision: request.expectedRevision, command }, organizationId);
    if (canonicalErpJson(privateRequest.command) !== canonicalErpJson(command)) return invalid();
    return snapshotPrivateJson({ idempotencyKey: privateRequest.idempotencyKey, expectedRevision: privateRequest.expectedRevision, command: { type: 'erp_command', request: privateRequest.command } }) as UsFinancialRequestV5;
  } catch { return invalid(); }
}
export function validateUsFinancialPilotCommercialReceipt(value: unknown, organizationId: string, expected?: UsFinancialPilotCommercialRequest): UsFinancialPilotCommercialReceipt {
  try {
    const r = exact(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'entityId', 'action']);
    if (r.consumer !== 'financial-pilot' || r.schemaVersion !== 1 || r.organizationId !== organizationId || !['create_customer', 'save_estimate', 'accept_estimate'].includes(r.action as string)) return invalid();
    const revision = integer(r.revision, 1), entityId = text(r.entityId);
    if (expected) { const request = validateUsFinancialPilotCommercialRequest(expected); if (r.action !== request.command.type || revision !== request.expectedRevision + 1 || entityId !== usFinancialPilotCommercialEntityId(request)) return invalid(); }
    return Object.freeze({ consumer: 'financial-pilot', schemaVersion: 1, organizationId, revision, entityId, action: r.action as UsFinancialPilotCommercialCommand['type'] });
  } catch { throw new ErpError('invalid_financial_pilot_response', 503); }
}
