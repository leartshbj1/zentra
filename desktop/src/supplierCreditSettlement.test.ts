import { describe, expect, it } from 'vitest';
import { creditSettlementDateError } from './supplierCreditSettlement';

describe('dates effectives des compensations fournisseurs', () => {
  it.each([null, undefined, '', '2026-02-30', '2026-5-15', '2026-05-00', '2026-13-01'])('refuse une date absente ou invalide : %s', (date) => {
    expect(creditSettlementDateError(date, '2026-01-01')).not.toBe('');
  });
  it('respecte les documents, la date de l’imputation à extourner et la date du jour', () => {
    expect(creditSettlementDateError('2026-05-14', '2026-05-15', '2026-06-01')).not.toBe('');
    expect(creditSettlementDateError('2026-06-02', '2026-05-15', '2026-06-01')).not.toBe('');
    expect(creditSettlementDateError('2026-05-15', '2026-05-15', '2026-06-01')).toBe('');
    expect(creditSettlementDateError('2026-06-01', '2026-05-15', '2026-06-01')).toBe('');
  });
  it('permet de préparer un brouillon futur sans le comptabiliser', () => {
    expect(creditSettlementDateError('2028-02-29', '2026-05-15')).toBe('');
    expect(creditSettlementDateError('2028-02-29', '2026-05-15', '2026-06-01')).not.toBe('');
  });
});
