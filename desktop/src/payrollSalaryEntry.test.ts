import { describe, expect, it } from 'vitest';
import { hourlySalaryCents, payrollDecimal, payrollBasisQuestions, missingPayrollBasis } from './payrollSalaryEntry';
import type { PayrollContributionDefinition } from './types';

describe('hourly salary entered from a contract', () => {
  it.each([['160', '30.50', 488000], ['152,50', '30,25', 461313], ['0.50', '30.01', 1501]])('calculates %s hours at CHF %s with cent rounding', (hours, rate, expected) => {
    expect(hourlySalaryCents(hours, rate)).toBe(expected);
  });
  it.each(['', '-1', '1e3', '1.001', '30 CHF', '1,2,3', 'Infinity', '9007199254740991'])('rejects ambiguous or unsafe input %s', input => {
    expect(payrollDecimal(input)).toBeUndefined();
    expect(hourlySalaryCents('160', input)).toBeUndefined();
  });
  it('keeps a confirmed zero distinct from an unknown basis, but does not apply a zero salary', () => {
    expect(payrollDecimal('0')).toBe(0);
    expect(hourlySalaryCents('0', '30')).toBeUndefined();
    expect(hourlySalaryCents('0.01', '0.01')).toBeUndefined();
    expect(hourlySalaryCents('90000000000000', '90000000000000')).toBeUndefined();
  });
});

const definition = (id: string, patch: Partial<PayrollContributionDefinition> = {}): PayrollContributionDefinition => ({
  id, code: id, label: id, category: 'avs_ai_apg', side: 'employee', basisKind: 'ahv_salary',
  calculationKind: 'rate', rateBp: 435, fixedAmountCents: null, annualCeilingCents: null,
  lppEmployeeId: null, lppComponent: null, source: 'Contrat de recette', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31',
  active: true, expenseAccountId: '', liabilityAccountId: 'social', ...patch,
});
describe('guided insurance bases', () => {
  it('asks one AVS amount for all statutory shares, but keeps different insurance contracts separate', () => {
    const definitions = [definition('avs'), definition('ai'), definition('apg'), definition('employer', { side: 'employer' }),
      definition('accident-1', { category: 'aap' }), definition('accident-2', { category: 'aap' }), definition('unselected')];
    const questions = payrollBasisQuestions(definitions, definitions.slice(0, -1).map(item => ({ definitionId: item.id })));
    expect(questions).toHaveLength(3);
    expect(questions[0].definitions.map(item => item.id)).toEqual(['avs', 'ai', 'apg', 'employer']);
    expect(questions.every(missingPayrollBasis)).toBe(true);
  });
  it('requires confirmation when shared amounts disagree; a confirmed zero is valid', () => {
    const definitions = [definition('one'), definition('two')];
    expect(missingPayrollBasis(payrollBasisQuestions(definitions, [{ definitionId: 'one', basisCents: 500000 }, { definitionId: 'two', basisCents: 400000 }])[0])).toBe(true);
    expect(missingPayrollBasis(payrollBasisQuestions(definitions, definitions.map(item => ({ definitionId: item.id, basisCents: 0 })))[0])).toBe(false);
  });
  it('leaves automatic gross and coordinated pension bases to the payroll engine', () => {
    const definitions = [definition('gross', { basisKind: 'gross' }), definition('shared'), definition('lpp', { category: 'lpp', basisKind: 'coordinated' })];
    expect(payrollBasisQuestions(definitions, definitions.map(item => ({ definitionId: item.id })))).toEqual([]);
  });
  it('asks for custom annual cumuls without requesting AC/LAA cumuls already computed natively', () => {
    const definitions = [definition('ijm', { category: 'ijm', basisKind: 'gross', annualCeilingCents: 10000000 }),
      definition('ac', { category: 'ac', basisKind: 'gross', annualCeilingCents: 14820000 }),
      definition('laa', { category: 'aap', basisKind: 'gross', annualCeilingCents: 14820000 })];
    expect(payrollBasisQuestions(definitions, definitions.map(item => ({ definitionId: item.id })))).toMatchObject([{ definitionId: 'ijm', field: 'yearToDateBasisCents' }]);
  });
});
