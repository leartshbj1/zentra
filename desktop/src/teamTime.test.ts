import { describe, expect, it } from 'vitest';
import { ijmToDeclare, negativeBalances, pendingClaims, sickSpells, vacationBalance, workingDays } from './teamTime';
import type { Absence, Employee, ExpenseClaim } from './types';

const absence = (id: string, kind: Absence['kind'], startDate: string, endDate: string, days: number, extra: Partial<Absence> = {}): Absence =>
  ({ id, employeeId: 'e1', kind, startDate, endDate, days, incapacityPercent: 100, certificate: false, note: '', ijmDeclaredAt: null, ...extra });

describe('absences et vacances', () => {
  it('counts the vacation taken this year against the entitlement and carry-over', () => {
    const absences = [absence('a', 'vacation', '2026-07-06', '2026-07-17', 10), absence('b', 'vacation', '2025-12-29', '2025-12-31', 3), absence('c', 'sick', '2026-03-02', '2026-03-03', 2)];
    expect(vacationBalance('e1', [], absences, 2026)).toEqual({ entitlement: 20, taken: 10, remaining: 10 });
    expect(vacationBalance('e1', [{ employeeId: 'e1', vacationDaysPerYear: 25, carriedOverDays: -2.5 }], absences, 2026).remaining).toBe(12.5);
    const employees = [{ id: 'e1', name: 'Marc' } as Employee];
    expect(negativeBalances(employees, [{ employeeId: 'e1', vacationDaysPerYear: 5, carriedOverDays: 0 }], absences, 2026)).toHaveLength(1);
  });

  it('joins consecutive sick leaves and flags those over 30 days not declared', () => {
    const absences = [
      absence('s1', 'sick', '2026-09-01', '2026-09-20', 14),
      absence('s2', 'sick', '2026-09-21', '2026-12-31', 70),
      absence('s3', 'sick', '2026-05-04', '2026-05-08', 5),
    ];
    const spells = sickSpells(absences, '2026-10-20');
    expect(spells.map((spell) => [spell.start, spell.end, spell.days])).toEqual([['2026-05-04', '2026-05-08', 5], ['2026-09-01', '2026-10-20', 50]]);
    expect(ijmToDeclare(absences, '2026-10-20').map((spell) => spell.absenceIds)).toEqual([['s1', 's2']]);
    expect(ijmToDeclare([...absences.slice(0, 1), { ...absences[1], ijmDeclaredAt: '2026-10-02' }], '2026-10-20')).toEqual([]);
    expect(ijmToDeclare(absences, '2026-09-25')).toEqual([]);
  });

  it('sums the expense notes waiting for a decision', () => {
    const claim = (status: ExpenseClaim['status'], amountCents: number) => ({ status, amountCents } as ExpenseClaim);
    expect(pendingClaims([claim('submitted', 4_850), claim('submitted', 12_000), claim('approved', 900)])).toEqual({ count: 2, totalCents: 16_850 });
  });

  it('proposes working days between two dates', () => {
    expect(workingDays('2026-10-19', '2026-10-25')).toBe(5);
    expect(workingDays('2026-10-24', '2026-10-25')).toBe(0);
    expect(workingDays('2026-10-25', '2026-10-19')).toBe(0);
  });
});
