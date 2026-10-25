import { describe, expect, it } from 'vitest';
import { chapterGroups, evaluateFormula, measurementQuantity, measurementQuantityMilli, measurementRowMilli, measurementRowsFromRaw, measurementRowsToRaw } from './measurement';

const row = (formula: string, deduct = false) => ({ label: '', formula, deduct });

describe('métré', () => {
  it('soustrait les ouvertures du mur (mêmes cas que le calcul natif)', () => {
    expect(measurementQuantityMilli([row('4,20 × 2,60'), row('3.80 x 2.60'), row('0,90 × 2,10', true), row('2 * 1,20 * 1,40', true)])).toBe(15_550);
  });

  it('respecte priorités, parenthèses et division exacte', () => {
    expect(evaluateFormula('2 + 3 × 4')).toBe(14_000_000_000n);
    expect(evaluateFormula('(2 + 3) × 4')).toBe(20_000_000_000n);
    expect(evaluateFormula('-(1,5) + 4')).toBe(2_500_000_000n);
    expect(evaluateFormula('10 / 3')).toBe(3_333_333_333n);
    expect(evaluateFormula('2 ÷ 3')).toBe(666_666_667n);
    expect(evaluateFormula("1'250,5")).toBe(1_250_500_000_000n);
    expect(evaluateFormula('5 − 2')).toBe(3_000_000_000n);
    expect(measurementQuantityMilli([row('10 / 3')])).toBe(3_333);
    expect(measurementQuantityMilli([row('2 / 3')])).toBe(667);
    expect(measurementQuantityMilli([row('0,0005')])).toBe(1);
  });

  it('refuse les formules illisibles ou trop grandes', () => {
    for (const formula of ['', '4,2 ×', '2 3', '(2', '2)', '1/0', 'abc', '1,2,3', '0,1234567891', '99999999999', '('.repeat(30), '100000 × 100000']) {
      expect(() => evaluateFormula(formula), formula).toThrow();
    }
    expect(measurementQuantity([row('1'), row('2', true)])).toHaveProperty('error');
    expect(measurementQuantity([])).toHaveProperty('error');
    expect(measurementQuantity([{ label: 'Mur', formula: '4,2*2,6' }, { label: 'Porte', formula: '0,9*2,1', deduct: true }])).toEqual({ quantity: 9.03 });
    expect(measurementRowMilli(row('0,9 × 2,1'))).toBe(1_890);
    expect(measurementRowMilli(row('x'))).toBeNull();
  });

  it('lit et écrit le métré enregistré', () => {
    expect(measurementRowsFromRaw('[{"label":"Mur","formula":"2*3"},{"formula":"1","deduct":true}]')).toEqual([{ label: 'Mur', formula: '2*3' }, { label: '', formula: '1', deduct: true }]);
    expect(measurementRowsFromRaw('pas du json')).toEqual([]);
    expect(measurementRowsFromRaw(null)).toEqual([]);
    expect(measurementRowsToRaw([{ label: ' Mur ', formula: ' 2*3 ' }, { label: 'vide', formula: ' ' }])).toBe('[{"label":"Mur","formula":"2*3","deduct":false}]');
    expect(measurementRowsToRaw([])).toBeNull();
  });

  it('regroupe les lignes consécutives en chapitres avec sous-totaux', () => {
    const lines = [
      { sectionTitle: 'Salon', net: 100 }, { sectionTitle: 'Salon', net: 50 },
      { sectionTitle: null, net: 7 }, { sectionTitle: 'Cuisine', net: 30 }, { sectionTitle: 'Salon', net: 1 },
    ];
    expect(chapterGroups(lines, line => line.net).map(group => [group.title, group.lines.length, group.netCents])).toEqual([
      ['Salon', 2, 150], [null, 1, 7], ['Cuisine', 1, 30], ['Salon', 1, 1],
    ]);
  });
});
