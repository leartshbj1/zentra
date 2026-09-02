import { describe, expect, it } from 'vitest';
import { findPotentialPayrollEmployeeDuplicate, findStrongEmployeeMatch } from './payrollEmployeeMatching';
import type { Employee, PayrollImportEmployeeDraft } from './types';
import type { PayrollAiIdentityEvidence } from './types';

const employee = (patch: Partial<Employee> = {}): Employee => ({
  id: 'employee-a', employeeNumber: 'E-001', name: 'Alex Exemple', role: '', email: '', phone: '', address: '', addressLine1: '', addressLine2: '', postalCode: '', city: '', canton: '', country: 'CH', birthDate: '1990-01-02', avsNumber: '756.9217.0769.85', employmentStart: '', employmentEnd: '', employmentContractKind: null, lppAssessmentYear: null, lppAnnualSalaryCents: null, lppExceptionCode: null, lppExceptionEvidenceReference: '', referenceAgeDate: '', avsAllowanceWaived: null, employmentRate: 100, contractualWeeklyMinutes: null, acOpeningYear: null, acOpeningBasisCents: null, laaOpeningYear: null, laaOpeningBasisCents: null, salaryMode: 'monthly', grossSalaryCents: 0, hourlyCostCents: 0, iban: 'CH93 0076 2011 6238 5295 7', active: true, notes: '', ...patch,
});

const evidence = (patch: Partial<PayrollAiIdentityEvidence> = {}): PayrollAiIdentityEvidence => ({
  passes: 2, employeeNumber: '', avsNumber: '', birthDate: '', iban: '', conflicts: [], ...patch,
});

describe('rattachement fort des fiches de salaire', () => {
  it('rattache un AVS valide et unique, malgré sa ponctuation', () => {
    expect(findStrongEmployeeMatch(evidence({ avsNumber: '7569217076985' }), [employee()]).employeeId).toBe('employee-a');
  });

  it('refuse un AVS dupliqué et des identifiants qui désignent deux personnes', () => {
    const second = employee({ id: 'employee-b', employeeNumber: 'E-002' });
    expect(findStrongEmployeeMatch(evidence({ avsNumber: '756.9217.0769.85' }), [employee(), second]).conflict).toBe(true);
    const other = employee({ id: 'employee-b', avsNumber: '', employeeNumber: 'E-002' });
    expect(findStrongEmployeeMatch(evidence({ avsNumber: '756.9217.0769.85', employeeNumber: 'E-002' }), [employee(), other]).conflict).toBe(true);
  });

  it('ne rattache jamais un nom ou un numéro employé seul', () => {
    expect(findStrongEmployeeMatch(evidence(), [employee()]).employeeId).toBeNull();
    expect(findStrongEmployeeMatch(evidence({ employeeNumber: 'E-001' }), [employee()]).employeeId).toBeNull();
  });

  it('accepte un numéro employé unique avec un second facteur concordant', () => {
    expect(findStrongEmployeeMatch(evidence({ employeeNumber: 'E001', birthDate: '1990-01-02' }), [employee()]).employeeId).toBe('employee-a');
    expect(findStrongEmployeeMatch(evidence({ employeeNumber: 'E001', iban: 'CH9300762011623852957' }), [employee()]).employeeId).toBe('employee-a');
  });

  it('désactive tout rattachement automatique après une divergence de double lecture', () => {
    expect(findStrongEmployeeMatch(evidence({ avsNumber: '756.9217.0769.85', conflicts: ['numéro AVS'] }), [employee()])).toMatchObject({ employeeId: null, conflict: true });
    expect(findStrongEmployeeMatch(evidence({ passes: 1, avsNumber: '756.9217.0769.85' }), [employee()]).employeeId).toBeNull();
  });

  it('refuse de contourner un AVS valide inconnu avec un numéro employé', () => {
    const result = findStrongEmployeeMatch(evidence({ avsNumber: '756.9217.0769.77', employeeNumber: 'E-001', birthDate: '1990-01-02' }), [employee()]);
    expect(result).toMatchObject({ employeeId: null, conflict: true });
  });

  it('refuse un AVS concordant si un autre identifiant consensuel ne correspond pas', () => {
    expect(findStrongEmployeeMatch(evidence({ avsNumber: '756.9217.0769.85', employeeNumber: 'INCONNU' }), [employee()])).toMatchObject({ employeeId: null, conflict: true });
    expect(findStrongEmployeeMatch(evidence({ avsNumber: '756.9217.0769.85', birthDate: '1991-01-02' }), [employee()])).toMatchObject({ employeeId: null, conflict: true });
    expect(findStrongEmployeeMatch(evidence({ avsNumber: '756.9217.0769.85', iban: 'CH5604835012345678009' }), [employee()])).toMatchObject({ employeeId: null, conflict: true });
  });
});

describe('prévention de doublons collaborateurs à la confirmation', () => {
  const imported = (patch: Partial<PayrollImportEmployeeDraft> = {}): PayrollImportEmployeeDraft => ({
    employeeNumber: '', name: 'Alex Exemple', role: '', addressLine1: '', addressLine2: '', postalCode: '', city: '', canton: '',
    birthDate: '', avsNumber: '', iban: '', employmentRate: 100, salaryMode: 'monthly' as const, ...patch,
  });

  it('bloque toujours un AVS ou un numéro employé déjà attribué', () => {
    expect(findPotentialPayrollEmployeeDuplicate(imported({ avsNumber: '7569217076985' }), [employee()])).toMatchObject({
      employeeIds: ['employee-a'], signal: 'avs',
    });
    expect(findPotentialPayrollEmployeeDuplicate(imported({ employeeNumber: ' e 001 ' }), [employee()])).toMatchObject({
      employeeIds: ['employee-a'], signal: 'employee_number',
    });
  });

  it('bloque une création probable par nom et naissance même sans identifiant administratif', () => {
    expect(findPotentialPayrollEmployeeDuplicate(imported({ name: 'Àlex  Exemple', birthDate: '1990-01-02' }), [employee()])).toMatchObject({
      employeeIds: ['employee-a'], signal: 'name_birth_date',
    });
  });

  it('conserve les lettres non latines comme le backend lors du contrôle de doublon', () => {
    const existing = employee({ id: 'employee-unicode', name: 'Марія Іваненко', birthDate: '1992-04-05' });
    expect(findPotentialPayrollEmployeeDuplicate(imported({ name: 'МАРІЯ-ІВАНЕНКО', birthDate: '1992-04-05' }), [existing])).toMatchObject({
      employeeIds: ['employee-unicode'], signal: 'name_birth_date',
    });
    expect(findPotentialPayrollEmployeeDuplicate(imported({ name: '王 小明', birthDate: '1992-04-05' }), [existing]).employeeIds).toEqual([]);
  });

  it('bloque une création probable par nom et IBAN valide concordant', () => {
    expect(findPotentialPayrollEmployeeDuplicate(imported({ name: 'alex-exemple', iban: 'CH9300762011623852957' }), [employee()])).toMatchObject({
      employeeIds: ['employee-a'], signal: 'name_iban',
    });
  });

  it('ne bloque jamais un homonyme sur le seul nom ou avec une preuve invalide', () => {
    expect(findPotentialPayrollEmployeeDuplicate(imported(), [employee()]).employeeIds).toEqual([]);
    expect(findPotentialPayrollEmployeeDuplicate(imported({ birthDate: '1990-02-30' }), [employee()]).employeeIds).toEqual([]);
    expect(findPotentialPayrollEmployeeDuplicate(imported({ iban: 'CH00 INVALIDE' }), [employee()]).employeeIds).toEqual([]);
  });
});
