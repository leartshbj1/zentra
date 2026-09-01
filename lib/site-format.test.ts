import { describe, expect, it } from 'vitest';
import { formatChfCents, formatPercentFromBasisPoints } from './site-format';

describe('formatage déterministe du site', () => {
  it('utilise le séparateur suisse sans dépendre de ICU', () => {
    expect(formatChfCents(168_000)).toBe('1’680.00\u00a0CHF');
    expect(formatChfCents(-5)).toBe('−0.05\u00a0CHF');
  });

  it('affiche les points de base avec une virgule lisible', () => {
    expect(formatPercentFromBasisPoints(810)).toBe('8,1 %');
    expect(formatPercentFromBasisPoints(1_000)).toBe('10 %');
  });

  it('refuse les valeurs non entières sûres', () => {
    expect(formatChfCents(Number.NaN)).toBe('Montant à contrôler');
    expect(formatPercentFromBasisPoints(8.1)).toBe('Taux à contrôler');
  });
});
