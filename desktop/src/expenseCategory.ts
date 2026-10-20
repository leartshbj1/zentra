// Catégorie proposée pour une dépense payée par la banque, d'après les
// dépenses et factures déjà enregistrées chez le même fournisseur. Règle
// déterministe : la catégorie la plus utilisée, puis la plus récente.

import type { Expense, SupplierInvoice } from './types';

const LEGAL_FORMS = /\b(ag|sa|sarl|sàrl|gmbh|sagl|ltd|inc|cie|co|kg|und|et)\b/g;

/** « Swisscom (Schweiz) AG » et « SWISSCOM SCHWEIZ » donnent la même clé. */
export function counterpartyKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(LEGAL_FORMS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameCounterparty(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  // Un libellé bancaire tronqué ou complété (« swisscom » / « swisscom schweiz ») compte.
  return short.length >= 4 && (long.startsWith(short + ' ') || long.endsWith(' ' + short));
}

export type CategorySuggestion = Readonly<{ category: string; uses: number; lastUsed: string }>;

export function suggestExpenseCategory(
  counterparty: string,
  expenses: readonly Pick<Expense, 'supplier' | 'category' | 'date' | 'archivedAt'>[],
  supplierInvoices: readonly Pick<SupplierInvoice, 'supplierName' | 'documentDate' | 'documentStatus' | 'lines'>[],
): CategorySuggestion | null {
  const key = counterpartyKey(counterparty);
  if (!key) return null;
  const tally = new Map<string, { uses: number; lastUsed: string }>();
  const add = (category: string, date: string) => {
    const name = category.trim();
    if (!name) return;
    const current = tally.get(name) ?? { uses: 0, lastUsed: '' };
    tally.set(name, { uses: current.uses + 1, lastUsed: date > current.lastUsed ? date : current.lastUsed });
  };
  for (const expense of expenses) {
    if (!expense.archivedAt && sameCounterparty(key, counterpartyKey(expense.supplier))) add(expense.category, expense.date);
  }
  for (const invoice of supplierInvoices) {
    if (invoice.documentStatus !== 'validated' || !sameCounterparty(key, counterpartyKey(invoice.supplierName))) continue;
    for (const category of new Set(invoice.lines.map((line) => line.category))) add(category, invoice.documentDate);
  }
  let best: CategorySuggestion | null = null;
  for (const [category, { uses, lastUsed }] of tally) {
    if (!best || uses > best.uses || (uses === best.uses && lastUsed > best.lastUsed)) best = { category, uses, lastUsed };
  }
  return best;
}
