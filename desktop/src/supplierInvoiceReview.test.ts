import { describe, expect, it } from 'vitest';
import { supplierReviewContext, supplierReviewPreflight, supplierReviewProblem, type SupplierReviewWorkspace } from './supplierInvoiceReview';
import type { SupplierInvoice, SupplierOrder, SupplierInvoiceMatch, AccountingSettings } from './types';

function invoice(patch: Partial<SupplierInvoice> = {}): SupplierInvoice {
  return { id: 'invoice', supplierId: 'supplier', supplierName: 'Fournisseur', projectId: null, documentDate: '2026-09-05', dueDate: '2026-10-05', reference: 'REF-12', currency: 'CHF', documentStatus: 'draft', paymentStatus: 'pending', netCents: 10000, vatCents: 810, totalCents: 10810, paidCents: 0, creditedCents: 0, balanceCents: 10810, matchStatus: 'unmatched', validatedAt: null, validationJournalEntryId: null, note: '', lines: [{ id: 'line', description: 'Matériel', quantityMilli: 1000, unit: 'pièce', unitPriceCents: 10000, discountBp: 0, vatBp: 810, category: 'Marchandises', netCents: 10000, vatCents: 810, totalCents: 10810, position: 0, supplierInvoiceId: 'invoice', expenseAccountId: null, postedExpenseAccountId: null, projectId: null }], attachments: [], payments: [], createdAt: '', updatedAt: '', ...patch };
}
function workspace(patch: Partial<SupplierReviewWorkspace> = {}): SupplierReviewWorkspace {
  return { supplierInvoices: [], supplierInvoiceMatches: [], supplierOrders: [], supplierReceipts: [], accountingSettings: { enabled: true, expenseAccountId: 'expense', vatReceivableAccountId: 'vat', supplierPayableAccountId: 'ap' } as AccountingSettings, ...patch };
}
const order = (patch: Partial<SupplierOrder> = {}) => ({ id: 'order', supplierId: 'supplier', currency: 'CHF', status: 'confirmed', lines: [], ...patch } as SupplierOrder);
describe('supplier review preflight', () => {
  it('allows an ordinary draft without silently requiring a bank account or attachment', () => {
    expect(supplierReviewPreflight(invoice(), workspace())).toBeNull();
    expect(supplierReviewContext(invoice(), workspace()).standaloneChoice).toBe(false);
  });
  it('directs the missing reference to its field, or to existing links when protected', () => {
    expect(supplierReviewPreflight(invoice({ reference: '  ' }), workspace())?.target).toBe('reference');
    const linked = workspace({ supplierInvoiceMatches: [{ supplierInvoiceId: 'invoice', supplierOrderId: 'order' } as SupplierInvoiceMatch] });
    expect(supplierReviewPreflight(invoice({ reference: '' }), linked)?.target).toBe('matching');
  });
  it.each([{ documentDate: '2026-02-30' }, { dueDate: '2026-09-01' }, { dueDate: '' }])('explains invalid dates %j', patch => {
    expect(supplierReviewPreflight(invoice(patch), workspace())?.target).toBe('document');
  });
  it.each([{ lines: [] }, { totalCents: 0 }, { totalCents: 10811 }, { totalCents: Number.NaN }])('rejects incomplete totals %j', patch => {
    expect(supplierReviewPreflight(invoice(patch), workspace())?.title).toBe('Vérifiez le montant de l’achat');
  });
  it('routes missing supplier accounts to accounting', () => {
    expect(supplierReviewPreflight(invoice(), workspace({ accountingSettings: null }))?.target).toBe('accounts');
  });
  it('never confirms an already validated document or a mismatch', () => {
    expect(supplierReviewPreflight(invoice({ documentStatus: 'validated' }), workspace())?.target).toBe('invoices');
    expect(supplierReviewPreflight(invoice({ matchStatus: 'mismatch' }), workspace())?.target).toBe('matching');
  });
});
describe('matching context', () => {
  it('proposes only an open command for this supplier and currency', () => {
    const data = workspace({ supplierOrders: [order({ id: 'other', supplierId: 'else' }), order({ id: 'closed', status: 'closed' }), order()] });
    expect(supplierReviewContext(invoice(), data)).toMatchObject({ order: { id: 'order' }, standaloneChoice: true });
  });
  it('preserves the linked order even if it later closes', () => {
    const data = workspace({ supplierOrders: [order(), order({ id: 'linked', status: 'closed' })], supplierInvoiceMatches: [{ supplierInvoiceId: 'invoice', supplierOrderId: 'linked' } as SupplierInvoiceMatch] });
    expect(supplierReviewContext(invoice(), data)).toMatchObject({ order: { id: 'linked' }, standaloneChoice: false });
    expect(supplierReviewPreflight(invoice(), data)?.target).toBe('matching');
  });
});
describe('native refusal guidance', () => {
  it.each([
    ['Cette période comptable est clôturée.', 'periods'],
    ['Le compte de charges est archivé.', 'accounts'],
    ['Une facture validée de ce fournisseur possède déjà la même référence.', 'reference'],
    ['Le justificatif original lié à la provenance e-mail est absent.', 'attachments'],
    ['Un écart de TVA subsiste dans le rapprochement.', 'matching'],
    ['Interruption inattendue', 'document'],
  ] as const)('maps %s to %s', (message, target) => {
    expect(supplierReviewProblem(message).target).toBe(target);
  });
});
