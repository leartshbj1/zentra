// Consolidation simple de plusieurs sociétés : bilan et résultat additionnés
// compte par compte, plus des éliminations saisies à la main (créances et
// dettes réciproques, ventes internes). Tout est calculé ici, en centimes, à
// partir de la balance de chaque société ; rien n'est écrit dans la
// comptabilité de l'entreprise ouverte.
import { swissAccountClass } from './chartImport';
import type { AccountType, TrialBalanceRow } from './types';

/** Solde d'un compte en « débit net » : positif au débit, négatif au crédit. */
export type CompanyBalance = { id: string; name: string; accounts: Record<string, { name: string; netDebitCents: number; type: AccountType | null }> };
export type Elimination = { id: string; code: string; label: string; debitCents: number; creditCents: number };

const resultType = (type: AccountType | null) => type === 'revenue' || type === 'expense';

/** Balance de l'entreprise ouverte : clôture pour le bilan, mouvements de la période pour le résultat. */
export function balanceFromTrial(id: string, name: string, rows: readonly TrialBalanceRow[]): CompanyBalance {
  const accounts: CompanyBalance['accounts'] = {};
  for (const row of rows) {
    const netDebitCents = resultType(row.accountType) ? row.debitCents - row.creditCents : row.debitBalanceCents - row.creditBalanceCents;
    if (netDebitCents) accounts[row.code] = { name: row.name, netDebitCents, type: row.accountType };
  }
  return { id, name, accounts };
}

/**
 * Balance lue dans un fichier (même lecture que le bilan d'ouverture) : avec
 * débit et crédit, le solde est leur différence ; avec une seule colonne, le
 * solde est dans le sens normal du compte (actif et charge au débit).
 */
export function balanceFromRows(
  id: string,
  name: string,
  rows: readonly { code: string; name: string; balanceCents: number | null; debitCents: number | null; creditCents: number | null; errors: string[] }[],
): CompanyBalance {
  const accounts: CompanyBalance['accounts'] = {};
  for (const row of rows) {
    if (row.errors.length) continue;
    const type = swissAccountClass(row.code)?.accountType ?? null;
    const debitNormal = type === 'asset' || type === 'expense';
    const netDebitCents = row.balanceCents !== null ? (debitNormal ? row.balanceCents : -row.balanceCents) : (row.debitCents ?? 0) - (row.creditCents ?? 0);
    if (netDebitCents) accounts[row.code] = { name: row.name, netDebitCents: (accounts[row.code]?.netDebitCents ?? 0) + netDebitCents, type };
  }
  return { id, name, accounts };
}

export type ConsolidatedLine = { code: string; name: string; type: AccountType | null; byCompany: number[]; eliminationCents: number; totalCents: number };

export type Consolidation = {
  balanceSheet: ConsolidatedLine[];
  income: ConsolidatedLine[];
  /** Comptes sans nature connue : à classer avant de se fier aux totaux. */
  unclassified: ConsolidatedLine[];
  totals: { assetsCents: number; liabilitiesAndEquityCents: number; resultCents: number; revenueCents: number; expenseCents: number };
  eliminationsBalanced: boolean;
  /** Actifs = passifs + fonds propres + résultat de la période. */
  balanced: boolean;
};

export function consolidate(companies: readonly CompanyBalance[], eliminations: readonly Elimination[]): Consolidation {
  const codes = new Map<string, { name: string; type: AccountType | null }>();
  for (const company of companies) for (const [code, account] of Object.entries(company.accounts)) if (!codes.has(code)) codes.set(code, { name: account.name, type: account.type ?? swissAccountClass(code)?.accountType ?? null });
  for (const row of eliminations) if (row.code && !codes.has(row.code)) codes.set(row.code, { name: row.label, type: swissAccountClass(row.code)?.accountType ?? null });
  const lines: ConsolidatedLine[] = [...codes].sort(([a], [b]) => a.localeCompare(b, 'fr', { numeric: true })).map(([code, info]) => {
    const byCompany = companies.map((company) => company.accounts[code]?.netDebitCents ?? 0);
    const eliminationCents = eliminations.filter((row) => row.code === code).reduce((sum, row) => sum + row.debitCents - row.creditCents, 0);
    return { code, name: info.name, type: info.type, byCompany, eliminationCents, totalCents: byCompany.reduce((sum, value) => sum + value, 0) + eliminationCents };
  });
  const sum = (filter: (line: ConsolidatedLine) => boolean) => lines.filter(filter).reduce((total, line) => total + line.totalCents, 0);
  const assetsCents = sum((line) => line.type === 'asset');
  const liabilitiesAndEquityCents = -sum((line) => line.type === 'liability' || line.type === 'equity');
  const revenueCents = -sum((line) => line.type === 'revenue');
  const expenseCents = sum((line) => line.type === 'expense');
  const resultCents = revenueCents - expenseCents;
  const eliminationDebit = eliminations.reduce((total, row) => total + row.debitCents, 0);
  const eliminationCredit = eliminations.reduce((total, row) => total + row.creditCents, 0);
  return {
    balanceSheet: lines.filter((line) => line.type === 'asset' || line.type === 'liability' || line.type === 'equity'),
    income: lines.filter((line) => resultType(line.type)),
    unclassified: lines.filter((line) => !line.type),
    totals: { assetsCents, liabilitiesAndEquityCents, resultCents, revenueCents, expenseCents },
    eliminationsBalanced: eliminationDebit === eliminationCredit,
    balanced: assetsCents === liabilitiesAndEquityCents + resultCents,
  };
}

const money = (cents: number) => `${cents < 0 ? '-' : ''}${Math.trunc(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

/** Tableau CSV (point-virgule, BOM) : une ligne par compte, une colonne par société. */
export function consolidationCsv(companies: readonly CompanyBalance[], result: Consolidation): string {
  const header = ['Compte', 'Nom', ...companies.map((company) => company.name), 'Éliminations', 'Consolidé'];
  const cell = (value: string) => (/[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : /^[=+@-]/.test(value) && !/^-?\d/.test(value) ? `'${value}` : value);
  const row = (line: ConsolidatedLine) => [line.code, line.name, ...line.byCompany.map(money), money(line.eliminationCents), money(line.totalCents)];
  const lines = [header, ...[...result.balanceSheet, ...result.income, ...result.unclassified].map(row)];
  return '﻿' + lines.map((cells) => cells.map(cell).join(';')).join('\r\n') + '\r\n';
}
