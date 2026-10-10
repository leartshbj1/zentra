import { validDate } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { countryConfiguration } from './country-config';
import { canonicalErpJson, ErpError } from './erp-contract';
import { lineTotals } from './invoicing';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { validateUsFinancialInvoiceOperationV5, type UsFinancialInvoiceOperationV5 } from './us-financial-invoice-test';
import { validateUsFinancialRequestV5, type UsFinancialRequestV5 } from './us-financial-kernel-runtime';

export const US_FINANCIAL_PILOT_INVOICE_MAX_BODY_BYTES = 262_144;
export interface UsFinancialPilotInvoiceChoices {
  readonly classifications: readonly Readonly<{ lineId: string; taxCode: string; confirmedService: true }>[];
  readonly taxDateInstant: string; readonly addressSource: 'billing' | 'shipping';
}
export interface UsFinancialPilotInvoiceRequest {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly requestId: string; readonly expectedRevision: number;
  readonly command: Readonly<{ type: 'issue_invoice'; estimateId: string; expectedEstimateRevision: number; date: string; accountingDate: string; dueDate: string; periodId: string }>;
  readonly choices: UsFinancialPilotInvoiceChoices;
}
export interface UsFinancialPilotInvoiceIssueRequest { readonly request: UsFinancialPilotInvoiceRequest; readonly reviewId: string }
export interface UsFinancialPilotInvoicePreview {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly organizationId: string; readonly revision: number;
  readonly requestId: string; readonly reviewId: string; readonly status: 'prepared_test'; readonly financialStatus: 'not_issued' | 'issued';
  readonly invoiceId: string; readonly estimateId: string; readonly estimateRevision: number; readonly estimateNumber: string; readonly customerName: string;
  readonly currency: 'USD'; readonly date: string; readonly accountingDate: string; readonly dueDate: string; readonly periodId: string;
  readonly timeZone: string; readonly addressSource: 'billing' | 'shipping'; readonly taxDateInstant: string;
  readonly lines: readonly Readonly<{ id: string; description: string; quantityUnits: string; quantityScale: number; netMinor: string; taxMinor: string; totalMinor: string; taxCode: string }>[];
  readonly netMinor: string; readonly taxMinor: string; readonly totalMinor: string; readonly retryUntil: string; readonly expiresAt: string;
}
export interface UsFinancialPilotInvoiceReceipt {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly organizationId: string; readonly revision: number;
  readonly entityId: string; readonly action: 'issue_invoice'; readonly requestId: string;
}
export interface UsFinancialPilotTaxCatalogue {
  readonly consumer: 'financial-pilot'; readonly schemaVersion: 1; readonly organizationId: string;
  readonly taxCodes: readonly Readonly<{ id: string; name: string; description: string }>[];
  readonly hasMore: boolean; readonly nextCursor: string | null;
}
const invalid = (): never => { throw new ErpError('invalid_financial_pilot_request', 422); };
const responseInvalid = (): never => { throw new ErpError('invalid_financial_pilot_response', 503); };
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 160, multiline = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || (!multiline && value !== value.trim()) || Array.from(value).some(c => {
    const n = c.charCodeAt(0); return n === 127 || (n < 32 && !(multiline && [9, 10, 13].includes(n)));
  })) return invalid();
  return value;
}
function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER - 1): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : invalid();
}
function uuid(value: unknown): string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ? value : invalid(); }
function hash(value: unknown): string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : invalid(); }
function date(value: unknown): string { return typeof value === 'string' && !value.startsWith('0000-') && validDate(value) ? value : invalid(); }
function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return invalid();
  try { if (parseInstant(value).toISOString() !== value) return invalid(); } catch { return invalid(); }
  return value;
}
function taxCode(value: unknown): string { return typeof value === 'string' && /^txcd_[0-9]{8}$/.test(value) ? value : invalid(); }
function unsigned(value: unknown): string { return typeof value === 'string' && /^(0|[1-9][0-9]{0,95})$/.test(value) ? value : invalid(); }
function bounded(value: unknown): unknown {
  const captured = snapshotPrivateJson(value);
  if (new TextEncoder().encode(JSON.stringify(captured)).byteLength > US_FINANCIAL_PILOT_INVOICE_MAX_BODY_BYTES) return invalid();
  return captured;
}
/** Presentation choices cannot provide nexus, registrations, rates or authority. */
export function validateUsFinancialPilotInvoiceRequest(value: unknown): UsFinancialPilotInvoiceRequest {
  try {
    const r = exact(bounded(value), ['consumer', 'schemaVersion', 'requestId', 'expectedRevision', 'command', 'choices']);
    if (r.consumer !== 'financial-pilot' || r.schemaVersion !== 1) return invalid();
    const c = exact(r.command, ['type', 'estimateId', 'expectedEstimateRevision', 'date', 'accountingDate', 'dueDate', 'periodId']);
    if (c.type !== 'issue_invoice') return invalid();
    const documentDate = date(c.date), dueDate = date(c.dueDate); if (dueDate < documentDate) return invalid();
    const v = exact(r.choices, ['classifications', 'taxDateInstant', 'addressSource']);
    if (!Array.isArray(v.classifications) || !v.classifications.length || v.classifications.length > 100 || !['billing', 'shipping'].includes(v.addressSource as string)) return invalid();
    const classifications = Object.freeze(v.classifications.map(input => {
      const l = exact(input, ['lineId', 'taxCode', 'confirmedService']);
      if (l.confirmedService !== true) return invalid();
      return Object.freeze({ lineId: text(l.lineId), taxCode: taxCode(l.taxCode), confirmedService: true as const });
    }));
    if (new Set(classifications.map(l => l.lineId)).size !== classifications.length) return invalid();
    const taxDateInstant = instant(v.taxDateInstant); if (!taxDateInstant.endsWith('.000Z')) return invalid();
    return Object.freeze({ consumer: 'financial-pilot', schemaVersion: 1, requestId: uuid(r.requestId), expectedRevision: integer(r.expectedRevision),
      command: Object.freeze({ type: 'issue_invoice', estimateId: text(c.estimateId), expectedEstimateRevision: integer(c.expectedEstimateRevision), date: documentDate, accountingDate: date(c.accountingDate), dueDate, periodId: text(c.periodId) }),
      choices: Object.freeze({ classifications, taxDateInstant, addressSource: v.addressSource as 'billing' | 'shipping' }) });
  } catch { return invalid(); }
}
export function validateUsFinancialPilotInvoiceIssueRequest(value: unknown): UsFinancialPilotInvoiceIssueRequest {
  try { const v = exact(bounded(value), ['request', 'reviewId']); return Object.freeze({ request: validateUsFinancialPilotInvoiceRequest(v.request), reviewId: hash(v.reviewId) }); }
  catch { return invalid(); }
}
export function buildUsFinancialPilotInvoiceRequest(value: unknown, organizationId: string): UsFinancialRequestV5 {
  try {
    const request = validateUsFinancialPilotInvoiceRequest(value);
    text(organizationId, 128);
    return validateUsFinancialRequestV5({ idempotencyKey: `pilot:invoice:${request.requestId}`, expectedRevision: request.expectedRevision,
      command: { type: 'erp_command', request: { ...request.command, id: `pilot-invoice:${request.requestId}` } } }, organizationId);
  } catch { return invalid(); }
}
/** Call only in addition to complete private operation validation. Every
 * historical/resolver read needs this check: the ERP hash omits these choices. */
export function usFinancialPilotInvoiceChoicesMatch(operation: UsFinancialInvoiceOperationV5, value: unknown): boolean {
  try {
    const request = validateUsFinancialPilotInvoiceRequest(value), op = snapshotPrivateJson(operation) as UsFinancialInvoiceOperationV5;
    const choices = { classifications: op.preparation.classifications.map(c => ({ lineId: c.lineId, taxCode: c.taxCode, confirmedService: true })), taxDateInstant: op.preparation.taxDateInstant, addressSource: op.preparation.addressSource };
    return canonicalErpJson(op.preparation.request) === canonicalErpJson(buildUsFinancialPilotInvoiceRequest(request, op.organizationId)) && canonicalErpJson(choices) === canonicalErpJson(request.choices);
  } catch { return false; }
}
export function validateUsFinancialPilotInvoicePreview(value: unknown, organizationId?: string, expected?: UsFinancialPilotInvoiceRequest): UsFinancialPilotInvoicePreview {
  try {
    const v = exact(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'requestId', 'reviewId', 'status', 'financialStatus', 'invoiceId', 'estimateId', 'estimateRevision', 'estimateNumber', 'customerName', 'currency', 'date', 'accountingDate', 'dueDate', 'periodId', 'timeZone', 'addressSource', 'taxDateInstant', 'lines', 'netMinor', 'taxMinor', 'totalMinor', 'retryUntil', 'expiresAt']);
    const org = text(v.organizationId, 128), requestId = uuid(v.requestId), revision = integer(v.revision), estimateId = text(v.estimateId), estimateRevision = integer(v.estimateRevision);
    if (v.consumer !== 'financial-pilot' || v.schemaVersion !== 1 || (organizationId !== undefined && org !== organizationId) || v.status !== 'prepared_test' || !['not_issued', 'issued'].includes(v.financialStatus as string) || v.currency !== 'USD' || v.invoiceId !== `pilot-invoice:${requestId}`) return invalid();
    if (!countryConfiguration('US').timeZones.includes(v.timeZone as string) || !['billing', 'shipping'].includes(v.addressSource as string)) return invalid();
    const documentDate = date(v.date), accountingDate = date(v.accountingDate), dueDate = date(v.dueDate), taxDateInstant = instant(v.taxDateInstant), retryUntil = instant(v.retryUntil), expiresAt = instant(v.expiresAt);
    if (dueDate < documentDate || expiresAt > retryUntil || !taxDateInstant.endsWith('.000Z')) return invalid();
    if (!Array.isArray(v.lines) || !v.lines.length || v.lines.length > 100) return invalid();
    const lines = Object.freeze(v.lines.map(raw => {
      const l = exact(raw, ['id', 'description', 'quantityUnits', 'quantityScale', 'netMinor', 'taxMinor', 'totalMinor', 'taxCode']);
      const netMinor = unsigned(l.netMinor), taxMinor = unsigned(l.taxMinor), totalMinor = unsigned(l.totalMinor), quantityUnits = unsigned(l.quantityUnits);
      const quantityScale = integer(l.quantityScale, 0, 6);
      if (quantityUnits === '0' || BigInt(quantityUnits) % (BigInt(10) ** BigInt(quantityScale)) !== BigInt(0) || BigInt(netMinor) + BigInt(taxMinor) !== BigInt(totalMinor)) return invalid();
      return Object.freeze({ id: text(l.id), description: text(l.description, 4000, true), quantityUnits, quantityScale, netMinor, taxMinor, totalMinor, taxCode: taxCode(l.taxCode) });
    }));
    if (new Set(lines.map(l => l.id)).size !== lines.length) return invalid();
    const netMinor = unsigned(v.netMinor), taxMinor = unsigned(v.taxMinor), totalMinor = unsigned(v.totalMinor);
    for (const key of ['netMinor', 'taxMinor', 'totalMinor'] as const) if (lines.reduce((n, l) => n + BigInt(l[key]), BigInt(0)).toString() !== v[key]) return invalid();
    if (expected) {
      const r = validateUsFinancialPilotInvoiceRequest(expected), c = r.command;
      if (requestId !== r.requestId || revision !== r.expectedRevision || estimateId !== c.estimateId || estimateRevision !== c.expectedEstimateRevision || documentDate !== c.date || accountingDate !== c.accountingDate || dueDate !== c.dueDate || v.periodId !== c.periodId || v.addressSource !== r.choices.addressSource || taxDateInstant !== r.choices.taxDateInstant || canonicalErpJson(lines.map(l => ({ lineId: l.id, taxCode: l.taxCode, confirmedService: true }))) !== canonicalErpJson(r.choices.classifications)) return invalid();
    }
    return Object.freeze({ consumer: 'financial-pilot', schemaVersion: 1, organizationId: org, revision, requestId, reviewId: hash(v.reviewId), status: 'prepared_test', financialStatus: v.financialStatus as 'not_issued' | 'issued', invoiceId: v.invoiceId as string, estimateId, estimateRevision, estimateNumber: text(v.estimateNumber, 160), customerName: text(v.customerName, 160), currency: 'USD', date: documentDate, accountingDate, dueDate, periodId: text(v.periodId), timeZone: v.timeZone as string, addressSource: v.addressSource as 'billing' | 'shipping', taxDateInstant, lines, netMinor, taxMinor, totalMinor, retryUntil, expiresAt });
  } catch { return responseInvalid(); }
}
/** Capture synchronously, validate stored evidence at its historical admission
 * time, and publish only presentation data. Fresh authority remains mandatory
 * in the server; this pure projection cannot authorize an issue or retry. */
export async function projectUsFinancialPilotInvoicePreview(operation: UsFinancialInvoiceOperationV5, value: unknown, allowTestFixtures = false): Promise<UsFinancialPilotInvoicePreview> {
  let raw: unknown, request: UsFinancialPilotInvoiceRequest;
  try { raw = snapshotPrivateJson(operation); request = validateUsFinancialPilotInvoiceRequest(value); } catch { return responseInvalid(); }
  const op = await validateUsFinancialInvoiceOperationV5(raw, (raw as UsFinancialInvoiceOperationV5).organizationId, allowTestFixtures);
  if (op.status === 'reserved' || !op.assessment || !usFinancialPilotInvoiceChoicesMatch(op, request)) return responseInvalid();
  const source = op.preparation.estimate;
  if (source.lines.length !== request.choices.classifications.length || source.lines.some(l => l.taxTreatment !== 'taxable' || BigInt(l.quantityUnits) % (BigInt(10) ** BigInt(l.quantityScale)) !== BigInt(0))) return responseInvalid();
  const lines = source.lines.map((line, index) => {
    const tax = op.assessment!.lines.find(l => l.id === line.id); if (!tax) return responseInvalid();
    const netMinor = lineTotals(line, 'USD').net.minorUnits;
    return { id: line.id, description: line.description, quantityUnits: line.quantityUnits, quantityScale: line.quantityScale, netMinor, taxMinor: tax.taxMinor, totalMinor: (BigInt(netMinor) + BigInt(tax.taxMinor)).toString(), taxCode: request.choices.classifications[index].taxCode };
  });
  const reviewId = await sha256Hex(canonicalErpJson(['zentra:financial-pilot:invoice-review:v1', op.organizationId, request, op.operationId, op.preparation.preparationSha256, op.proofSha256]));
  const sums = Object.fromEntries((['netMinor', 'taxMinor', 'totalMinor'] as const).map(key => [key, lines.reduce((n, l) => n + BigInt(l[key]), BigInt(0)).toString()]));
  const expiresAt = [op.retryUntil, op.assessment.validUntil, op.preparation.context.binding.validUntil].map(v => new Date(parseInstant(v)).toISOString()).sort()[0];
  return validateUsFinancialPilotInvoicePreview({ consumer: 'financial-pilot', schemaVersion: 1, organizationId: op.organizationId, revision: request.expectedRevision, requestId: request.requestId, reviewId, status: 'prepared_test', financialStatus: op.status === 'committed' ? 'issued' : 'not_issued', invoiceId: `pilot-invoice:${request.requestId}`, estimateId: source.id, estimateRevision: source.revision, estimateNumber: source.number, customerName: source.customer.name, currency: 'USD', date: request.command.date, accountingDate: request.command.accountingDate, dueDate: request.command.dueDate, periodId: request.command.periodId, timeZone: op.preparation.context.configuration.timeZone, addressSource: request.choices.addressSource, taxDateInstant: request.choices.taxDateInstant, lines, ...sums, retryUntil: op.retryUntil, expiresAt }, op.organizationId, request);
}
export function validateUsFinancialPilotInvoiceReceipt(value: unknown, organizationId: string, expected?: UsFinancialPilotInvoiceRequest): UsFinancialPilotInvoiceReceipt {
  try {
    const v = exact(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'revision', 'entityId', 'action', 'requestId']), requestId = uuid(v.requestId), revision = integer(v.revision);
    if (v.consumer !== 'financial-pilot' || v.schemaVersion !== 1 || v.organizationId !== organizationId || v.action !== 'issue_invoice' || v.entityId !== `pilot-invoice:${requestId}`) return invalid();
    if (expected) { const r = validateUsFinancialPilotInvoiceRequest(expected); if (r.requestId !== requestId || revision !== r.expectedRevision + 1) return invalid(); }
    return Object.freeze({ consumer: 'financial-pilot', schemaVersion: 1, organizationId, revision, entityId: v.entityId as string, action: 'issue_invoice', requestId });
  } catch { return responseInvalid(); }
}
export function validateUsFinancialPilotTaxCatalogue(value: unknown, organizationId?: string): UsFinancialPilotTaxCatalogue {
  try {
    const v = exact(snapshotPrivateJson(value), ['consumer', 'schemaVersion', 'organizationId', 'taxCodes', 'hasMore', 'nextCursor']), org = text(v.organizationId, 128);
    if (v.consumer !== 'financial-pilot' || v.schemaVersion !== 1 || (organizationId !== undefined && org !== organizationId) || !Array.isArray(v.taxCodes) || v.taxCodes.length > 20 || typeof v.hasMore !== 'boolean') return invalid();
    const codes = Object.freeze(v.taxCodes.map(raw => { const c = exact(raw, ['id', 'name', 'description']); return Object.freeze({ id: taxCode(c.id), name: text(c.name, 2000), description: text(c.description, 16_000) }); }));
    // The provider filters unsupported performance-location codes. Its raw
    // continuation can differ from the last visible code, or span an empty page.
    if (new Set(codes.map(c => c.id)).size !== codes.length || (v.hasMore ? typeof v.nextCursor !== 'string' || !/^txcd_[0-9]{8}$/.test(v.nextCursor) : v.nextCursor !== null)) return invalid();
    return Object.freeze({ consumer: 'financial-pilot', schemaVersion: 1, organizationId: org, taxCodes: codes, hasMore: v.hasMore, nextCursor: v.nextCursor as string | null });
  } catch { return responseInvalid(); }
}
