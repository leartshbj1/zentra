import type Stripe from 'stripe';
import { sha256Hex } from '../account-security';
import { validateAddress } from './addresses';
import { validDate } from './accounting/ledger';
import { validateCompanyConfiguration } from './country-config';
import { canonicalErpJson } from './erp-contract';
import { lineTotals, validateEstimate, type Estimate } from './invoicing';
import { parseInstant } from './localization';
import type { CompanyConfiguration, USAddress } from './types';
import { validateUsTaxFacts, type UsTaxFacts } from './us-tax-profile';

export const STRIPE_TAX_API_VERSION = '2026-08-26.dahlia' as const;
/** Supplied only by the trusted upstream binding reader. These fields do not
 * authenticate an account or prove registrations/legal liability by themselves.
 * Runtime must refuse test_fixture except through explicit QA dependencies. */
export interface StripeTaxTestBinding {
  readonly organizationId: string;
  readonly accountId: string;
  readonly mode: 'test';
  readonly apiVersion: typeof STRIPE_TAX_API_VERSION;
  readonly revision: number;
  readonly settingsSha256: string;
  readonly registrationsSha256: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly evidenceKind: 'provider_observation' | 'test_fixture';
  readonly scope: 'erp_invoice_tax';
}
/** A server classification decision, not a product/category inferred here.
 * taxCode is checked syntactically only; upstream must confirm its actual code,
 * service category and legal applicability against the provider's catalogue. */
export interface StripeTaxServiceClassification {
  readonly lineId: string;
  readonly taxCode: string;
  readonly kind: 'service';
  readonly taxBehavior: 'exclusive';
  readonly revision: number;
  readonly evidenceReference: string;
}
export interface StripeTaxResolvedRequestInput {
  readonly organizationId: string;
  readonly operationId: string;
  readonly invoiceId: string;
  readonly actorUserId: string;
  readonly erpIdempotencyKey: string;
  readonly commandHash: string;
  readonly expectedErpRevision: number;
  readonly countryRevision: number;
  readonly sellerRevision: number;
  readonly taxFactsRevision: number;
  readonly configuration: CompanyConfiguration;
  readonly estimate: Estimate;
  readonly taxFacts: UsTaxFacts;
  readonly binding: StripeTaxTestBinding;
  readonly classifications: readonly StripeTaxServiceClassification[];
  readonly invoiceDate: string;
  /** Caller resolves this explicit instant according to the seller's zone.
   * No implicit estimate-date, browser-clock or midnight-UTC conversion. */
  readonly taxDateInstant: string;
  readonly taxDatePolicy: 'caller_supplied_invoice_instant';
  /** Fresh trusted server clock, supplied explicitly for deterministic bounds. */
  readonly now: string;
  readonly addressSource: 'billing' | 'shipping';
}
export type StripeTaxCalculationParams = Readonly<{
  currency: 'usd';
  customer_details: Readonly<{ address: Readonly<{ country: 'US'; line1: string; line2?: string; city: string; state: string; postal_code: string }>; address_source: 'billing' | 'shipping' }>;
  tax_date: number;
  line_items: readonly Readonly<{ amount: number; quantity: number; reference: string; tax_code: string; tax_behavior: 'exclusive' }>[];
  expand: readonly ['line_items.data.tax_breakdown'];
}>;
export interface ResolvedStripeTaxRequest {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly operationId: string;
  readonly invoiceId: string;
  readonly actorUserId: string;
  readonly erpIdempotencyKey: string;
  readonly commandHash: string;
  readonly expectedErpRevision: number;
  readonly sourceEstimateId: string;
  readonly sourceEstimateRevision: number;
  readonly countryRevision: number;
  readonly sellerRevision: number;
  readonly taxFactsRevision: number;
  readonly binding: StripeTaxTestBinding;
  readonly classifications: readonly StripeTaxServiceClassification[];
  readonly invoiceDate: string;
  readonly taxDateInstant: string;
  readonly taxDatePolicy: 'caller_supplied_invoice_instant';
  readonly timeZone: string;
  readonly snapshots: Readonly<{ configuration: CompanyConfiguration; estimate: Estimate; taxFacts: UsTaxFacts }>;
  readonly params: StripeTaxCalculationParams;
  readonly netTotalMinor: string;
  readonly paramsSha256: string;
  /** Exact canonical UTF8 bodies supplied separately to durable PG reservation. */
  readonly paramsBody: string;
  readonly resolvedBody: string;
  readonly resolvedSha256: string;
  /** Opaque digest only: no raw tenant, actor, customer, address or ERP key. */
  readonly idempotencyKey: string;
}
export class StripeTaxResolvedRequestError extends Error {
  constructor(readonly code: 'invalid_request' | 'tenant_mismatch' | 'unsupported_tax_request' | 'binding_unavailable' | 'invalid_tax_date', readonly status = 422) {
    super(code); this.name = 'StripeTaxResolvedRequestError';
  }
}

const inputFields = ['organizationId', 'operationId', 'invoiceId', 'actorUserId', 'erpIdempotencyKey', 'commandHash', 'expectedErpRevision', 'countryRevision', 'sellerRevision', 'taxFactsRevision', 'configuration', 'estimate', 'taxFacts', 'binding', 'classifications', 'invoiceDate', 'taxDateInstant', 'taxDatePolicy', 'now', 'addressSource'];
const maxSafe = BigInt(Number.MAX_SAFE_INTEGER), second = BigInt(1_000_000), windowMicros = BigInt(31 * 86_400) * second;
function fail(code: StripeTaxResolvedRequestError['code'] = 'invalid_request', status = 422): never { throw new StripeTaxResolvedRequestError(code, status); }
/** Copy all data before the first hash await; never invoke a getter/toJSON or
 * retain a caller's mutable document. Bounded depth/nodes avoids cyclic input. */
function snapshot(input: unknown): unknown {
  let nodes = 0, textUnits = 0;
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 20_000 || depth > 16) return fail();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      textUnits += value.length;
      if (value.length > 2_621_440 || textUnits > 4_194_304 || value.includes('\u0000') || !wellFormed(value)) return fail();
      return value;
    }
    if (typeof value === 'number') { if (!Number.isFinite(value)) return fail(); return value; }
    if (!value || typeof value !== 'object') return fail();
    if (Array.isArray(value)) {
      if (value.length > 1_000 || Reflect.ownKeys(value).length !== value.length + 1) return fail();
      const items: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail();
        items.push(copy(descriptor.value, depth + 1));
      }
      return Object.freeze(items);
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || key.includes('\u0000') || !wellFormed(key)) return fail();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail();
      result[key] = copy(descriptor.value, depth + 1);
    }
    return Object.freeze(result);
  }
  return copy(input, 0);
}
function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function object(input: unknown, fields: readonly string[], required: readonly string[] = fields): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  const result = input as Record<string, unknown>;
  if (Object.keys(result).some(key => !fields.includes(key)) || required.some(key => !Object.hasOwn(result, key))) return fail();
  return result;
}
function text(value: unknown, maximum = 160): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return fail();
  return value;
}
function revision(value: unknown, zero = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (zero ? 0 : 1) || (value as number) >= Number.MAX_SAFE_INTEGER) return fail();
  return value as number;
}
function hash(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return fail(); return value; }
/** Keep six-digit observations exact when comparing an expiry boundary. */
function instant(value: unknown): { original: string; micros: bigint; date: Date } {
  if (typeof value !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)) return fail('invalid_tax_date');
  try {
    const date = parseInstant(value.replace(/(\.[0-9]{3})[0-9]{1,3}(?=Z|[+-])/, '$1'));
    if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return fail('invalid_tax_date');
    const fraction = /\.([0-9]+)(?=Z|[+-])/.exec(value)?.[1] ?? '';
    return { original: value, date, micros: BigInt(date.getTime()) * BigInt(1_000) + BigInt(fraction.padEnd(6, '0').slice(3)) };
  } catch { return fail('invalid_tax_date'); }
}
function localDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
  return `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}`;
}
function stripeAddress(address: USAddress): StripeTaxCalculationParams['customer_details']['address'] {
  return Object.freeze({ country: 'US', line1: address.line1, ...(address.line2 === undefined ? {} : { line2: address.line2 }), city: address.city, state: address.subdivision, postal_code: address.postalCode });
}

/** Pure private preparation only. No Auth, provider call, SQL mutation, rate,
 * registration verification or issuance grant is created from this input. */
async function prepare(input: unknown): Promise<ResolvedStripeTaxRequest> {
  const value = object(snapshot(input), inputFields);
  const organizationId = text(value.organizationId, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId)) return fail();
  const operationId = text(value.operationId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)) return fail();
  const invoiceId = text(value.invoiceId), actorUserId = text(value.actorUserId, 256), erpIdempotencyKey = text(value.erpIdempotencyKey, 232), commandHash = hash(value.commandHash);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(erpIdempotencyKey)) return fail();
  const expectedErpRevision = revision(value.expectedErpRevision, true), countryRevision = revision(value.countryRevision), sellerRevision = revision(value.sellerRevision), taxFactsRevision = revision(value.taxFactsRevision);
  let configuration: CompanyConfiguration, taxFacts: UsTaxFacts, estimate: Estimate;
  try {
    configuration = validateCompanyConfiguration(value.configuration); taxFacts = validateUsTaxFacts(value.taxFacts);
    estimate = object(value.estimate, ['id', 'organizationId', 'revision', 'currency', 'number', 'customer', 'projectId', 'date', 'expiresAt', 'paymentTermsDays', 'lines', 'notes', 'status'], ['id', 'organizationId', 'revision', 'currency', 'number', 'customer', 'date', 'expiresAt', 'paymentTermsDays', 'lines', 'notes', 'status']) as unknown as Estimate;
    object(estimate.customer, ['id', 'organizationId', 'kind', 'name', 'billingAddress', 'shippingAddress', 'email', 'phone', 'contactName', 'paymentTermsDays'], ['id', 'organizationId', 'kind', 'name', 'billingAddress', 'paymentTermsDays']);
    text(estimate.id); text(estimate.number); text(estimate.customer.id); text(estimate.customer.name);
    if (estimate.projectId !== undefined) text(estimate.projectId);
    if (!['business', 'individual'].includes(estimate.customer.kind) || !Number.isInteger(estimate.customer.paymentTermsDays) || estimate.customer.paymentTermsDays < 0 || estimate.customer.paymentTermsDays > 365) return fail();
    if (configuration.organizationId !== organizationId || estimate.organizationId !== organizationId || estimate.customer.organizationId !== organizationId) return fail('tenant_mismatch', 403);
    if (configuration.country !== 'US' || configuration.currency !== 'USD' || estimate.currency !== 'USD' || estimate.status !== 'accepted') return fail('unsupported_tax_request');
    validateEstimate(configuration, estimate);
    // A resolved declaration must already be canonical, not silently repaired.
    if (canonicalErpJson(taxFacts) !== canonicalErpJson(value.taxFacts)) return fail();
  } catch (error) { if (error instanceof StripeTaxResolvedRequestError) throw error; return fail(); }
  if (estimate.lines.length > 100 || !Array.isArray(value.classifications) || value.classifications.length !== estimate.lines.length) return fail('unsupported_tax_request');
  const bindingValue = object(value.binding, ['organizationId', 'accountId', 'mode', 'apiVersion', 'revision', 'settingsSha256', 'registrationsSha256', 'observedAt', 'validUntil', 'evidenceKind', 'scope']);
  if (bindingValue.organizationId !== organizationId) return fail('tenant_mismatch', 403);
  if (bindingValue.mode !== 'test' || bindingValue.apiVersion !== STRIPE_TAX_API_VERSION || bindingValue.scope !== 'erp_invoice_tax' || !['provider_observation', 'test_fixture'].includes(bindingValue.evidenceKind as string)) return fail('binding_unavailable', 409);
  const accountId = text(bindingValue.accountId, 100);
  if (!/^acct_[A-Za-z0-9]+$/.test(accountId)) return fail();
  const binding = Object.freeze({ ...bindingValue, accountId, revision: revision(bindingValue.revision), settingsSha256: hash(bindingValue.settingsSha256), registrationsSha256: hash(bindingValue.registrationsSha256) }) as unknown as StripeTaxTestBinding;
  const now = instant(value.now), observed = instant(binding.observedAt), until = instant(binding.validUntil), taxDate = instant(value.taxDateInstant);
  if (observed.micros > now.micros || until.micros <= now.micros || until.micros <= observed.micros) return fail('binding_unavailable', 409);
  if (value.taxDatePolicy !== 'caller_supplied_invoice_instant' || typeof value.invoiceDate !== 'string' || !validDate(value.invoiceDate) || taxDate.micros < BigInt(0) || taxDate.micros % second !== BigInt(0) || taxDate.micros - now.micros > windowMicros || now.micros - taxDate.micros > windowMicros || localDate(taxDate.date, taxFacts.timeZone) !== value.invoiceDate) return fail('invalid_tax_date');
  if (value.addressSource !== 'billing' && value.addressSource !== 'shipping') return fail('unsupported_tax_request');
  let destination: USAddress;
  try { destination = validateAddress(value.addressSource === 'billing' ? estimate.customer.billingAddress : estimate.customer.shippingAddress, 'US') as USAddress; }
  catch { return fail('unsupported_tax_request'); }
  const classificationsById = new Map<string, StripeTaxServiceClassification>();
  for (const raw of value.classifications) {
    const c = object(raw, ['lineId', 'taxCode', 'kind', 'taxBehavior', 'revision', 'evidenceReference']);
    const lineId = text(c.lineId), taxCode = text(c.taxCode, 13);
    if (c.kind !== 'service' || c.taxBehavior !== 'exclusive' || !/^txcd_[0-9]{8}$/.test(taxCode)) return fail('unsupported_tax_request');
    if (classificationsById.has(lineId)) return fail();
    classificationsById.set(lineId, Object.freeze({ lineId, taxCode, kind: 'service', taxBehavior: 'exclusive', revision: revision(c.revision), evidenceReference: text(c.evidenceReference, 256) }));
  }
  let netTotal = BigInt(0);
  const classifications: StripeTaxServiceClassification[] = [];
  const lineItems = estimate.lines.map(line => {
    object(line, ['id', 'description', 'quantityUnits', 'quantityScale', 'unitPrice', 'discountBasisPoints', 'taxTreatment']);
    const classification = classificationsById.get(line.id);
    if (!classification || line.taxTreatment !== 'taxable') return fail('unsupported_tax_request');
    if (typeof line.quantityUnits !== 'string' || !/^[1-9][0-9]{0,35}$/.test(line.quantityUnits)) return fail('unsupported_tax_request');
    const numerator = BigInt(line.quantityUnits), divisor = BigInt(10) ** BigInt(line.quantityScale);
    const quantity = numerator / divisor, net = BigInt(lineTotals(line, 'USD').net.minorUnits);
    // SDK22.6 defines a positive amount. Free/fully-discounted lines are outside
    // this first scope; the quantity is used for unit price, never multiplied again.
    if (numerator % divisor !== BigInt(0) || quantity < BigInt(1) || quantity > maxSafe || net < BigInt(1) || net > maxSafe) return fail('unsupported_tax_request');
    netTotal += net; if (netTotal > maxSafe) return fail('unsupported_tax_request');
    classifications.push(classification);
    return Object.freeze({ amount: Number(net), quantity: Number(quantity), reference: line.id, tax_code: classification.taxCode, tax_behavior: 'exclusive' as const });
  });
  const params: StripeTaxCalculationParams = Object.freeze({ currency: 'usd', customer_details: Object.freeze({ address: stripeAddress(destination), address_source: value.addressSource }), tax_date: Number(taxDate.micros / second), line_items: Object.freeze(lineItems), expand: Object.freeze(['line_items.data.tax_breakdown'] as const) });
  // Compile against the installed SDK without sacrificing the readonly public
  // contract: a gateway may copy the two arrays into Stripe's mutable SDK shape.
  const sdkCompatible: Stripe.Tax.CalculationCreateParams = { ...params, line_items: [...params.line_items], expand: [...params.expand] }; void sdkCompatible;
  const paramsBody = canonicalErpJson(params), paramsSha256 = await sha256Hex(paramsBody);
  // The fresh validation clock is not a business parameter. Checking the same
  // immutable request later must not mint another provider idempotency key.
  const payload = Object.freeze({ schemaVersion: 1 as const, organizationId, operationId, invoiceId, actorUserId, erpIdempotencyKey, commandHash, expectedErpRevision, sourceEstimateId: estimate.id, sourceEstimateRevision: revision(estimate.revision), countryRevision, sellerRevision, taxFactsRevision, binding, classifications: Object.freeze(classifications), invoiceDate: value.invoiceDate, taxDateInstant: taxDate.original, taxDatePolicy: 'caller_supplied_invoice_instant' as const, timeZone: taxFacts.timeZone, snapshots: Object.freeze({ configuration, estimate, taxFacts }), params, netTotalMinor: netTotal.toString(), paramsSha256 });
  const resolvedBody = canonicalErpJson(payload), resolvedSha256 = await sha256Hex(resolvedBody);
  const keyHash = await sha256Hex(canonicalErpJson(['zentra:us:stripe-tax:calculation:v1', organizationId, operationId, binding.accountId, binding.mode, resolvedSha256]));
  return Object.freeze({ ...payload, paramsBody, resolvedBody, resolvedSha256, idempotencyKey: `ztax_test_${keyHash}` });
}

export function prepareStripeTaxResolvedRequest(input: StripeTaxResolvedRequestInput): Promise<ResolvedStripeTaxRequest> { return prepare(input); }

/** Validate an untrusted pending-operation RPC projection, including both exact
 * canonical bodies and its whole DTO. This uses a fresh trusted clock; it is not
 * the historical validator for an already issued invoice/receipt. */
export async function validateResolvedStripeTaxRequest(input: unknown, now: string): Promise<ResolvedStripeTaxRequest> {
  const value = object(snapshot(input), ['schemaVersion', 'organizationId', 'operationId', 'invoiceId', 'actorUserId', 'erpIdempotencyKey', 'commandHash', 'expectedErpRevision', 'sourceEstimateId', 'sourceEstimateRevision', 'countryRevision', 'sellerRevision', 'taxFactsRevision', 'binding', 'classifications', 'invoiceDate', 'taxDateInstant', 'taxDatePolicy', 'timeZone', 'snapshots', 'params', 'netTotalMinor', 'paramsSha256', 'paramsBody', 'resolvedBody', 'resolvedSha256', 'idempotencyKey']);
  const stored = object(value.snapshots, ['configuration', 'estimate', 'taxFacts']);
  const params = object(value.params, ['currency', 'customer_details', 'tax_date', 'line_items', 'expand']);
  const customer = object(params.customer_details, ['address', 'address_source']);
  const rebuilt = await prepare({ organizationId: value.organizationId, operationId: value.operationId, invoiceId: value.invoiceId, actorUserId: value.actorUserId, erpIdempotencyKey: value.erpIdempotencyKey, commandHash: value.commandHash, expectedErpRevision: value.expectedErpRevision, countryRevision: value.countryRevision, sellerRevision: value.sellerRevision, taxFactsRevision: value.taxFactsRevision, configuration: stored.configuration, estimate: stored.estimate, taxFacts: stored.taxFacts, binding: value.binding, classifications: value.classifications, invoiceDate: value.invoiceDate, taxDateInstant: value.taxDateInstant, taxDatePolicy: value.taxDatePolicy, addressSource: customer.address_source, now });
  if (canonicalErpJson(rebuilt) !== canonicalErpJson(value)) return fail();
  return rebuilt;
}
