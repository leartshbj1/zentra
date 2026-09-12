import { describe, expect, it } from 'vitest';
import { supplierDraftError, supplierPaymentInput } from './purchaseFormValidation';

describe('paiement du fournisseur', () => {
  it('accepte un règlement partiel avec virgule sans arrondir la saisie', () => {
    expect(supplierPaymentInput('50,25', '2026-09-06', '2026-09-01', 10810)).toEqual({ amountCents: 5025, error: '' });
  });
  it.each(['', '0', '-1', '1e2', '1.001', 'Infinity', '10 CHF'])('explique le montant incorrect %s', amount => {
    expect(supplierPaymentInput(amount, '2026-09-06', '2026-09-01', 10810).error).toMatch(/montant réellement payé/);
  });
  it('compare au solde actuel et vérifie la date réelle', () => {
    expect(supplierPaymentInput('108.11', '2026-09-06', '2026-09-01', 10810).error).toMatch(/dépasse le solde/);
    expect(supplierPaymentInput('50', '2026-02-30', '2026-01-01', 10810).error).toMatch(/date/);
    expect(supplierPaymentInput('50', '2026-08-31', '2026-09-01', 10810).error).toMatch(/précéder/);
  });
});

describe('facture fournisseur', () => {
  const line = { description: 'Câbles', quantityMilli: 1000, unit: 'pièce', unitPriceCents: 10000, discountBp: 0, vatBp: 810, category: 'Marchandises' };
  it('indique la ligne et l’action qui bloquent le brouillon', () => {
    expect(supplierDraftError('supplier', '2026-09-01', '2026-09-30', [line, { ...line, description: ' ' }], [810], 21620)).toBe('Ligne 2 : décrivez ce que vous avez acheté.');
    expect(supplierDraftError('supplier', '2026-09-01', '2026-09-30', [{ ...line, vatBp: 770 }], [810], 10770)).toMatch(/Ligne 1.*taux/);
  });
  it('permet la saisie valide et explique les dates inversées', () => {
    expect(supplierDraftError('supplier', '2026-09-01', '2026-09-30', [line], [810], 10810)).toBe('');
    expect(supplierDraftError('supplier', '2026-09-01', '2026-08-30', [line], [810], 10810)).toMatch(/échéance/);
  });
});
