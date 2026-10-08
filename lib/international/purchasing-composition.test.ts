import { describe, expect, it, vi } from 'vitest';
import type { FinancialAuthority } from './accounting/ledger';
import type { Contact } from './invoicing';
import { canonicalErpJson, executeErp, ErpError } from './runtime';
import { applyErpDelta, type ErpEvent } from './runtime-sync';
import type { ErpCommand, ErpCommit, ErpReceipt, ErpState, ErpStore } from './runtime-types';
import type { RecordedVendorBill, RecordedVendorPayment } from './purchasing';
import type { CompanyConfiguration } from './types';
import { STRIPE_TAX_API_VERSION, type ResolvedStripeTaxRequest } from './stripe-tax-resolved-request';
import type { StripeTaxCalculationObservation } from './stripe-tax-calculation';
import type { UsTaxFinancialContext } from './us-tax-financial-context';
import type { StoredUsTaxOperation, UsTaxOperationStore } from './us-tax-operation-store';
import { executeUsTaxInvoiceTest, type UsTaxInvoiceTestDependencies } from './us-tax-invoice';

// Composes actual ERP, purchasing, delta application, private TEST issuer,
// mapper and normalizer. RAM stores and fixture gateway prove no SQL/Auth,
// concurrent transactions, payment execution or provider/production facts.
const org = 'fictitious-purchasing-composition', timestamp = '2026-10-08T12:00:00.000Z';
const operationId = 'c4000000-0000-4000-8000-000000000001';
function delta(fromRevision: number, events: readonly ErpEvent[]) {
  const revision = events.at(-1)?.revision ?? fromRevision;
  return { schemaVersion: events.at(-1)?.schemaVersion ?? 1, organizationId: org, fromRevision, toRevision: revision, headRevision: revision, hasMore: false, resetRequired: false, events };
}
function observed(resolved: ResolvedStripeTaxRequest): StripeTaxCalculationObservation {
  const line = resolved.params.line_items[0];
  return { accountId: resolved.binding.accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, evidenceKind: 'test_fixture', observedAt: timestamp,
    calculation: {
      id: 'taxcalc_FictitiousComposition', object: 'tax.calculation', amount_total: line.amount + 160, currency: 'usd', customer: null,
      customer_details: { address: { ...resolved.params.customer_details.address, line2: null }, address_source: 'billing', ip_address: null, tax_ids: [], taxability_override: 'none' },
      expires_at: Date.parse(timestamp) / 1000 + 3600, tax_date: resolved.params.tax_date, livemode: false, shipping_cost: null, ship_from_details: null, tax_amount_exclusive: 160, tax_amount_inclusive: 0,
      line_items: { object: 'list', has_more: false, url: '/v1/tax/calculations/taxcalc_FictitiousComposition/line_items', data: [
        { id: 'tax_li_FictitiousComposition', object: 'tax.calculation_line_item', amount: line.amount, amount_tax: 160, quantity: line.quantity, reference: line.reference, tax_code: line.tax_code, tax_behavior: 'exclusive', livemode: false, product: null,
          tax_breakdown: [{ amount: 160, taxable_amount: line.amount, taxability_reason: 'standard_rated', sourcing: 'destination', jurisdiction: { country: 'US', state: 'NY', level: 'state', display_name: 'Fictitious jurisdiction' }, tax_rate_details: { tax_type: 'sales_tax', display_name: 'Fictitious tax', percentage_decimal: '8.0' } }] },
      ] },
      tax_breakdown: [{ amount: 160, taxable_amount: line.amount, taxability_reason: 'standard_rated', inclusive: false, tax_rate_details: { country: 'US', state: 'NY', tax_type: 'sales_tax', percentage_decimal: '8.0', rate_type: 'percentage', flat_amount: null } }],
    } };
}
async function fixture(basis: 'cash' | 'accrual', capability: 1 | 2 = 2) {
  const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: basis, invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' } };
  const owner: FinancialAuthority = { organizationId: org, userId: 'fictitious-creation-owner', role: 'owner', managementEntitled: true, timestamp };
  const accountant: FinancialAuthority = { ...owner, userId: 'fictitious-accountant', role: 'accountant' };
  const events: ErpEvent[] = [], snapshots = new Map<number, ErpState | null>([[0,null]]), receipts = new Map<string, ErpReceipt>();
  let state: ErpState | null = null, operation: StoredUsTaxOperation | null = null;
  const store = {
    supportedSchemaVersion: capability,
    read: vi.fn(async () => structuredClone(state)),
    receipt: vi.fn(async (_organizationId: string, key: string) => structuredClone(receipts.get(key) ?? null)),
    commit: vi.fn(async (input: ErpCommit) => {
      const existing = receipts.get(input.receipt.idempotencyKey);
      if (existing) { if (canonicalErpJson(existing) !== canonicalErpJson(input.receipt)) throw new ErpError('idempotency_conflict', 409); return structuredClone(existing); }
      if ((state?.revision ?? 0) !== input.expectedRevision) throw new ErpError('revision_conflict', 409);
      const commit = structuredClone(input), event: ErpEvent = { schemaVersion: commit.header.schemaVersion, organizationId: org, revision: commit.header.revision, header: commit.header, changes: commit.changes, ledgerAudit: commit.ledgerAudit, receipt: commit.receipt, actorId: commit.actor.userId, occurredAt: commit.actor.timestamp };
      const candidate = applyErpDelta(state, delta(input.expectedRevision, [event]), org, capability);
      if (!candidate) throw new ErpError('invalid_state');
      state = candidate; events.push(event); snapshots.set(candidate.revision, structuredClone(candidate)); receipts.set(commit.receipt.idempotencyKey, commit.receipt); return structuredClone(commit.receipt);
    }),
  } satisfies ErpStore;
  const vendor: Contact = { id: 'vendor', organizationId: org, kind: 'business', name: 'Fictitious Supplier', billingAddress: configuration.address, paymentTermsDays: 30 };
  const commands: ErpCommand[] = [
    { type: 'initialize', periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] },
    { type: 'save_customer', customer: { ...vendor, id: 'customer', name: 'Fictitious Customer' } },
    { type: 'save_estimate', id: 'estimate', expectedEstimateRevision: 0, customerId: 'customer', date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: 30, lines: [{ id: 'line', description: 'Fictitious service', quantityUnits: '2', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: '1000' }, discountBasisPoints: 0, taxTreatment: 'taxable' }], notes: '' },
    { type: 'accept_estimate', estimateId: 'estimate', expectedEstimateRevision: 1 },
    { type: 'save_vendor', vendor },
    { type: 'record_vendor_bill', id: 'bill', vendorId: 'vendor', reference: 'FICTITIOUS-1', date: '2026-10-08', accountingDate: '2026-10-09', dueDate: '2026-11-08', periodId: '2026', netMinor: '10000', purchaseTaxMinor: '800', expenseAccountId: 'purchases', sourceReference: 'Fictitious manual source' },
    { type: 'record_vendor_payment', id: 'vendor-payment', billId: 'bill', amountMinor: '1000', paymentDate: '2026-10-10', accountingDate: '2026-10-11', periodId: '2026', reference: 'Fictitious bank source' },
  ];
  for (const command of commands.slice(0, capability === 2 ? undefined : 4)) await executeErp({ store, configuration, actor: command.type === 'initialize' ? owner : accountant, revalidate: async () => command.type === 'initialize' ? owner : accountant, taxProvider: async () => null }, { idempotencyKey: `setup-${events.length}`, expectedRevision: events.length, command });
  const context: UsTaxFinancialContext = { organizationId: org, actor: accountant, recordedAt: timestamp, countryRevision: 1, configuration, sellerRevision: 1, seller: { displayName: 'Fictitious Public Seller' }, taxFactsRevision: 1, taxFacts: { schemaVersion: 1, legalName: 'PRIVATE Fictitious Entity', taxOrigin: configuration.address, timeZone: configuration.timeZone }, binding: { organizationId: org, accountId: 'acct_FictitiousComposition', mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, revision: 1, settingsSha256: 'b'.repeat(64), registrationsSha256: 'c'.repeat(64), observedAt: timestamp, validUntil: '2026-10-09T12:00:00.000Z', evidenceKind: 'test_fixture', scope: 'erp_invoice_tax' } };
  const operations = {
    read: vi.fn(async () => structuredClone(operation)),
    reserve: vi.fn(async (admitted, resolved) => {
      operation = { status: 'reserved', organizationId: org, operationId: resolved.operationId, actorUserId: admitted.userId, erpIdempotencyKey: resolved.erpIdempotencyKey, commandHash: resolved.commandHash, reservedAt: timestamp, retryUntil: '2026-10-09T11:00:00.000Z', resolved: JSON.parse(canonicalErpJson(resolved)), calculation: null, receipt: null }; return structuredClone(operation);
    }),
    record: vi.fn(async (_admitted, _resolved, calculated) => {
      if (!operation) throw new ErpError('invalid_state');
      operation = { ...operation, status: 'calculated', calculation: { proofBody: calculated.proofBody, proofSha256: calculated.proofSha256, assessment: JSON.parse(canonicalErpJson(calculated.assessment)) } }; return structuredClone(operation);
    }),
    commit: vi.fn(async (id, input) => {
      if (!operation || operation.operationId !== id || operation.status !== 'calculated') throw new ErpError('invalid_state');
      const receipt = await store.commit(input); operation = { ...operation, status: 'committed', receipt }; return receipt;
    }),
  } satisfies UsTaxOperationStore;
  const dependencies = {
    erp: { store, configuration, actor: accountant, revalidate: vi.fn(async () => accountant) },
    contexts: { read: vi.fn(async () => structuredClone(context)) }, operations,
    gateway: { verify: vi.fn(async value => { expect(value.binding.evidenceKind).toBe('test_fixture'); }), calculate: vi.fn(async resolved => observed(resolved)) },
    classifications: vi.fn(async () => [{ lineId: 'line', taxCode: 'txcd_99999999', kind: 'service' as const, taxBehavior: 'exclusive' as const, revision: 1, evidenceReference: 'Fictitious explicit QA classification' }]),
    transactionLocation: vi.fn(async () => ({ taxDateInstant: timestamp, addressSource: 'billing' as const })), operationId: () => operationId, now: () => timestamp, allowTestFixtures: true,
  } satisfies UsTaxInvoiceTestDependencies;
  const request = { idempotencyKey: 'invoice-after-purchases', expectedRevision: events.length, command: { type: 'issue_invoice', id: 'invoice', estimateId: 'estimate', expectedEstimateRevision: 2, date: '2026-10-08', accountingDate: '2026-10-08', dueDate: '2026-11-08', periodId: '2026' } };
  return { dependencies, context, events, snapshots, store, operations, request, state: () => structuredClone(state!), issue: () => executeUsTaxInvoiceTest(dependencies, request) };
}

describe('schema promotion composed with the private TEST issuer', () => {
  it.each(['cash','accrual'] as const)('keeps underlying schema2 capability and purchases through real invoice issue and replay (%s)', async basis => {
    const t = await fixture(basis), before = t.state(); expect(before.schemaVersion).toBe(2); expect(t.store.supportedSchemaVersion).toBe(2);
    const first = await t.issue(), after = t.state();
    expect(first).toMatchObject({ replayed: false, receipt: { action: 'issue_invoice', revision: 8, entityId: 'invoice' } });
    expect(after.schemaVersion).toBe(2); expect(after.vendorBills).toEqual(before.vendorBills); expect(after.vendorPayments).toEqual(before.vendorPayments); expect(after.vendors).toEqual(before.vendors);
    expect(after.invoices).toHaveLength(1); expect(after.invoices[0]).toMatchObject({ issuedBy: 'fictitious-accountant', tax: { currency: 'USD', minorUnits: '160' }, total: { currency: 'USD', minorUnits: '2160' } });
    expect(after.counters.invoice).toBe(1); expect(after.ledger.entries).toHaveLength(basis === 'cash' ? 1 : 3);
    expect(await t.issue()).toEqual({ receipt: first.receipt, replayed: true }); expect(t.dependencies.gateway.calculate).toHaveBeenCalledTimes(1); expect(t.operations.commit).toHaveBeenCalledTimes(1); expect(t.store.commit).toHaveBeenCalledTimes(8);
    expect(Object.keys(first.receipt)).toEqual(['idempotencyKey','commandHash','revision','entityId','action']); expect(JSON.stringify(first)).not.toContain('PRIVATE'); expect(JSON.stringify(first)).not.toContain('acct_');
  });
  it.each(['cash','accrual'] as const)('preserves old schema1 capability through the same real issuer (%s)', async basis => {
    const t = await fixture(basis, 1); expect(t.state().schemaVersion).toBe(1); await t.issue();
    expect(t.state().schemaVersion).toBe(1); expect(t.state()).not.toHaveProperty('vendors'); expect(t.dependencies.gateway.calculate).toHaveBeenCalledTimes(1);
  });
  it('keeps a real client-upgrade refusal public and withholds before private context/provider work', async () => {
    const t = await fixture('cash'); Object.assign(t.store, { supportedSchemaVersion: 1 });
    await expect(t.issue()).rejects.toMatchObject({ code: 'client_upgrade_required', status: 409 });
    expect(t.dependencies.contexts.read).not.toHaveBeenCalled(); expect(t.dependencies.gateway.calculate).not.toHaveBeenCalled(); expect(t.operations.read).not.toHaveBeenCalled(); expect(t.state().invoices).toEqual([]);
  });
});

describe('purchasing delta stamps and supplier snapshot binding', () => {
  it.each(['cash','accrual'] as const)('applies unmodified creation/payment deltas from the real ERP (%s)', async basis => {
    const t = await fixture(basis); let applied: ErpState | null = null;
    for (const event of t.events) applied = applyErpDelta(applied, delta(event.revision - 1, [event]), org, 2);
    expect(applied).toEqual(t.state());
  });
  it.each(['cash','accrual'] as const)('accepts equivalent zero-millisecond event instants without rewriting record or journal stamps (%s)', async basis => {
    const t = await fixture(basis);
    for (const action of ['record_vendor_bill','record_vendor_payment']) {
      const event = t.events.find(event => event.receipt.action === action)!, before = t.snapshots.get(event.revision - 1)!;
      const result = applyErpDelta(before, delta(event.revision - 1, [{ ...event, occurredAt: timestamp.replace('.000Z','Z') }]), org, 2);
      expect(result).toEqual(t.snapshots.get(event.revision));
    }
  });
  it.each(['cash','accrual'] as const)('rejects changed approval occurrence or supplier snapshot without applying a partial candidate (%s)', async basis => {
    const t = await fixture(basis), event = t.events.find(event => event.receipt.action === 'record_vendor_bill')!, before = t.snapshots.get(event.revision - 1)!, original = canonicalErpJson(before);
    const altered: ErpEvent[] = [
      { ...event, occurredAt: '2026-10-07T12:00:00.000Z' },
      { ...event, changes: event.changes.map(change => change.kind !== 'vendor_bill' ? change : { ...change, payload: { ...(change.payload as RecordedVendorBill), approvedAt: '2026-10-07T12:00:00.000Z' } }) },
      { ...event, changes: event.changes.map(change => change.kind !== 'vendor_bill' ? change : { ...change, payload: { ...(change.payload as RecordedVendorBill), vendorSnapshot: { ...(change.payload as RecordedVendorBill).vendorSnapshot, name: 'Different Fictitious Supplier' } } }) },
    ];
    for (const value of altered) { expect(() => applyErpDelta(before, delta(event.revision - 1, [value]), org, 2)).toThrow('invalid_sync_state'); expect(canonicalErpJson(before)).toBe(original); }
  });
  it.each(['cash','accrual'] as const)('rejects payment recordedAt or occurredAt divergence without applying it (%s)', async basis => {
    const t = await fixture(basis), event = t.events.find(event => event.receipt.action === 'record_vendor_payment')!, before = t.snapshots.get(event.revision - 1)!, original = canonicalErpJson(before);
    const altered: ErpEvent[] = [
      { ...event, occurredAt: '2026-10-07T12:00:00.000Z' },
      { ...event, changes: event.changes.map(change => change.kind !== 'vendor_payment' ? change : { ...change, payload: { ...(change.payload as RecordedVendorPayment), recordedAt: '2026-10-07T12:00:00.000Z' } }) },
    ];
    for (const value of altered) { expect(() => applyErpDelta(before, delta(event.revision - 1, [value]), org, 2)).toThrow('invalid_sync_state'); expect(canonicalErpJson(before)).toBe(original); }
  });
  it.each(['cash','accrual'] as const)('binds the payment idempotency key to its exact event receipt (%s)', async basis => {
    const t = await fixture(basis), event = t.events.find(event => event.receipt.action === 'record_vendor_payment')!, before = t.snapshots.get(event.revision - 1)!, original = canonicalErpJson(before);
    const altered = { ...event, receipt: { ...event.receipt, idempotencyKey: 'different-fictitious-receipt-key' } };
    expect(() => applyErpDelta(before, delta(event.revision - 1, [altered]), org, 2)).toThrow('invalid_sync_state'); expect(canonicalErpJson(before)).toBe(original);
  });
});
