import { describe, expect, it } from 'vitest';
import { addMonths, contractAlerts } from './contracts';
import type { Contract } from './types';

const contract = (extra: Partial<Contract> = {}): Contract => ({
  id: 'c1', side: 'supplier', clientId: null, supplierId: null, partyName: 'Régie du Lac', title: 'Bail de l’atelier',
  startDate: '2024-04-01', endDate: '2026-03-31', noticeMonths: 6, autoRenew: true, renewalMonths: 12,
  amountCents: 240_000, currency: 'CHF', frequency: 'monthly', indexation: '', note: '', status: 'active', terminatedOn: null, ...extra,
});

describe('contrats', () => {
  it('adds months without drifting at month ends', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-03-31', -6)).toBe('2025-09-30');
    expect(addMonths('2025-12-15', 2)).toBe('2026-02-15');
  });


  it('warns 60 days before the last day to cancel, or before the end', () => {
    // Délai de cette période dépassé : l'alerte porte sur la suivante, trop loin.
    expect(contractAlerts([contract()], '2026-10-20')).toEqual([]);
    const alerts = contractAlerts([contract()], '2026-08-15');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'notice', deadline: '2026-09-30', end: '2027-03-31', days: 46 });
    const ending = contractAlerts([contract({ autoRenew: false, endDate: '2026-12-01' })], '2026-10-20');
    expect(ending[0]).toMatchObject({ kind: 'ending', end: '2026-12-01', days: 42 });
    expect(contractAlerts([contract({ status: 'terminated', terminatedOn: '2026-01-01' })], '2026-08-15')).toEqual([]);
  });

});
