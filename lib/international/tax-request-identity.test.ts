import { describe, expect, it } from 'vitest';
import { buildTaxRequest, type Estimate } from './invoicing';
import { canonicalErpJson } from './erp-contract';
import type { CompanyConfiguration } from './types';

const us = { schemaVersion: 1, organizationId: 'synthetic-us-identity', country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', address: { country: 'US', line1: '1 Example Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, taxConfiguration: { status: 'unconfigured' } } satisfies CompanyConfiguration;
const ch = { ...us, organizationId: 'synthetic-ch-identity', country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich', invoiceNumberPrefix: 'FAC', address: { country: 'CH', line1: '1 Rue Exemple', city: 'Genève', subdivision: 'GE', postalCode: '1201' } } satisfies CompanyConfiguration;
function estimate(config: CompanyConfiguration): Estimate {
  return { id: 'estimate', organizationId: config.organizationId, revision: 2, currency: config.currency, number: 'EST-000001', customer: { id: 'customer', organizationId: config.organizationId, kind: 'business', name: 'Fictitious identity customer', billingAddress: { ...config.address }, shippingAddress: { ...config.address, line1: '2 Example Street' }, paymentTermsDays: 30 }, date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: 30, status: 'accepted', lines: [{ id: 'service', description: 'Fictitious service', quantityUnits: '2', quantityScale: 0, unitPrice: { currency: config.currency, minorUnits: '1500' }, discountBasisPoints: 500, taxTreatment: 'taxable' }], notes: 'Synthetic data only' };
}
function reverseObjects<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseObjects) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjects(child)])) as T;
  return value;
}
const fingerprint = (config: CompanyConfiguration, doc: Estimate) => buildTaxRequest(config, doc, '2026-10-09').fingerprint;

describe('national tax request identity and durable US order independence', () => {
  it('keeps US identity across independent object insertion orders and canonical durable JSON', () => {
    const doc = estimate(us), expected = fingerprint(us, doc);
    expect(fingerprint(reverseObjects(us), doc)).toBe(expected);
    expect(fingerprint(us, reverseObjects(doc))).toBe(expected);
    expect(fingerprint(reverseObjects(us), reverseObjects(doc))).toBe(expected);
    expect(fingerprint(JSON.parse(canonicalErpJson(us)), JSON.parse(canonicalErpJson(doc)))).toBe(expected);
    expect(fingerprint(JSON.parse(JSON.stringify(us)), JSON.parse(JSON.stringify(doc)))).toBe(expected);
  });
  it('retains the previous CH assessment bytes and does not silently canonicalize historical identities', () => {
    const doc = estimate(ch), request = buildTaxRequest(ch, doc, '2026-10-09');
    const old = JSON.stringify([ch.organizationId, ch.country, ch.currency, ch.address, doc.id, doc.revision, '2026-10-09', doc.customer.billingAddress, doc.customer.shippingAddress ?? null, [{ id: 'service', netMinor: '2850', taxTreatment: 'taxable' }]]);
    expect(request.fingerprint).toBe(old);
    expect(fingerprint(ch, reverseObjects(doc))).not.toBe(old);
    expect(request).toMatchObject({ country: 'CH', currency: 'CHF' });
  });
  it.each([
    ['revision', (doc: Estimate) => ({ ...doc, revision: 3 })],
    ['customer billing location', (doc: Estimate) => ({ ...doc, customer: { ...doc.customer, billingAddress: { ...doc.customer.billingAddress, line1: '3 Example Street' } } })],
    ['customer shipping location', (doc: Estimate) => ({ ...doc, customer: { ...doc.customer, shippingAddress: { ...us.address, line1: '4 Example Street' } } })],
    ['net unit price', (doc: Estimate) => ({ ...doc, lines: [{ ...doc.lines[0], unitPrice: { currency: 'USD' as const, minorUnits: '1501' } }] })],
    ['quantity', (doc: Estimate) => ({ ...doc, lines: [{ ...doc.lines[0], quantityUnits: '3' }] })],
    ['discount affecting rounded net', (doc: Estimate) => ({ ...doc, lines: [{ ...doc.lines[0], discountBasisPoints: 510 }] })],
    ['tax treatment', (doc: Estimate) => ({ ...doc, lines: [{ ...doc.lines[0], taxTreatment: 'exempt' as const }] })],
    ['line identity', (doc: Estimate) => ({ ...doc, lines: [{ ...doc.lines[0], id: 'different-service' }] })],
  ] as const)('still invalidates US proof after an actual change to %s', (_label, change) => {
    const doc = estimate(us);
    expect(fingerprint(us, change(doc))).not.toBe(fingerprint(us, doc));
  });
  it('distinguishes transaction date, origin address, tenant and line order', () => {
    const doc = estimate(us), original = fingerprint(us, doc);
    expect(buildTaxRequest(us, doc, '2026-10-10').fingerprint).not.toBe(original);
    expect(fingerprint({ ...us, address: { ...us.address, line1: '5 Example Street' } }, doc)).not.toBe(original);
    const other = { ...us, organizationId: 'another-synthetic-us-identity' }, otherDoc = { ...doc, organizationId: other.organizationId, customer: { ...doc.customer, organizationId: other.organizationId } };
    expect(fingerprint(other, otherDoc)).not.toBe(original);
    const two = { ...doc, lines: [...doc.lines, { ...doc.lines[0], id: 'second-service' }] };
    expect(fingerprint(us, { ...two, lines: [...two.lines].reverse() })).not.toBe(fingerprint(us, two));
  });
  it('does not translate notes or customer data while deriving a tax identity', () => {
    const doc = estimate(us), before = JSON.stringify(doc), request = buildTaxRequest(us, doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(request.customer).toBe(doc.customer);
    expect(fingerprint(us, { ...doc, notes: 'Note changée\nwithout a tax revision' })).toBe(fingerprint(us, doc));
  });
});
