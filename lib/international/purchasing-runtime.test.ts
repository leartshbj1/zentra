import { describe, expect, it, vi } from 'vitest';
import { executeErp, ErpError, canonicalErpJson } from './runtime';
import type { ErpCommand, ErpCommit, ErpReceipt, ErpState, ErpStore } from './runtime-types';
import { applyErpDelta, type ErpEvent } from './runtime-sync';
import { validateStoredErp } from './runtime-store';
import type { FinancialAuthority } from './accounting/ledger';
import { cashFlow, profitAndLoss, trialBalance } from './accounting/reports';
import type { Contact, PublicSellerSnapshot, TaxCalculationProvider } from './invoicing';
import { invoiceBalance } from './invoicing';
import { money } from './money';
import { vendorBillBalance, type BillInput, type PaymentInput, type RecordedVendorBill, type RecordedVendorPayment } from './purchasing';
import type { CompanyConfiguration } from './types';

// Real ERP transitions, delta application and stored-book validation. This CAS
// store and the Auth/provider fixtures are local RAM substitutes, not SQL,
// concurrent database, payment execution, or production fiscal evidence.
const organizationId = 'fictitious-purchasing-runtime';
const configuration: CompanyConfiguration = {
  schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York',
  address: { country: 'US', line1: '1 Example Street', city: 'New York', subdivision: 'NY', postalCode: '10001' },
  accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' },
};
const initialActor: FinancialAuthority = {
  organizationId, userId: 'fictitious-owner', role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z',
};
const periods = [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' as const }];
const vendor: Contact = {
  id: 'vendor-1', organizationId, kind: 'business', name: 'Fictitious supplier', billingAddress: configuration.address,
  email: 'supplier@example.test', paymentTermsDays: 30,
};
const bill: BillInput = {
  id: 'bill-1', vendorId: vendor.id, reference: 'FICTITIOUS-BILL-1', date: '2026-10-08', accountingDate: '2026-10-09',
  dueDate: '2026-11-07', periodId: '2026', netMinor: '10000', purchaseTaxMinor: '825', expenseAccountId: 'purchases',
  sourceReference: 'manual:fictitious-source-1',
};
type PurchaseCommand = { type: 'save_vendor'; vendor: Contact } | ({ type: 'record_vendor_bill' } & BillInput) | ({ type: 'record_vendor_payment' } & PaymentInput);
type PurchasingState = Omit<ErpState, 'schemaVersion'> & {
  schemaVersion: 2; vendors: readonly Contact[]; vendorBills: readonly RecordedVendorBill[]; vendorPayments: readonly RecordedVendorPayment[];
};
function purchasingState(state: ErpState | null): PurchasingState {
  expect(state?.schemaVersion).toBe(2);
  return state as unknown as PurchasingState;
}
function delta(fromRevision: number, headRevision: number, events: readonly ErpEvent[]) {
  return { schemaVersion: events.at(-1)?.schemaVersion ?? 1, organizationId, fromRevision, toRevision: fromRevision + events.length,
    headRevision, hasMore: fromRevision + events.length < headRevision, resetRequired: false, events };
}
class LocalCasStore implements ErpStore {
  supportedSchemaVersion?: 1 | 2;
  state: ErpState | null = null;
  receipts = new Map<string, ErpReceipt>();
  commits: ErpCommit[] = [];
  events: ErpEvent[] = [];
  beforeRead?: () => void;
  beforeReceipt?: () => void;
  failBeforeCommit = false;
  loseNextResponse = false;
  constructor(capability: 1 | 2 | undefined) { if (capability !== undefined) this.supportedSchemaVersion = capability; }
  read = async (org: string): Promise<ErpState | null> => {
    if (org !== organizationId) throw new ErpError('tenant_mismatch', 403);
    this.beforeRead?.();
    return this.state ? structuredClone(this.state) : null;
  };
  receipt = async (org: string, key: string): Promise<ErpReceipt | null> => {
    if (org !== organizationId) throw new ErpError('tenant_mismatch', 403);
    this.beforeReceipt?.();
    return structuredClone(this.receipts.get(key) ?? null);
  };
  commit = async (input: ErpCommit): Promise<ErpReceipt> => {
    if (this.failBeforeCommit) throw new ErpError('service_unavailable', 503);
    const saved = this.receipts.get(input.receipt.idempotencyKey);
    if (saved) {
      if (saved.commandHash !== input.receipt.commandHash) throw new ErpError('idempotency_conflict', 409);
      return structuredClone(saved);
    }
    if (input.organizationId !== organizationId) throw new ErpError('tenant_mismatch', 403);
    if ((this.state?.revision ?? 0) !== input.expectedRevision) throw new ErpError('revision_conflict', 409);
    const commit = structuredClone(input);
    const event: ErpEvent = { schemaVersion: commit.header.schemaVersion, organizationId, revision: commit.header.revision,
      header: commit.header, changes: commit.changes, ledgerAudit: commit.ledgerAudit, receipt: commit.receipt,
      actorId: commit.actor.userId, occurredAt: commit.actor.timestamp };
    const candidate = applyErpDelta(this.state, delta(input.expectedRevision, input.header.revision, [event]), organizationId, this.supportedSchemaVersion ?? 1);
    this.state = candidate;
    this.events.push(event); this.commits.push(commit); this.receipts.set(commit.receipt.idempotencyKey, commit.receipt);
    if (this.loseNextResponse) { this.loseNextResponse = false; throw new ErpError('service_unavailable', 503); }
    return structuredClone(commit.receipt);
  };
}
function fixture(basis: 'cash' | 'accrual' = 'accrual', capability: 1 | 2 | undefined = 2) {
  const store = new LocalCasStore(capability);
  let currentActor = structuredClone(initialActor), sequence = 0;
  const taxProvider = vi.fn(async (): Promise<TaxCalculationProvider | null> => null);
  const seller = vi.fn(async (): Promise<PublicSellerSnapshot | null> => null);
  const dependencies = { store, configuration: { ...configuration, accountingBasis: basis }, actor: currentActor,
    revalidate: async (): Promise<FinancialAuthority> => currentActor, taxProvider, seller };
  function request(command: ErpCommand | PurchaseCommand, key = `purchase-${++sequence}`) {
    return { command, idempotencyKey: key, expectedRevision: store.state?.revision ?? 0 };
  }
  const send = (command: ErpCommand | PurchaseCommand, key?: string) => executeErp(dependencies, request(command, key));
  const initialize = () => send({ type: 'initialize', periods });
  const saveVendor = (value: Contact = vendor) => send({ type: 'save_vendor', vendor: value });
  const recordBill = (value: BillInput = bill, key?: string) => send({ type: 'record_vendor_bill', ...value }, key);
  const payment = (id = 'vendor-payment-1', amountMinor = '5000', billId = bill.id): PurchaseCommand => ({
    type: 'record_vendor_payment', id, billId, amountMinor, paymentDate: '2026-10-10', accountingDate: '2026-10-11', periodId: '2026', reference: `manual:${id}`,
  });
  const pay = (id?: string, amount?: string, key?: string, billId?: string) => send(payment(id, amount, billId), key);
  function actor(value: FinancialAuthority) { currentActor = value; dependencies.actor = value; }
  async function prepare() { await initialize(); await saveVendor(); await recordBill(); }
  return { store, dependencies, taxProvider, seller, request, send, initialize, saveVendor, recordBill, payment, pay, actor, prepare };
}
async function noMutation(t: ReturnType<typeof fixture>, operation: () => Promise<unknown>, error?: { code?: string; status?: number }) {
  const before = canonicalErpJson(t.store.state), commits = t.store.commits.length, events = t.store.events.length, receipts = t.store.receipts.size;
  if (error) await expect(operation()).rejects.toMatchObject(error); else await expect(operation()).rejects.toThrow();
  expect(canonicalErpJson(t.store.state)).toBe(before); expect(t.store.commits).toHaveLength(commits);
  expect(t.store.events).toHaveLength(events); expect(t.store.receipts.size).toBe(receipts);
}

describe('real purchasing ERP transitions with explicit schema-2 storage capability', () => {
  it.each(['cash', 'accrual'] as const)('saves an unchanged supplier through the real delta contract and replays it once (%s)', async basis => {
    const t = fixture(basis); await t.prepare();
    await t.saveVendor({ ...vendor, id: 'vendor-2', name: 'Second fictitious supplier' });
    const before = structuredClone(t.store.state!), request = t.request({ type: 'save_vendor', vendor }, 'unchanged-vendor');
    const result = await executeErp(t.dependencies, request), saved = t.store.commits.at(-1)!;
    expect(result.replayed).toBe(false); expect(saved.changes).toEqual([{ kind: 'vendor', id: vendor.id, payload: vendor }]);
    expect(saved.ledgerAudit).toEqual([]); expect(t.store.state!.revision).toBe(before.revision + 1);
    expect(t.store.state!.vendors).toEqual(before.vendors); expect(t.store.state!.vendorBills).toEqual(before.vendorBills);
    expect(t.store.state!.vendorPayments).toEqual(before.vendorPayments); expect(t.store.state!.ledger).toEqual(before.ledger);
    const committed = canonicalErpJson(t.store.state), count = t.store.commits.length;
    expect((await executeErp(t.dependencies, request)).replayed).toBe(true);
    expect(canonicalErpJson(t.store.state)).toBe(committed); expect(t.store.commits).toHaveLength(count);
  });
  it.each(['cash', 'accrual'] as const)('promotes only on purchasing and posts one bill with two exact partial payments (%s)', async basis => {
    const t = fixture(basis); await t.initialize();
    expect(t.store.state?.schemaVersion).toBe(1); expect(t.store.state).not.toHaveProperty('vendors');
    const original = structuredClone(t.store.state), initialReceipt = structuredClone(t.store.events[0].receipt);
    await t.saveVendor(); const registered = purchasingState(t.store.state);
    expect(registered.vendors).toEqual([vendor]); expect(registered.vendorBills).toEqual([]); expect(registered.vendorPayments).toEqual([]);
    await t.recordBill(); const recorded = purchasingState(t.store.state).vendorBills[0];
    expect(recorded).toMatchObject({ id: bill.id, vendorId: vendor.id, vendorSnapshot: vendor, net: money('USD', '10000'), tax: money('USD', '825'),
      total: money('USD', '10825'), validatedBy: initialActor.userId, approvedAt: initialActor.timestamp, approvalSource: 'manual_entry', recordedRevision: 3 });
    const billCommit = t.store.commits.at(-1)!;
    expect(billCommit.changes.map(change => change.kind)).toEqual(basis === 'accrual' ? ['vendor_bill', 'journal'] : ['vendor_bill']);
    expect(billCommit.ledgerAudit).toHaveLength(basis === 'accrual' ? 1 : 0);
    if (basis === 'accrual') expect(t.store.state!.ledger.entries[0].lines).toEqual([
      { accountId: 'purchases', debitMinor: '10825', creditMinor: '0' }, { accountId: 'payables', debitMinor: '0', creditMinor: '10825' },
    ]);
    await t.pay('partial-1', '5000', 'vendor-partial-1');
    expect(vendorBillBalance(recorded, purchasingState(t.store.state).vendorPayments).minorUnits).toBe('5825');
    await t.pay('partial-2', '5825', 'vendor-partial-2'); const state = purchasingState(t.store.state);
    expect(state.vendorPayments.map(value => [value.amount.minorUnits, value.recordedRevision, value.recordedBy])).toEqual([
      ['5000', 4, initialActor.userId], ['5825', 5, initialActor.userId],
    ]);
    expect(vendorBillBalance(recorded, state.vendorPayments).minorUnits).toBe('0'); expect(state.vendorBills[0]).toEqual(recorded);
    expect(state.ledger.entries).toHaveLength(basis === 'accrual' ? 3 : 2);
    for (const [index, amount] of ['5000', '5825'].entries()) {
      const entry = state.ledger.entries[index + (basis === 'accrual' ? 1 : 0)];
      expect(entry.lines).toEqual([{ accountId: basis === 'accrual' ? 'payables' : 'purchases', debitMinor: amount, creditMinor: '0' },
        { accountId: 'cash', debitMinor: '0', creditMinor: amount, description: `partial-${index + 1}` }]);
      expect(entry.source).toEqual({ type: 'vendor_payment', id: bill.id }); expect(entry.cashFlowCategory).toBe('operating');
    }
    expect(trialBalance(state.ledger, '2026-12-31').balanced).toBe(true);
    expect(profitAndLoss(state.ledger, { start: '2026-01-01', end: '2026-12-31' }).expenseMinor).toBe('10825');
    expect(cashFlow(state.ledger, { start: '2026-01-01', end: '2026-12-31' }).operatingMinor).toBe('-10825');
    expect(state.counters).toEqual({ estimate: 0, invoice: 0 }); expect(validateStoredErp(state, organizationId)).toBe(state);
    expect(t.taxProvider).not.toHaveBeenCalled(); expect(t.seller).not.toHaveBeenCalled();
    expect(original?.schemaVersion).toBe(1); expect(t.store.events[0].receipt).toEqual(initialReceipt);
    let reconstructed: ErpState | null = null;
    for (const event of t.store.events) reconstructed = applyErpDelta(reconstructed, delta(event.revision - 1, event.revision, [event]), organizationId, 2);
    expect(canonicalErpJson(reconstructed)).toBe(canonicalErpJson(state));
    expect(canonicalErpJson(applyErpDelta(null, delta(0, state.revision, t.store.events), organizationId, 2))).toBe(canonicalErpJson(state));
    expect(() => applyErpDelta(null, delta(0, state.revision, t.store.events), organizationId)).toThrow('client_upgrade_required');
    expect(Object.keys(t.store.commits.at(-1)!.header).sort()).toEqual(['configuration', 'counters', 'ledger', 'revision', 'schemaVersion']);
  });

  it.each([1, undefined] as const)('keeps old schema-1 books and refuses all purchasing without support %s', async capability => {
    const t = fixture('accrual', capability); if (capability === undefined) delete t.store.supportedSchemaVersion;
    await t.initialize(); await t.send({ type: 'save_customer', customer: { ...vendor, id: 'old-customer' } });
    for (const command of [{ type: 'save_vendor' as const, vendor }, { type: 'record_vendor_bill' as const, ...bill }, t.payment()]) {
      await noMutation(t, () => t.send(command), { code: 'purchasing_unavailable', status: 409 });
    }
    expect(t.store.state?.schemaVersion).toBe(1); expect(Object.keys(t.store.state!).sort()).toEqual([
      'configuration', 'counters', 'customers', 'estimates', 'invoices', 'ledger', 'revision', 'schemaVersion',
    ]); expect(validateStoredErp(t.store.state, organizationId)).toBe(t.store.state);
  });

  it('refuses an old client capability after promotion instead of dropping purchasing state', async () => {
    const t = fixture(); await t.prepare(); t.store.supportedSchemaVersion = 1;
    await noMutation(t, () => t.send({ type: 'save_customer', customer: { ...vendor, id: 'customer-1' } }), { code: 'client_upgrade_required', status: 409 });
    expect(purchasingState(t.store.state).vendorBills).toHaveLength(1);
  });

  it.each(['owner', 'admin', 'accountant'] as const)('records the actual %s identity for vendor approval and payment', async role => {
    const t = fixture(); await t.initialize(); const admitted = { ...initialActor, role, userId: `fictitious-${role}-actual` };
    t.actor(admitted); await t.saveVendor(); await t.recordBill(); await t.pay(); const state = purchasingState(t.store.state);
    expect(state.vendorBills[0].validatedBy).toBe(admitted.userId); expect(state.vendorPayments[0].recordedBy).toBe(admitted.userId);
    expect(state.ledger.audit.every(event => event.actorId === admitted.userId)).toBe(true);
    expect(state.ledger.entries.every(entry => entry.postedBy === admitted.userId)).toBe(true);
  });

  it.each(['member', 'read_only'] as const)('denies every purchasing mutation to %s', async role => {
    const t = fixture(); await t.prepare(); t.actor({ ...initialActor, role });
    for (const command of [{ type: 'save_vendor' as const, vendor }, { type: 'record_vendor_bill' as const, ...bill, id: 'other-bill' }, t.payment()]) {
      await noMutation(t, () => t.send(command), { code: 'financial_permission_required', status: 403 });
    }
  });

  it('freezes the vendor snapshot despite later supplier edits and retains prior events and receipts', async () => {
    const t = fixture(); await t.prepare(); const recorded = structuredClone(purchasingState(t.store.state).vendorBills[0]);
    const history = structuredClone(t.store.events); await t.saveVendor({ ...vendor, name: 'Changed supplier', billingAddress: { ...vendor.billingAddress, line1: '2 Changed Street' } });
    await t.pay(); const state = purchasingState(t.store.state);
    expect(state.vendors[0].name).toBe('Changed supplier'); expect(state.vendorBills[0]).toEqual(recorded);
    expect(state.vendorBills[0].vendorSnapshot.name).toBe(vendor.name); expect(t.store.events.slice(0, history.length)).toEqual(history);
    expect(validateStoredErp(structuredClone(state), organizationId)).toEqual(state);
  });

  it.each(['cash', 'accrual'] as const)('reconstructs a mixed customer and supplier journal chronology (%s)', async basis => {
    const t = fixture(basis); t.dependencies.configuration = { ...t.dependencies.configuration, taxConfiguration: { status: 'configured' } };
    const provider: TaxCalculationProvider = { id: 'explicit-fictitious-sales-provider', async calculate(request) {
      return { ...request, source: 'external-provider', providerReference: 'fictitious-sales-proof', determinedAt: initialActor.timestamp,
        validUntil: '2026-10-09T12:00:00.000Z', lines: request.lines.map(line => ({ id: line.id, taxMinor: '825', jurisdiction: 'fictitious-US-NY', evidenceReference: 'fixture-only' })) };
    } };
    t.dependencies.taxProvider = vi.fn(async () => provider); t.dependencies.seller = vi.fn(async () => ({ organizationId, displayName: 'Fictitious seller' }));
    await t.initialize(); await t.send({ type: 'save_customer', customer: { ...vendor, id: 'customer-1' } });
    await t.send({ type: 'save_estimate', id: 'estimate-1', expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: 30,
      lines: [{ id: 'line-1', description: 'Fictitious service', quantityUnits: '1', quantityScale: 0, unitPrice: money('USD', '20000'), discountBasisPoints: 0, taxTreatment: 'taxable' }], notes: '' });
    await t.send({ type: 'accept_estimate', estimateId: 'estimate-1', expectedEstimateRevision: 1 });
    await t.send({ type: 'issue_invoice', id: 'invoice-1', estimateId: 'estimate-1', expectedEstimateRevision: 2, date: '2026-10-08', accountingDate: '2026-10-09', dueDate: '2026-11-07', periodId: '2026' });
    const originalInvoice = structuredClone(t.store.state!.invoices[0]); const originalReceipt = structuredClone(t.store.events.at(-1)!.receipt);
    await t.saveVendor(); await t.recordBill(); await t.send({ type: 'record_payment', id: 'customer-payment', invoiceId: 'invoice-1', amountMinor: '20825', paymentDate: '2026-10-10', accountingDate: '2026-10-11', periodId: '2026', reference: 'fictitious-client-receipt' });
    await t.pay('supplier-partial-1', '5000'); await t.pay('supplier-partial-2', '5825'); const state = purchasingState(t.store.state);
    expect(state.invoices[0].taxAssessment).toEqual(originalInvoice.taxAssessment); expect(state.invoices[0].sellerSnapshot).toEqual(originalInvoice.sellerSnapshot);
    expect(invoiceBalance(state.invoices[0]).minorUnits).toBe('0'); expect(state.counters).toEqual({ estimate: 1, invoice: 1 });
    expect(state.ledger.entries.map(entry => entry.source.type)).toEqual(basis === 'cash'
      ? ['customer_payment', 'vendor_payment', 'vendor_payment']
      : ['customer_invoice', 'vendor_bill', 'customer_payment', 'vendor_payment', 'vendor_payment']);
    expect(validateStoredErp(JSON.parse(JSON.stringify(state)), organizationId)).toEqual(state);
    expect(trialBalance(state.ledger, '2026-12-31').balanced).toBe(true);
    expect(profitAndLoss(state.ledger, { start: '2026-01-01', end: '2026-12-31' })).toMatchObject({ incomeMinor: '20000', expenseMinor: '10825', profitMinor: '9175' });
    expect(t.store.receipts.get(originalReceipt.idempotencyKey)).toEqual(originalReceipt);
  });

  it('returns the historical receipt after later changes without approving, paying or posting twice', async () => {
    const t = fixture(); await t.initialize(); await t.saveVendor(); const command = { type: 'record_vendor_bill' as const, ...bill };
    const request = t.request(command, 'stable-bill'), first = await executeErp(t.dependencies, request);
    await t.pay(); await t.saveVendor({ ...vendor, name: 'Updated supplier' }); const count = t.store.commits.length;
    expect(await executeErp(t.dependencies, request)).toEqual({ ...first, replayed: true }); expect(t.store.commits).toHaveLength(count);
    await noMutation(t, () => executeErp(t.dependencies, { ...request, command: { ...command, sourceReference: 'different-source' } }), { code: 'idempotency_conflict', status: 409 });
    expect(purchasingState(t.store.state).vendorBills).toHaveLength(1);
  });

  it.each(['record_vendor_bill', 'record_vendor_payment'] as const)('recovers an ambiguous committed %s with the identical request', async action => {
    const t = fixture(); await t.initialize(); await t.saveVendor(); if (action === 'record_vendor_payment') await t.recordBill();
    const command = action === 'record_vendor_bill' ? { type: action, ...bill } : t.payment(); const request = t.request(command, `lost-${action}`);
    t.store.loseNextResponse = true; await expect(executeErp(t.dependencies, request)).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
    const stored = canonicalErpJson(t.store.state), count = t.store.commits.length, receipt = t.store.receipts.get(request.idempotencyKey);
    expect(receipt).toBeDefined(); expect(await executeErp(t.dependencies, request)).toEqual({ receipt, replayed: true });
    expect(canonicalErpJson(t.store.state)).toBe(stored); expect(t.store.commits).toHaveLength(count); expect(t.store.events).toHaveLength(count);
  });

  it('does not partially mutate anything when the atomic store fails before commit', async () => {
    const t = fixture(); await t.initialize(); await t.saveVendor(); t.store.failBeforeCommit = true;
    await noMutation(t, () => t.recordBill(), { code: 'service_unavailable', status: 503 });
    expect(purchasingState(t.store.state).vendorBills).toEqual([]); expect(t.store.state!.ledger.entries).toEqual([]);
  });

  it('rejects stale ERP revisions and allows only one concurrent CAS winner', async () => {
    const t = fixture(); await t.prepare(); const expectedRevision = t.store.state!.revision;
    await noMutation(t, () => executeErp(t.dependencies, { ...t.request(t.payment(), 'stale'), expectedRevision: expectedRevision - 1 }), { code: 'revision_conflict', status: 409 });
    const results = await Promise.allSettled(['concurrent-a', 'concurrent-b'].map(id => executeErp(t.dependencies, { command: t.payment(id), idempotencyKey: id, expectedRevision })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(purchasingState(t.store.state).vendorPayments).toHaveLength(1);
    expect(t.store.state!.revision).toBe(expectedRevision + 1);
  });

  it('rejects absent vendors, absent bills, duplicate bill identities and payment identities', async () => {
    const t = fixture(); await t.initialize(); await noMutation(t, () => t.recordBill(), { code: 'vendor_required', status: 422 });
    await t.saveVendor(); await noMutation(t, () => t.pay(), { status: 404 }); await t.recordBill();
    await noMutation(t, () => t.recordBill({ ...bill, netMinor: '9999' }), { status: 409 }); await t.pay();
    await noMutation(t, () => t.pay(), { status: 409 });
  });

  it('does not admit the same vendor reference/date again under a different bill ID', async () => {
    const t = fixture(); await t.prepare();
    await noMutation(t, () => t.recordBill({ ...bill, id: 'different-id-same-source' }), { code: 'vendor_bill_already_recorded', status: 409 });
  });

  it('keeps partial-payment balances independent across two supplier bills', async () => {
    const t = fixture(); await t.prepare(); const second = { ...bill, id: 'bill-2', reference: 'FICTITIOUS-BILL-2', sourceReference: 'manual:fictitious-source-2', netMinor: '2000', purchaseTaxMinor: '0' };
    await t.recordBill(second); await t.pay('first-partial', '5000'); await t.pay('second-paid', '2000', undefined, second.id);
    const state = purchasingState(t.store.state);
    expect(vendorBillBalance(state.vendorBills[0], state.vendorPayments.filter(payment => payment.billId === bill.id)).minorUnits).toBe('5825');
    expect(vendorBillBalance(state.vendorBills[1], state.vendorPayments.filter(payment => payment.billId === second.id)).minorUnits).toBe('0');
    await noMutation(t, () => t.pay('second-overpaid', '1', undefined, second.id), { status: 409 });
    expect(validateStoredErp(state, organizationId)).toBe(state);
  });

  it.each(['cash', 'accrual'] as const)('retains exact cents beyond JavaScript safe-integer precision (%s)', async basis => {
    const t = fixture(basis); await t.initialize(); await t.saveVendor();
    const exact = '9007199254740993'; await t.recordBill({ ...bill, netMinor: exact, purchaseTaxMinor: '0' });
    await t.pay('large-payment', exact); const state = purchasingState(t.store.state);
    expect(state.vendorBills[0].net.minorUnits).toBe(exact); expect(state.vendorBills[0].total.minorUnits).toBe(exact);
    expect(state.vendorPayments[0].amount.minorUnits).toBe(exact); expect(state.ledger.entries.at(-1)!.lines.map(line => [line.debitMinor, line.creditMinor])).toEqual([[exact, '0'], ['0', exact]]);
    expect(trialBalance(state.ledger, '2026-12-31').balanced).toBe(true);
  });

  it.each(['cash', 'accrual'] as const)('refuses bills and payments in a closed accounting period (%s)', async basis => {
    const t = fixture(basis); await t.prepare(); await t.send({ type: 'close_period', periodId: '2026' });
    await noMutation(t, () => t.recordBill({ ...bill, id: 'closed-bill', reference: 'FICTITIOUS-CLOSED-BILL' }), { code: 'accounting_period_not_open', status: 409 });
    await noMutation(t, () => t.pay(), { code: 'accounting_period_not_open', status: 409 });
  });

  it.each(['cash', 'accrual'] as const)('refuses overpayment before or after a partial payment (%s)', async basis => {
    const t = fixture(basis); await t.prepare(); await noMutation(t, () => t.pay('too-much', '10826'), { status: 409 });
    await t.pay('partial', '5000'); await noMutation(t, () => t.pay('too-much-after', '5826'), { status: 409 });
    expect(vendorBillBalance(purchasingState(t.store.state).vendorBills[0], purchasingState(t.store.state).vendorPayments).minorUnits).toBe('5825');
  });

  const invalidBills: [string, Partial<BillInput>][] = [
    ['blank source', { sourceReference: ' ' }], ['source control', { sourceReference: 'source\u0000bad' }], ['source too long', { sourceReference: 's'.repeat(501) }],
    ['purchase account', { expenseAccountId: 'cash' }], ['due before bill', { dueDate: '2026-10-07' }], ['impossible date', { date: '2026-02-30' }],
    ['zero total', { netMinor: '0', purchaseTaxMinor: '0' }], ['negative purchase tax', { purchaseTaxMinor: '-1' }], ['decimal minor', { netMinor: '1.25' }],
    ['noncanonical minor', { netMinor: '01' }], ['oversized sum', { netMinor: '9'.repeat(36), purchaseTaxMinor: '1' }],
  ];
  it.each(invalidBills)('rejects invalid bill %s without consuming a revision', async (_label, update) => {
    const t = fixture(); await t.initialize(); await t.saveVendor(); await noMutation(t, () => t.recordBill({ ...bill, ...update }));
  });

  it.each(['validatedBy', 'approvedAt', 'approvalSource', 'vendorSnapshot', 'recordedRevision', 'role', 'total', 'taxAssessment'])('rejects submitted calculated or authority field %s', async field => {
    const t = fixture(); await t.initialize(); await t.saveVendor();
    await noMutation(t, () => executeErp(t.dependencies, t.request({ type: 'record_vendor_bill', ...bill, [field]: 'forged' } as PurchaseCommand)), { code: 'invalid_request', status: 422 });
  });

  it('refuses a foreign vendor and a foreign financial actor without touching storage', async () => {
    const t = fixture(); await t.initialize();
    await noMutation(t, () => t.saveVendor({ ...vendor, organizationId: 'another-workspace' }), { code: 'tenant_mismatch', status: 403 });
    t.actor({ ...initialActor, organizationId: 'another-workspace' }); await noMutation(t, () => t.saveVendor(), { code: 'tenant_mismatch', status: 403 });
  });

  it('permits an explicitly Swiss supplier address without changing the US book or inferring a VAT credit', async () => {
    const t = fixture(); await t.initialize();
    const foreignSupplier: Contact = { ...vendor, billingAddress: { country: 'CH', line1: '1 Rue Exemple', city: 'Genève', subdivision: 'GE', postalCode: '1201' } };
    await t.saveVendor(foreignSupplier); await t.recordBill(); const state = purchasingState(t.store.state);
    expect(state.configuration.country).toBe('US'); expect(state.vendorBills[0].currency).toBe('USD');
    expect(state.vendorBills[0].vendorSnapshot.billingAddress).toEqual(foreignSupplier.billingAddress);
    expect(state.ledger.entries[0].lines).toEqual([{ accountId: 'purchases', debitMinor: '10825', creditMinor: '0' }, { accountId: 'payables', debitMinor: '0', creditMinor: '10825' }]);
    expect(t.taxProvider).not.toHaveBeenCalled(); expect(t.seller).not.toHaveBeenCalled();
  });

  it('uses a fresh admitted actor timestamp before approval/payment stamps and rechecks before commit', async () => {
    const t = fixture(); await t.initialize(); await t.saveVendor(); let count = 0;
    t.dependencies.revalidate = vi.fn(async () => ({ ...initialActor, timestamp: `2026-10-08T12:00:${String(++count).padStart(2, '0')}.000Z` }));
    await t.recordBill(); const state = purchasingState(t.store.state), recorded = state.vendorBills[0];
    expect(recorded.approvedAt).not.toBe(initialActor.timestamp); expect(state.ledger.entries[0].postedAt).toBe(recorded.approvedAt);
    expect(t.dependencies.revalidate).toHaveBeenCalledTimes(2); expect(recorded.approvedAt).toBe('2026-10-08T12:00:02.000Z');
    expect(t.store.commits.at(-1)!.actor.timestamp).toBe(recorded.approvedAt);
    count = 0; vi.mocked(t.dependencies.revalidate).mockClear(); await t.pay();
    const paid = purchasingState(t.store.state).vendorPayments[0]; expect(paid.recordedAt).not.toBe(initialActor.timestamp);
    expect(t.store.state!.ledger.entries.at(-1)!.postedAt).toBe(paid.recordedAt); expect(t.dependencies.revalidate).toHaveBeenCalledTimes(2);
    expect(paid.recordedAt).toBe('2026-10-08T12:00:02.000Z'); expect(t.store.commits.at(-1)!.actor.timestamp).toBe(paid.recordedAt);
  });

  it.each(['record_vendor_bill', 'record_vendor_payment'] as const)('withholds %s when admission is revoked before stamping or at final commit', async action => {
    for (const refusedCall of [1, 2]) {
      const t = fixture(); await t.initialize(); await t.saveVendor(); if (action === 'record_vendor_payment') await t.recordBill(); let calls = 0;
      t.dependencies.revalidate = async () => (++calls === refusedCall ? { ...initialActor, managementEntitled: false } : initialActor);
      await noMutation(t, () => action === 'record_vendor_bill' ? t.recordBill() : t.pay(), { code: 'management_entitlement_required', status: 402 });
    }
  });

  it.each(['user', 'organization', 'role'] as const)('rejects a changed %s during awaited admission rather than stamping submitted authority', async change => {
    const t = fixture(); await t.initialize(); await t.saveVendor(); t.dependencies.revalidate = async () => ({ ...initialActor,
      ...(change === 'user' ? { userId: 'other-user' } : change === 'organization' ? { organizationId: 'other-org' } : { role: 'member' as const }) });
    await noMutation(t, () => t.recordBill(), { status: change === 'user' ? 401 : 403 });
  });

  it('revalidates old receipts and does not disclose them after revocation during lookup', async () => {
    const t = fixture(); await t.initialize(); await t.saveVendor(); const request = t.request({ type: 'record_vendor_bill', ...bill }, 'revoked-replay');
    await executeErp(t.dependencies, request); t.store.beforeReceipt = () => { t.dependencies.revalidate = async () => ({ ...initialActor, managementEntitled: false }); };
    await noMutation(t, () => executeErp(t.dependencies, request), { code: 'management_entitlement_required', status: 402 });
  });

  it.each(['save_vendor', 'record_vendor_bill', 'record_vendor_payment'] as const)('rejects %s after entitlement revocation during the state read', async action => {
    const t = fixture(); await t.prepare();
    t.store.beforeRead = () => { t.dependencies.revalidate = async () => ({ ...initialActor, managementEntitled: false }); };
    const command = action === 'save_vendor' ? { type: action, vendor: { ...vendor, name: 'Denied update' } }
      : action === 'record_vendor_bill' ? { type: action, ...bill, id: 'denied-new-bill', reference: 'FICTITIOUS-DENIED-BILL' } : t.payment();
    await noMutation(t, () => t.send(command), { code: 'management_entitlement_required', status: 402 });
  });

  it('does not let another admitted financial user claim an earlier actor receipt', async () => {
    const t = fixture(); await t.initialize(); await t.saveVendor(); const request = t.request({ type: 'record_vendor_bill', ...bill }, 'actor-scoped-receipt');
    await executeErp(t.dependencies, request); t.actor({ ...initialActor, role: 'accountant', userId: 'different-fictitious-accountant' });
    await noMutation(t, () => executeErp(t.dependencies, request), { code: 'idempotency_conflict', status: 409 });
  });

  it('copies submitted supplier and bill facts before an awaited receipt lookup', async () => {
    const t = fixture(); await t.initialize(); const submitted = structuredClone({ ...vendor, billingAddress: { ...vendor.billingAddress } });
    t.store.beforeReceipt = () => { submitted.name = 'Mutated while waiting'; submitted.billingAddress.line1 = 'Changed while waiting'; };
    await t.saveVendor(submitted); expect(purchasingState(t.store.state).vendors[0]).toEqual(vendor);
    const input = { ...bill }; t.store.beforeReceipt = () => { input.netMinor = '99999'; input.sourceReference = 'changed-after-admission'; };
    await t.recordBill(input); expect(purchasingState(t.store.state).vendorBills[0]).toMatchObject({ net: money('USD', '10000'), sourceReference: bill.sourceReference });
  });

  it('accepts the exact supplier-payment key bound and preserves the older command key bound', async () => {
    const t = fixture(); await t.prepare(); await t.pay('long-key-payment', '5000', 'k'.repeat(225));
    expect(t.store.state!.ledger.entries.at(-1)!.idempotencyKey).toBe(`vendor-payment:${'k'.repeat(225)}`);
    await noMutation(t, () => t.pay('too-long', '1', 'k'.repeat(226)), { status: 422 });
    await t.saveVendor({ ...vendor, name: 'Allowed old-length command' });
    await t.send({ type: 'save_customer', customer: { ...vendor, id: 'legacy-key-customer' } }, 'k'.repeat(232));
    expect(t.store.receipts.has('k'.repeat(232))).toBe(true);
  });

  it('preserves supplier data through existing customer and configuration commands', async () => {
    const t = fixture(); await t.prepare(); const before = structuredClone(purchasingState(t.store.state));
    await t.send({ type: 'save_customer', customer: { ...vendor, id: 'later-customer' } });
    t.dependencies.configuration = { ...t.dependencies.configuration, language: 'fr' }; await t.send({ type: 'refresh_configuration' });
    const after = purchasingState(t.store.state); expect(after.vendors).toEqual(before.vendors); expect(after.vendorBills).toEqual(before.vendorBills);
    expect(after.vendorPayments).toEqual(before.vendorPayments); expect(after.configuration.language).toBe('fr'); expect(validateStoredErp(after, organizationId)).toBe(after);
  });

  it('rejects a tampered supplier amount, source, revision or orphan instead of accepting a balanced fabricated ledger', async () => {
    const t = fixture(); await t.prepare(); await t.pay(); const state = purchasingState(t.store.state);
    const mutations: ((value: PurchasingState) => void)[] = [
      value => { value.vendorBills = [{ ...value.vendorBills[0], total: money('USD', '10826') }]; },
      value => { value.vendorBills = [{ ...value.vendorBills[0], approvalSource: 'forged' as 'manual_entry' }]; },
      value => { value.vendorBills = [{ ...value.vendorBills[0], recordedRevision: state.revision + 1 }]; },
      value => { value.vendorPayments = [{ ...value.vendorPayments[0], billId: 'missing-bill' }]; },
    ];
    for (const mutate of mutations) { const altered = structuredClone(state); mutate(altered); expect(() => validateStoredErp(altered, organizationId)).toThrow('invalid_stored_state'); }
  });
});
