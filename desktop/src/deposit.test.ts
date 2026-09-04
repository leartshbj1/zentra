import { describe, expect, it } from 'vitest';
import { buildDepositLines, restoreDepositBaseLines } from './deposit';
import { documentTotals } from './utils';

describe('facture d’acompte en pourcentage', () => {
  const base = [
    {
      id: 'base-1',
      catalogItemId: 'stock-1',
      description: 'Travaux préparatoires',
      quantity: 2,
      unit: 'jour',
      unitPriceCents: 50_000,
      discountBp: 0,
      vatRateBp: 810,
    },
    {
      id: 'base-2',
      catalogItemId: 'stock-2',
      description: 'Matériel',
      quantity: 1,
      unit: 'forfait',
      unitPriceCents: 25_000,
      discountBp: 1_000,
      vatRateBp: 810,
    },
  ];

  it('calcule les bases nettes par taux et neutralise les sorties de stock', () => {
    let sequence = 0;
    const lines = buildDepositLines(base, 3_000, () => `deposit-${++sequence}`);
    expect(lines).toEqual([
      expect.objectContaining({
        id: 'deposit-1',
        catalogItemId: null,
        description: 'Acompte 30 % — Travaux préparatoires',
        quantity: 1,
        unit: 'acompte',
        unitPriceCents: 30_000,
        discountBp: 0,
        vatRateBp: 810,
      }),
      expect.objectContaining({ unitPriceCents: 6_750, catalogItemId: null }),
    ]);
    expect(documentTotals(lines).netCents).toBe(36_750);
  });

  it('permet de recalculer un brouillon sauvegardé depuis sa base reconstituée', () => {
    const first = buildDepositLines(base, 3_000, () => 'first');
    const restored = restoreDepositBaseLines(first, 3_000);
    const second = buildDepositLines(restored, 5_000, () => 'second');
    expect(second[0].unitPriceCents).toBe(50_000);
    expect(second[0].description).toBe('Acompte 50 % — Travaux préparatoires');
  });

  it('refuse zéro et les pourcentages supérieurs à 100 %', () => {
    expect(() => buildDepositLines(base, 0)).toThrow(/0,01 et 100/);
    expect(() => buildDepositLines(base, 10_001)).toThrow(/0,01 et 100/);
  });
});
