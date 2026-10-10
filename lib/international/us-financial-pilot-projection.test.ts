import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import type { TaxCalculationProvider } from './invoicing';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { applyUsFinancialOperationV5, buildUsFinancialCreditCandidateV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import type { UsFinancialBookV5, UsFinancialErpCommandV5, UsFinancialOperationV5 } from './us-financial-kernel-types';
import { projectUsFinancialPilotInvoice, projectUsFinancialPilotInvoices, projectUsFinancialPilotList, projectUsFinancialPilotOverview } from './us-financial-pilot-projection';
import { financialPilotCursor } from './us-financial-pilot-contract';
import { usFinancialErpEntityIdV5 } from './us-financial-kernel-erp';
import { executeErp } from './runtime';
import { applyErpDelta } from './runtime-sync';
import type { ErpCommand, ErpState, ErpStore } from './runtime-types';

async function fixture(options: Parameters<typeof financialKernelFixture>[0] = {}) {
  const data = await financialKernelFixture(options); let book = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor);
  const apply = async (operation: UsFinancialOperationV5, id = `entity-${book.revision}`) => { book = (await applyUsFinancialOperationV5(book, operation, data.actor, operation.type === 'erp_command' ? usFinancialErpEntityIdV5(operation.command, data.configuration.organizationId) : id)).book; };
  const erp = (command: UsFinancialErpCommandV5, key = `private-command-${book.revision}`) => apply({ type: 'erp_command', idempotencyKey: key, command, facts: { kind: 'none' } });
  const credit = async (key = 'DO-NOT-EXPOSE-CREDIT-KEY') => {
    const input = { type: 'customer_credit' as const, idempotencyKey: key, invoiceId: 'invoice-1', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic adjustment', selections: [{ lineId: 'line-1', quantityUnits: '1' }] };
    const candidate = await buildUsFinancialCreditCandidateV5(book, input);
    await apply({ ...input, taxProof: { schemaVersion: 1, environment: 'test', kind: 'test_adjustment_authorization', invoiceFingerprint: candidate.invoiceFingerprint, allocationSha256: candidate.allocationSha256, reference: 'DO-NOT-EXPOSE-PROOF', verifiedBy: 'synthetic-reviewer', verifiedAt: data.actor.timestamp, providerAccountReference: 'DO-NOT-EXPOSE-PROVIDER-ACCOUNT', originalTaxTransactionReference: 'testtxn_SyntheticOriginal', adjustmentPlanReference: `private-plan-${key}`, authorizedTaxMinor: candidate.allocation.taxMinor } }, 'credit-public-id');
  };
  const payment = (key = 'DO-NOT-EXPOSE-PAYMENT-KEY', id = 'payment-public-id', amount = '1000') => apply({ type: 'customer_payment', idempotencyKey: key, invoiceId: 'invoice-1', amountMinor: amount, paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic bank receipt' }, id);
  return { ...data, apply, erp, credit, payment, book: () => book };
}

describe('financial-pilot current-book whitelist projection', () => {
  it('separates payment and credit, preserves historical parties and never exposes private keys/proofs', async () => {
    const t = await fixture(); await t.credit(); await t.payment();
    await t.erp({ type: 'save_customer', customer: { ...t.baseline.customers[0], name: 'Updated current customer' } });
    const book = t.book(), before = canonicalErpJson(book), overview = await projectUsFinancialPilotOverview(book, book.revision), detail = await projectUsFinancialPilotInvoice(book, { revision: book.revision, invoiceId: 'invoice-1' });
    expect(overview.summary).toEqual({ invoiceCount: 1, totalMinor: '32475', receivedMinor: '1000', creditedMinor: '10825', outstandingMinor: '20650' });
    expect(overview.invoices.items[0].status).toBe('partially_settled'); expect(detail.invoice).toEqual(overview.invoices.items[0]);
    expect(detail.customer.name).toBe(t.baseline.invoices[0].customer.name); expect(overview.customers.items[0].name).toBe('Updated current customer');
    expect(detail.payments.items[0]).toEqual({ id: 'payment-public-id', invoiceId: 'invoice-1', amountMinor: '1000', paymentDate: '2026-10-10', accountingDate: '2026-10-10', reference: 'Synthetic bank receipt', recordedBy: t.actor.userId });
    expect(detail.credits.items[0]).toMatchObject({ totalMinor: '10825', taxDisposition: 'adjustment_pending' });
    expect(overview.journals.items[0].source).toMatchObject({ kind: 'customer_payment', entityId: 'invoice-1', reference: t.baseline.invoices[0].number });
    const text = JSON.stringify({ overview, detail });
    for (const forbidden of ['DO-NOT-EXPOSE', 'idempotencyKey', 'providerReference', 'taxAssessment', 'invoiceFingerprint', 'allocationSha256', 'baselineSha256', 'grantVersion', 'testtxn_', 'policyVersion', 'logoRef']) expect(text).not.toContain(forbidden);
    expect(canonicalErpJson(book)).toBe(before); expect(Object.isFrozen(detail)).toBe(true);
  });
  it('uses customer and vendor invoice references for real AR/AP payment journals', async () => {
    const t = await fixture({ paid: '500' }); await t.erp({ type: 'save_vendor', vendor: { ...t.baseline.customers[0], id: 'vendor-1', name: 'Synthetic supplier' } });
    await t.erp({ type: 'record_vendor_bill', id: 'bill-1', vendorId: 'vendor-1', reference: 'SUPPLIER-TEST', date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026', netMinor: '10000', purchaseTaxMinor: '825', expenseAccountId: 'purchases', sourceReference: 'synthetic-file' });
    await t.erp({ type: 'record_vendor_payment', id: 'vendor-payment-1', billId: 'bill-1', amountMinor: '4000', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic supplier transfer' }, 'DO-NOT-EXPOSE-VENDOR-PAYMENT');
    const overview = await projectUsFinancialPilotOverview(t.book());
    expect(overview.vendors.items[0].name).toBe('Synthetic supplier');
    expect(overview.journals.items.find(row => row.source.kind === 'vendor_payment')?.source).toEqual({ kind: 'vendor_payment', entityId: 'bill-1', reference: 'SUPPLIER-TEST', journalRevision: null });
    expect(overview.journals.items.find(row => row.source.kind === 'customer_payment')?.source.entityId).toBe('invoice-1');
    expect(JSON.stringify(overview)).not.toContain('DO-NOT-EXPOSE-VENDOR-PAYMENT');
  });
  it('does not claim that a fully credited invoice was paid or that zero tax is a live reversal', async () => {
    const t = await fixture(); const input = { type: 'customer_credit' as const, idempotencyKey: 'full-credit', invoiceId: 'invoice-1', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic full cancellation', selections: [{ lineId: 'line-1', quantityUnits: '3' }] };
    const c = await buildUsFinancialCreditCandidateV5(t.book(), input);
    await t.apply({ ...input, taxProof: { schemaVersion: 1, environment: 'test', kind: 'test_adjustment_authorization', invoiceFingerprint: c.invoiceFingerprint, allocationSha256: c.allocationSha256, reference: 'synthetic', verifiedBy: 'synthetic', verifiedAt: t.actor.timestamp, providerAccountReference: 'synthetic', originalTaxTransactionReference: 'testtxn_full', adjustmentPlanReference: 'synthetic-plan', authorizedTaxMinor: c.allocation.taxMinor } }, 'full-credit-id');
    expect((await projectUsFinancialPilotOverview(t.book())).invoices.items[0]).toMatchObject({ receivedMinor: '0', creditedMinor: '32475', outstandingMinor: '0', status: 'credited' });
  });
  it('rejects corrupt private history, stale revision, malformed selectors and missing invoices', async () => {
    const t = await fixture(), raw = structuredClone(t.book()); (raw as { revision: number }).revision++;
    await expect(projectUsFinancialPilotOverview(raw)).rejects.toMatchObject({ status: 503 });
    await expect(projectUsFinancialPilotOverview(t.book(), t.book().revision + 1)).rejects.toMatchObject({ code: 'financial_snapshot_changed', status: 409 });
    await expect(projectUsFinancialPilotInvoice(t.book(), { revision: t.book().revision, invoiceId: 'missing' })).rejects.toMatchObject({ status: 404 });
    await expect(projectUsFinancialPilotInvoice(t.book(), { invoiceId: 'invoice-1' } as never)).rejects.toMatchObject({ status: 422 });
    await expect(projectUsFinancialPilotInvoices(t.book(), { revision: t.book().revision, actor: 'forged' } as never)).rejects.toMatchObject({ status: 422 });
    await expect(projectUsFinancialPilotList(t.book(), { revision: t.book().revision, kind: 'events' } as never)).rejects.toMatchObject({ status: 422 });
  });
  it('captures the source and selectors before the first asynchronous replay', async () => {
    const t = await fixture(), raw = structuredClone(t.book()), query = { revision: raw.revision, invoiceId: 'invoice-1' };
    const pending = projectUsFinancialPilotInvoice(raw, query); (raw as { revision: number }).revision++; query.invoiceId = 'missing';
    expect((await pending).invoice.id).toBe('invoice-1');
  });
  it('bounds invoice payment detail pages and binds their cursor to this invoice', async () => {
    const t = await fixture(); for (let i = 0; i < 26; i++) await t.payment(`private-payment-key-${i}`, `public-payment-${String(i).padStart(2, '0')}`, '1');
    const first = await projectUsFinancialPilotInvoice(t.book(), { revision: t.book().revision, invoiceId: 'invoice-1' });
    expect(first.payments.items).toHaveLength(25); expect(first.payments.total).toBe(26); expect(first.invoice.receivedMinor).toBe('26');
    const second = await projectUsFinancialPilotInvoice(t.book(), { revision: t.book().revision, invoiceId: 'invoice-1', paymentCursor: first.payments.nextCursor });
    expect(second.payments.items).toHaveLength(1); expect(second.payments.nextCursor).toBeNull();
    expect(new Set([...first.payments.items, ...second.payments.items].map(row => row.id)).size).toBe(26);
    await expect(projectUsFinancialPilotInvoice(t.book(), { revision: t.book().revision, invoiceId: 'invoice-1', paymentCursor: financialPilotCursor('invoice_payments', t.book().revision, 25, 'another-invoice') })).rejects.toMatchObject({ status: 422 });
  }, 20_000);
});

describe('financial-pilot stable invoice pages on actual accepted sales', () => {
  let book: UsFinancialBookV5;
  beforeAll(async () => {
    const t = await financialKernelFixture({ tax: '0' }); let state: ErpState = t.baseline, sequence = 0;
    // Real ERP4 issuance followed by real V5 promotion gives a multi-document
    // baseline without replaying 80 append prefixes merely to seed pagination.
    const store: ErpStore = { supportedSchemaVersion: 4, read: async () => state, receipt: async () => null, commit: async commit => {
      const next = applyErpDelta(state, { schemaVersion: 4, organizationId: t.configuration.organizationId, fromRevision: commit.expectedRevision, toRevision: commit.header.revision, headRevision: commit.header.revision, hasMore: false, resetRequired: false, events: [{ schemaVersion: 4, organizationId: t.configuration.organizationId, revision: commit.header.revision, header: commit.header, changes: commit.changes, ledgerAudit: commit.ledgerAudit, receipt: commit.receipt, actorId: t.actor.userId, occurredAt: t.actor.timestamp }] }, t.configuration.organizationId, 4); if (!next) throw Error('Synthetic issuance failed'); state = next; return commit.receipt;
    } };
    const provider: TaxCalculationProvider = { id: 'synthetic-pagination-only', calculate: async request => ({ ...request, source: 'external-provider', providerReference: 'synthetic-not-a-provider', determinedAt: '2026-10-10T11:00:00Z', validUntil: '2026-10-10T13:00:00Z', lines: request.lines.map(line => ({ id: line.id, taxMinor: '0', jurisdiction: 'synthetic-only', evidenceReference: `synthetic-${line.id}` })) }) };
    const send = (command: ErpCommand) => executeErp({ configuration: t.configuration, actor: t.actor, store, revalidate: async () => t.actor, taxProvider: async () => provider, seller: async () => t.baseline.invoices[0].sellerSnapshot }, { idempotencyKey: `private-pagination-${++sequence}`, expectedRevision: state.revision, command });
    for (let index = 2; index <= 27; index++) {
      const id = String(index).padStart(2, '0'), estimateId = `estimate-${id}`;
      for (const command of [
        { type: 'save_estimate', id: estimateId, expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30, lines: t.baseline.estimates[0].lines, notes: 'Synthetic only' },
        { type: 'accept_estimate', estimateId, expectedEstimateRevision: 1 },
      ] as const) await send(command);
      await send({ type: 'issue_invoice', id: `invoice-${id}`, estimateId, expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026' });
    }
    book = await promoteUsFinancialBookV5(state, t.policy, t.actor);
  }, 30_000);
  it('shows recent-first stable IDs across pages25 without repeats or lost invoices', async () => {
    const first = await projectUsFinancialPilotInvoices(book, { revision: book.revision }), second = await projectUsFinancialPilotInvoices(book, { revision: book.revision, cursor: first.nextCursor });
    expect(first.total).toBe(27); expect(first.items).toHaveLength(25); expect(second.items).toHaveLength(2); expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map(row => row.id); expect(new Set(ids).size).toBe(27); expect(ids[0]).toBe('invoice-27'); expect(ids).toContain('invoice-1');
    const overview = await projectUsFinancialPilotOverview(book, book.revision); expect(overview.estimates.items).toHaveLength(25); expect(overview.journals.items).toHaveLength(25);
  }, 20_000);
  it('refuses cross-list or old-revision cursor and pages outside the current collection', async () => {
    await expect(projectUsFinancialPilotInvoices(book, { revision: book.revision, cursor: financialPilotCursor('estimates', book.revision, 25, null) })).rejects.toMatchObject({ status: 422 });
    await expect(projectUsFinancialPilotInvoices(book, { revision: book.revision, cursor: financialPilotCursor('invoices', book.revision - 1, 25, null) })).rejects.toMatchObject({ status: 422 });
    await expect(projectUsFinancialPilotInvoices(book, { revision: book.revision - 1 })).rejects.toMatchObject({ status: 409 });
    await expect(projectUsFinancialPilotInvoices(book, { revision: book.revision, cursor: financialPilotCursor('invoices', book.revision, 50, null) })).rejects.toMatchObject({ status: 422 });
  }, 20_000);
});
