import { describe, expect, it } from 'vitest';
import { counterpartyKey, suggestExpenseCategory } from './expenseCategory';

const expense = (supplier: string, category: string, date: string, archivedAt: string | null = null) => ({ supplier, category, date, archivedAt });
const invoice = (supplierName: string, documentDate: string, categories: string[], documentStatus: 'validated' | 'draft' = 'validated') =>
  ({ supplierName, documentDate, documentStatus, lines: categories.map((category) => ({ category })) }) as never;

describe('catégorie proposée pour une dépense bancaire', () => {
  it('ramène les libellés bancaires et les fiches au même fournisseur', () => {
    expect(counterpartyKey('Swisscom (Schweiz) AG')).toBe('swisscom schweiz');
    expect(counterpartyKey('SWISSCOM SCHWEIZ')).toBe('swisscom schweiz');
    expect(counterpartyKey('Boulangerie Müller Sàrl')).toBe('boulangerie muller');
  });

  it('prend la catégorie la plus utilisée chez ce fournisseur', () => {
    const result = suggestExpenseCategory('SWISSCOM SCHWEIZ AG', [
      expense('Swisscom (Schweiz) AG', 'Télécommunications', '2026-08-02'),
      expense('Swisscom', 'Télécommunications', '2026-09-02'),
      expense('Swisscom', 'Matériel informatique', '2026-10-01'),
      expense('Sunrise', 'Télécommunications', '2026-10-01'),
    ], []);
    expect(result).toEqual({ category: 'Télécommunications', uses: 2, lastUsed: '2026-09-02' });
  });

  it('départage par la date la plus récente et compte les factures fournisseurs validées', () => {
    const result = suggestExpenseCategory('Garage Martin', [expense('Garage Martin', 'Véhicules', '2026-05-01')], [
      invoice('Garage Martin', '2026-09-15', ['Entretien', 'Entretien']),
      invoice('Garage Martin', '2026-10-01', ['Pneus'], 'draft'),
    ]);
    expect(result?.category).toBe('Entretien');
  });

  it('ne propose rien sans historique ni pour une dépense archivée', () => {
    expect(suggestExpenseCategory('Inconnu SA', [expense('Autre', 'Divers', '2026-01-01')], [])).toBeNull();
    expect(suggestExpenseCategory('Migros', [expense('Migros', 'Repas', '2026-01-01', '2026-02-01')], [])).toBeNull();
    expect(suggestExpenseCategory('', [], [])).toBeNull();
  });
});
