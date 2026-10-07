import { describe, it, expect } from 'vitest';
import { publicCompanyConfiguration, publicErpState, publicErpDelta } from './public-projection';
import { executeErp, canonicalErpJson } from './runtime';
import { applyErpDelta, type ErpEvent, type ErpDelta } from './runtime-sync';
import { validateStoredErp } from './runtime-validation';
import type { ErpCommit, ErpReceipt, ErpState, ErpStore, ErpCommand } from './runtime-types';
import type { CompanyConfiguration } from './types';
import type { TaxCalculationProvider } from './invoicing';
import { createErpHandlers } from './runtime-server';
import { createErpSyncHandlers } from './runtime-sync-server';

const org = 'fictitious-private-profile';
const config = {
  schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en',
  timeZone: 'America/New_York', address: { country: 'US', line1: '1 Example Street', city: 'New York', subdivision: 'NY', postalCode: '10001' },
  accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' }, ein: '12-3456789',
} satisfies CompanyConfiguration;
const actor = { organizationId: org, userId: 'fictitious-owner', role: 'owner' as const, managementEntitled: true, timestamp: '2026-10-08T12:00:00Z' };
const provider: TaxCalculationProvider = {
  id: 'fictitious-only', async calculate(request) {
    return { ...request, source: 'external-provider', providerReference: 'fictitious-proof', determinedAt: actor.timestamp, validUntil: '2026-10-09T12:00:00Z',
      providerDebug: { credential: 'SYNTHETIC_PRIVATE_MARKER' },
      lines: request.lines.map(line => ({ id: line.id, taxMinor: '825', jurisdiction: 'fictitious-only', evidenceReference: 'fictitious-proof', privateCredential: 'SYNTHETIC_PRIVATE_MARKER' })) };
  },
};
function delta(events: readonly ErpEvent[]): ErpDelta {
  return { schemaVersion: 1, organizationId: org, fromRevision: 0, toRevision: events.length, headRevision: events.length, hasMore: false, resetRequired: false, events };
}
async function fixture() {
  let state: ErpState | null = null, sequence = 0;
  const events: ErpEvent[] = [], receipts = new Map<string, ErpReceipt>();
  const store: ErpStore = {
    async read() { return state; }, async receipt(_org, key) { return receipts.get(key) ?? null; },
    async commit(input: ErpCommit) {
      const event: ErpEvent = { schemaVersion: 1, organizationId: org, revision: input.header.revision, header: input.header,
        changes: input.changes, ledgerAudit: input.ledgerAudit, receipt: input.receipt, actorId: actor.userId, occurredAt: actor.timestamp };
      const before = state?.revision ?? 0;
      state = applyErpDelta(state, { ...delta([event]), fromRevision: before, toRevision: before + 1, headRevision: before + 1 }, org);
      events.push(event); receipts.set(input.receipt.idempotencyKey, input.receipt); return input.receipt;
    },
  };
  const send = (command: ErpCommand) => executeErp({ store, configuration: config, actor, taxProvider: async () => provider,
    seller: async () => ({ organizationId: org, displayName: 'Fictitious Seller' }), revalidate: async () => actor },
  { idempotencyKey: `private-${++sequence}`, expectedRevision: state?.revision ?? 0, command });
  await send({ type: 'initialize', periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
  await send({ type: 'save_customer', customer: { id: 'c1', organizationId: org, kind: 'business', name: 'Fictitious Customer', billingAddress: config.address, paymentTermsDays: 30 } });
  await send({ type: 'save_estimate', id: 'q1', expectedEstimateRevision: 0, customerId: 'c1', date: '2026-10-08', expiresAt: '2026-11-07', paymentTermsDays: 30,
    lines: [{ id: 'l1', description: 'Fictitious service', quantityUnits: '1', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: '10000' }, discountBasisPoints: 0, taxTreatment: 'taxable' }], notes: '' });
  await send({ type: 'accept_estimate', estimateId: 'q1', expectedEstimateRevision: 1 });
  await send({ type: 'issue_invoice', id: 'i1', estimateId: 'q1', expectedEstimateRevision: 2, date: '2026-10-08', accountingDate: '2026-10-08', dueDate: '2026-11-07', periodId: '2026' });
  await send({ type: 'record_payment', id: 'p1', invoiceId: 'i1', amountMinor: '2500', paymentDate: '2026-10-08', accountingDate: '2026-10-08', periodId: '2026', reference: 'Fictitious receipt' });
  return { state: state!, events, store };
}

describe('default public financial projections', () => {
  it('omits EIN without mutating private or historical profiles and keeps financial evidence exact', async () => {
    const t = await fixture(), original = canonicalErpJson(t.state), result = publicErpState(t.state);
    expect(config.ein).toBe('12-3456789'); expect(t.state.invoices[0].companyConfiguration).toHaveProperty('ein', config.ein);
    expect(result.configuration).not.toHaveProperty('ein'); expect(result.invoices[0].companyConfiguration).not.toHaveProperty('ein');
    expect(result.invoices[0].taxAssessment).toEqual(t.state.invoices[0].taxAssessment);
    expect(result.invoices[0].payments).toEqual(t.state.invoices[0].payments); expect(result.ledger).toEqual(t.state.ledger);
    expect(validateStoredErp(result, org)).toEqual(result); expect(canonicalErpJson(t.state)).toBe(original);
    expect(publicCompanyConfiguration(config).organizationId).toBe(org);
  });
  it('projects every delta profile and reconstructs the same public state with unchanged receipts', async () => {
    const t = await fixture(), privateDelta = delta(t.events), publicDelta = publicErpDelta(privateDelta);
    expect(JSON.stringify(publicDelta)).not.toContain('12-3456789'); expect(JSON.stringify(privateDelta)).toContain('12-3456789');
    expect(applyErpDelta(null, publicDelta, org)).toEqual(publicErpState(t.state));
    expect(publicDelta.events.map(event => event.receipt)).toEqual(privateDelta.events.map(event => event.receipt));
  });
  it('does not share mutable financial arrays with the store', async () => {
    const t = await fixture(), result = publicErpState(t.state);
    (result.invoices[0].payments as unknown as { reference: string }[])[0].reference = 'Mutated wire copy';
    expect(t.state.invoices[0].payments[0].reference).toBe('Fictitious receipt');
  });
  it('never persists raw provider debug, credentials or extra request fields into issued tax evidence', async () => {
    const t = await fixture();
    expect(JSON.stringify(t.state.invoices[0].taxAssessment)).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    expect(t.state.invoices[0].taxAssessment).not.toHaveProperty('customer');
    expect(t.state.invoices[0].taxAssessment).not.toHaveProperty('transactionDate');
    expect(t.state.invoices[0].taxAssessment.lines[0]).not.toHaveProperty('privateCredential');
  });
  it('refuses an unexpected stored proof but also strips it defensively at the public projection', async () => {
    const t = await fixture(), invalid = structuredClone(t.state);
    Object.assign(invalid.invoices[0].taxAssessment, { providerDebug: { credential: 'SYNTHETIC_PRIVATE_MARKER' } });
    Object.assign(invalid.invoices[0].taxAssessment.lines[0], { privateCredential: 'SYNTHETIC_PRIVATE_MARKER' });
    expect(() => validateStoredErp(invalid, org)).toThrow('invalid_stored_state');
    const projected = publicErpState(invalid);
    expect(JSON.stringify(projected)).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    expect(validateStoredErp(projected, org)).toEqual(projected);
    expect(invalid.invoices[0].taxAssessment).toHaveProperty('providerDebug');
  });
  it('redacts full HTTP and delta HTTP responses after authoritative reads', async () => {
    const t = await fixture();
    const dependencies = { enabled: () => true, authority: async () => ({ mode: 'device' as const, actor }), configuration: async () => config,
      rateLimit: async () => {}, diagnostic: () => {} };
    const full = createErpHandlers({ ...dependencies, store: () => t.store, taxProvider: async () => null });
    const changes = createErpSyncHandlers({ ...dependencies, syncStore: () => ({ revision: async () => ({ schemaVersion: 1 as const, organizationId: org, revision: t.state.revision }), changes: async () => delta(t.events) }) });
    const fullResponse = await full.GET(new Request('https://zentraapp.ch/erp'), org);
    const deltaResponse = await changes.changes(new Request('https://zentraapp.ch/erp/changes?after=0'), org);
    expect(fullResponse.status).toBe(200); expect(deltaResponse.status).toBe(200);
    expect(JSON.stringify(await fullResponse.json())).not.toContain('12-3456789');
    expect(JSON.stringify(await deltaResponse.json())).not.toContain('12-3456789');
    expect(t.state.configuration).toHaveProperty('ein', config.ein);
  });
});
