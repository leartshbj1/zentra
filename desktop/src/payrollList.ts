import type { Employee, Payslip } from './types';
import { searchText } from './utils';

export function filterPayrollList(payslips: Payslip[], employees: Employee[], query: string, status: string): Payslip[] {
  const people = new Map(employees.map((employee) => [employee.id, employee]));
  return payslips.filter((payslip) => {
    const employee = people.get(payslip.employeeId);
    return (status === 'all' || payslip.status === status || (status === 'incomplete' && payslip.status === 'draft'))
      && searchText([employee?.name, employee?.employeeNumber, employee?.email, payslip.period, payslip.paymentReference, payslip.notes], query);
  }).sort((a, b) => b.period.localeCompare(a.period) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}
