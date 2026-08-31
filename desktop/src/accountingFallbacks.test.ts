import { describe, expect, it } from 'vitest';
import { accountingFallbacksFromPostPayslip } from './bridge';

describe('avertissements de ventilation comptable de paie', () => {
  it('remonte les comptes généraux substitués par le backend', () => {
    expect(accountingFallbacksFromPostPayslip({
      journal: {
        accounting_fallbacks: [{
          contribution: 'AVS employé',
          field: 'liability_account_id',
          account_id: 'account-social-payable',
          reason: 'Compte créancier non figé.',
        }],
      },
    })).toEqual([{
      contribution: 'AVS employé',
      field: 'liability_account_id',
      accountId: 'account-social-payable',
      reason: 'Compte créancier non figé.',
    }]);
  });

  it('retourne une liste vide si aucune substitution n’a eu lieu', () => {
    expect(accountingFallbacksFromPostPayslip({ journal: {} })).toEqual([]);
  });
});
