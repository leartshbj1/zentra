import { describe, expect, it } from 'vitest';
import { balanceFromRows, balanceFromTrial, consolidate, consolidationCsv } from './consolidation';
import type { TrialBalanceRow } from './types';

const trial = (code: string, name: string, accountType: TrialBalanceRow['accountType'], debitBalanceCents: number, creditBalanceCents: number, debitCents = 0, creditCents = 0) =>
  ({ id: code, code, name, accountType, normalBalance: 'debit', reportSection: 'current_assets', active: true, openingDebitCents: 0, openingCreditCents: 0, openingDebitBalanceCents: 0, openingCreditBalanceCents: 0, openingNetDebitCents: 0, debitCents, creditCents, debitBalanceCents, creditBalanceCents, closingNetDebitCents: debitBalanceCents - creditBalanceCents }) as TrialBalanceRow;

// Mère : banque 50 000, créance sur la fille 10 000, capital 40 000, ventes 30 000 dont 10 000 à la fille, charges 10 000.
const parent = balanceFromTrial('mere', 'Holding SA', [
  trial('1020', 'Banque', 'asset', 5_000_000, 0),
  trial('1100', 'Créances', 'asset', 1_000_000, 0),
  trial('2800', 'Capital', 'equity', 0, 4_000_000),
  trial('3200', 'Ventes', 'revenue', 0, 3_000_000, 0, 3_000_000),
  trial('4000', 'Charges', 'expense', 1_000_000, 0, 1_000_000, 0),
]);
// Fille lue depuis un fichier : une colonne de solde dans le sens normal.
const child = balanceFromRows('fille', 'Atelier Sàrl', [
  { code: '1020', name: 'Banque', balanceCents: 2_000_000, debitCents: null, creditCents: null, errors: [] },
  { code: '2000', name: 'Fournisseurs', balanceCents: 1_000_000, debitCents: null, creditCents: null, errors: [] },
  { code: '2800', name: 'Capital', balanceCents: 2_000_000, debitCents: null, creditCents: null, errors: [] },
  { code: '4000', name: 'Charges', balanceCents: 1_000_000, debitCents: null, creditCents: null, errors: [] },
  { code: '3200', name: 'Ventes', balanceCents: 0, debitCents: null, creditCents: null, errors: [] },
  { code: 'XX', name: 'Illisible', balanceCents: 5, debitCents: null, creditCents: null, errors: ['Montant illisible'] },
]);

describe('consolidation', () => {
  it('adds companies account by account and checks the balance sheet', () => {
    const result = consolidate([parent, child], []);
    expect(result.balanceSheet.find((line) => line.code === '1020')).toMatchObject({ byCompany: [5_000_000, 2_000_000], totalCents: 7_000_000 });
    expect(result.totals).toEqual({ assetsCents: 8_000_000, liabilitiesAndEquityCents: 7_000_000, resultCents: 1_000_000, revenueCents: 3_000_000, expenseCents: 2_000_000 });
    expect(result.balanced).toBe(true);
    expect(result.unclassified).toEqual([]);
  });

  it('applies balanced manual eliminations of intercompany balances and sales', () => {
    const result = consolidate([parent, child], [
      { id: '1', code: '2000', label: 'Dette envers la holding', debitCents: 1_000_000, creditCents: 0 },
      { id: '2', code: '1100', label: 'Créance sur la fille', debitCents: 0, creditCents: 1_000_000 },
      { id: '3', code: '3200', label: 'Vente interne', debitCents: 1_000_000, creditCents: 0 },
      { id: '4', code: '4000', label: 'Achat interne', debitCents: 0, creditCents: 1_000_000 },
    ]);
    expect(result.eliminationsBalanced).toBe(true);
    expect(result.totals).toEqual({ assetsCents: 7_000_000, liabilitiesAndEquityCents: 6_000_000, resultCents: 1_000_000, revenueCents: 2_000_000, expenseCents: 1_000_000 });
    expect(result.balanced).toBe(true);
    expect(consolidate([parent], [{ id: 'x', code: '1100', label: 'Seule', debitCents: 0, creditCents: 100 }]).eliminationsBalanced).toBe(false);
  });

  it('writes one CSV row per account with a column per company', () => {
    const csv = consolidationCsv([parent, child], consolidate([parent, child], []));
    const rows = csv.replace('﻿', '').trimEnd().split('\r\n');
    expect(rows[0]).toBe('Compte;Nom;Holding SA;Atelier Sàrl;Éliminations;Consolidé');
    expect(rows).toContain('2800;Capital;-40000.00;-20000.00;0.00;-60000.00');
  });
});
