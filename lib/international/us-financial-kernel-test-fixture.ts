import type { FinancialAuthority } from './accounting/ledger';
import { ErpError } from './erp-contract';
import type { TaxCalculationProvider } from './invoicing';
import { money } from './money';
import { executeErp } from './runtime';
import { applyErpDelta } from './runtime-sync';
import type { ErpCommand, ErpReceipt, ErpState, ErpStore } from './runtime-types';
import { validateStoredErp } from './runtime-validation';
import type { CompanyConfiguration } from './types';
import type { UsFinancialPolicyV5 } from './us-financial-kernel-types';

/** Synthetic local fixture built through the actual published ERP4 commands,
 * delta application and invoice/ledger replay. No network, provider reversal,
 * customer data, kernel promotion or production persistence is involved. */
export async function financialKernelFixture(options: Readonly<{
  basis?: 'cash' | 'accrual'; paid?: string; tax?: string; discountBasisPoints?: number;
}> = {}): Promise<Readonly<{
  configuration: CompanyConfiguration;
  actor: FinancialAuthority;
  policy: UsFinancialPolicyV5;
  baseline: ErpState;
}>> {
  const organizationId = 'synthetic-financial-kernel-workspace';
  const configuration: CompanyConfiguration = {
    schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York',
    address: { country: 'US', line1: '1 Synthetic Example Street', city: 'Brooklyn', postalCode: '11201', subdivision: 'NY' },
    accountingBasis: options.basis ?? 'accrual', invoiceNumberPrefix: 'SYNTHETIC-INV', taxConfiguration: { status: 'configured' },
  };
  const actor: FinancialAuthority = { organizationId, userId: 'synthetic-financial-owner', role: 'owner', managementEntitled: true, timestamp: '2026-10-10T12:00:00.000Z' };
  const policy: UsFinancialPolicyV5 = {
    version: 'us-accrual-receivable-credit-v1', environment: 'test',
    approval: { reference: 'SYNTHETIC-LOCAL-POLICY-ONLY', reviewedBy: 'synthetic-policy-reviewer', reviewedAt: '2026-10-10T11:00:00.000Z' },
  };
  let current: ErpState | null = null, sequence = 0;
  const receipts = new Map<string, ErpReceipt>();
  const scoped = (org: string) => { if (org !== organizationId) throw new ErpError('tenant_mismatch', 403); };
  const store: ErpStore = {
    supportedSchemaVersion: 4,
    async read(org) { scoped(org); return current; },
    async receipt(org, key) { scoped(org); return receipts.get(key) ?? null; },
    async commit(input) {
      scoped(input.organizationId);
      if ((current?.revision ?? 0) !== input.expectedRevision) throw new ErpError('revision_conflict', 409);
      current = applyErpDelta(current, {
        schemaVersion: 4, organizationId, fromRevision: input.expectedRevision, toRevision: input.header.revision, headRevision: input.header.revision, hasMore: false, resetRequired: false,
        events: [{ schemaVersion: 4, organizationId, revision: input.header.revision, header: input.header, changes: input.changes, ledgerAudit: input.ledgerAudit, receipt: input.receipt, actorId: input.actor.userId, occurredAt: input.actor.timestamp }],
      }, organizationId, 4);
      receipts.set(input.receipt.idempotencyKey, input.receipt);
      return input.receipt;
    },
  };
  const taxProvider: TaxCalculationProvider = {
    id: 'synthetic-local-calculation-not-a-provider',
    async calculate(request) {
      return {
        ...request, source: 'external-provider', providerReference: 'synthetic-calculation-never-a-tax-transaction', determinedAt: '2026-10-10T11:00:00Z', validUntil: '2026-10-10T13:00:00Z',
        lines: request.lines.map(line => ({ id: line.id, taxMinor: line.taxTreatment === 'taxable' ? options.tax ?? '2475' : '0', jurisdiction: 'synthetic-jurisdiction-no-rate-claim', evidenceReference: `synthetic-evidence-${line.id}` })),
      };
    },
  };
  const send = (command: ErpCommand) => executeErp({
    store, configuration, actor, revalidate: async () => actor, taxProvider: async () => taxProvider,
    seller: async () => ({ organizationId, displayName: 'Synthetic Seller LLC — local tests only', contactEmail: 'synthetic-seller@example.test' }),
  }, { idempotencyKey: `synthetic-baseline-${++sequence}`, expectedRevision: current?.revision ?? 0, command });
  await send({ type: 'initialize', periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
  await send({ type: 'save_customer', customer: { id: 'customer-1', organizationId, kind: 'business', name: 'Synthetic Customer LLC — local tests only', billingAddress: configuration.address, paymentTermsDays: 30 } });
  await send({
    type: 'save_estimate', id: 'estimate-1', expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-09', expiresAt: '2026-11-09', paymentTermsDays: 30,
    lines: [{ id: 'line-1', description: 'Synthetic service — no commercial transaction', quantityUnits: '3', quantityScale: 0, unitPrice: money('USD', '10000'), discountBasisPoints: options.discountBasisPoints ?? 0, taxTreatment: 'taxable' }], notes: 'Synthetic local financial-kernel fixture only.',
  });
  await send({ type: 'accept_estimate', estimateId: 'estimate-1', expectedEstimateRevision: 1 });
  await send({ type: 'issue_invoice', id: 'invoice-1', estimateId: 'estimate-1', expectedEstimateRevision: 2, date: '2026-10-09', accountingDate: '2026-10-09', dueDate: '2026-11-08', periodId: '2026' });
  if (options.paid !== undefined && options.paid !== '0') await send({ type: 'record_payment', id: 'payment-1', invoiceId: 'invoice-1', amountMinor: options.paid, paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'synthetic-bank-reference-no-money-moved' });
  return Object.freeze({ configuration, actor, policy, baseline: validateStoredErp(current, organizationId) });
}
