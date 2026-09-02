import { describe, expect, it } from 'vitest';
import {
  isPayrollCalculationCurrent,
  payrollCalculationFingerprint,
} from './payrollCalculationFingerprint';

const base = {
  employeeId: 'employee-a',
  period: '2026-08',
  paymentDate: '2026-08-25',
  lines: [
    {
      id: 'salary',
      label: 'Salaire',
      kind: 'earning' as const,
      amountCents: 500_000,
    },
  ],
  selections: [
    { definitionId: 'avs-employee', basisCents: 500_000 },
    {
      definitionId: 'ac-employee',
      basisCents: 500_000,
      yearToDateBasisCents: 2_000_000,
    },
  ],
};

describe('empreinte du calcul de paie', () => {
  it('est stable quand seul l’ordre des cotisations change', () => {
    expect(payrollCalculationFingerprint(base)).toBe(
      payrollCalculationFingerprint({
        ...base,
        selections: [...base.selections].reverse(),
      }),
    );
  });

  it.each([
    ['collaborateur', { employeeId: 'employee-b' }],
    ['période', { period: '2026-09' }],
    ['date de versement', { paymentDate: '2026-09-01' }],
    ['brut', { lines: [{ ...base.lines[0], amountCents: 510_000 }] }],
    ['libellé de ligne', { lines: [{ ...base.lines[0], label: 'Prime' }] }],
    ['choix de cotisations', { selections: [base.selections[0]] }],
    [
      'base',
      {
        selections: [
          { ...base.selections[0], basisCents: 499_999 },
          base.selections[1],
        ],
      },
    ],
    [
      'cumul AC',
      {
        selections: [
          base.selections[0],
          { ...base.selections[1], yearToDateBasisCents: 2_000_001 },
        ],
      },
    ],
  ])('invalide le calcul quand change: %s', (_label, patch) => {
    const calculated = payrollCalculationFingerprint(base);
    const current = payrollCalculationFingerprint({ ...base, ...patch });
    expect(isPayrollCalculationCurrent(calculated, current)).toBe(false);
  });
});
