import { describe, expect, it } from 'vitest';
import type { CatalogItem, DocumentLine, Invoice, Quote } from './types';
import { findUsualArticles, withUsualArticles } from './usualArticles';

const item = (id: string, patch: Partial<CatalogItem> = {}): CatalogItem => ({
  id, kind: 'product', sku: null, name: id, description: '', unit: 'pièce', salesPriceCents: 1000, purchaseCostCents: 0,
  vatBp: 810, trackStock: false, stockQuantityMilli: 0, reorderLevelMilli: 0, archivedAt: null, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...patch,
});
const line = (catalogItemId: string | null, quantity: number, unitPriceCents = 1): DocumentLine => ({
  id: `${catalogItemId}-${quantity}`, catalogItemId, description: 'old text', quantity, unit: 'old', unitPriceCents, discountBp: 0, vatRateBp: 0,
});
const quote = (id: string, issueDate: string, lines: DocumentLine[], patch: Partial<Quote> = {}): Quote => ({
  id, number: id, clientId: 'c1', projectId: null, title: '', issueDate, validUntil: issueDate, currency: 'CHF', status: 'accepted',
  lines, notes: '', terms: '', createdAt: issueDate, ...patch,
});
const invoice = (id: string, issueDate: string, lines: DocumentLine[], patch: Partial<Invoice> = {}): Invoice => ({
  id, number: id, clientId: 'c1', projectId: null, quoteId: null, originalInvoiceId: null, title: '', type: 'standard', issueDate,
  dueDate: issueDate, serviceDateFrom: '', serviceDateTo: '', currency: 'CHF', status: 'paid', lines, notes: '', terms: '',
  depositPercentageBp: null, depositBasisLines: null, createdAt: issueDate, ...patch,
});

describe('usual articles', () => {
  const catalogItems = [item('wine', { salesPriceCents: 2500, vatBp: 810, unit: 'carton' }), item('oil'), item('old', { archivedAt: '2026-05-01' })];

  it('suggests items from at least two counted documents with current catalogue prices and the lower median quantity', () => {
    const usual = findUsualArticles({
      catalogItems,
      quotes: [quote('q1', '2026-01-10', [line('wine', 2), line('oil', 1)]), quote('q2', '2026-02-10', [line('wine', 4)], { status: 'refused' })],
      invoices: [invoice('i1', '2026-03-10', [line('wine', 3), line('old', 1)]), invoice('i2', '2026-04-10', [line('wine', 2), line('wine', 2), line('old', 1)])],
    }, 'c1', 'CHF');
    expect(usual.countedDocuments).toBe(3);
    expect(usual.lines.map(entry => [entry.line.catalogItemId, entry.line.quantity, entry.line.unitPriceCents, entry.line.unit, entry.line.vatRateBp, entry.documentCount, entry.quantityStable]))
      .toEqual([['wine', 3, 2500, 'carton', 810, 3, false]]);
  });

  it('counts an invoiced quote once and ignores other clients, currencies, credit notes and the open document', () => {
    const usual = findUsualArticles({
      catalogItems,
      quotes: [quote('q1', '2026-01-10', [line('oil', 1)])],
      invoices: [
        invoice('i1', '2026-01-20', [line('oil', 1)], { quoteId: 'q1' }),
        invoice('i2', '2026-02-20', [line('oil', 1)], { clientId: 'c2' }),
        invoice('i3', '2026-02-21', [line('oil', 1)], { currency: 'EUR' }),
        invoice('i4', '2026-02-22', [line('oil', 1)], { type: 'credit_note' }),
        invoice('i5', '2026-02-23', [line('oil', 1)], { status: 'draft' }),
        invoice('i6', '2026-02-24', [line('oil', 1)]),
      ],
    }, 'c1', 'CHF', 'i6');
    expect(usual).toEqual({ countedDocuments: 1, lines: [] });
  });

  it('never suggests catalogue prices in another currency', () => {
    const workspace = { catalogItems, quotes: [quote('q1', '2026-01-10', [line('oil', 1)], { currency: 'EUR' }), quote('q2', '2026-01-11', [line('oil', 1)], { currency: 'EUR' })], invoices: [] };
    expect(findUsualArticles(workspace, 'c1', 'EUR').lines).toEqual([]);
  });

  it('replaces only the empty starter line and never duplicates a reference', () => {
    const usual = { countedDocuments: 2, lines: [{ line: line('wine', 3), documentCount: 2, quantityStable: true }, { line: line('oil', 1), documentCount: 2, quantityStable: true }] };
    const starter: DocumentLine = { id: 'empty', catalogItemId: null, description: ' ', quantity: 0, unit: '', unitPriceCents: 0, vatRateBp: 0 };
    expect(withUsualArticles([starter], usual).map(row => row.catalogItemId)).toEqual(['wine', 'oil']);
    expect(withUsualArticles([line('oil', 5)], usual).map(row => [row.catalogItemId, row.quantity])).toEqual([['oil', 5], ['wine', 3]]);
  });
});
