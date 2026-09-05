import { describe, expect, it } from 'vitest';
import type { Employee, Payslip } from './types';
import { filterPayrollList } from './payrollList';

const people = [{ id: 'e', name: 'Élodie Dubois', employeeNumber: '42', email: '' }, { id: 'j', name: 'Jean Martin', employeeNumber: '43', email: '' }] as Employee[];
const rows = [
  { id: 'old', employeeId: 'e', period: '2026-01', createdAt: '2026-01-20', status: 'paid', paymentReference: 'SALAIRE JANVIER' },
  { id: 'new', employeeId: 'e', period: '2026-09', createdAt: '2026-09-01', status: 'draft' },
  { id: 'other', employeeId: 'j', period: '2026-08', createdAt: '2026-08-01', status: 'posted' },
] as Payslip[];
describe('salary list', () => {
  it('searches employee names without accents and combines the status', () => {
    expect(filterPayrollList(rows, people, 'elodie', 'incomplete').map((row) => row.id)).toEqual(['new']);
    expect(filterPayrollList(rows, people, 'JEAN', 'paid')).toEqual([]);
  });
  it('searches references, periods and employee numbers', () => {
    expect(filterPayrollList(rows, people, 'salaire janvier', 'all').map((row) => row.id)).toEqual(['old']);
    expect(filterPayrollList(rows, people, '2026-08', 'all').map((row) => row.id)).toEqual(['other']);
    expect(filterPayrollList(rows, people, '42', 'all').map((row) => row.id)).toEqual(['new', 'old']);
  });
  it('sorts newest first without mutating workspace history', () => {
    expect(filterPayrollList(rows, people, '', 'all').map((row) => row.id)).toEqual(['new', 'other', 'old']);
    expect(rows.map((row) => row.id)).toEqual(['old', 'new', 'other']);
  });
});
