import { describe, expect, it, vi } from 'vitest';
import {
  financialPilotCursor, financialPilotCursorOffset, validateUsFinancialPilotHead, validateUsFinancialPilotInvoiceDetail,
  validateUsFinancialPilotListQuery, validateUsFinancialPilotOverview, validateUsFinancialPilotPage,
} from './us-financial-pilot-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { promoteUsFinancialBookV5 } from './us-financial-kernel';
import { projectUsFinancialPilotInvoice, projectUsFinancialPilotOverview } from './us-financial-pilot-projection';

const head = { schemaVersion: 1, consumer: 'financial-pilot', organizationId: 'synthetic-pilot', revision: 9 };
const invoice = { id: 'invoice', number: 'SYNTHETIC-1', customerId: 'customer', customerName: 'Synthetic customer', date: '2026-10-09', accountingDate: '2026-10-09', dueDate: '2026-11-08', issuedAt: '2026-10-10T12:00:00Z', issuedBy: 'synthetic-owner', totalMinor: '32475', receivedMinor: '1000', creditedMinor: '10825', outstandingMinor: '20650', status: 'partially_settled' };
const page = { ...head, ledgerRevision: 4, kind: 'invoices', scope: null, total: 1, items: [invoice], nextCursor: null };

describe('financial-pilot DTO1 strict browser contract', () => {
  it('keeps a distinct exact head and rejects private schema5 or extra authority', () => {
    expect(validateUsFinancialPilotHead(head, head.organizationId)).toEqual(head);
    for (const value of [{ ...head, schemaVersion: 5 }, { ...head, consumer: 'erp' }, { ...head, grantVersion: 1 }, { ...head, revision: 0 }, { ...head, revision: 1.5 }]) expect(() => validateUsFinancialPilotHead(value)).toThrow();
    expect(() => validateUsFinancialPilotHead(head, 'another-company')).toThrow();
  });
  it('validates four exact amounts without treating credit as received cash', () => {
    expect(validateUsFinancialPilotPage(page, head.organizationId, 9)).toEqual(page);
    for (const patch of [{ receivedMinor: '11825' }, { outstandingMinor: '20651' }, { creditedMinor: '-1' }, { totalMinor: 32475 }, { receivedMinor: '01' }, { status: 'paid' }, { status: 'open' }]) expect(() => validateUsFinancialPilotPage({ ...page, items: [{ ...invoice, ...patch }] })).toThrow();
    expect(() => validateUsFinancialPilotPage(page, head.organizationId, 10)).toThrowError(expect.objectContaining({ code: 'financial_snapshot_changed', status: 409 }));
  });
  it.each(['providerReference', 'fingerprint', 'idempotencyKey', 'taxProof', 'ein'])('rejects nested private field %s rather than removing it after transport', field => {
    expect(() => validateUsFinancialPilotPage({ ...page, items: [{ ...invoice, [field]: 'synthetic-private' }] })).toThrowError(expect.objectContaining({ status: 503 }));
  });
  it('never invokes getters and refuses custom prototypes or sparse arrays', () => {
    const get = vi.fn(() => 9), value = { ...head }; Object.defineProperty(value, 'revision', { enumerable: true, get });
    expect(() => validateUsFinancialPilotHead(value)).toThrow(); expect(get).not.toHaveBeenCalled();
    expect(() => validateUsFinancialPilotHead(Object.assign(Object.create({}), head))).toThrow();
    const sparse: unknown[] = []; sparse.length = 1; expect(() => validateUsFinancialPilotPage({ ...page, items: sparse })).toThrow();
  });
  it('requires pages25 and a canonical cursor bound to revision, kind and scope', () => {
    const cursor = financialPilotCursor('invoices', 9, 25, null);
    expect(financialPilotCursorOffset(cursor, 'invoices', 9, null)).toBe(25);
    for (const value of ['[]', '["invoices",9,26,null]', '["invoices",9,1000025,null]', ` ${cursor}`, financialPilotCursor('customers', 9, 25, null), financialPilotCursor('invoices', 10, 25, null)]) expect(() => financialPilotCursorOffset(value, 'invoices', 9, null)).toThrow();
    expect(() => financialPilotCursorOffset(financialPilotCursor('invoice_payments', 9, 25, 'invoice-A'), 'invoice_payments', 9, 'invoice-B')).toThrow();
    expect(() => validateUsFinancialPilotPage({ ...page, total: 26, items: Array.from({ length: 26 }, () => invoice) })).toThrow();
    expect(() => validateUsFinancialPilotPage({ ...page, nextCursor: cursor })).toThrow();
  });
  it('rejects authority and facts in list requests before reading a book', () => {
    expect(validateUsFinancialPilotListQuery({ revision: 9, kind: 'invoices' })).toEqual({ revision: 9, kind: 'invoices', cursor: null });
    for (const value of [{ kind: 'invoices' }, { revision: 9, kind: 'events' }, { revision: 9, kind: 'invoices', actor: head.organizationId }, { revision: 9, kind: 'invoices', facts: {} }]) expect(() => validateUsFinancialPilotListQuery(value)).toThrowError(expect.objectContaining({ status: 422 }));
  });
  it('corroborates nested overview scope and invoice detail line totals on real kernel output', async () => {
    const t = await financialKernelFixture(), book = await promoteUsFinancialBookV5(t.baseline, t.policy, t.actor);
    const overview = await projectUsFinancialPilotOverview(book), detail = await projectUsFinancialPilotInvoice(book, { revision: book.revision, invoiceId: 'invoice-1' });
    expect(validateUsFinancialPilotOverview(overview, t.configuration.organizationId, book.revision)).toEqual(overview);
    expect(validateUsFinancialPilotInvoiceDetail(detail, t.configuration.organizationId, book.revision)).toEqual(detail);
    expect(() => validateUsFinancialPilotOverview({ ...overview, customers: { ...overview.customers, organizationId: 'another-company' } })).toThrow();
    expect(() => validateUsFinancialPilotOverview({ ...overview, invoices: { ...overview.invoices, kind: 'vendors' } })).toThrow();
    expect(() => validateUsFinancialPilotInvoiceDetail({ ...detail, lines: [{ ...detail.lines[0], taxMinor: '0' }] })).toThrow();
    expect(() => validateUsFinancialPilotInvoiceDetail({ ...detail, payments: { ...detail.payments, scope: 'another-invoice' } })).toThrow();
    expect(Object.isFrozen(detail.lines)).toBe(true); expect(Object.isFrozen(detail.customer.billingAddress)).toBe(true);
  });
});
