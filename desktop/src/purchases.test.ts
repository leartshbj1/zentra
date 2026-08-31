import { describe, expect, it } from 'vitest';
import {
  expensePaymentStatusFromRaw,
  filterPurchaseExpenses,
  filterSuppliers,
  isExpenseOverdue,
  purchaseSummary,
  selectableSuppliers,
  supplierDueDate,
  supplierSnapshotForDraft,
} from './purchases';
import type { Expense, Project, Supplier } from './types';

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

describe('compatibilité des achats', () => {
  it('considère les anciennes dépenses sans nouveau champ comme déjà payées', () => {
    expect(expensePaymentStatusFromRaw(undefined)).toBe('paid');
    expect(expensePaymentStatusFromRaw('paid')).toBe('paid');
    expect(expensePaymentStatusFromRaw('pending')).toBe('pending');
  });

  it('n’invente aucune date de paiement pour une ancienne dépense', () => {
    expect(paid.paymentStatus).toBe('paid');
    expect(paid.paidAt).toBeNull();
  });
});

describe('pilotage des achats', () => {
  it('sépare les montants à payer, échus et payés', () => {
    expect(purchaseSummary([pending, paid], '2026-09-01')).toEqual({
      pendingCents: 10_810,
      overdueCents: 10_810,
      paidCents: 2_000,
      pendingCount: 1,
      overdueCount: 1,
      paidCount: 1,
    });
    expect(isExpenseOverdue({ ...pending, dueDate: '2026-09-01' }, '2026-09-01')).toBe(false);
  });

  it('recherche dans le snapshot, la référence et le projet tout en acceptant un achat sans projet', () => {
    expect(filterPurchaseExpenses([pending, paid], [project], 'pâquis', 'pending').map((item) => item.id)).toEqual(['expense-pending']);
    expect(filterPurchaseExpenses([pending, paid], [project], 'ticket-2', 'paid').map((item) => item.id)).toEqual(['expense-paid']);
  });

  it('calcule l’échéance depuis les conditions du fournisseur ou le délai global', () => {
    expect(supplierDueDate('2026-09-01', supplier, 30)).toBe('2026-09-21');
    expect(supplierDueDate('2026-09-01', undefined, 30)).toBe('2026-10-01');
  });
});

describe('annuaire fournisseurs et snapshots', () => {
  const archived = { ...supplier, id: 'supplier-old', name: 'Ancien fournisseur', archivedAt: '2026-09-01T09:00:00Z' };

  it('exclut les archivés par défaut mais permet de les retrouver', () => {
    expect(filterSuppliers([archived, supplier], '', 'active').map((item) => item.id)).toEqual(['supplier-1']);
    expect(filterSuppliers([archived, supplier], 'ancien', 'archived').map((item) => item.id)).toEqual(['supplier-old']);
  });

  it('propose le fournisseur archivé déjà lié uniquement pour préserver une édition', () => {
    expect(selectableSuppliers([supplier, archived]).map((item) => item.id)).toEqual(['supplier-1']);
    expect(selectableSuppliers([supplier, archived], archived.id).map((item) => item.id)).toEqual(['supplier-old', 'supplier-1']);
  });

  it('préserve le snapshot si le lien ne change pas et copie le nouveau nom lors d’un changement', () => {
    expect(supplierSnapshotForDraft(pending, supplier, '')).toBe('Ancien nom du fournisseur');
    expect(supplierSnapshotForDraft(pending, { ...supplier, id: 'supplier-2', name: 'Nouveau fournisseur' }, '')).toBe('Nouveau fournisseur');
    expect(supplierSnapshotForDraft(undefined, undefined, '  Saisie libre  ')).toBe('Saisie libre');
  });
});
