import { executeErp } from './runtime';
import { applyErpDelta } from './runtime-sync';
import { money } from './money';
import type { ErpCommand, ErpReceipt, ErpState, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';
/** Test-only: real engine and delta, fictitious tax proof and RAM persistence.
 * This helper never represents a real provider, real business or actual tax rate. */
export async function browserSalesFixture(basis: 'cash' | 'accrual' = 'accrual'): Promise<ErpState> {
  const organizationId = 'fictitious-sales-company', configuration: CompanyConfiguration = { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Example Street', city: 'Brooklyn', subdivision: 'NY', postalCode: '11201' }, accountingBasis: basis, invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' } };
  const actor = { organizationId, userId: 'fictitious-owner', role: 'owner' as const, managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z' };
  let state: ErpState | null = null, sequence = 0; const receipts = new Map<string, ErpReceipt>();
  const store: ErpStore = { supportedSchemaVersion: 2, read: async () => structuredClone(state), receipt: async (_org, key) => structuredClone(receipts.get(key) ?? null), commit: async input => {
    if ((state?.revision ?? 0) !== input.expectedRevision) throw new Error('Fixture CAS conflict');
    state = applyErpDelta(state, { schemaVersion: input.header.schemaVersion, organizationId, fromRevision: input.expectedRevision, toRevision: input.header.revision, headRevision: input.header.revision, hasMore: false, resetRequired: false, events: [{ schemaVersion: input.header.schemaVersion, organizationId, revision: input.header.revision, header: input.header, changes: input.changes, ledgerAudit: input.ledgerAudit, receipt: input.receipt, actorId: actor.userId, occurredAt: actor.timestamp }] }, organizationId, 2);
    receipts.set(input.receipt.idempotencyKey, input.receipt); return input.receipt;
  } };
  const send = (command: ErpCommand) => executeErp({ configuration, actor, revalidate: async () => actor, store, seller: async () => ({ organizationId, displayName: 'Fictitious seller' }), taxProvider: async () => ({ id: 'TEST-ONLY', calculate: async request => ({ ...request, source: 'external-provider', providerReference: 'TEST-ONLY not real tax', determinedAt: '2026-10-08T11:00:00.000Z', validUntil: '2026-10-08T13:00:00.000Z', lines: request.lines.map(line => ({ id: line.id, taxMinor: '825', jurisdiction: 'Fictitious test', evidenceReference: 'Test only' })) }) }) }, { expectedRevision: state?.revision ?? 0, idempotencyKey: `sales-fixture-${++sequence}`, command });
  await send({ type: 'initialize', periods: [{ id: 'period-2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
  await send({ type: 'save_customer', customer: { id: 'customer-1', organizationId, kind: 'business', name: 'Fictitious customer', billingAddress: configuration.address, paymentTermsDays: 30 } });
  for (const id of ['estimate-1', 'estimate-2']) {
    await send({ type: 'save_estimate', id, expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: 30, notes: 'Fictitious demonstration\nNo real payment', lines: [{ id: 'line-1', description: 'Fictitious recorded service', quantityUnits: '1', quantityScale: 0, unitPrice: money('USD', '10000'), discountBasisPoints: 0, taxTreatment: 'taxable' }] });
    await send({ type: 'accept_estimate', estimateId: id, expectedEstimateRevision: 1 });
  }
  await send({ type: 'issue_invoice', id: 'invoice-1', estimateId: 'estimate-1', expectedEstimateRevision: 2, date: '2026-10-08', accountingDate: '2026-10-09', dueDate: '2026-11-08', periodId: 'period-2026' });
  if (!state) throw new Error('Missing fixture'); return state;
}
