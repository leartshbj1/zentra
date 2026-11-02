import { describe, expect, it } from 'vitest';
import { supplierPaymentInput } from './purchaseFormValidation';

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

