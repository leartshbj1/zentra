import { validDate } from './accounting/ledger';
import { ErpError } from './erp-contract';
import { estimateTotals, lineTotals } from './invoicing';
import { money } from './money';
import { snapshotPrivateJson } from './private-json';
import type { UsFinancialPilotCommercialLine } from './us-financial-pilot-commercial';
import { UsFinancialPilotError, validateUsFinancialPilotHead, validateUsFinancialPilotPage,
  type UsFinancialPilotEstimateRow, type UsFinancialPilotHead, type UsFinancialPilotParty } from './us-financial-pilot-contract';
import { financialPilotHead, financialPilotParty, readUsFinancialPilotView } from './us-financial-pilot-projection';

export interface UsFinancialPilotEstimateDetailQuery { readonly revision: number; readonly estimateId: string }
export interface UsFinancialPilotCustomerDetailQuery { readonly revision: number; readonly customerId: string }
export interface UsFinancialPilotCustomerDetail extends UsFinancialPilotHead {
  readonly ledgerRevision: number; readonly customer: UsFinancialPilotParty;
}
export interface UsFinancialPilotEstimateDetail extends UsFinancialPilotHead {
  readonly ledgerRevision: number; readonly estimate: UsFinancialPilotEstimateRow; readonly customer: UsFinancialPilotParty;
  readonly projectId: string | null; readonly paymentTermsDays: number; readonly notes: string;
  readonly subtotalMinor: string; readonly discountMinor: string; readonly netMinor: string;
  readonly lines: readonly (Omit<UsFinancialPilotCommercialLine, 'id'> & Readonly<{ id: string; netMinor: string }>)[];
}
const invalid = (): never => { throw new ErpError('invalid_financial_pilot_response', 503); };
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, multiline = false, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) || Array.from(value).some(character => {
    const code = character.charCodeAt(0); return code === 127 || (code < 32 && !(multiline && [9, 10, 13].includes(code)));
  })) return invalid();
  return value;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER - 1): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : invalid();
}
function unsigned(value: unknown): string { return typeof value === 'string' && /^(0|[1-9][0-9]{0,95})$/.test(value) ? value : invalid(); }
/** A current customer card, distinct from customer snapshots in documents. */
export function validateUsFinancialPilotCustomerDetail(value: unknown, organizationId?: string, revision?: number, customerId?: string): UsFinancialPilotCustomerDetail {
  try {
    const v = exact(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'ledgerRevision', 'customer']);
    const head = validateUsFinancialPilotHead({ consumer: v.consumer, schemaVersion: v.schemaVersion, organizationId: v.organizationId, revision: v.revision }, organizationId);
    if (revision !== undefined && head.revision !== revision) throw new UsFinancialPilotError('financial_snapshot_changed', 409);
    const ledgerRevision = integer(v.ledgerRevision); if (ledgerRevision > head.revision) return invalid();
    const customer = validateUsFinancialPilotPage({ ...head, ledgerRevision, kind: 'customers', scope: null, total: 1, items: [v.customer], nextCursor: null }, head.organizationId, head.revision).items[0] as UsFinancialPilotParty;
    if (text(customer.id, 160) !== customer.id.trim() || customerId !== undefined && customer.id !== customerId) return invalid();
    return Object.freeze({ ...head, ledgerRevision, customer });
  } catch (error) { if (error instanceof UsFinancialPilotError && error.code === 'financial_snapshot_changed') throw error; return invalid(); }
}
export async function projectUsFinancialPilotCustomer(input: unknown, queryInput: UsFinancialPilotCustomerDetailQuery): Promise<UsFinancialPilotCustomerDetail> {
  let query: UsFinancialPilotCustomerDetailQuery;
  try {
    const raw = exact(snapshotPrivateJson(queryInput), ['revision', 'customerId']), customerId = text(raw.customerId, 160);
    if (customerId !== customerId.trim()) throw Error();
    query = Object.freeze({ revision: integer(raw.revision, 1), customerId });
  } catch { throw new UsFinancialPilotError('invalid_financial_pilot_query', 422); }
  const view = await readUsFinancialPilotView(input, query.revision), customer = view.customers.find(row => row.id === query.customerId);
  if (!customer) throw new ErpError('customer_not_found', 404);
  return validateUsFinancialPilotCustomerDetail({ ...financialPilotHead(view), ledgerRevision: view.ledger.revision, customer: financialPilotParty(customer) }, view.organizationId, view.revision, query.customerId);
}
/** Response validation is structural/privacy validation, never a grant. */
export function validateUsFinancialPilotEstimateDetail(value: unknown, organizationId?: string, revision?: number, estimateId?: string): UsFinancialPilotEstimateDetail {
  try {
    const v = exact(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'ledgerRevision', 'estimate', 'customer', 'projectId', 'paymentTermsDays', 'notes', 'subtotalMinor', 'discountMinor', 'netMinor', 'lines']);
    const head = validateUsFinancialPilotHead({ consumer: v.consumer, schemaVersion: v.schemaVersion, organizationId: v.organizationId, revision: v.revision }, organizationId);
    if (revision !== undefined && head.revision !== revision) throw new UsFinancialPilotError('financial_snapshot_changed', 409);
    const ledgerRevision = integer(v.ledgerRevision); if (ledgerRevision > head.revision) return invalid();
    const page = (kind: 'estimates' | 'customers', item: unknown) => validateUsFinancialPilotPage({ ...head, ledgerRevision, kind, scope: null, total: 1, items: [item], nextCursor: null }, head.organizationId, head.revision);
    const estimate = page('estimates', v.estimate).items[0] as UsFinancialPilotEstimateRow, customer = page('customers', v.customer).items[0] as UsFinancialPilotParty;
    if ((estimateId !== undefined && estimate.id !== estimateId) || estimate.customerId !== customer.id || estimate.customerName !== customer.name || estimate.expiresAt < estimate.date) return invalid();
    if (!Array.isArray(v.lines) || !v.lines.length || v.lines.length > 1000) return invalid();
    const lines = Object.freeze(v.lines.map(input => {
      const l = exact(input, ['id', 'description', 'quantityUnits', 'quantityScale', 'unitPriceMinor', 'discountBasisPoints', 'taxTreatment', 'netMinor']);
      const id = text(l.id, 160), description = text(l.description, 4000, true), quantityUnits = unsigned(l.quantityUnits), quantityScale = integer(l.quantityScale, 0, 6),
        unitPriceMinor = unsigned(l.unitPriceMinor), discountBasisPoints = integer(l.discountBasisPoints, 0, 10000), netMinor = unsigned(l.netMinor);
      if (quantityUnits === '0' || !['taxable', 'non_taxable', 'exempt'].includes(l.taxTreatment as string)) return invalid();
      const taxTreatment = l.taxTreatment as UsFinancialPilotCommercialLine['taxTreatment'];
      const totals = lineTotals({ id, description, quantityUnits, quantityScale, unitPrice: money('USD', unitPriceMinor), discountBasisPoints, taxTreatment }, 'USD');
      if (totals.net.minorUnits !== netMinor) return invalid();
      return Object.freeze({ id, description, quantityUnits, quantityScale, unitPriceMinor, discountBasisPoints, taxTreatment, netMinor });
    }));
    if (new Set(lines.map(line => line.id)).size !== lines.length) return invalid();
    const subtotalMinor = unsigned(v.subtotalMinor), discountMinor = unsigned(v.discountMinor), netMinor = unsigned(v.netMinor);
    const totals = lines.reduce((sum, line) => {
      const current = lineTotals({ ...line, unitPrice: money('USD', line.unitPriceMinor) }, 'USD');
      return { gross: sum.gross + BigInt(current.gross.minorUnits), discount: sum.discount + BigInt(current.discount.minorUnits), net: sum.net + BigInt(current.net.minorUnits) };
    }, { gross: BigInt(0), discount: BigInt(0), net: BigInt(0) });
    if (totals.gross.toString() !== subtotalMinor || totals.discount.toString() !== discountMinor || totals.net.toString() !== netMinor || estimate.netMinor !== netMinor) return invalid();
    return Object.freeze({ ...head, ledgerRevision, estimate, customer, projectId: v.projectId === null ? null : text(v.projectId, 160), paymentTermsDays: integer(v.paymentTermsDays, 0, 365),
      notes: text(v.notes, 20_000, true, true), subtotalMinor, discountMinor, netMinor, lines });
  } catch (error) { if (error instanceof UsFinancialPilotError && error.code === 'financial_snapshot_changed') throw error; return invalid(); }
}
/** Capture both arguments synchronously; the only source is validated V5 replay. */
export async function projectUsFinancialPilotEstimate(input: unknown, queryInput: UsFinancialPilotEstimateDetailQuery): Promise<UsFinancialPilotEstimateDetail> {
  let query: UsFinancialPilotEstimateDetailQuery;
  try {
    const raw = exact(snapshotPrivateJson(queryInput), ['revision', 'estimateId']);
    query = Object.freeze({ revision: integer(raw.revision, 1), estimateId: text(raw.estimateId, 160) });
  } catch { throw new UsFinancialPilotError('invalid_financial_pilot_query', 422); }
  const view = await readUsFinancialPilotView(input, query.revision), estimate = view.estimates.find(row => row.id === query.estimateId);
  if (!estimate) throw new UsFinancialPilotError('financial_pilot_record_not_found', 404);
  if (!validDate(estimate.date) || !validDate(estimate.expiresAt)) return invalid();
  const totals = estimateTotals(estimate);
  return validateUsFinancialPilotEstimateDetail({ ...financialPilotHead(view), ledgerRevision: view.ledger.revision,
    estimate: { id: estimate.id, number: estimate.number, revision: estimate.revision, customerId: estimate.customer.id, customerName: estimate.customer.name,
      date: estimate.date, expiresAt: estimate.expiresAt, status: estimate.status, netMinor: totals.net.minorUnits },
    customer: financialPilotParty(estimate.customer), projectId: estimate.projectId ?? null, paymentTermsDays: estimate.paymentTermsDays, notes: estimate.notes,
    subtotalMinor: totals.subtotal.minorUnits, discountMinor: totals.discount.minorUnits, netMinor: totals.net.minorUnits,
    lines: estimate.lines.map(line => ({ id: line.id, description: line.description, quantityUnits: line.quantityUnits, quantityScale: line.quantityScale, unitPriceMinor: line.unitPrice.minorUnits,
      discountBasisPoints: line.discountBasisPoints, taxTreatment: line.taxTreatment, netMinor: lineTotals(line, 'USD').net.minorUnits })) }, view.organizationId, view.revision, query.estimateId);
}
