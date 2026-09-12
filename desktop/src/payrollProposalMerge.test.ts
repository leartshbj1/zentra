import { describe, expect, it } from 'vitest';
import { mergePayrollProposals } from './payrollProposalMerge';
import type { PayrollContributionDefinition } from './types';

const definition = (id: string, basisKind: PayrollContributionDefinition['basisKind']) => ({ id, basisKind }) as PayrollContributionDefinition;
describe('reprise des cotisations après une correction', () => {
  const input = () => ({ current: { manual: { basisCents: 410000, yearToDateBasisCents: 900000 }, zero: { basisCents: 0 } },
    automaticIds: new Set(['auto-existing']), proposals: [definition('manual', 'ahv_salary'), definition('zero', 'gross'), definition('new', 'ahv_salary'), definition('omitted', 'gross')],
    approvedIds: new Set(['manual', 'zero', 'new']), grossCents: 500000, ahvBasisCents: 480000 });
  it('conserve les montants manuels, les cumuls, les zéros et les exclusions précédentes', () => {
    const before = input();
    const merged = mergePayrollProposals(before);
    expect(merged.selections).toEqual({ ...before.current, new: { basisCents: 480000 } });
    expect(merged.automaticIds).toEqual(new Set(['auto-existing', 'new']));
    expect(merged.addedIds).toEqual(['new']);
    expect(before.automaticIds).toEqual(new Set(['auto-existing']));
    expect(Object.keys(before.current)).toEqual(['manual', 'zero']);
  });
  it('reste idempotent après une reprise et ignore les cotisations plus applicables', () => {
    const before = input(), first = mergePayrollProposals(before);
    expect(mergePayrollProposals({ ...before, current: first.selections, automaticIds: first.automaticIds }).addedIds).toEqual([]);
    expect(mergePayrollProposals({ ...before, approvedIds: new Set(['not-in-proposal']) }).addedIds).toEqual([]);
  });
  it('laisse un montant inconnu à confirmer et réutilise seulement les bases disponibles', () => {
    const merged = mergePayrollProposals({ ...input(), current: {}, proposals: [definition('custom', 'custom'), definition('annual', 'coordinated'), definition('gross', 'gross'), definition('ahv', 'ahv_salary')],
      approvedIds: new Set(['custom', 'annual', 'gross', 'ahv']), ahvBasisCents: undefined, coordinatedAnnualCents: 3200000 });
    expect(merged.selections).toEqual({ custom: { basisCents: undefined }, annual: { basisCents: 3200000 }, gross: { basisCents: 500000 }, ahv: { basisCents: undefined } });
  });
});
