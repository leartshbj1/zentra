import type { ActiveTimer, Employee, Payslip, Project, ProjectTask, TimeEntry } from './types';

/**
 * Projects, hours and payroll moments Autopilote points out. Each card opens
 * the existing screen or runs one native command after a click; no amount is
 * computed here.
 */
const addDays = (iso: string, days: number) => new Date(Date.parse(iso + 'T12:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);

/** Unbilled ready hours grouped by project, shown from the 25th, on the 1st, or once the project is completed. */
export function hoursToBill(entries: readonly TimeEntry[], projects: readonly Project[], today: string) {
  const day = Number(today.slice(8, 10));
  const groups = new Map<string, { project: Project; minutes: number; amountCents: number }>();
  for (const entry of entries) {
    const project = projects.find(row => row.id === entry.projectId);
    if (!project) continue;
    if (!(day >= 25 || day === 1 || project.status === 'completed')) continue;
    const group = groups.get(project.id) ?? { project, minutes: 0, amountCents: 0 };
    group.minutes += entry.minutes;
    group.amountCents += Math.round(entry.minutes * (entry.billingRateCents ?? 0) / 60);
    groups.set(project.id, group);
  }
  return [...groups.values()].filter(group => group.minutes > 0);
}

/** A timer running for more than 10 hours, or since before today. */
export function forgottenTimer(timer: ActiveTimer, now: Date) {
  if (!timer) return null;
  const started = Date.parse(timer.startedAt);
  if (!Number.isFinite(started)) return null;
  const hours = (now.getTime() - started) / 3_600_000;
  const startedDay = new Date(started).toISOString().slice(0, 10), today = now.toISOString().slice(0, 10);
  return hours > 10 || startedDay < today ? { timer, hours: Math.floor(hours) } : null;
}

export function overdueTasks(tasks: readonly ProjectTask[], today: string) {
  return tasks.filter(task => task.dueDate && task.dueDate < today && (task.status === 'todo' || task.status === 'in_progress'));
}

/** Projects at 80 % or 100 % of their budget, by the cost already recorded (hours and purchases). */
export function budgetAlerts(projects: readonly Project[], costOf: (project: Project) => number) {
  return projects.flatMap(project => {
    if (project.budgetCents <= 0 || project.status === 'completed' || project.status === 'closed') return [];
    const share = costOf(project) / project.budgetCents;
    return share >= 0.8 ? [{ project, percent: Math.round(share * 100), level: share >= 1 ? 100 : 80 }] : [];
  });
}

export function projectsPastEnd(projects: readonly Project[], today: string) {
  return projects.filter(project => project.plannedEnd && project.plannedEnd < today && (project.status === 'planned' || project.status === 'in_progress'));
}

/** From the 20th, employees still working this month who have no payslip yet. */
export function payrollToPrepare(employees: readonly Employee[], payslips: readonly Payslip[], today: string) {
  if (Number(today.slice(8, 10)) < 20) return null;
  const period = today.slice(0, 7), monthStart = period + '-01';
  const active = employees.filter(employee => !employee.archivedAt && (!employee.employmentStart || employee.employmentStart <= today)
    && (!employee.employmentEnd || employee.employmentEnd >= monthStart));
  const missing = active.filter(employee => !payslips.some(slip => slip.employeeId === employee.id && slip.period === period));
  return missing.length ? { period, employees: missing } : null;
}

/** Year-end closing from 15 December to the end of January; salary certificates in January. */
export function yearEndMoments(today: string) {
  const month = Number(today.slice(5, 7)), day = Number(today.slice(8, 10)), year = Number(today.slice(0, 4));
  return {
    closingYear: month === 12 && day >= 15 ? year : month === 1 ? year - 1 : null,
    certificatesYear: month === 1 ? year - 1 : null,
  };
}
export const weekLater = (today: string) => addDays(today, 7);
