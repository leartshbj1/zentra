import { describe, expect, it } from 'vitest';
import { purchaseCostCategories, purchaseVatOptions } from './purchaseVat';

describe('purchase defaults independent of sales settings', () => {
  it('keeps current Swiss supplier rates available with no sales rates', () => {
    expect(purchaseVatOptions(false, []).sort()).toEqual([0,260,380,810].sort());
    expect(purchaseVatOptions(true, []).sort()).toEqual([0,260,380,810].sort());
  });
  it('provides usable purchase categories before customization', () => {
    expect(purchaseCostCategories([])).toEqual(['Marchandises', 'Prestations de services', 'Autres achats']);
    expect(purchaseCostCategories([' ', ''])).toEqual(purchaseCostCategories([]));
  });
  it('preserves customized categories without empty or duplicate choices', () => {
    expect(purchaseCostCategories([' Bois ', 'Bois', '', 'Sous-traitance'])).toEqual(['Bois', 'Sous-traitance']);
  });
});
