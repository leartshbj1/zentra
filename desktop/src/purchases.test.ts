import { describe, expect, it } from 'vitest';
import {
  expensePaymentStatusFromRaw,
  filterPurchaseExpenses,
  filterSupplierInvoices,
  filterSuppliers,
  isExpenseOverdue,
  isSupplierInvoiceOverdue,
  purchaseSummary,
  selectableSuppliers,
  supplierDueDate,
  supplierInvoiceAccountingReady,
  supplierSnapshotForDraft,
} from './purchases';
import type {
  AccountingSettings,
  Expense,
  Project,
  Supplier,
  SupplierInvoice,
} from './types';
import { projectFinancials } from './utils';
import { supplierInvoiceLineTotals } from './PurchasesScreen';

const supplier: Supplier = {
  id: 'supplier-1',
  name: 'Matériaux Léman SA',
  contactName: 'Lina Meyer',
  email: 'achats@example.ch',
  phone: '+41 22 555 00 00',
  address: 'Rue du Lac 1\n1200 Genève',
  uidNumber: 'CHE-123.456.789',
  iban: 'CH9300762011623852957',
  currency: 'CHF',
  paymentTermsDays: 20,
  notes: 'Livraison le matin',
  archivedAt: null,
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-01T08:00:00Z',
};

const project: Project = {
  id: 'project-1',
  clientId: 'client-1',
  name: 'Rénovation Pâquis',
  address: '',
  status: 'in_progress',
  plannedStart: '',
  plannedEnd: '',
  actualStart: '',
  actualEnd: '',
  budgetCents: 0,
  plannedMinutes: 0,
  notes: '',
};

const pending: Expense = {
  id: 'expense-pending',
  projectId: project.id,
  supplierId: supplier.id,
  date: '2026-08-01',
  dueDate: '2026-08-21',
  supplier: 'Ancien nom du fournisseur',
  category: 'Matériaux',
  reference: 'FAC-001',
  netCents: 10_000,
  vatCents: 810,
  totalCents: 10_810,
  paymentStatus: 'pending',
  paidAt: null,
  reimbursable: false,
  note: 'Câbles',
};

const paid: Expense = {
  ...pending,
  id: 'expense-paid',
  projectId: null,
  dueDate: null,
  supplier: 'Papeterie locale',
  category: 'Fournitures',
  reference: 'TICKET-2',
  totalCents: 2_000,
  paymentStatus: 'paid',
  paidAt: null,
};

const supplierInvoice: SupplierInvoice = {
  id: 'supplier-invoice-1',
  supplierId: supplier.id,
  projectId: project.id,
  documentDate: '2026-08-10',
  dueDate: '2026-08-30',
  supplierName: supplier.name,
  reference: 'FOUR-2026-001',
  currency: 'CHF',
  documentStatus: 'validated',
  paymentStatus: 'partial',
  netCents: 20_000,
  vatCents: 0,
  totalCents: 20_000,
  paidCents: 8_000,
  creditedCents: 0,
  balanceCents: 12_000,
  matchStatus: 'unmatched',
  validatedAt: '2026-08-10T08:00:00Z',
  validationJournalEntryId: 'journal-supplier-1',
  note: 'Livraison principale',
  lines: [
    {
      id: 'supplier-line-1',
      supplierInvoiceId: 'supplier-invoice-1',
      position: 0,
      description: 'Câbles cuivre',
      quantityMilli: 2_000,
      unit: 'bobine',
      unitPriceCents: 10_000,
      discountBp: 0,
      vatBp: 0,
      netCents: 20_000,
      vatCents: 0,
      totalCents: 20_000,
      category: 'Matériaux',
      expenseAccountId: null,
      projectId: null,
    },
  ],
  payments: [
    {
      id: 'supplier-payment-1',
      supplierInvoiceId: 'supplier-invoice-1',
      requestId: '26ec4237-fdf6-4212-9302-e7140c34a4cf',
      date: '2026-08-20',
      amountCents: 8_000,
      method: 'bank_transfer',
      reference: 'VIR-BANQUE-77',
      notes: 'Premier acompte',
      journalEntryId: 'journal-payment-1',
      createdAt: '2026-08-20T08:00:00Z',
    },
  ],
  attachments: [],
  createdAt: '2026-08-10T08:00:00Z',
  updatedAt: '2026-08-20T08:00:00Z',
};

describe('compatibilité des achats', () => {
  it('ne transforme jamais un statut ancien ou inconnu en paiement', () => {
    expect(expensePaymentStatusFromRaw(undefined)).toBe('pending');
    expect(expensePaymentStatusFromRaw('inconnu')).toBe('pending');
    expect(expensePaymentStatusFromRaw('paid')).toBe('paid');
    expect(expensePaymentStatusFromRaw('pending')).toBe('pending');
  });

  it('n’invente aucune date de paiement pour une ancienne dépense', () => {
    expect(paid.paymentStatus).toBe('paid');
    expect(paid.paidAt).toBeNull();
  });
});

describe('pilotage des achats', () => {
  it('autorise une facture fournisseur sans exiger les comptes de paie', () => {
    const accounting = {
      enabled: true,
      arAccountId: 'ar',
      revenueAccountId: 'revenue',
      vatPayableAccountId: 'vat-payable',
      vatDeferredPayableAccountId: 'vat-deferred',
      bankAccountId: 'bank',
      expenseAccountId: 'expense',
      vatReceivableAccountId: 'vat-receivable',
      supplierPayableAccountId: 'supplier-payable',
      wagesExpenseAccountId: '',
      wagesPayableAccountId: '',
      socialExpenseAccountId: '',
      socialPayableAccountId: '',
    } satisfies AccountingSettings;

    expect(supplierInvoiceAccountingReady(accounting)).toBe(true);
    expect(
      supplierInvoiceAccountingReady({
        ...accounting,
        supplierPayableAccountId: '',
      }),
    ).toBe(false);
    expect(
      supplierInvoiceAccountingReady({ ...accounting, enabled: false }),
    ).toBe(false);
  });

  it('sépare les montants à payer, échus et payés', () => {
    expect(purchaseSummary([pending, paid], '2026-09-01')).toEqual({
      draftCount: 0,
      partialCount: 0,
      pendingCents: 10_810,
      overdueCents: 10_810,
      paidCents: 2_000,
      pendingCount: 1,
      overdueCount: 1,
      paidCount: 1,
    });
    expect(
      isExpenseOverdue({ ...pending, dueDate: '2026-09-01' }, '2026-09-01'),
    ).toBe(false);
  });

  it('additionne le solde fournisseur, les acomptes et exclut les brouillons', () => {
    const draft = {
      ...supplierInvoice,
      id: 'supplier-draft',
      documentStatus: 'draft' as const,
      paymentStatus: null,
      paidCents: 0,
      balanceCents: 20_000,
      payments: [],
      updatedAt: '2026-09-02T10:00:00Z',
    };
    const fullyPaid = {
      ...supplierInvoice,
      id: 'supplier-paid',
      paymentStatus: 'paid' as const,
      paidCents: 20_000,
      balanceCents: 0,
      dueDate: '2026-09-30',
    };
    expect(
      purchaseSummary([], '2026-09-01', [draft, supplierInvoice, fullyPaid]),
    ).toEqual({
      draftCount: 1,
      partialCount: 1,
      pendingCents: 12_000,
      overdueCents: 12_000,
      paidCents: 28_000,
      pendingCount: 1,
      overdueCount: 1,
      paidCount: 1,
    });
    expect(
      isSupplierInvoiceOverdue(
        { ...supplierInvoice, dueDate: '2026-09-01' },
        '2026-09-01',
      ),
    ).toBe(false);
  });

  it('filtre les quatre états et retrouve les lignes comme les références de paiement', () => {
    const draft = {
      ...supplierInvoice,
      id: 'draft',
      documentStatus: 'draft' as const,
      paymentStatus: null,
      payments: [],
      updatedAt: '2026-09-02T10:00:00Z',
    };
    const pendingInvoice = {
      ...supplierInvoice,
      id: 'pending',
      paymentStatus: 'pending' as const,
      paidCents: 0,
      balanceCents: 20_000,
      payments: [],
    };
    const paidInvoice = {
      ...supplierInvoice,
      id: 'paid',
      paymentStatus: 'paid' as const,
      paidCents: 20_000,
      balanceCents: 0,
    };
    const invoices = [pendingInvoice, supplierInvoice, paidInvoice, draft];
    expect(
      filterSupplierInvoices(invoices, [project], '', 'draft').map(
        (item) => item.id,
      ),
    ).toEqual(['draft']);
    expect(
      filterSupplierInvoices(invoices, [project], '', 'pending').map(
        (item) => item.id,
      ),
    ).toEqual(['pending']);
    expect(
      filterSupplierInvoices(
        invoices,
        [project],
        'câbles cuivre',
        'partial',
      ).map((item) => item.id),
    ).toEqual(['supplier-invoice-1']);
    expect(
      filterSupplierInvoices(invoices, [project], 'VIR-BANQUE-77', 'paid').map(
        (item) => item.id,
      ),
    ).toEqual(['paid']);
    expect(
      filterSupplierInvoices(
        invoices,
        [project],
        'premier acompte',
        'partial',
      ).map((item) => item.id),
    ).toEqual(['supplier-invoice-1']);
  });

  it('intègre uniquement les lignes fournisseur validées à la rentabilité du projet', () => {
    const draft = {
      ...supplierInvoice,
      id: 'draft-cost',
      documentStatus: 'draft' as const,
      paymentStatus: null,
    };
    const stats = projectFinancials(
      project,
      [],
      [],
      [],
      [],
      [supplierInvoice, draft],
    );
    expect(stats.expenseNet).toBe(20_000);
    expect(stats.margin).toBe(-20_000);
  });

  it('arrondit quantité, remise et TVA comme le moteur local', () => {
    expect(
      supplierInvoiceLineTotals({
        id: 'line-rounding',
        description: 'Ligne arrondie',
        quantityMilli: 1_333,
        unit: 'heure',
        unitPriceCents: 12_345,
        discountBp: 750,
        vatBp: 810,
        category: 'Prestation',
        expenseAccountId: '',
        projectId: '',
      }),
    ).toEqual({ netCents: 15_222, vatCents: 1_233, totalCents: 16_455 });
  });

  it('recherche dans le snapshot, la référence et le projet tout en acceptant un achat sans projet', () => {
    expect(
      filterPurchaseExpenses(
        [pending, paid],
        [project],
        'pâquis',
        'pending',
      ).map((item) => item.id),
    ).toEqual(['expense-pending']);
    expect(
      filterPurchaseExpenses(
        [pending, paid],
        [project],
        'ticket-2',
        'paid',
      ).map((item) => item.id),
    ).toEqual(['expense-paid']);
  });

  it('calcule l’échéance depuis les conditions du fournisseur ou le délai global', () => {
    expect(supplierDueDate('2026-09-01', supplier, 30)).toBe('2026-09-21');
    expect(supplierDueDate('2026-09-01', undefined, 30)).toBe('2026-10-01');
  });
});

describe('annuaire fournisseurs et snapshots', () => {
  const archived = {
    ...supplier,
    id: 'supplier-old',
    name: 'Ancien fournisseur',
    archivedAt: '2026-09-01T09:00:00Z',
  };

  it('exclut les archivés par défaut mais permet de les retrouver', () => {
    expect(
      filterSuppliers([archived, supplier], '', 'active').map(
        (item) => item.id,
      ),
    ).toEqual(['supplier-1']);
    expect(
      filterSuppliers([archived, supplier], 'ancien', 'archived').map(
        (item) => item.id,
      ),
    ).toEqual(['supplier-old']);
  });

  it('propose le fournisseur archivé déjà lié uniquement pour préserver une édition', () => {
    expect(
      selectableSuppliers([supplier, archived]).map((item) => item.id),
    ).toEqual(['supplier-1']);
    expect(
      selectableSuppliers([supplier, archived], archived.id).map(
        (item) => item.id,
      ),
    ).toEqual(['supplier-old', 'supplier-1']);
  });

  it('préserve le snapshot si le lien ne change pas et copie le nouveau nom lors d’un changement', () => {
    expect(supplierSnapshotForDraft(pending, supplier, '')).toBe(
      'Ancien nom du fournisseur',
    );
    expect(
      supplierSnapshotForDraft(
        pending,
        { ...supplier, id: 'supplier-2', name: 'Nouveau fournisseur' },
        '',
      ),
    ).toBe('Nouveau fournisseur');
    expect(
      supplierSnapshotForDraft(undefined, undefined, '  Saisie libre  '),
    ).toBe('Saisie libre');
  });
});
