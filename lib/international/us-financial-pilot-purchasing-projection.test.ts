import { beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import { applyUsFinancialOperationV5, projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import { usFinancialErpEntityIdV5 } from './us-financial-kernel-erp';
import type { UsFinancialBookV5, UsFinancialErpCommandV5 } from './us-financial-kernel-types';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { createInMemoryUsFinancialKernelStoreV5, executeUsFinancialKernelV5 } from './us-financial-kernel-runtime';
import { buildUsFinancialPilotPurchasingRequest, validateUsFinancialPilotPurchasingRequest, type UsFinancialPilotPurchasingCommand } from './us-financial-pilot-purchasing';
import { financialPilotPurchasingCursor, financialPilotPurchasingCursorOffset, projectUsFinancialPilotVendor, projectUsFinancialPilotVendorBill, projectUsFinancialPilotVendorBills,
  validateUsFinancialPilotPurchasingPage, validateUsFinancialPilotVendorBillDetail, validateUsFinancialPilotVendorDetail,
  validateUsFinancialPilotVendorBillDetailQuery, validateUsFinancialPilotVendorBillsQuery, validateUsFinancialPilotVendorDetailQuery } from './us-financial-pilot-purchasing-projection';

/** Synthetic actual V5 runtime, one book and CAS; no hosted/SQL assertion. */
async function fixture() {
  const data = await financialKernelFixture(), initial = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor), store = await createInMemoryUsFinancialKernelStoreV5(initial, data.policy, actor => actor);
  const tax = vi.fn(async (): Promise<never> => { throw Error('Purchasing must not call a tax provider'); });
  const deps = { ...data, store, resolveTax: tax, resolveIssuance: tax, revalidate: async () => ({ configuration: data.configuration, actor: data.actor, policy: data.policy }) };
  const read = async () => (await store.read(data.configuration.organizationId)) as UsFinancialBookV5;
  let sequence = 0;
  const send = async (command: UsFinancialPilotPurchasingCommand) => {
    const before = await read(), request = validateUsFinancialPilotPurchasingRequest({ consumer: 'financial-pilot', schemaVersion: 1, requestId: `a1000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, expectedRevision: before.revision, command });
    return executeUsFinancialKernelV5(deps, buildUsFinancialPilotPurchasingRequest(request, data.configuration.organizationId));
  };
  const vendor = { kind: 'business', name: 'Synthetic vendor original 🌍', billingAddress: data.configuration.address, shippingAddress: null, email: null, phone: null, contactName: null, paymentTermsDays: 30 } as const;
  const created = await send({ type: 'save_vendor', vendorId: null, vendor });
  const bill = (overrides: Partial<Extract<UsFinancialPilotPurchasingCommand, { type: 'record_vendor_bill' }>> = {}): UsFinancialPilotPurchasingCommand => ({ type: 'record_vendor_bill', vendorId: created.entityId, reference: 'Synthetic original invoice',
    date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026', netMinor: '9007199254740993', purchaseTaxMinor: '825', sourceReference: 'Manual note 🌍', ...overrides });
  const recorded = await send(bill());
  const payment = (amountMinor = '100', overrides: Partial<Extract<UsFinancialPilotPurchasingCommand, { type: 'record_vendor_payment' }>> = {}): UsFinancialPilotPurchasingCommand => ({ type: 'record_vendor_payment', billId: recorded.entityId, amountMinor,
    paymentDate: '2026-10-09', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic already executed transfer', ...overrides });
  return { ...data, initial, store, deps, read, send, vendor, vendorId: created.entityId, billId: recorded.entityId, bill, payment, tax };
}

describe('financial-pilot purchasing projections from the sole validated V5 book', () => {
  it('keeps big money exact, cost tax separate, and balances all partial/final recorded payments', async () => {
    const t = await fixture(); let book = await t.read(), detail = await projectUsFinancialPilotVendorBill(book, { revision: book.revision, billId: t.billId });
    expect(detail.bill).toMatchObject({ totalMinor: '9007199254741818', netMinor: '9007199254740993', purchaseTaxMinor: '825', paidMinor: '0', outstandingMinor: '9007199254741818', status: 'open', approvedBy: t.actor.userId, approvedAt: t.actor.timestamp });
    expect(detail).toMatchObject({ sourceReference: 'Manual note 🌍', approvalSource: 'manual_entry' });
    const paid = await t.send(t.payment()); book = await t.read(); detail = await projectUsFinancialPilotVendorBill(book, { revision: book.revision, billId: t.billId });
    expect(detail.bill).toMatchObject({ paidMinor: '100', outstandingMinor: '9007199254741718', status: 'partially_paid' });
    expect(detail.payments.items[0]).toMatchObject({ id: paid.entityId, amountMinor: '100', billId: t.billId, periodId: '2026', recordedBy: t.actor.userId, recordedAt: t.actor.timestamp, paymentDate: '2026-10-09', recordedRevision: paid.revision });
    await t.send(t.payment(detail.bill.outstandingMinor)); book = await t.read(); detail = await projectUsFinancialPilotVendorBill(book, { revision: book.revision, billId: t.billId });
    expect(detail.bill).toMatchObject({ paidMinor: '9007199254741818', outstandingMinor: '0', status: 'paid' });
    expect(detail.payments.items.map(row => row.recordedRevision)).toEqual(detail.payments.items.map(row => row.recordedRevision).sort((a, b) => b - a));
    const view = await projectUsFinancialBookV5(book); expect(view.invoices).toHaveLength(1); expect(view.vendorBills).toHaveLength(1);
    const billPosting = view.ledger.entries.find(row => row.source.type === 'vendor_bill');
    expect(billPosting?.lines.find(row => row.accountId === 'purchases')?.debitMinor).toBe('9007199254741818'); expect(t.tax).not.toHaveBeenCalled();
  });
  it('retains immutable supplier snapshot after current supplier changes and exposes only public DTOs', async () => {
    const t = await fixture(); await t.send(t.payment()); await t.send({ type: 'save_vendor', vendorId: t.vendorId, vendor: { ...t.vendor, name: 'Synthetic vendor changed' } });
    const book = await t.read(), before = canonicalErpJson(book), detail = await projectUsFinancialPilotVendorBill(book, { revision: book.revision, billId: t.billId }), live = await projectUsFinancialPilotVendor(book, { revision: book.revision, vendorId: t.vendorId });
    expect(detail.vendor.name).toBe(t.vendor.name); expect(detail.bill.vendorName).toBe(t.vendor.name); expect(live.vendor.name).toBe('Synthetic vendor changed');
    const text = JSON.stringify({ detail, live });
    for (const forbidden of ['idempotencyKey', 'baselineSha256', 'pilot:purchasing:', 'organizationId":"other', 'vendorSnapshot', 'expenseAccountId', 'taxAssessment', 'policy', 'effects', 'commit', 'providerReference']) expect(text).not.toContain(forbidden);
    expect(canonicalErpJson(book)).toBe(before); expect(Object.isFrozen(detail.vendor.billingAddress)).toBe(true); expect(Object.isFrozen(detail.payments.items[0])).toBe(true);
    expect(validateUsFinancialPilotVendorDetail(live, live.organizationId, live.revision, t.vendorId)).toEqual(live);
    expect(() => validateUsFinancialPilotVendorDetail(live, live.organizationId, live.revision, 'other')).toThrow(expect.objectContaining({ status: 503 }));
  });
  it('rejects corrupt sources, stale head, missing IDs and malformed selectors', async () => {
    const t = await fixture(), book = await t.read(), query = { revision: book.revision, billId: t.billId };
    await expect(projectUsFinancialPilotVendorBills({ ...book, revision: book.revision + 1 }, { revision: book.revision })).rejects.toMatchObject({ status: 503 });
    await expect(projectUsFinancialPilotVendorBill(book, { ...query, revision: book.revision - 1 })).rejects.toMatchObject({ code: 'financial_snapshot_changed', status: 409 });
    await expect(projectUsFinancialPilotVendorBill(book, { ...query, billId: 'missing' })).rejects.toMatchObject({ code: 'financial_pilot_record_not_found', status: 404 });
    await expect(projectUsFinancialPilotVendor(book, { revision: book.revision, vendorId: 'missing' })).rejects.toMatchObject({ status: 404 });
    await expect(projectUsFinancialPilotVendorBill(book, { ...query, private: true } as never)).rejects.toMatchObject({ status: 422 });
    await expect(projectUsFinancialPilotVendorBills(book, { revision: book.revision, kind: 'vendors' } as never)).rejects.toMatchObject({ status: 422 });
    expect(() => validateUsFinancialPilotVendorDetailQuery({ revision: book.revision, vendorId: t.vendorId, organizationId: book.baseline.configuration.organizationId })).toThrow(expect.objectContaining({ status: 422 }));
  });
  it('captures source and each query synchronously before replay and rejects accessors/prototypes', async () => {
    const t = await fixture(), book = await t.read(), raw = structuredClone(book), query = { revision: raw.revision, billId: t.billId };
    const pending = projectUsFinancialPilotVendorBill(raw, query); query.billId = 'changed'; (raw as { revision: number }).revision++;
    expect((await pending).bill.id).toBe(t.billId);
    const vendorRaw = structuredClone(book), vendorQuery = { revision: book.revision, vendorId: t.vendorId }, pendingVendor = projectUsFinancialPilotVendor(vendorRaw, vendorQuery);
    vendorQuery.vendorId = 'changed'; (vendorRaw as { revision: number }).revision++; expect((await pendingVendor).vendor.id).toBe(t.vendorId);
    const billsRaw = structuredClone(book), listQuery = { revision: book.revision, cursor: null as string | null }, pendingList = projectUsFinancialPilotVendorBills(billsRaw, listQuery);
    listQuery.cursor = 'changed'; (billsRaw as { revision: number }).revision++; expect((await pendingList).items[0].id).toBe(t.billId);
    const getter = vi.fn(() => t.billId);
    await expect(projectUsFinancialPilotVendorBill(book, Object.defineProperty({ ...query }, 'billId', { enumerable: true, get: getter }))).rejects.toMatchObject({ status: 422 });
    await expect(projectUsFinancialPilotVendorBills(book, Object.assign(Object.create({ private: true }) as object, { revision: book.revision }) as never)).rejects.toMatchObject({ status: 422 });
    expect(getter).not.toHaveBeenCalled();
  });
  it('closes rows, balances, identities, revisions, source and payment metadata', async () => {
    const t = await fixture(); await t.send(t.payment()); const book = await t.read(), detail = await projectUsFinancialPilotVendorBill(book, { revision: book.revision, billId: t.billId });
    for (const patch of [
      { private: true }, { ledgerRevision: book.revision + 1 }, { sourceReference: 'x'.repeat(501) }, { approvalSource: 'automatic' },
      { vendor: { ...detail.vendor, name: 'Different' } }, { bill: { ...detail.bill, totalMinor: '1' } }, { bill: { ...detail.bill, paidMinor: '0' } },
      { bill: { ...detail.bill, status: 'paid' } }, { bill: { ...detail.bill, date: '2026-02-30' } }, { bill: { ...detail.bill, recordedRevision: book.revision + 1 } },
      { bill: { ...detail.bill, reference: 'x'.repeat(501) } }, { payments: { ...detail.payments, total: 0, items: [] } },
      { payments: { ...detail.payments, items: [{ ...detail.payments.items[0], idempotencyKey: 'private' }] } },
      { payments: { ...detail.payments, items: [{ ...detail.payments.items[0], billId: 'other' }] } },
      { payments: { ...detail.payments, items: [{ ...detail.payments.items[0], amountMinor: '101' }] } },
      { payments: { ...detail.payments, items: [{ ...detail.payments.items[0], recordedRevision: detail.bill.recordedRevision }] } },
    ]) expect(() => validateUsFinancialPilotVendorBillDetail({ ...detail, ...patch }, detail.organizationId, book.revision, t.billId)).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => validateUsFinancialPilotVendorBillDetail(detail, 'other')).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => validateUsFinancialPilotVendorBillDetail(detail, detail.organizationId, book.revision - 1)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => validateUsFinancialPilotVendorBillDetail(detail, detail.organizationId, book.revision, 'other')).toThrow(expect.objectContaining({ status: 503 }));
    const getter = vi.fn(() => 'private'); expect(() => validateUsFinancialPilotVendorBillDetail(Object.defineProperty({ ...detail }, 'private', { enumerable: true, get: getter }))).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('retains domain rejection of duplicate bills, overpayments and absent/open-period boundaries', async () => {
    const t = await fixture(), before = (await t.read()).revision;
    await expect(t.send(t.bill())).rejects.toMatchObject({ status: 409 });
    await expect(t.send(t.payment('9007199254741819'))).rejects.toMatchObject({ code: 'overpayment', status: 409 });
    await expect(t.send(t.payment('1', { periodId: 'absent' }))).rejects.toMatchObject({ code: 'accounting_period_not_open', status: 409 });
    await expect(t.send(t.payment('1', { accountingDate: '2027-01-01' }))).rejects.toMatchObject({ code: 'accounting_period_not_open', status: 409 });
    expect((await t.read()).revision).toBe(before);
  });
});

describe('financial-pilot actual V5 purchasing pagination beyond25', () => {
  let book: UsFinancialBookV5, firstBillId: string, lastVendorId: string;
  beforeAll(async () => {
    const t = await financialKernelFixture(); book = await promoteUsFinancialBookV5(t.baseline, t.policy, t.actor);
    const erp = async (command: UsFinancialErpCommandV5) => {
      book = (await applyUsFinancialOperationV5(book, { type: 'erp_command', idempotencyKey: `DO-NOT-EXPOSE-${book.revision}`, command, facts: { kind: 'none' } }, t.actor, usFinancialErpEntityIdV5(command, t.configuration.organizationId))).book;
    };
    for (let index = 0; index < 27; index++) {
      const suffix = String(index).padStart(2, '0'), vendorId = `vendor-${suffix}`, billId = `bill-${suffix}`;
      await erp({ type: 'save_vendor', vendor: { ...t.baseline.customers[0], id: vendorId, name: `Synthetic vendor ${suffix}` } });
      await erp({ type: 'record_vendor_bill', id: billId, vendorId, reference: `Bill ${suffix}`, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026', netMinor: '100', purchaseTaxMinor: '7', expenseAccountId: 'purchases', sourceReference: 'Manual source' });
      if (index === 0) firstBillId = billId; lastVendorId = vendorId;
    }
    for (let index = 0; index < 26; index++) await erp({ type: 'record_vendor_payment', id: `payment-${String(index).padStart(2, '0')}`, billId: firstBillId, amountMinor: '1', paymentDate: '2026-10-09', accountingDate: '2026-10-10', periodId: '2026', reference: `Synthetic transfer ${index}` });
  }, 60_000);
  it('returns stable recent-first bill pages and selected vendor/detail beyond the first page', async () => {
    const first = await projectUsFinancialPilotVendorBills(book, { revision: book.revision }), second = await projectUsFinancialPilotVendorBills(book, { revision: book.revision, cursor: first.nextCursor });
    expect(first.kind).toBe('vendor_bills'); expect(first.scope).toBeNull(); expect(first.items).toHaveLength(25); expect(first.total).toBe(27); expect(second.items).toHaveLength(2); expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map(row => row.id); expect(new Set(ids).size).toBe(27); expect(ids[0]).toBe('bill-26'); expect(ids.at(-1)).toBe(firstBillId);
    const detail = await projectUsFinancialPilotVendorBill(book, { revision: book.revision, billId: second.items[1].id }); expect(detail.bill.id).toBe(firstBillId);
    expect((await projectUsFinancialPilotVendor(book, { revision: book.revision, vendorId: lastVendorId })).vendor.id).toBe(lastVendorId);
    expect(validateUsFinancialPilotPurchasingPage(first, first.organizationId, book.revision, 'vendor_bills', null)).toEqual(first);
  }, 20_000);
  it('computes bill balance from all26 payments independently of either displayed page', async () => {
    const first = await projectUsFinancialPilotVendorBill(book, { revision: book.revision, billId: firstBillId }), second = await projectUsFinancialPilotVendorBill(book, { revision: book.revision, billId: firstBillId, paymentCursor: first.payments.nextCursor });
    expect(first.bill).toMatchObject({ paidMinor: '26', outstandingMinor: '81', status: 'partially_paid' }); expect(second.bill).toEqual(first.bill);
    expect(first.payments.items).toHaveLength(25); expect(first.payments.total).toBe(26); expect(second.payments.items).toHaveLength(1); expect(second.payments.nextCursor).toBeNull();
    expect(new Set([...first.payments.items, ...second.payments.items].map(row => row.id)).size).toBe(26); expect(first.payments.items[0].id).toBe('payment-25');
    expect(JSON.stringify({ first, second })).not.toContain('DO-NOT-EXPOSE');
  }, 20_000);
  it('rejects mismatched kind/revision/scope, noncanonical cursor and out-of-range pages', async () => {
    for (const cursor of [JSON.stringify(['vendors', book.revision, 25, null]), financialPilotPurchasingCursor('vendor_bills', book.revision - 1, 25, null), JSON.stringify(['vendor_bills', book.revision, 25, firstBillId]),
      JSON.stringify(['vendor_bills', book.revision, 24, null]), JSON.stringify(['vendor_bills', book.revision, 25, null]) + ' ', financialPilotPurchasingCursor('vendor_bills', book.revision, 50, null)]) {
      await expect(projectUsFinancialPilotVendorBills(book, { revision: book.revision, cursor })).rejects.toMatchObject({ status: 422 });
    }
    await expect(projectUsFinancialPilotVendorBill(book, { revision: book.revision, billId: firstBillId, paymentCursor: financialPilotPurchasingCursor('vendor_payments', book.revision, 25, 'other') })).rejects.toMatchObject({ status: 422 });
    const first = await projectUsFinancialPilotVendorBills(book, { revision: book.revision });
    for (const patch of [{ kind: 'vendors' }, { scope: 'other' }, { total: 0 }, { items: [first.items[0], first.items[0]] }, { items: [...first.items].reverse() }, { nextCursor: financialPilotPurchasingCursor('vendor_bills', book.revision, 50, null) }]) expect(() => validateUsFinancialPilotPurchasingPage({ ...first, ...patch })).toThrow(expect.objectContaining({ status: 503 }));
  }, 20_000);
});

describe('purchasing query/cursor capture', () => {
  it('rejects getters, symbols and prototype data without evaluating accessors', () => {
    const getter = vi.fn(() => 9);
    for (const validate of [validateUsFinancialPilotVendorBillsQuery, validateUsFinancialPilotVendorDetailQuery, validateUsFinancialPilotVendorBillDetailQuery]) {
      expect(() => validate(Object.defineProperty({}, 'revision', { enumerable: true, get: getter }))).toThrow(expect.objectContaining({ status: 422 }));
      expect(() => validate(Object.assign(Object.create({ revision: 9 }) as object, { billId: 'bill', vendorId: 'vendor' }))).toThrow(expect.objectContaining({ status: 422 }));
      expect(() => validate({ revision: 9, [Symbol('private')]: true })).toThrow(expect.objectContaining({ status: 422 }));
    }
    expect(getter).not.toHaveBeenCalled(); expect(financialPilotPurchasingCursorOffset(null, 'vendor_bills', 9, null)).toBe(0);
    for (const cursor of ['[]', 'x'.repeat(513), JSON.stringify(['vendor_bills', 9, 0, null]), JSON.stringify(['vendor_bills', 9, 1000025, null])]) expect(() => financialPilotPurchasingCursorOffset(cursor, 'vendor_bills', 9, null)).toThrow(expect.objectContaining({ status: 422 }));
  });
});
