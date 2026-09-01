import { describe, expect, it } from 'vitest';
import { familyAllowanceReferenceForCanton, SWISS_FAMILY_ALLOWANCES_2026 } from './swissFamilyAllowances2026';

describe('référence cantonale des allocations familiales 2026', () => {
  it('couvre exactement les 26 cantons sans doublon', () => {
    const cantons = SWISS_FAMILY_ALLOWANCES_2026.map((item) => item.canton);
    expect(cantons).toHaveLength(26);
    expect(new Set(cantons).size).toBe(26);
    expect(cantons).toEqual([...cantons].sort());
  });

  it('retrouve le canton sans dépendre de la casse ou des espaces', () => {
    expect(familyAllowanceReferenceForCanton(' vd ')).toMatchObject({
      name: 'Vaud',
      child: 'CHF 322 / 365',
      education: 'CHF 425 / 468',
    });
  });

  it('conserve les paliers au lieu de choisir automatiquement un montant', () => {
    expect(familyAllowanceReferenceForCanton('ZH')).toMatchObject({
      child: 'CHF 215 / 268',
      note: expect.stringContaining('12 ans'),
    });
    expect(familyAllowanceReferenceForCanton('XX')).toBeUndefined();
  });
});
