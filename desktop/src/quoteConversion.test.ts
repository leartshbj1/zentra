import { describe, expect, it } from 'vitest';
import {
  parseDepositPercentageBp,
  quoteConversionPreview,
  quoteConversionSelection,
} from './quoteConversion';

const lines = [
  {
    id: 'line-1',
    catalogItemId: 'service-1',
    description: 'Conseil',
    quantity: 2,
    unit: 'heure',
    unitPriceCents: 10_000,
    discountBp: 1_000,
    vatRateBp: 810,
  },
  {
    id: 'line-2',
    catalogItemId: null,
    description: 'Débours',
    quantity: 1,
    unit: 'forfait',
    unitPriceCents: 2_500,
    discountBp: 0,
    vatRateBp: 260,
  },
];

describe('choix d’acompte pendant la conversion d’un devis', () => {
  it('conserve une facture complète quand l’option est désactivée', () => {
    expect(quoteConversionSelection(false, 'valeur ignorée')).toEqual({
      depositPercentageBp: null,
      error: null,
    });
    expect(quoteConversionPreview(lines, null)).toEqual({
      quoteTotalCents: 22_023,
      invoiceTotalCents: 22_023,
      remainingCents: 0,
    });
  });

  it('accepte le point ou la virgule et conserve exactement deux décimales', () => {
    expect(parseDepositPercentageBp('0,01')).toBe(1);
    expect(parseDepositPercentageBp('30')).toBe(3_000);
    expect(parseDepositPercentageBp('33.33')).toBe(3_333);
    expect(parseDepositPercentageBp('100,00')).toBe(10_000);
  });

  it('refuse les valeurs hors bornes ou trop précises', () => {
    for (const value of ['', 'texte', '0', '-1', '3 0', '30,001', '100,01']) {
      expect(parseDepositPercentageBp(value)).toBeNull();
      expect(quoteConversionSelection(true, value).error).toMatch(/0,01 et 100/);
    }
  });

  it('calcule l’aperçu avec les remises et les différents taux de TVA', () => {
    expect(quoteConversionPreview(lines, 3_000)).toEqual({
      quoteTotalCents: 22_023,
      invoiceTotalCents: 6_607,
      remainingCents: 15_416,
    });
  });
});
