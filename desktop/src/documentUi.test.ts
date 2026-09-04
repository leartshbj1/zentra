import { describe, expect, it } from 'vitest';
import {
  invoiceCorrectionWorkflowFor,
  invoiceModificationAction,
  reserveDocumentAction,
  searchableDocumentCatalogItems,
  upsertDocumentFooterTemplate,
} from './documentUi';
import type { CatalogItem, Invoice, InvoiceCorrectionWorkflow } from './types';

const catalog = (id: string, sku: string, name: string): CatalogItem =>
  ({
    id,
    sku,
    name,
    description: `${name} fournisseur`,
    kind: 'product',
    unit: 'pièce',
    purchaseCostCents: 100,
    salesPriceCents: 200,
    vatBp: 810,
    trackStock: true,
    stockQuantityMilli: 0,
    reorderLevelMilli: 0,
    archivedAt: null,
    createdAt: '',
    updatedAt: '',
  }) as CatalogItem;

const invoice = (id: string, status: Invoice['status']): Invoice => ({
  id,
  number: status === 'draft' ? '' : `F-${id}`,
  clientId: 'client-1',
  projectId: null,
  quoteId: null,
  originalInvoiceId: null,
  title: id,
  type: 'standard',
  issueDate: '2026-09-04',
  dueDate: '2026-10-04',
  serviceDateFrom: '2026-09-04',
  serviceDateTo: '2026-09-04',
  currency: 'CHF',
  status,
  lines: [],
  notes: '',
  terms: '',
  depositPercentageBp: null,
  depositBasisLines: null,
  createdAt: '',
});

describe('interactions des documents', () => {
  it('recherche le catalogue par référence ou désignation et limite les résultats', () => {
    const items = [
      catalog('2', 'ZZ-20', 'Robinet'),
      catalog('1', 'FOUR-17', 'Mitigeur chromé'),
      { ...catalog('3', 'FOUR-18', 'Mitigeur archivé'), archivedAt: '2026-09-04' },
    ];
    expect(searchableDocumentCatalogItems(items, 'four-17', 10).map((item) => item.id)).toEqual([
      '1',
    ]);
    expect(searchableDocumentCatalogItems(items, 'robinet', 10).map((item) => item.id)).toEqual([
      '2',
    ]);
    expect(searchableDocumentCatalogItems(items, '', 1)).toHaveLength(1);
  });

  it('met à jour le modèle sélectionné par son identifiant, même si son nom change', () => {
    const result = upsertDocumentFooterTemplate(
      [
        { id: 'footer-a', name: 'Ancien nom', text: 'Ancien texte' },
        { id: 'footer-b', name: 'Autre', text: 'Autre texte' },
      ],
      'footer-a',
      'Nouveau nom',
      'Nouveau texte',
      () => 'ne-doit-pas-servir',
    );
    expect(result.id).toBe('footer-a');
    expect(result.templates).toContainEqual({
      id: 'footer-a',
      name: 'Nouveau nom',
      text: 'Nouveau texte',
    });
    expect(result.templates).not.toContainEqual(
      expect.objectContaining({ id: 'ne-doit-pas-servir' }),
    );
  });

  it('ouvre le remplacement existant au lieu de relancer la correction originale', () => {
    const original = invoice('original', 'paid');
    const replacementDraft = invoice('replacement', 'draft');
    const workflow: InvoiceCorrectionWorkflow = {
      id: 'workflow-1',
      originalInvoiceId: original.id,
      creditNoteId: 'credit-1',
      replacementInvoiceId: replacementDraft.id,
      reason: 'Correction adresse',
      createdAt: '',
    };
    expect(invoiceCorrectionWorkflowFor(original.id, [workflow])).toBe(workflow);
    expect(
      invoiceModificationAction(original, workflow, [original, replacementDraft]),
    ).toEqual({ kind: 'edit', invoice: replacementDraft });

    const issuedReplacement = { ...replacementDraft, status: 'issued' as const, number: 'F-2' };
    expect(
      invoiceModificationAction(original, workflow, [original, issuedReplacement]),
    ).toEqual({ kind: 'correct', invoice: issuedReplacement });

    const cancelledReplacement = {
      ...replacementDraft,
      status: 'cancelled' as const,
      number: 'F-2',
    };
    expect(
      invoiceModificationAction(original, workflow, [original, cancelledReplacement]),
    ).toEqual({ kind: 'view', invoice: cancelledReplacement });
  });

  it('refuse une deuxième action tant que le même devis est réservé', () => {
    const pending = new Set<string>();
    expect(reserveDocumentAction(pending, 'quote-1')).toBe(true);
    expect(reserveDocumentAction(pending, 'quote-1')).toBe(false);
    pending.delete('quote-1');
    expect(reserveDocumentAction(pending, 'quote-1')).toBe(true);
  });
});
