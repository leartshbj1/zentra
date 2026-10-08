import { executeErp } from './runtime';
import { applyErpDelta } from './runtime-sync';
import type { ErpCommand, ErpState, ErpStore, ErpReceipt } from './runtime-types';
import type { CompanyConfiguration } from './types';
import type { FinancialAuthority } from './accounting/ledger';

const org = 'fictitious-export-company';
/** Real engine and delta reconstruction, synthetic RAM CAS and fiscal evidence. */
export async function exportFixture(basis: 'cash' | 'accrual' = 'accrual', notes = '', description = 'Recorded service', unitPriceMinor = '12345', withProject = false): Promise<ErpState> {
  const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', address: { country: 'US', line1: '1 Example Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, timeZone: 'America/New_York', accountingBasis: basis, invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' }, ein: '12-3456789' };
  const actor: FinancialAuthority = { organizationId: org, userId: 'actual-fixture-accountant', role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z' };
  let state: ErpState | null = null, sequence = 0; const receipts = new Map<string, ErpReceipt>();
  const capability = withProject ? 3 : 2;
  const store: ErpStore = { supportedSchemaVersion: capability, read: async () => state, receipt: async (_org, key) => receipts.get(key) ?? null, commit: async input => {
    state = applyErpDelta(state, { schemaVersion: input.header.schemaVersion, organizationId: org, fromRevision: input.expectedRevision, toRevision: input.receipt.revision, headRevision: input.receipt.revision, hasMore: false, resetRequired: false, events: [{ schemaVersion: input.header.schemaVersion, organizationId: org, revision: input.receipt.revision, header: input.header, changes: input.changes, ledgerAudit: input.ledgerAudit, receipt: input.receipt, actorId: actor.userId, occurredAt: actor.timestamp }] }, org, capability);
    receipts.set(input.receipt.idempotencyKey, input.receipt); return input.receipt;
  } };
  const write = (command: ErpCommand) => executeErp({ configuration, actor, store, revalidate: async () => actor, seller: async () => ({ organizationId: org, displayName: 'Historical Seller Énergie', contactEmail: 'old@example.test' }), taxProvider: async () => ({ id: 'explicit-fictitious-provider', calculate: async request => ({ organizationId: org, country: 'US', currency: 'USD', documentId: request.documentId, documentRevision: request.documentRevision, fingerprint: request.fingerprint, source: 'external-provider', providerReference: 'private-fictitious-reference', determinedAt: actor.timestamp, validUntil: '2026-10-09T12:00:00Z', lines: request.lines.map(line => ({ id: line.id, taxMinor: '825', jurisdiction: 'fictitious-jurisdiction', evidenceReference: 'private-fictitious-proof' })) }) }) }, { idempotencyKey: `fixture-export-${++sequence}`, expectedRevision: state?.revision ?? 0, command });
  await write({ type: 'initialize', periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
  const contact = { id: 'customer 1 é', organizationId: org, kind: 'business' as const, name: 'Actual customer example', billingAddress: configuration.address, paymentTermsDays: 30 };
  await write({ type: 'save_customer', customer: contact });
  const project = { id: 'project 1 é', expectedProjectRevision: 0, customerId: contact.id, name: 'Fictitious project Énergie', status: 'active' as const, notes, startDate: '2026-10-08', targetDate: '2026-11-08', budgetMinor: '100000', vendorBillIds: [] as string[] };
  if (withProject) await write({ type: 'save_projects', projects: [project] });
  await write({ type: 'save_estimate', id: 'estimate 1 é', expectedEstimateRevision: 0, customerId: contact.id, ...(withProject ? { projectId: project.id } : {}), date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: 30, notes, lines: [{ id: 'line-1', description, quantityUnits: '2', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: unitPriceMinor }, discountBasisPoints: 0, taxTreatment: 'taxable' }] });
  await write({ type: 'accept_estimate', estimateId: 'estimate 1 é', expectedEstimateRevision: 1 });
  await write({ type: 'issue_invoice', id: 'invoice 1 é', estimateId: 'estimate 1 é', expectedEstimateRevision: 2, date: '2026-10-08', accountingDate: '2026-10-08', dueDate: '2026-11-08', periodId: '2026' });
  await write({ type: 'save_vendor', vendor: { ...contact, id: 'vendor-1', name: 'Recorded supplier', billingAddress: { country: 'CH', line1: '1 Rue Exemple', city: 'Genève', subdivision: 'GE', postalCode: '1201' } } });
  await write({ type: 'record_vendor_bill', id: 'bill-1', vendorId: 'vendor-1', reference: 'SUPPLIER-42', date: '2026-10-08', accountingDate: '2026-10-08', dueDate: '2026-11-08', periodId: '2026', netMinor: '10000', purchaseTaxMinor: '825', expenseAccountId: 'purchases', sourceReference: 'Recorded source reference' });
  await write({ type: 'record_vendor_payment', id: 'payment-1', billId: 'bill-1', amountMinor: '5000', paymentDate: '2026-10-08', accountingDate: '2026-10-08', periodId: '2026', reference: 'Recorded payment reference' });
  if (withProject) {
    await write({ type: 'record_payment', id: 'customer-payment-1', invoiceId: 'invoice 1 é', amountMinor: '10000', paymentDate: '2026-10-08', accountingDate: '2026-10-08', periodId: '2026', reference: 'Fictitious payment already received' });
    await write({ type: 'save_projects', projects: [{ ...project, expectedProjectRevision: 1, vendorBillIds: ['bill-1'] }] });
  }
  return state!;
}
