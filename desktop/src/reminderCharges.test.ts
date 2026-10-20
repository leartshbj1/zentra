import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  discountMatch,
  discountedAmountCents,
  lateInterestCents,
  reminderCharges,
  withDiscountConditions,
} from './reminderCharges';

describe('intérêts moratoires', () => {
  it('suit le calcul natif : jours exacts sur 365, au centime', () => {
    expect(lateInterestCents(100_000, 500, 365)).toBe(5_000);
    expect(lateInterestCents(100_000, 500, 30)).toBe(411);
    expect(lateInterestCents(178_000, 500, 30)).toBe(732);
    expect(lateInterestCents(100_000, 500, 0)).toBe(0);
    expect(lateInterestCents(-5, 500, 30)).toBe(0);
  });

  it('compte les jours sans dérive d’heure d’été', () => {
    expect(daysBetween('2026-09-30', '2026-10-30')).toBe(30);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });

  it('ajoute frais du niveau et intérêts seulement quand ils sont activés', () => {
    const settings = { interestEnabled: false, interestRateBp: 500, fees: { 2: 2_000, 3: 3_000 } };
    expect(reminderCharges(settings, 2, 178_000, '2026-09-30', '2026-10-30')).toEqual({
      feeCents: 2_000, interestCents: 0, interestRateBp: 0, interestDays: 0, interestFrom: null, totalDueCents: 180_000,
    });
    expect(reminderCharges({ ...settings, interestEnabled: true }, 3, 178_000, '2026-09-30', '2026-10-30')).toEqual({
      feeCents: 3_000, interestCents: 732, interestRateBp: 500, interestDays: 30, interestFrom: '2026-10-01', totalDueCents: 181_732,
    });
    expect(reminderCharges({ ...settings, interestEnabled: true }, 1, 178_000, '2026-09-30', '2026-09-20').totalDueCents).toBe(178_000);
  });
});

describe('escompte', () => {
  it('calcule le montant escompté, arrondi aux 5 centimes inférieurs', () => {
    expect(discountedAmountCents(180_000, 200)).toBe(176_400);
    expect(discountedAmountCents(12_345, 200)).toBe(12_095);
  });

  it('écrit les conditions Swico dans les informations de facture', () => {
    const terms = { discountBp: 200, days: 10, netDays: 30 };
    expect(withDiscountConditions('', terms)).toBe('//S1/40/2:10;0:30');
    expect(withDiscountConditions('//S1/10/F-2026-12/11/261020', terms)).toBe('//S1/10/F-2026-12/11/261020/40/2:10;0:30');
    expect(withDiscountConditions('//S1/10/F1/40/0:30', terms)).toBe('//S1/10/F1/40/2:10;0:30');
    expect(withDiscountConditions('//S1/10/F1', null)).toBe('//S1/10/F1');
    expect(withDiscountConditions('texte libre', terms)).toBe('texte libre');
    expect(withDiscountConditions('', { discountBp: 150, days: 8, netDays: 30 })).toBe('//S1/40/1.5:8;0:30');
  });

  it('reconnaît un paiement escompté dans le délai seulement', () => {
    const terms = { discountBp: 200, days: 10, netDays: 30 };
    expect(discountMatch(180_000, '2026-10-01', terms, 176_400, '2026-10-09')).toEqual({ discountCents: 3_600 });
    expect(discountMatch(180_000, '2026-10-01', terms, 176_400, '2026-10-20')).toBeNull();
    expect(discountMatch(180_000, '2026-10-01', terms, 180_000, '2026-10-05')).toBeNull();
  });
});
