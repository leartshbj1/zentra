import { describe, expect, it } from 'vitest';
import {
  netAmountForGross,
  supplierEmailDraftIssues,
  supplierEmailImportPayload,
  type SupplierEmailImportDraft,
  type SupplierEmailInspection,
} from './supplierEmail';
import type { Workspace } from './types';

const inspection: SupplierEmailInspection = {
  fileName: 'facture.eml',
  fileSizeBytes: 1200,
  sha256: 'a'.repeat(64),
  messageId: 'message-42@example',
  subject: 'Facture INV-42',
  senderName: 'Papeterie SA',
  senderEmail: 'factures@papeterie.example',
  attachmentNames: ['facture.pdf'],
  invoiceSignal: true,
  confidence: 'high',
  matchedSupplierId: 'supplier-1',
  duplicateInvoiceId: null,
  reference: 'INV-42',
  documentDate: '2026-09-02',
  dueDate: '2026-10-02',
  currency: 'CHF',
  netCents: 10_000,
  vatCents: 810,
  totalCents: 10_810,
  issues: [],
  networkAccess: false,
  aiUsed: false,
};

const draft: SupplierEmailImportDraft = {
  id: '7ba86f19-c15d-4cb2-8151-30bd2f39f640',
  supplierId: 'supplier-1',
  projectId: '',
  reference: 'INV-42',
  documentDate: '2026-09-02',
  dueDate: '2026-10-02',
  currency: 'CHF',
  totalCents: 10_810,
  vatBp: 810,
  category: 'Matériel',
  expenseAccountId: 'account-expense',
  description: 'Papeterie',
};

const workspace = {
  suppliers: [{ id: 'supplier-1', archivedAt: null }],
  supplierInvoices: [],
} as unknown as Workspace;

describe('import déterministe de facture reçue par e-mail', () => {
  it('retrouve un net dont le calcul TVA reproduit exactement le total', () => {
    expect(netAmountForGross(10_810, 810)).toBe(10_000);
    expect(netAmountForGross(10_000, 0)).toBe(10_000);
  });

  it('construit un brouillon auditable sans le valider ni le payer', () => {
    expect(supplierEmailDraftIssues(draft, inspection, workspace)).toEqual([]);
    expect(supplierEmailImportPayload(draft, inspection)).toMatchObject({
      id: '7ba86f19-c15d-4cb2-8151-30bd2f39f640',
      supplierId: 'supplier-1',
      reference: 'INV-42',
      items: [
        {
          unitPriceCents: 10_000,
          vatBp: 810,
          category: 'Matériel',
          expenseAccountId: 'account-expense',
        },
      ],
    });
    expect(supplierEmailImportPayload(draft, inspection).note).toContain(
      `SHA-256: ${inspection.sha256}`,
    );
  });

  it('conserve le même identifiant de brouillon lors de chaque reprise', () => {
    const firstAttempt = supplierEmailImportPayload(draft, inspection);
    const retryAfterRefreshFailure = supplierEmailImportPayload(
      draft,
      inspection,
    );

    expect(firstAttempt.id).toBe(draft.id);
    expect(retryAfterRefreshFailure.id).toBe(firstAttempt.id);
  });

  it('ne bloque pas le brouillon repris comme un doublon de lui-même', () => {
    const refreshedWorkspace = {
      ...workspace,
      supplierInvoices: [
        {
          id: draft.id,
          supplierId: draft.supplierId,
          reference: draft.reference,
        },
      ],
    } as Workspace;

    expect(
      supplierEmailDraftIssues(draft, inspection, refreshedWorkspace),
    ).toEqual([]);
  });

  it('bloque doublons, devises étrangères et champs non contrôlés', () => {
    const duplicateWorkspace = {
      ...workspace,
      supplierInvoices: [
        { supplierId: 'supplier-1', reference: 'INV-42', id: 'invoice-1' },
      ],
    } as Workspace;
    const duplicateIssues = supplierEmailDraftIssues(
      { ...draft, currency: 'EUR' },
      { ...inspection, currency: 'EUR', duplicateInvoiceId: 'invoice-1' },
      duplicateWorkspace,
    );
    expect(duplicateIssues).toEqual(
      expect.arrayContaining([
        'Cette référence existe déjà pour ce fournisseur.',
        'Seules les factures fournisseurs en CHF sont importables actuellement.',
      ]),
    );
    const issues = supplierEmailDraftIssues(
      {
        ...draft,
        supplierId: '',
        dueDate: '2026-08-01',
        reference: '',
        totalCents: 0,
      },
      inspection,
      workspace,
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        'Choisissez un fournisseur actif.',
        'Indiquez la référence fournisseur.',
        'Indiquez un montant total positif.',
      ]),
    );
  });
});
