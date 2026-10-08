import { sha256Hex } from '../account-security';
import { canonicalErpJson } from './erp-contract';
import { buildTaxRequest, validateTaxAssessment, type TaxAssessment } from './invoicing';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { validateResolvedStripeTaxRequest, type ResolvedStripeTaxRequest } from './stripe-tax-resolved-request';

export type StripeTaxReason = 'standard_rated' | 'zero_rated' | 'product_exempt' | 'not_subject_to_tax';
export interface StripeTaxPrivateProof {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly operationId: string;
  readonly provider: 'stripe_tax';
  readonly accountId: string;
  readonly mode: 'test';
  readonly apiVersion: string;
  readonly bindingRevision: number;
  readonly resolvedSha256: string;
  readonly paramsSha256: string;
  readonly settingsSha256: string;
  readonly registrationsSha256: string;
  readonly evidenceKind: 'provider_observation' | 'test_fixture';
  readonly calculationId: string;
  readonly calculatedAt: string;
  readonly expiresAt: string;
  readonly taxDate: number;
  readonly currency: 'USD';
  readonly netMinor: string;
  readonly taxMinor: string;
  readonly totalMinor: string;
  readonly lines: readonly Readonly<{
    lineId: string; providerLineId: string; netMinor: string; quantity: string;
    taxCode: string; taxMinor: string;
    breakdowns: readonly Readonly<{
      amountMinor: string; taxableMinor: string; taxabilityReason: StripeTaxReason;
      sourcing: 'origin' | 'destination';
      jurisdiction: Readonly<{ country: 'US'; state?: string; level: string; displayName: string }>;
    }>[];
  }>[];
}
/** Server transport supplies the scoped account observation, never the browser.
 * A matching envelope is not authentication: its upstream must verify credential
 * identity, TEST mode, settings, registrations and revision before calling Stripe. */
export interface StripeTaxCalculationObservation {
  readonly accountId: string;
  readonly mode: 'test';
  readonly apiVersion: string;
  readonly evidenceKind: 'provider_observation' | 'test_fixture';
  readonly observedAt: string;
  readonly calculation: unknown;
}
export interface ValidatedStripeTaxCalculation {
  readonly proof: StripeTaxPrivateProof;
  readonly proofBody: string;
  readonly proofSha256: string;
  readonly assessment: TaxAssessment;
}
export class StripeTaxCalculationError extends Error {
  constructor(readonly code: 'invalid_tax_calculation' | 'tax_calculation_expired' | 'tax_binding_changed' | 'unsupported_tax_calculation', readonly status = 409) {
    super(code); this.name = 'StripeTaxCalculationError';
  }
}
function fail(code: StripeTaxCalculationError['code'] = 'invalid_tax_calculation'): never { throw new StripeTaxCalculationError(code); }
/** Bounded, own-data-only snapshot before awaits. Unknown SDK fields can evolve,
 * but are never persisted or projected to a public invoice. No getters/toJSON. */
function copy(input: unknown): unknown {
  try { return snapshotPrivateJson(input); } catch { return fail(); }
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(); return value as Record<string, unknown>; }
function text(value: unknown, limit = 160): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > limit || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return fail(); return value;
}
function integer(value: unknown): bigint { if (!Number.isSafeInteger(value) || (value as number) < 0) return fail(); return BigInt(value as number); }
function instant(value: unknown): { value: string; micros: bigint } {
  try {
    const v = text(value, 40);
    if (!/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(v)) return fail();
    const date = parseInstant(v.replace(/(\.[0-9]{3})[0-9]{1,3}(?=Z|[+-])/, '$1'));
    const fraction = /\.([0-9]+)(?=Z|[+-])/.exec(v)?.[1] ?? '';
    return { value: v, micros: BigInt(date.getTime()) * BigInt(1_000) + BigInt(fraction.padEnd(6, '0').slice(3)) };
  } catch { return fail(); }
}
function unixIso(value: unknown): string {
  const seconds = integer(value); if (seconds > BigInt(253_402_300_799)) return fail();
  return new Date(Number(seconds) * 1_000).toISOString();
}
const reasons: readonly string[] = ['standard_rated', 'zero_rated', 'product_exempt', 'not_subject_to_tax'];
function reason(value: unknown, amount: bigint): StripeTaxReason {
  if (!reasons.includes(value as string)) return fail('unsupported_tax_calculation');
  if (value !== 'standard_rated' && amount !== BigInt(0)) return fail();
  return value as StripeTaxReason;
}
function exact(value: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const v = object(value);
  if (Object.keys(v).some(key => !fields.includes(key)) || fields.some(key => !optional.includes(key) && !Object.hasOwn(v, key))) return fail();
  return v;
}
function minor(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) return fail();
  return BigInt(value);
}
function assessmentFromProof(resolved: ResolvedStripeTaxRequest, proof: StripeTaxPrivateProof, now: string): TaxAssessment {
  const expiry = instant(proof.expiresAt), until = instant(resolved.binding.validUntil);
  const clock = instant(now), effectiveExpiry = expiry.micros <= until.micros ? expiry.micros : until.micros;
  // The established public invoice contract accepts millisecond ISO instants.
  // Keep exact microseconds in private evidence, round public expiry down and
  // reject its last sub-millisecond window rather than extending validity.
  const publicInstant = (micros: bigint) => new Date(Number(micros / BigInt(1_000))).toISOString();
  if (effectiveExpiry / BigInt(1_000) <= clock.micros / BigInt(1_000)) return fail('tax_calculation_expired');
  const request = buildTaxRequest(resolved.snapshots.configuration, resolved.snapshots.estimate, resolved.invoiceDate);
  const assessment: TaxAssessment = Object.freeze({
    organizationId: resolved.organizationId, country: 'US', currency: 'USD', documentId: request.documentId, documentRevision: request.documentRevision, fingerprint: request.fingerprint,
    source: 'external-provider', providerReference: proof.calculationId, determinedAt: publicInstant(instant(proof.calculatedAt).micros),
    validUntil: publicInstant(effectiveExpiry),
    lines: Object.freeze(proof.lines.map(line => Object.freeze({ id: line.lineId, taxMinor: line.taxMinor, jurisdiction: text([...new Set(line.breakdowns.map(b => `US${b.jurisdiction.state ? `-${b.jurisdiction.state}` : ''}`))].join('; ')), evidenceReference: `${proof.calculationId}:${line.providerLineId}` }))),
  });
  validateTaxAssessment(request, assessment, publicInstant(clock.micros)); return assessment;
}
/** Revalidate a pending calculated operation read from private storage. Exact
 * canonical bodies are not signatures and do not prove Stripe authentication.
 * Upstream Auth/D1, version fences and the transactional SQL link remain required.
 * Historical completed receipts must use the ERP receipt path, not this freshness
 * validator. No expired calculation may be retried under a fresh provider key. */
export async function validateStoredStripeTaxCalculation(resolvedInput: ResolvedStripeTaxRequest, input: unknown, now: string): Promise<ValidatedStripeTaxCalculation> {
  const savedResolved = copy(resolvedInput), value = exact(copy(input), ['proofBody', 'proofSha256', 'assessment']);
  if (typeof value.proofBody !== 'string' || value.proofBody.length > 524_288 || typeof value.proofSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.proofSha256)) return fail();
  let raw: unknown; try { raw = JSON.parse(value.proofBody); } catch { return fail(); }
  const p = exact(copy(raw), ['schemaVersion', 'organizationId', 'operationId', 'provider', 'accountId', 'mode', 'apiVersion', 'bindingRevision', 'resolvedSha256', 'paramsSha256', 'settingsSha256', 'registrationsSha256', 'evidenceKind', 'calculationId', 'calculatedAt', 'expiresAt', 'taxDate', 'currency', 'netMinor', 'taxMinor', 'totalMinor', 'lines']);
  const resolved = await validateResolvedStripeTaxRequest(savedResolved, now), b = resolved.binding;
  const expected = { schemaVersion: 1, organizationId: resolved.organizationId, operationId: resolved.operationId, provider: 'stripe_tax', accountId: b.accountId, mode: 'test', apiVersion: b.apiVersion, bindingRevision: b.revision, resolvedSha256: resolved.resolvedSha256, paramsSha256: resolved.paramsSha256, settingsSha256: b.settingsSha256, registrationsSha256: b.registrationsSha256, evidenceKind: b.evidenceKind, taxDate: resolved.params.tax_date, currency: 'USD', netMinor: resolved.netTotalMinor };
  for (const [key, expectedValue] of Object.entries(expected)) if (p[key] !== expectedValue) return fail('tax_binding_changed');
  if (!/^taxcalc_[A-Za-z0-9]+$/.test(text(p.calculationId, 100))) return fail();
  const clock = instant(now), calculated = instant(p.calculatedAt), expiry = instant(p.expiresAt);
  if (calculated.micros > clock.micros || calculated.micros < instant(b.observedAt).micros) return fail();
  if (expiry.micros <= clock.micros || expiry.micros <= calculated.micros) return fail('tax_calculation_expired');
  if (!Array.isArray(p.lines) || p.lines.length !== resolved.params.line_items.length) return fail();
  let totalTax = BigInt(0); const providerIds = new Set<string>();
  for (const [index, rawLine] of p.lines.entries()) {
    const line = exact(rawLine, ['lineId', 'providerLineId', 'netMinor', 'quantity', 'taxCode', 'taxMinor', 'breakdowns']), planned = resolved.params.line_items[index];
    if (line.lineId !== planned.reference || line.netMinor !== String(planned.amount) || line.quantity !== String(planned.quantity) || line.taxCode !== planned.tax_code || !/^tax_li_[A-Za-z0-9]+$/.test(text(line.providerLineId, 100)) || providerIds.has(line.providerLineId as string)) return fail();
    providerIds.add(line.providerLineId as string);
    const net = minor(line.netMinor), tax = minor(line.taxMinor); let sum = BigInt(0);
    if (!Array.isArray(line.breakdowns) || !line.breakdowns.length || line.breakdowns.length > 100) return fail();
    const jurisdictions = new Set<string>();
    for (const rawBreakdown of line.breakdowns) {
      const d = exact(rawBreakdown, ['amountMinor', 'taxableMinor', 'taxabilityReason', 'sourcing', 'jurisdiction']), amount = minor(d.amountMinor);
      reason(d.taxabilityReason, amount);
      if (minor(d.taxableMinor) > net || !['origin', 'destination'].includes(d.sourcing as string)) return fail();
      const j = exact(d.jurisdiction, ['country', 'state', 'level', 'displayName'], ['state']);
      if (j.country !== 'US' || !['country', 'state', 'county', 'city', 'district'].includes(text(j.level, 20)) || (j.state !== undefined && !/^[A-Z]{2}$/.test(text(j.state, 2))) || (j.level !== 'country' && j.state === undefined)) return fail();
      text(j.displayName, 100); const key = canonicalErpJson(j); if (jurisdictions.has(key)) return fail(); jurisdictions.add(key); sum += amount;
    }
    if (sum !== tax) return fail(); totalTax += tax;
  }
  if (minor(p.taxMinor) !== totalTax || minor(p.totalMinor) !== minor(p.netMinor) + totalTax || canonicalErpJson(p) !== value.proofBody || await sha256Hex(value.proofBody) !== value.proofSha256) return fail();
  const proof = p as unknown as StripeTaxPrivateProof, assessment = assessmentFromProof(resolved, proof, now);
  if (canonicalErpJson(value.assessment) !== canonicalErpJson(assessment)) return fail();
  return Object.freeze({ proof, proofBody: value.proofBody, proofSha256: value.proofSha256, assessment });
}
/** Strict TEST calculation normalization. The first supported scope is taxable,
 * tax-exclusive services, integer quantities, no shipping or customer override.
 * Missing/unknown reasoning is blocked, not guessed into a zero rate.
 * Known mixed jurisdiction reasons are preserved, never collapsed to one reason.
 * SDK contract: stripe@22.6.0 esm/resources/Tax/Calculations and CalculationLineItems. */
export async function validateStripeTaxCalculation(input: ResolvedStripeTaxRequest, observation: StripeTaxCalculationObservation, now: string): Promise<ValidatedStripeTaxCalculation> {
  // Both caller-owned objects are copied before the first hash await.
  const saved = copy(input), observed = object(copy(observation));
  if (Object.keys(observed).sort().join(',') !== ['accountId', 'apiVersion', 'calculation', 'evidenceKind', 'mode', 'observedAt'].sort().join(',')) return fail();
  const resolved = await validateResolvedStripeTaxRequest(saved, now);
  const binding = resolved.binding;
  if (observed.accountId !== binding.accountId || observed.mode !== 'test' || observed.apiVersion !== binding.apiVersion || observed.evidenceKind !== binding.evidenceKind) return fail('tax_binding_changed');
  const clock = instant(now), received = instant(observed.observedAt);
  if (received.micros > clock.micros || received.micros < instant(binding.observedAt).micros) return fail();
  const c = object(observed.calculation);
  const calculationId = text(c.id, 100);
  if (!/^taxcalc_[A-Za-z0-9]+$/.test(calculationId) || c.object !== 'tax.calculation' || c.livemode !== false || c.currency !== 'usd' || c.tax_date !== resolved.params.tax_date) return fail();
  if (c.customer !== null || c.shipping_cost !== null || c.ship_from_details !== null || integer(c.tax_amount_inclusive) !== BigInt(0)) return fail('unsupported_tax_calculation');
  const details = object(c.customer_details), address = object(details.address), expected = resolved.params.customer_details;
  if (details.address_source !== expected.address_source || details.ip_address !== null || details.taxability_override !== 'none' || !Array.isArray(details.tax_ids) || details.tax_ids.length) return fail('unsupported_tax_calculation');
  for (const key of ['country', 'line1', 'city', 'state', 'postal_code'] as const) if (address[key] !== expected.address[key]) return fail();
  if ((address.line2 ?? undefined) !== expected.address.line2) return fail();
  const expiresAt = unixIso(c.expires_at), expiry = instant(expiresAt);
  if (expiry.micros <= clock.micros || expiry.micros <= received.micros) return fail('tax_calculation_expired');
  const list = object(c.line_items);
  if (list.object !== 'list' || list.has_more !== false || !Array.isArray(list.data) || list.data.length !== resolved.params.line_items.length) return fail();
  const byReference = new Map(resolved.params.line_items.map(line => [line.reference, line]));
  const seenReferences = new Set<string>(), seenIds = new Set<string>();
  let netSum = BigInt(0), taxSum = BigInt(0);
  const proofLines: StripeTaxPrivateProof['lines'][number][] = [];
  for (const raw of list.data) {
    const line = object(raw), reference = text(line.reference), providerLineId = text(line.id, 100), expectedLine = byReference.get(reference);
    if (!expectedLine || seenReferences.has(reference) || seenIds.has(providerLineId) || !/^tax_li_[A-Za-z0-9]+$/.test(providerLineId) || line.object !== 'tax.calculation_line_item' || line.livemode !== false) return fail();
    seenReferences.add(reference); seenIds.add(providerLineId);
    const net = integer(line.amount), tax = integer(line.amount_tax), quantity = integer(line.quantity);
    if (net !== BigInt(expectedLine.amount) || quantity !== BigInt(expectedLine.quantity) || line.tax_code !== expectedLine.tax_code || line.tax_behavior !== 'exclusive' || line.product !== null) return fail();
    if (!Array.isArray(line.tax_breakdown) || !line.tax_breakdown.length || line.tax_breakdown.length > 100) return fail('unsupported_tax_calculation');
    let breakdownSum = BigInt(0);
    const breakdowns: StripeTaxPrivateProof['lines'][number]['breakdowns'][number][] = [];
    const jurisdictionKeys = new Set<string>();
    for (const rawBreakdown of line.tax_breakdown) {
      const breakdown = object(rawBreakdown), amount = integer(breakdown.amount), taxable = integer(breakdown.taxable_amount);
      const taxabilityReason = reason(breakdown.taxability_reason, amount);
      if (taxable > net || !['origin', 'destination'].includes(breakdown.sourcing as string)) return fail();
      const j = object(breakdown.jurisdiction), level = text(j.level, 20), displayName = text(j.display_name, 100);
      if (j.country !== 'US' || !['country', 'state', 'county', 'city', 'district'].includes(level) || (j.state !== null && (typeof j.state !== 'string' || !/^[A-Z]{2}$/.test(j.state)))) return fail('unsupported_tax_calculation');
      if (level !== 'country' && j.state === null) return fail();
      const jurisdiction = Object.freeze({ country: 'US' as const, ...(j.state === null ? {} : { state: j.state as string }), level, displayName });
      const key = canonicalErpJson(jurisdiction);
      if (jurisdictionKeys.has(key)) return fail(); jurisdictionKeys.add(key);
      if (breakdown.tax_rate_details === null) { if (amount !== BigInt(0) || breakdown.taxability_reason === 'standard_rated') return fail(); }
      else {
        const rate = object(breakdown.tax_rate_details);
        if (rate.tax_type !== 'sales_tax') return fail('unsupported_tax_calculation');
        text(rate.display_name, 160);
        // We validate provider syntax, never recompute tax from a local rate.
        if (typeof rate.percentage_decimal !== 'string' || !/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,12})?$/.test(rate.percentage_decimal)) return fail();
      }
      breakdowns.push(Object.freeze({ amountMinor: amount.toString(), taxableMinor: taxable.toString(), taxabilityReason, sourcing: breakdown.sourcing as 'origin' | 'destination', jurisdiction }));
      breakdownSum += amount;
    }
    if (breakdownSum !== tax) return fail();
    proofLines.push(Object.freeze({ lineId: reference, providerLineId, netMinor: net.toString(), quantity: quantity.toString(), taxCode: expectedLine.tax_code, taxMinor: tax.toString(), breakdowns: Object.freeze(breakdowns) }));
    netSum += net; taxSum += tax;
  }
  if (!Array.isArray(c.tax_breakdown) || !c.tax_breakdown.length || c.tax_breakdown.length > 1_000) return fail('unsupported_tax_calculation');
  let topTax = BigInt(0);
  for (const raw of c.tax_breakdown) {
    const b = object(raw), amount = integer(b.amount);
    const taxabilityReason = reason(b.taxability_reason, amount);
    if (b.inclusive !== false || integer(b.taxable_amount) > netSum) return fail();
    const rate = object(b.tax_rate_details);
    if (rate.country !== 'US' || (rate.state !== null && (typeof rate.state !== 'string' || !/^[A-Z]{2}$/.test(rate.state))) ||
        (rate.tax_type !== 'sales_tax' && !(rate.tax_type === null && amount === BigInt(0) && taxabilityReason !== 'standard_rated')) ||
        (rate.rate_type != null && rate.rate_type !== 'percentage') || rate.flat_amount != null) return fail('unsupported_tax_calculation');
    if (typeof rate.percentage_decimal !== 'string' || !/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,12})?$/.test(rate.percentage_decimal)) return fail();
    topTax += amount;
  }
  const total = integer(c.amount_total);
  if (netSum.toString() !== resolved.netTotalMinor || taxSum !== integer(c.tax_amount_exclusive) || topTax !== taxSum || total !== netSum + taxSum || total > BigInt(Number.MAX_SAFE_INTEGER)) return fail();
  const ordered = resolved.params.line_items.map(item => proofLines.find(line => line.lineId === item.reference)!);
  const proof: StripeTaxPrivateProof = Object.freeze({
    schemaVersion: 1, organizationId: resolved.organizationId, operationId: resolved.operationId, provider: 'stripe_tax',
    accountId: binding.accountId, mode: 'test', apiVersion: binding.apiVersion, bindingRevision: binding.revision,
    resolvedSha256: resolved.resolvedSha256, paramsSha256: resolved.paramsSha256, settingsSha256: binding.settingsSha256, registrationsSha256: binding.registrationsSha256,
    evidenceKind: binding.evidenceKind, calculationId, calculatedAt: received.value, expiresAt, taxDate: resolved.params.tax_date,
    currency: 'USD', netMinor: netSum.toString(), taxMinor: taxSum.toString(), totalMinor: total.toString(), lines: Object.freeze(ordered),
  });
  // Public assessment has the existing eleven fields only. No account, binding,
  // private tax origin/declaration or raw Stripe response crosses this boundary.
  // The existing fingerprint still includes public invoice/customer addresses.
  const assessment = assessmentFromProof(resolved, proof, now);
  const proofBody = canonicalErpJson(proof);
  return Object.freeze({ proof, proofBody, proofSha256: await sha256Hex(proofBody), assessment });
}
