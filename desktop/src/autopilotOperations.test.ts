import { describe, expect, it } from 'vitest';
import { budgetAlerts, forgottenTimer, hoursToBill, overdueTasks, payrollToPrepare, projectsPastEnd, yearEndMoments } from './autopilotOperations';
import type { ActiveTimer, Employee, Payslip, Project, ProjectTask, TimeEntry } from './types';

const project = (values: Partial<Project>) => ({ id: 'p1', name: 'Cuisine', clientId: 'c1', status: 'in_progress', plannedEnd: '', budgetCents: 0, ...values }) as Project;
describe('projects, hours and payroll moments', () => {
  it('groups unbilled hours by project at month end or once completed', () => {
    const entries = [{ projectId: 'p1', minutes: 90, billingRateCents: 12000 }, { projectId: 'p1', minutes: 30, billingRateCents: 12000 }] as TimeEntry[];
    expect(hoursToBill(entries, [project({})], '2026-10-10')).toEqual([]);
    expect(hoursToBill(entries, [project({})], '2026-10-27')).toMatchObject([{ minutes: 120, amountCents: 24000 }]);
    expect(hoursToBill(entries, [project({ status: 'completed' })], '2026-10-10')).toHaveLength(1);
  });
  it('spots a forgotten timer, late tasks, budget levels and passed ends', () => {
    const timer = { projectId: 'p1', startedAt: '2026-10-19T08:00:00Z' } as ActiveTimer;
    expect(forgottenTimer(timer, new Date('2026-10-19T17:00:00Z'))).toBeNull();
    expect(forgottenTimer(timer, new Date('2026-10-20T07:00:00Z'))?.hours).toBe(23);
    expect(overdueTasks([{ id: 't', dueDate: '2026-10-18', status: 'todo' }, { id: 'u', dueDate: '2026-10-18', status: 'done' }] as ProjectTask[], '2026-10-20').map(task => task.id)).toEqual(['t']);
    expect(budgetAlerts([project({ budgetCents: 1000 })], () => 850)).toMatchObject([{ percent: 85, level: 80 }]);
    expect(budgetAlerts([project({ budgetCents: 1000 })], () => 1200)).toMatchObject([{ level: 100 }]);
    expect(projectsPastEnd([project({ plannedEnd: '2026-10-01' }), project({ id: 'p2', plannedEnd: '2026-10-01', status: 'completed' })], '2026-10-20').map(row => row.id)).toEqual(['p1']);
  });
  it('prepares payroll from the 20th and year-end from mid-December', () => {
    const employees = [{ id: 'e1', employmentStart: '2026-01-01', employmentEnd: '' }, { id: 'e2', employmentStart: '2026-01-01', employmentEnd: '2026-09-30' }] as Employee[];
    expect(payrollToPrepare(employees, [], '2026-10-19')).toBeNull();
    expect(payrollToPrepare(employees, [], '2026-10-20')?.employees.map(row => row.id)).toEqual(['e1']);
    expect(payrollToPrepare(employees, [{ employeeId: 'e1', period: '2026-10' } as Payslip], '2026-10-21')).toBeNull();
    expect(yearEndMoments('2026-12-16')).toEqual({ closingYear: 2026, certificatesYear: null });
    expect(yearEndMoments('2027-01-05')).toEqual({ closingYear: 2026, certificatesYear: 2026 });
    expect(yearEndMoments('2026-10-20')).toEqual({ closingYear: null, certificatesYear: null });
  });
});
