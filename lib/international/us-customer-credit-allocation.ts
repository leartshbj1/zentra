import { canonicalErpJson, ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import type {
  UsCustomerCreditAllocation,
  UsCustomerCreditAllocationHistory,
  UsCustomerCreditAllocationLine,
  UsCustomerCreditRemainingLine,
  UsCustomerCreditSelection,
  UsCustomerCreditSource,
  UsCustomerCreditSourceLine,
} from './us-customer-credit-types';

type InvalidCode = 'invalid_credit_source' | 'invalid_credit_selection' | 'invalid_credit_history';
const fail = (code: InvalidCode): never => { throw new ErpError(code, code === 'invalid_credit_selection' ? 422 : 503); };
const sourceKeys = ['schemaVersion', 'organizationId', 'invoiceId', 'invoiceNumber', 'customerId', 'currency', 'invoiceFingerprint', 'lines'] as const;
const lineKeys = ['lineId', 'quantityUnits', 'quantityScale', 'netMinor', 'taxMinor', 'jurisdiction', 'evidenceReference'] as const;
const allocationKeys = ['invoiceFingerprint', 'lines', 'netMinor', 'taxMinor', 'totalMinor'] as const;
const allocationLineKeys = ['lineId', 'quantityUnits', 'netMinor', 'taxMinor', 'totalMinor'] as const;

function detached(input: unknown, code: InvalidCode): unknown {
  try { return snapshotPrivateJson(input); } catch { return fail(code); }
}
function object(input: unknown, keys: readonly string[], code: InvalidCode): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) return fail(code);
  return input as Record<string, unknown>;
}
function array(input: unknown, minimum: number, code: InvalidCode): readonly unknown[] {
  if (!Array.isArray(input) || input.length < minimum || input.length > 1_000) return fail(code);
  return input;
}
function text(input: unknown, code: InvalidCode, maximum = 160): string {
  if (typeof input !== 'string' || !input || input !== input.trim() || input.length > maximum || Array.from(input).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fail(code);
  return input;
}
function integer(input: unknown, positive: boolean, code: InvalidCode): string {
  if (typeof input !== 'string' || input.length > 36 || !(positive ? /^[1-9][0-9]*$/ : /^(?:0|[1-9][0-9]*)$/).test(input)) return fail(code);
  return input;
}

/** An immutable arithmetic source only; this validator does not establish
 * invoice ownership, tax-adjustment permission or authority to issue a credit. */
export function validateUsCustomerCreditSource(input: unknown): UsCustomerCreditSource {
  const value = object(detached(input, 'invalid_credit_source'), sourceKeys, 'invalid_credit_source');
  if (value.schemaVersion !== 1 || value.currency !== 'USD' || typeof value.invoiceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.invoiceFingerprint)) return fail('invalid_credit_source');
  const identities = new Set<string>();
  const lines = array(value.lines, 1, 'invalid_credit_source').map(raw => {
    const line = object(raw, lineKeys, 'invalid_credit_source');
    const lineId = text(line.lineId, 'invalid_credit_source');
    if (identities.has(lineId) || typeof line.quantityScale !== 'number' || !Number.isSafeInteger(line.quantityScale) || Object.is(line.quantityScale, -0) || line.quantityScale < 0 || line.quantityScale > 6) return fail('invalid_credit_source');
    identities.add(lineId);
    return Object.freeze({
      lineId,
      quantityUnits: integer(line.quantityUnits, true, 'invalid_credit_source'),
      quantityScale: line.quantityScale,
      netMinor: integer(line.netMinor, false, 'invalid_credit_source'),
      taxMinor: integer(line.taxMinor, false, 'invalid_credit_source'),
      jurisdiction: text(line.jurisdiction, 'invalid_credit_source', 500),
      evidenceReference: text(line.evidenceReference, 'invalid_credit_source', 500),
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    organizationId: text(value.organizationId, 'invalid_credit_source'),
    invoiceId: text(value.invoiceId, 'invalid_credit_source'),
    invoiceNumber: text(value.invoiceNumber, 'invalid_credit_source'),
    customerId: text(value.customerId, 'invalid_credit_source'),
    currency: 'USD',
    invoiceFingerprint: value.invoiceFingerprint,
    lines: Object.freeze(lines),
  });
}

function selections(source: UsCustomerCreditSource, input: unknown, code: InvalidCode): ReadonlyMap<string, string> {
  const available = new Set(source.lines.map(line => line.lineId)), result = new Map<string, string>();
  for (const raw of array(input, 1, code)) {
    const value = object(raw, ['lineId', 'quantityUnits'], code), lineId = text(value.lineId, code);
    if (!available.has(lineId) || result.has(lineId)) return fail(code);
    result.set(lineId, integer(value.quantityUnits, true, code));
  }
  return result;
}

/** Nonnegative exact half-away-from-zero division. quantityScale cancels:
 * both selected and original quantities use the original line's units. */
function proportional(originalMinor: string, quantity: bigint, originalQuantity: string): bigint {
  const numerator = BigInt(originalMinor) * quantity, denominator = BigInt(originalQuantity);
  return numerator / denominator + (numerator % denominator * BigInt(2) >= denominator ? BigInt(1) : BigInt(0));
}

function allocate(source: UsCustomerCreditSource, selected: ReadonlyMap<string, string>, cumulative: Map<string, bigint>, historical: boolean): UsCustomerCreditAllocation {
  const lines: UsCustomerCreditAllocationLine[] = [];
  let net = BigInt(0), tax = BigInt(0);
  for (const line of source.lines) {
    const quantityUnits = selected.get(line.lineId);
    if (quantityUnits === undefined) continue;
    const previous = cumulative.get(line.lineId) ?? BigInt(0), next = previous + BigInt(quantityUnits);
    if (next > BigInt(line.quantityUnits)) {
      if (historical) return fail('invalid_credit_history');
      throw new ErpError('credit_quantity_exceeded', 409);
    }
    // Allocate net after the original discount and historical tax separately.
    // Rounding each new slice independently would lose or invent final cents.
    const allocatedNet = proportional(line.netMinor, next, line.quantityUnits) - proportional(line.netMinor, previous, line.quantityUnits);
    const allocatedTax = proportional(line.taxMinor, next, line.quantityUnits) - proportional(line.taxMinor, previous, line.quantityUnits);
    lines.push(Object.freeze({ lineId: line.lineId, quantityUnits, netMinor: allocatedNet.toString(), taxMinor: allocatedTax.toString(), totalMinor: (allocatedNet + allocatedTax).toString() }));
    cumulative.set(line.lineId, next);
    net += allocatedNet; tax += allocatedTax;
  }
  if (net + tax === BigInt(0)) {
    if (historical) return fail('invalid_credit_history');
    throw new ErpError('credit_amount_zero', 422);
  }
  // Input amounts are at most 36 digits; exact sums may legitimately be larger.
  return Object.freeze({ invoiceFingerprint: source.invoiceFingerprint, lines: Object.freeze(lines), netMinor: net.toString(), taxMinor: tax.toString(), totalMinor: (net + tax).toString() });
}

function historyQuantities(source: UsCustomerCreditSource, input: unknown): Map<string, bigint> {
  const cumulative = new Map<string, bigint>(), identities = new Set<string>();
  for (const raw of array(detached(input, 'invalid_credit_history'), 0, 'invalid_credit_history')) {
    const value = object(raw, ['id', 'allocation'], 'invalid_credit_history'), id = text(value.id, 'invalid_credit_history');
    if (identities.has(id)) return fail('invalid_credit_history');
    identities.add(id);
    const allocation = object(value.allocation, allocationKeys, 'invalid_credit_history');
    if (allocation.invoiceFingerprint !== source.invoiceFingerprint) return fail('invalid_credit_history');
    const previousSelections = array(allocation.lines, 1, 'invalid_credit_history').map(rawLine => {
      const line = object(rawLine, allocationLineKeys, 'invalid_credit_history');
      return Object.freeze({ lineId: line.lineId, quantityUnits: line.quantityUnits });
    });
    const rebuilt = allocate(source, selections(source, previousSelections, 'invalid_credit_history'), cumulative, true);
    // A full canonical comparison validates all minor-unit strings, source
    // order, sums and every historical rounding choice, without trusting totals.
    if (canonicalErpJson(allocation) !== canonicalErpJson(rebuilt)) return fail('invalid_credit_history');
  }
  return cumulative;
}

/** Candidate allocation only: no journal, receivable, issued credit, payment
 * or verified fiscal adjustment is created by this pure function. */
export function prepareUsCustomerCreditAllocation(
  source: UsCustomerCreditSource,
  selection: readonly UsCustomerCreditSelection[],
  history: readonly UsCustomerCreditAllocationHistory[] = [],
): UsCustomerCreditAllocation {
  const capturedSource = validateUsCustomerCreditSource(source);
  const selected = selections(capturedSource, detached(selection, 'invalid_credit_selection'), 'invalid_credit_selection');
  const cumulative = historyQuantities(capturedSource, history);
  return allocate(capturedSource, selected, cumulative, false);
}

export function remainingUsCustomerCredit(
  source: UsCustomerCreditSource,
  history: readonly UsCustomerCreditAllocationHistory[] = [],
): readonly UsCustomerCreditRemainingLine[] {
  const capturedSource = validateUsCustomerCreditSource(source), cumulative = historyQuantities(capturedSource, history);
  return Object.freeze(capturedSource.lines.map((line: UsCustomerCreditSourceLine) => {
    const quantity = cumulative.get(line.lineId) ?? BigInt(0);
    return Object.freeze({
      ...line,
      remainingQuantityUnits: (BigInt(line.quantityUnits) - quantity).toString(),
      remainingNetMinor: (BigInt(line.netMinor) - proportional(line.netMinor, quantity, line.quantityUnits)).toString(),
      remainingTaxMinor: (BigInt(line.taxMinor) - proportional(line.taxMinor, quantity, line.quantityUnits)).toString(),
    });
  }));
}
