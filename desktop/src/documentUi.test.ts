import { describe, expect, it } from 'vitest';
import {
  documentLinesValidationError,
  documentVatRateFromInput,
  invoiceCorrectionWorkflowFor,
  invoiceModificationAction,
  prepareDocumentQuickClient,
  reserveDocumentAction,
  salesDocumentDateError,
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

    const nextReplacement = invoice('replacement-2', 'draft');
    const nextWorkflow: InvoiceCorrectionWorkflow = {
      id: 'workflow-2',
      originalInvoiceId: issuedReplacement.id,
      creditNoteId: 'credit-2',
      replacementInvoiceId: nextReplacement.id,
      reason: 'Deuxième correction',
      createdAt: '2026-09-05T09:00:00Z',
    };
    expect(
      invoiceCorrectionWorkflowFor(issuedReplacement.id, [workflow, nextWorkflow]),
    ).toBe(nextWorkflow);
  });

  it.each([
    ['draft', 'edit'],
    ['issued', 'correct'],
    ['cancelled', 'view'],
  ] as const)(
    'suit toute la chaîne A vers B vers C lorsque C est %s',
    (latestStatus, expectedKind) => {
      const original = invoice('invoice-a', 'paid');
      const firstReplacement = invoice('invoice-b', 'issued');
      const latestReplacement = invoice('invoice-c', latestStatus);
      const firstWorkflow: InvoiceCorrectionWorkflow = {
        id: 'workflow-a-b',
        originalInvoiceId: original.id,
        creditNoteId: 'credit-a-b',
        replacementInvoiceId: firstReplacement.id,
        reason: 'Première correction',
        createdAt: '2026-09-04T09:00:00Z',
      };
      const latestWorkflow: InvoiceCorrectionWorkflow = {
        id: 'workflow-b-c',
        originalInvoiceId: firstReplacement.id,
        creditNoteId: 'credit-b-c',
        replacementInvoiceId: latestReplacement.id,
        reason: 'Deuxième correction',
        createdAt: '2026-09-05T09:00:00Z',
      };
      const invoices = [original, firstReplacement, latestReplacement];

      // L'ordre du stockage ne doit pas influencer la version ouverte.
      const resolved = invoiceCorrectionWorkflowFor(original.id, [
        firstWorkflow,
        latestWorkflow,
      ]);
      expect(resolved).toBe(latestWorkflow);
      expect(invoiceModificationAction(original, resolved, invoices)).toEqual({
        kind: expectedKind,
        invoice: latestReplacement,
      });
    },
  );

  it('borne une chaîne de corrections cyclique issue de données corrompues', () => {
    const first: InvoiceCorrectionWorkflow = {
      id: 'workflow-cycle-1',
      originalInvoiceId: 'invoice-a',
      creditNoteId: 'credit-cycle-1',
      replacementInvoiceId: 'invoice-b',
      reason: 'Cycle artificiel 1',
      createdAt: '2026-09-04T09:00:00Z',
    };
    const second: InvoiceCorrectionWorkflow = {
      id: 'workflow-cycle-2',
      originalInvoiceId: 'invoice-b',
      creditNoteId: 'credit-cycle-2',
      replacementInvoiceId: 'invoice-a',
      reason: 'Cycle artificiel 2',
      createdAt: '2026-09-05T09:00:00Z',
    };

    expect(
      invoiceCorrectionWorkflowFor('invoice-a', [second, first]),
    ).toBe(second);
  });

  it('refuse une deuxième action tant que le même devis est réservé', () => {
    const pending = new Set<string>();
    expect(reserveDocumentAction(pending, 'quote-1')).toBe(true);
    expect(reserveDocumentAction(pending, 'quote-1')).toBe(false);
    pending.delete('quote-1');
    expect(reserveDocumentAction(pending, 'quote-1')).toBe(true);
  });

  it('prépare le premier contact sans conserver les espaces ni un code pays ambigu', () => {
    expect(
      prepareDocumentQuickClient(
        {
          contactPerson: '  Léa Martin  ',
          company: '  Atelier Léman  ',
          email: '  lea@example.ch ',
          phone: ' +41 79 000 00 00 ',
          street: '  Rue du Lac  ',
          buildingNumber: '  17A ',
          postalCode: ' 1007 ',
          city: ' Lausanne ',
          canton: ' VD ',
          country: ' ch ',
        },
        'client-1',
      ),
    ).toEqual({
      id: 'client-1',
      name: 'Atelier Léman',
      contactPerson: 'Léa Martin',
      company: 'Atelier Léman',
      email: 'lea@example.ch',
      phone: '+41 79 000 00 00',
      addressLine1: 'Rue du Lac',
      addressLine2: '17A',
      postalCode: '1007',
      city: 'Lausanne',
      canton: 'VD',
      country: 'CH',
      notes: '',
    });
    expect(() =>
      prepareDocumentQuickClient(
        {
          contactPerson: 'Léa Martin',
          company: '',
          email: '',
          phone: '',
          street: 'Rue du Lac',
          buildingNumber: '',
          postalCode: '1007',
          city: 'Lausanne',
          canton: 'VD',
          country: 'Suisse',
        },
        'client-2',
      ),
    ).toThrow(/code pays à deux lettres/);

    expect(
      prepareDocumentQuickClient(
        {
          contactPerson: '',
          company: '  Entreprise sans personne de contact SA ',
          email: '',
          phone: '',
          street: ' Avenue de la Gare ',
          buildingNumber: ' 8 ',
          postalCode: ' 1003 ',
          city: ' Lausanne ',
          canton: ' VD ',
          country: ' ch ',
        },
        'client-company-only',
      ),
    ).toEqual(expect.objectContaining({
      id: 'client-company-only',
      name: 'Entreprise sans personne de contact SA',
      company: 'Entreprise sans personne de contact SA',
      contactPerson: '',
    }));

    expect(() =>
      prepareDocumentQuickClient(
        {
          contactPerson: ' ',
          company: ' ',
          email: '',
          phone: '',
          street: 'Rue du Lac',
          buildingNumber: '',
          postalCode: '1007',
          city: 'Lausanne',
          canton: 'VD',
          country: 'CH',
        },
        'client-without-name',
      ),
    ).toThrow(/nom de contact ou une entreprise/);
  });

  it('bloque une validité ou une échéance antérieure à l’émission', () => {
    expect(salesDocumentDateError('quotes', '2026-09-04', '2026-09-03')).toBe(
      'La date de validité ne peut pas précéder la date d’émission.',
    );
    expect(salesDocumentDateError('invoices', '2026-09-04', '2026-09-03')).toBe(
      'L’échéance ne peut pas précéder la date d’émission.',
    );
    expect(salesDocumentDateError('invoices', '2026-09-04', '2026-09-04')).toBe('');
    expect(salesDocumentDateError('quotes', '2026-09-04', '2026-10-04')).toBe('');
  });

  it('distingue un taux TVA 0 % explicite d’un taux encore non sélectionné', () => {
    const line = {
      id: 'line-1',
      catalogItemId: null,
      description: 'Opération hors TVA',
      quantity: 1,
      unit: 'forfait',
      unitPriceCents: 10_000,
      discountBp: 0,
      vatRateBp: 0,
    };
    expect(documentLinesValidationError([line])).toBe('');
    expect(documentLinesValidationError([{ ...line, vatRateBp: -1 }])).toContain(
      'Complétez chaque ligne',
    );
    expect(documentLinesValidationError([{ ...line, discountBp: 10_001 }])).toContain(
      'remise',
    );
    expect(documentVatRateFromInput('')).toBe(-1);
    expect(documentVatRateFromInput('0')).toBe(0);
    expect(documentVatRateFromInput('810')).toBe(810);
  });
});
