import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FinancialAuthority } from './accounting/ledger';
import { nationalAdapter } from './countries/adapters';
import { validateCompanyConfiguration } from './country-config';
import { buildPrintableDocument, renderPrintableDocumentHtml } from './documents';
import { canonicalErpJson, ErpError } from './erp-contract';
import { buildTaxRequest, invoiceFromEstimate, lineTotals, recordCustomerPayment, reconstructHistoricalInvoiceFromEstimate, validateHistoricalTaxAssessment, validateTaxAssessment, type IssuedInvoice, type TaxAssessment } from './invoicing';
import { publicErpDelta, publicErpState } from './public-projection';
import { executeErp } from './runtime';
import { applyErpDelta, type ErpDelta } from './runtime-sync';
import { validateStoredErp } from './runtime-validation';
import type { ErpCommand, ErpCommit, ErpReceipt, ErpState, ErpStore } from './runtime-types';
import { validateStoredStripeTaxCalculation, type StripeTaxPrivateProof } from './stripe-tax-calculation';
import { prepareStripeTaxResolvedRequest, STRIPE_TAX_API_VERSION } from './stripe-tax-resolved-request';

const org = 'fictitious-us-history', timestamp = '2026-10-08T12:00:00.000Z';
const configuration = validateCompanyConfiguration({ schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Public Road', city: 'New York', postalCode: '10001', subdivision: 'NY' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' } });
const actor: FinancialAuthority = { organizationId: org, userId: 'fictitious-owner', role: 'owner', managementEntitled: true, timestamp };
const seller = { organizationId: org, displayName: 'Fictitious historical seller', contactEmail: 'history@example.invalid' };
const digest = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
class MemoryStore implements ErpStore {
  state: ErpState | null = null;
  readonly receipts = new Map<string, ErpReceipt>();
  commits: ErpCommit[] = [];
  async read(organizationId: string) { if (organizationId !== org) throw new ErpError('tenant_mismatch', 403); return this.state === null ? null : validateStoredErp(this.state, org); }
  async receipt(organizationId: string, key: string) { if (organizationId !== org) throw new ErpError('tenant_mismatch', 403); return this.receipts.get(key) ?? null; }
  async commit(input: ErpCommit) {
    if ((this.state?.revision ?? 0) !== input.expectedRevision) throw new ErpError('revision_conflict', 409);
    const before = this.state;
    let customers = before?.customers ?? [], estimates = before?.estimates ?? [], invoices = before?.invoices ?? [], entries = before?.ledger.entries ?? [];
    for (const change of input.changes) {
      const upsert = (rows: readonly { id: string }[]) => [...rows.filter(row => row.id !== change.id), change.payload];
      if (change.kind === 'customer') customers = upsert(customers) as typeof customers;
      if (change.kind === 'estimate') estimates = upsert(estimates) as typeof estimates;
      if (change.kind === 'invoice') invoices = upsert(invoices) as typeof invoices;
      if (change.kind === 'journal') entries = [...entries, change.payload] as typeof entries;
    }
    this.state = { ...input.header, customers, estimates, invoices, ledger: { ...input.header.ledger, entries, audit: [...(before?.ledger.audit ?? []), ...input.ledgerAudit] } };
    this.commits.push(input); this.receipts.set(input.receipt.idempotencyKey, input.receipt); return input.receipt;
  }
}
// A real engine generates the document, totals, journal and receipts. Only its
// assessment fingerprint is seeded with the exact former US JSON.stringify
// representation, simulating already committed TEST history before canonical US
// serialization. This RAM fixture proves compatibility, not SQL/provider/Auth.
async function history() {
  const store = new MemoryStore(); let sequence = 0;
  const dependencies = { store, configuration, actor, revalidate: async () => actor, seller: async () => seller,
    taxProvider: async () => ({ id: 'explicit-fictitious-history-provider', calculate: async (request: ReturnType<typeof buildTaxRequest>): Promise<TaxAssessment> => ({
      organizationId: org, country: 'US', currency: 'USD', documentId: request.documentId, documentRevision: request.documentRevision, fingerprint: request.fingerprint,
      source: 'external-provider', providerReference: 'taxcalc_FictitiousHistory', determinedAt: timestamp, validUntil: '2026-10-08T13:00:00.000Z',
      lines: [{ id: 'line', taxMinor: '160', jurisdiction: 'US-NY', evidenceReference: 'taxcalc_FictitiousHistory:tax_li_FictitiousHistory' }],
    }) }) };
  const send = (command: ErpCommand) => executeErp(dependencies, { idempotencyKey: 'history-' + ++sequence, expectedRevision: store.state?.revision ?? 0, command });
  await send({ type: 'initialize', periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
  await send({ type: 'save_customer', customer: { id: 'customer', organizationId: org, kind: 'business', name: 'Fictitious customer', billingAddress: { country: 'US', subdivision: 'NY', city: 'New York', postalCode: '10001', line1: '2 Fictitious Customer Road' }, paymentTermsDays: 30 } });
  await send({ type: 'save_estimate', id: 'estimate', expectedEstimateRevision: 0, customerId: 'customer', date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: 30, lines: [{ id: 'line', description: 'Fictitious historical service', quantityUnits: '2', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: '1000' }, discountBasisPoints: 0, taxTreatment: 'taxable' }], notes: 'Fictitious TEST history only' });
  await send({ type: 'accept_estimate', estimateId: 'estimate', expectedEstimateRevision: 1 });
  await send({ type: 'issue_invoice', id: 'invoice', estimateId: 'estimate', expectedEstimateRevision: 2, date: '2026-10-08', accountingDate: '2026-10-08', dueDate: '2026-11-08', periodId: '2026' });
  const before = store.state!, estimate = before.estimates[0], invoice = before.invoices[0];
  const legacy = JSON.stringify([configuration.organizationId, configuration.country, configuration.currency, configuration.address, estimate.id, estimate.revision, invoice.date, estimate.customer.billingAddress, estimate.customer.shippingAddress ?? null, estimate.lines.map(line => ({ id: line.id, netMinor: lineTotals(line, estimate.currency).net.minorUnits, taxTreatment: line.taxTreatment }))]);
  expect(legacy).not.toBe(invoice.taxAssessment.fingerprint); expect(legacy.length).toBe(invoice.taxAssessment.fingerprint.length);
  const historicalInvoice = { ...invoice, taxAssessment: { ...invoice.taxAssessment, fingerprint: legacy } };
  store.state = { ...before, invoices: [historicalInvoice] };
  store.commits = store.commits.map(commit => ({ ...commit, changes: commit.changes.map(change => change.kind === 'invoice' ? { ...change, payload: historicalInvoice } : change) }));
  const request = buildTaxRequest(configuration, estimate, invoice.date);
  const delta = (): ErpDelta => ({ schemaVersion: 1, organizationId: org, fromRevision: 0, toRevision: store.state!.revision, headRevision: store.state!.revision, hasMore: false, resetRequired: false,
    events: store.commits.map(commit => ({ schemaVersion: 1, organizationId: org, revision: commit.header.revision, header: commit.header, changes: commit.changes, ledgerAudit: commit.ledgerAudit, receipt: commit.receipt, actorId: commit.actor.userId, occurredAt: commit.actor.timestamp })) });
  const reconstructionInput = { id: invoice.id, number: invoice.number, date: invoice.date, accountingDate: invoice.accountingDate, dueDate: invoice.dueDate };
  return { store, send, estimate, invoice: historicalInvoice, legacy, request, delta, reconstructionInput, issuanceActor: { organizationId: org, userId: actor.userId, canIssue: true, managementEntitled: true, timestamp } };
}
function withFingerprint(invoice: IssuedInvoice, fingerprint: string): IssuedInvoice { return { ...invoice, taxAssessment: { ...invoice.taxAssessment, fingerprint } }; }

describe('read-only US assessment fingerprint history compatibility', () => {
  it('validates the real engine book without rewriting original assessment bytes, money, journal or receipt', async () => {
    const t = await history(), before = JSON.stringify(t.store.state), commits = JSON.stringify(t.store.commits);
    expect(validateStoredErp(t.store.state, org)).toBe(t.store.state); expect(await t.store.read(org)).toBe(t.store.state);
    expect(JSON.stringify(t.store.state)).toBe(before); expect(JSON.stringify(t.store.commits)).toBe(commits);
    expect(t.store.state!.invoices[0].taxAssessment.fingerprint).toBe(t.legacy); expect(t.store.state!.ledger.entries).toHaveLength(1);
    expect(t.store.state!.invoices[0].total.minorUnits).toBe('2160'); expect(t.store.state!.counters.invoice).toBe(1);
  });
  it('reconstructs after JSONB-like property reordering while preserving the old fingerprint exactly', async () => {
    const t = await history(), reordered = JSON.parse(canonicalErpJson(t.store.state)) as ErpState;
    expect(validateStoredErp(reordered, org)).toBe(reordered); expect(reordered.invoices[0].taxAssessment.fingerprint).toBe(t.legacy);
    const rebuilt = reconstructHistoricalInvoiceFromEstimate(configuration, t.estimate, t.reconstructionInput, t.invoice.taxAssessment, t.issuanceActor, seller);
    expect(canonicalErpJson(rebuilt)).toBe(canonicalErpJson(t.invoice)); expect(rebuilt.taxAssessment.fingerprint).toBe(t.legacy);
  });
  it('applies historical state/delta and public projections without rewriting old evidence', async () => {
    const t = await history(), applied = applyErpDelta(null, t.delta(), org)!;
    expect(canonicalErpJson(applied)).toBe(canonicalErpJson(t.store.state));
    expect(publicErpState(applied).invoices[0].taxAssessment.fingerprint).toBe(t.legacy);
    expect(applyErpDelta(null, publicErpDelta(t.delta()), org)!.invoices[0].taxAssessment.fingerprint).toBe(t.legacy);
  });
  it('records a new real-engine partial payment through historical store validation and retains original invoice proof', async () => {
    const t = await history(), originalProof = JSON.stringify(t.invoice.taxAssessment);
    await t.send({ type: 'record_payment', id: 'payment', invoiceId: 'invoice', amountMinor: '500', paymentDate: '2026-10-09', accountingDate: '2026-10-09', periodId: '2026', reference: 'Fictitious partial historical payment' });
    const state = validateStoredErp(t.store.state, org);
    expect(state.invoices[0].payments).toHaveLength(1); expect(state.ledger.entries).toHaveLength(2); expect(state.counters.invoice).toBe(1);
    expect(JSON.stringify(state.invoices[0].taxAssessment)).toBe(originalProof); expect(applyErpDelta(null, t.delta(), org)!.invoices[0].payments).toHaveLength(1);
  });
  it('prints old expired-at-present evidence using issuance time and the frozen seller, with original bytes unchanged', async () => {
    vi.useFakeTimers(); vi.setSystemTime('2030-01-01T00:00:00.000Z');
    try {
      const t = await history(), before = JSON.stringify(t.invoice);
      expect(Date.now()).toBeGreaterThan(Date.parse(t.invoice.taxAssessment.validUntil));
      const document = buildPrintableDocument(configuration, { ...seller, displayName: 'New current seller' }, { type: 'invoice', document: t.invoice });
      const html = renderPrintableDocumentHtml(document);
      expect(document.seller.name).toBe('Fictitious historical seller'); expect(document.total.minorUnits).toBe('2160'); expect(html).toContain('INV-000001');
      expect(JSON.stringify(t.invoice)).toBe(before); expect(t.invoice.taxAssessment.fingerprint).toBe(t.legacy);
    } finally { vi.useRealTimers(); }
  });
  it('preserves historical proof in standalone payment projection, without turning that helper into an issuer', async () => {
    const t = await history(), paid = recordCustomerPayment(configuration, t.invoice, { id: 'standalone', idempotencyKey: 'standalone-payment', organizationId: org, invoiceId: t.invoice.id, amount: { currency: 'USD', minorUnits: '100' }, paymentDate: '2026-10-09', accountingDate: '2026-10-09', reference: 'Fictitious payment only' }, t.issuanceActor);
    expect(paid.taxAssessment).toBe(t.invoice.taxAssessment); expect(paid.number).toBe(t.invoice.number); expect(paid.payments).toHaveLength(1); expect(t.invoice.payments).toHaveLength(0);
  });
  it('keeps fresh assessment validation and invoice issuance strict despite read-only historical compatibility', async () => {
    const t = await history();
    expect(() => validateHistoricalTaxAssessment(t.request, t.invoice.taxAssessment, timestamp)).not.toThrow();
    expect(() => validateTaxAssessment(t.request, t.invoice.taxAssessment, timestamp)).toThrow('STALE_TAX_ASSESSMENT');
    expect(() => invoiceFromEstimate(configuration, t.estimate, t.reconstructionInput, t.invoice.taxAssessment, t.issuanceActor, seller)).toThrow('STALE_TAX_ASSESSMENT');
    expect(() => invoiceFromEstimate(configuration, t.estimate, t.reconstructionInput, { ...t.invoice.taxAssessment, fingerprint: t.request.fingerprint }, t.issuanceActor, seller)).not.toThrow();
  });
  it.each(['origin', 'destination', 'revision', 'transactionDate', 'net', 'tenant'] as const)('rejects an actually changed historical fingerprint %s in assessment, book, delta and print', async field => {
    const t = await history(), payload = JSON.parse(t.legacy);
    if (field === 'origin') payload[3].line1 = '9 Fictitious Public Road';
    if (field === 'destination') payload[7].line1 = '9 Fictitious Customer Road';
    if (field === 'revision') payload[5] = 3;
    if (field === 'transactionDate') payload[6] = '2026-10-09';
    if (field === 'net') payload[9][0].netMinor = '2001';
    if (field === 'tenant') payload[0] = 'other-us-history';
    const fingerprint = JSON.stringify(payload), altered = withFingerprint(t.invoice, fingerprint);
    expect(() => validateHistoricalTaxAssessment(t.request, altered.taxAssessment, timestamp)).toThrow('STALE_TAX_ASSESSMENT');
    expect(() => validateStoredErp({ ...t.store.state!, invoices: [altered] }, org)).toThrow('invalid_stored_state');
    const delta = structuredClone(t.delta()); const event = delta.events[4]; const changes = event.changes.map(change => change.kind === 'invoice' ? { ...change, payload: altered } : change);
    expect(() => applyErpDelta(null, { ...delta, events: [...delta.events.slice(0, 4), { ...event, changes }] }, org)).toThrow('invalid_stored_state');
    expect(() => buildPrintableDocument(configuration, seller, { type: 'invoice', document: altered })).toThrow();
  });
  it.each(['documentRevision', 'source', 'expiredAtIssuance', 'futureDetermination', 'lineIdentity', 'negativeTax'] as const)('does not relax any historical assessment invariant %s', async field => {
    const t = await history(), value = structuredClone(t.invoice.taxAssessment) as Record<string, unknown>;
    if (field === 'documentRevision') value.documentRevision = 3;
    if (field === 'source') value.source = 'swiss-vat';
    if (field === 'expiredAtIssuance') value.validUntil = '2026-10-08T11:59:59.999Z';
    if (field === 'futureDetermination') value.determinedAt = '2026-10-08T12:00:00.001Z';
    if (field === 'lineIdentity') value.lines = [{ ...t.invoice.taxAssessment.lines[0], id: 'another-line' }];
    if (field === 'negativeTax') value.lines = [{ ...t.invoice.taxAssessment.lines[0], taxMinor: '-1' }];
    expect(() => validateHistoricalTaxAssessment(t.request, value as unknown as TaxAssessment, timestamp)).toThrow();
    expect(() => validateStoredErp({ ...t.store.state!, invoices: [{ ...t.invoice, taxAssessment: value }] }, org)).toThrow('invalid_stored_state');
  });
  it.each(['origin', 'destination', 'revision', 'transactionDate', 'net'] as const)('rejects actually altered stored fiscal inputs %s while leaving the original legacy proof unchanged', async field => {
    const t = await history(), state = structuredClone(t.store.state!) as Mutable<ErpState>, invoice = state.invoices[0], estimate = state.estimates[0];
    if (field === 'origin') invoice.companyConfiguration.address.line1 = '9 Fictitious Public Road';
    if (field === 'destination') { invoice.customer.billingAddress.line1 = '9 Fictitious Customer Road'; estimate.customer.billingAddress.line1 = invoice.customer.billingAddress.line1; }
    if (field === 'revision') { estimate.revision = 3; invoice.sourceEstimateRevision = 3; }
    if (field === 'transactionDate') invoice.date = '2026-10-09';
    if (field === 'net') { estimate.lines[0].unitPrice.minorUnits = '1001'; invoice.lines[0].unitPrice.minorUnits = '1001'; }
    expect(invoice.taxAssessment.fingerprint).toBe(t.legacy);
    expect(() => validateStoredErp(state, org)).toThrow('invalid_stored_state');
    expect(() => buildPrintableDocument(configuration, seller, { type: 'invoice', document: invoice })).toThrow();
    expect(t.invoice.taxAssessment.fingerprint).toBe(t.legacy);
  });
  it.each(['space', 'duplicate', 'escaped', 'extra', 'malformed'] as const)('rejects a non-emitted legacy JSON representation %s', async field => {
    const t = await history(); let stored = t.legacy;
    if (field === 'space') stored = stored.replace(',', ', ');
    if (field === 'duplicate') stored = stored.replace('"country":"US"', '"country":"US","country":"US"');
    if (field === 'escaped') stored = stored.replace('Fictitious', '\\u0046ictitious');
    if (field === 'extra') { const payload = JSON.parse(stored); payload[3].grant = true; stored = JSON.stringify(payload); }
    if (field === 'malformed') stored = stored.slice(0, -1);
    expect(nationalAdapter('US').historicalTaxFingerprintMatches(t.request.fingerprint, stored)).toBe(false);
    expect(() => validateHistoricalTaxAssessment(t.request, { ...t.invoice.taxAssessment, fingerprint: stored }, timestamp)).toThrow();
  });
  it('does not add US property-order compatibility to CH fingerprints', () => {
    const value = [{ country: 'CH', line1: 'Fictitious road', city: 'Geneva' }], legacy = JSON.stringify(value), reordered = canonicalErpJson(value);
    expect(nationalAdapter('CH').serializeTaxFingerprint(value)).toBe(legacy); expect(legacy).not.toBe(reordered);
    expect(nationalAdapter('CH').historicalTaxFingerprintMatches(legacy, legacy)).toBe(true); expect(nationalAdapter('CH').historicalTaxFingerprintMatches(legacy, reordered)).toBe(false);
  });
  it('refuses legacy assessment bytes on a normalized pending private proof while preserving exact stored proof/hash', async () => {
    const t = await history();
    const resolved = await prepareStripeTaxResolvedRequest({ organizationId: org, operationId: 'a8000000-0000-4000-8000-000000000001', invoiceId: 'invoice', actorUserId: actor.userId, erpIdempotencyKey: 'history-5', commandHash: t.store.commits[4].receipt.commandHash, expectedErpRevision: 4, countryRevision: 2, sellerRevision: 1, taxFactsRevision: 1, configuration, estimate: t.estimate,
      taxFacts: { schemaVersion: 1, legalName: 'Private fictitious history name', taxOrigin: configuration.address as typeof configuration.address & { country: 'US' }, timeZone: 'America/New_York' },
      binding: { organizationId: org, accountId: 'acct_FictitiousHistory', mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, revision: 1, settingsSha256: digest('fixture settings'), registrationsSha256: digest('fixture registrations'), observedAt: '2026-10-08T11:00:00.000Z', validUntil: '2026-10-08T14:00:00.000Z', evidenceKind: 'test_fixture', scope: 'erp_invoice_tax' },
      classifications: [{ lineId: 'line', taxCode: 'txcd_99999999', kind: 'service', taxBehavior: 'exclusive', revision: 1, evidenceReference: 'Fixture classification only' }], invoiceDate: t.invoice.date, taxDateInstant: timestamp, taxDatePolicy: 'caller_supplied_invoice_instant', now: timestamp, addressSource: 'billing' });
    const proof: StripeTaxPrivateProof = { schemaVersion: 1, organizationId: org, operationId: resolved.operationId, provider: 'stripe_tax', accountId: resolved.binding.accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, bindingRevision: 1, resolvedSha256: resolved.resolvedSha256, paramsSha256: resolved.paramsSha256, settingsSha256: resolved.binding.settingsSha256, registrationsSha256: resolved.binding.registrationsSha256, evidenceKind: 'test_fixture', calculationId: 'taxcalc_FictitiousHistory', calculatedAt: timestamp, expiresAt: '2026-10-08T13:00:00.000Z', taxDate: resolved.params.tax_date, currency: 'USD', netMinor: '2000', taxMinor: '160', totalMinor: '2160',
      lines: [{ lineId: 'line', providerLineId: 'tax_li_FictitiousHistory', netMinor: '2000', quantity: '2', taxCode: 'txcd_99999999', taxMinor: '160', breakdowns: [{ amountMinor: '160', taxableMinor: '2000', taxabilityReason: 'standard_rated', sourcing: 'destination', jurisdiction: { country: 'US', state: 'NY', level: 'state', displayName: 'Fictitious jurisdiction' } }] }] };
    const proofBody = canonicalErpJson(proof), proofSha256 = digest(proofBody), assessment = { ...t.invoice.taxAssessment, fingerprint: t.request.fingerprint };
    const stored = { proofBody, proofSha256, assessment };
    expect((await validateStoredStripeTaxCalculation(resolved, stored, timestamp)).proofBody).toBe(proofBody);
    await expect(validateStoredStripeTaxCalculation(resolved, { ...stored, assessment: t.invoice.taxAssessment }, timestamp)).rejects.toMatchObject({ code: 'invalid_tax_calculation' });
    expect(stored.proofBody).toBe(proofBody); expect(stored.proofSha256).toBe(digest(proofBody)); expect(proof).not.toHaveProperty('grant');
  });
});
