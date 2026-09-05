import { desktopApi } from '../src/bridge';
import type { SupplierCreditNote, SupplierInvoice, Workspace } from '../src/types';
import { supplierDraftLineTotals } from '../src/PurchaseOrdersScreen';

/** Synthetic persistence only. Rust acceptance tests exercise SQLite and its guards. */
export function installCreditSettlementFixture(initial: Workspace) {
  const invoice = initial.supplierInvoices[0];
  invoice.documentStatus = 'validated';
  invoice.documentDate = '2026-09-02';
  invoice.validatedAt = '2026-09-02T10:00:00Z';
  invoice.validationJournalEntryId = 'invoice-journal';
  initial.supplierInvoices.push(
    // Deliberately malformed legacy data must not become an eligible CHF target.
    { ...structuredClone(invoice), id: 'eur-invoice', currency: 'EUR', reference: 'NE-PAS-PROPOSER-EUR' } as unknown as SupplierInvoice,
    { ...structuredClone(invoice), id: 'foreign-invoice', supplierId: 'another-supplier', reference: 'NE-PAS-PROPOSER-AUTRE-FOURNISSEUR' },
  );
  const makeCredit = (id: string, status: 'draft' | 'validated'): SupplierCreditNote => ({
    id, supplierId: invoice.supplierId, number: status === 'validated' ? 'AV-AVAILABLE' : '', reference: status === 'draft' ? 'AV-DRAFT-DATES' : 'AV-AVAILABLE', supplierName: invoice.supplierName, documentDate: '2026-09-01', status, currency: 'CHF', netCents: 5000, vatCents: 405, totalCents: 5405, allocatedCents: 0, note: '', validatedAt: status === 'validated' ? '2026-09-01T10:00:00Z' : null, validationJournalEntryId: status === 'validated' ? 'credit-journal' : null, createdAt: '', updatedAt: '',
    items: [{ ...invoice.lines[0], id: `${id}-line`, supplierCreditNoteId: id, quantityMilli: 1000, unitPriceCents: 5000, netCents: 5000, vatCents: 405, totalCents: 5405 }], allocations: [],
  });
  const draft = makeCredit('draft-credit', 'draft');
  draft.allocations = [{ id: 'legacy-draft-allocation', sequence: 1, requestId: '', supplierCreditNoteId: draft.id, supplierInvoiceId: invoice.id, eventType: 'apply', reversesAllocationId: null, amountCents: 1000, effectiveDate: null, reason: '', createdAt: '2026-09-01T10:00:00Z' }];
  draft.allocatedCents = 1000;
  initial.supplierCreditNotes = [draft, makeCredit('available-credit', 'validated')];
  const persisted = structuredClone(initial);
  desktopApi.loadWorkspace = async () => structuredClone(persisted);
  const log = (name: string, payload: unknown) => {
    const key = `qa-credit-date-${name}`;
    sessionStorage.setItem(key, JSON.stringify([...JSON.parse(sessionStorage.getItem(key) || '[]'), payload]));
    if (sessionStorage.getItem('qa-credit-date-reject') === '1') {
      sessionStorage.removeItem('qa-credit-date-reject');
      throw new Error('La période comptable est clôturée. Choisissez une date dans une période ouverte.');
    }
  };
  desktopApi.saveSupplierCreditNoteDraft = async (input) => {
    log('save', input);
    const credit = persisted.supplierCreditNotes.find((row) => row.id === input.id)!;
    credit.items = input.items.map((item, position) => ({ ...item, ...supplierDraftLineTotals({ ...item, discountBp: item.discountBp || 0 }), id: item.id!, supplierCreditNoteId: credit.id, unit: item.unit || '', discountBp: item.discountBp || 0, expenseAccountId: item.expenseAccountId || null, postedExpenseAccountId: null, projectId: item.projectId || null, position }));
    credit.documentDate = input.documentDate;
    credit.allocations = input.allocations.map((allocation, index) => ({ ...allocation, id: `draft-allocation-${index}`, sequence: index + 1, requestId: '', supplierCreditNoteId: credit.id, eventType: 'apply', reversesAllocationId: null, reason: '', createdAt: '' }));
    return structuredClone(persisted);
  };
  desktopApi.validateSupplierCreditNote = async (requestId, creditId) => {
    log('validate', { requestId, creditId });
    const credit = persisted.supplierCreditNotes.find((row) => row.id === creditId)!;
    credit.status = 'validated'; credit.number = 'AV-DRAFT-DATES'; credit.validatedAt = '2026-09-05T10:00:00Z';
    for (const allocation of credit.allocations) {
      const invoice = persisted.supplierInvoices.find((row) => row.id === allocation.supplierInvoiceId)!;
      invoice.creditedCents += allocation.amountCents; invoice.balanceCents -= allocation.amountCents;
    }
    return structuredClone(persisted);
  };
  desktopApi.applySupplierCredit = async (requestId, creditId, invoiceId, amountCents, effectiveDate) => {
    log('apply', { requestId, creditId, invoiceId, amountCents, effectiveDate });
    const credit = persisted.supplierCreditNotes.find((row) => row.id === creditId)!;
    const invoice = persisted.supplierInvoices.find((row) => row.id === invoiceId)!;
    credit.allocations.push({ id: requestId, sequence: 2, requestId, supplierCreditNoteId: creditId, supplierInvoiceId: invoiceId, eventType: 'apply', reversesAllocationId: null, amountCents, effectiveDate, reason: '', createdAt: '' });
    credit.allocatedCents += amountCents; invoice.creditedCents += amountCents; invoice.balanceCents -= amountCents;
    return structuredClone(persisted);
  };
  desktopApi.reverseSupplierCreditAllocation = async (requestId, allocationId, reason, effectiveDate) => {
    log('reverse', { requestId, allocationId, reason, effectiveDate });
    const credit = persisted.supplierCreditNotes.find((row) => row.allocations.some((allocation) => allocation.id === allocationId))!;
    const allocation = credit.allocations.find((row) => row.id === allocationId)!;
    const invoice = persisted.supplierInvoices.find((row) => row.id === allocation.supplierInvoiceId)!;
    credit.allocations.push({ ...allocation, id: requestId, requestId, sequence: 3, eventType: 'reverse', reversesAllocationId: allocationId, effectiveDate, reason });
    credit.allocatedCents -= allocation.amountCents; invoice.creditedCents -= allocation.amountCents; invoice.balanceCents += allocation.amountCents;
    return structuredClone(persisted);
  };
}
