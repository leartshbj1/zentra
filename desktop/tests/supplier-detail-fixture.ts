import type { SupplierCreditNote, SupplierInvoice, Workspace } from '../src/types';
export function seedSupplierDetail(workspace: Workspace, invoice: SupplierInvoice) {
  invoice.documentStatus = 'validated'; invoice.validationJournalEntryId = 'journal-invoice'; invoice.paymentStatus = 'partial';
  invoice.paidCents = 6025; invoice.creditedCents = 3000; invoice.balanceCents = 12595;
  invoice.note = 'Note de facture {name}\nConditions conservées sur deux lignes.';
  invoice.payments = [
    { id: 'payment-early', requestId: 'request-early', supplierInvoiceId: invoice.id, date: '2026-09-06', amountCents: 5025, method: 'bank_transfer', reference: 'Référence {amount} ' + 'Longue'.repeat(20), notes: 'Premier versement\nLigne suivante.', journalEntryId: 'journal-early', createdAt: '2026-09-10T12:00:00Z' },
    { id: 'payment-late', requestId: 'request-late', supplierInvoiceId: invoice.id, date: '2026-09-08', amountCents: 1000, method: 'Mode personnel {name}', reference: 'Virement complémentaire', notes: '', journalEntryId: 'journal-late', createdAt: '2026-09-08T12:00:00Z' },
  ];
  invoice.attachments = [{ id: 'receipt-detail', projectId: null, entityType: 'supplier_invoice', entityId: invoice.id, originalName: 'Document original {name} ' + 'Long'.repeat(30) + '.pdf', mimeType: 'application/pdf', sizeBytes: 12000, sha256: 'a'.repeat(64), createdAt: invoice.createdAt, updatedAt: invoice.updatedAt }];
  const credit: SupplierCreditNote = {
    id: 'credit-detail', supplierId: invoice.supplierId, supplierName: invoice.supplierName, number: 'AV-DETAIL-2026', reference: 'Avoir {name}', documentDate: '2026-09-06', currency: 'CHF', status: 'validated', netCents: 3700, vatCents: 300, totalCents: 4000, allocatedCents: 3000, refundedCents: 0, refunds: [], note: 'Retour de marchandises', validatedAt: invoice.createdAt, validationJournalEntryId: 'journal-credit', items: [], createdAt: invoice.createdAt, updatedAt: invoice.updatedAt,
    allocations: [
      { id: 'apply-detail', requestId: 'apply-request', sequence: 1, supplierCreditNoteId: 'credit-detail', supplierInvoiceId: invoice.id, eventType: 'apply', reversesAllocationId: null, amountCents: 4000, effectiveDate: '2026-09-07', reason: 'Retour partiel', createdAt: '2026-09-10T12:00:00Z' },
      { id: 'reverse-detail', requestId: 'reverse-request', sequence: 2, supplierCreditNoteId: 'credit-detail', supplierInvoiceId: invoice.id, eventType: 'reverse', reversesAllocationId: 'apply-detail', amountCents: 1000, effectiveDate: '2026-09-09', reason: 'Une partie a finalement été conservée.', createdAt: '2026-09-11T12:00:00Z' },
    ],
  };
  workspace.supplierCreditNotes = [credit];
}
