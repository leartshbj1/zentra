import { payrollDecimal } from './payrollSalaryEntry';
import { isSalesDate } from './salesFormValidation';
import type { TimeEntry, Workspace } from './types';

export type TimeEntryDraft = {
  projectId: string; taskId: string; employeeId: string; date: string;
  hours: string; minutes: string; breakMinutes: string;
  billable: '' | 'yes' | 'no'; billingRate: string; costRate: string;
  status: string; note: string;
};
export type TimeEntryIssue = { field: keyof TimeEntryDraft; message: string };

function whole(value: string) {
  const result = Number(value);
  return /^\d+$/.test(value.trim()) && Number.isSafeInteger(result) ? result : undefined;
}
export function workedMinutes(hours: string, minutes: string): number | undefined {
  const h = whole(hours.trim() || '0'), m = whole(minutes.trim() || '0');
  if (h === undefined || m === undefined || m > 59) return undefined;
  const total = h * 60 + m;
  return Number.isSafeInteger(total) && total > 0 ? total : undefined;
}
export function initialTimeEntryDraft(item?: TimeEntry): TimeEntryDraft {
  return {
    projectId: item?.projectId ?? '', taskId: item?.taskId ?? '', employeeId: item?.employeeId ?? '',
    date: item?.date ?? '', hours: item ? String(Math.floor(item.minutes / 60)) : '',
    minutes: item ? String(item.minutes % 60) : '0', breakMinutes: String(item?.breakMinutes ?? 0),
    billable: item ? (item.billable ? 'yes' : 'no') : '',
    billingRate: item ? ((item.billingRateCents ?? 0) / 100).toFixed(2) : '',
    costRate: item ? (item.hourlyCostCents / 100).toFixed(2) : '', status: item?.status ?? 'entered', note: item?.note ?? '',
  };
}
export function timeEntryIssue(draft: TimeEntryDraft, workspace: Workspace, item?: TimeEntry, timer = false): TimeEntryIssue | undefined {
  const issue = (field: keyof TimeEntryDraft, message: string) => ({ field, message });
  const project = workspace.projects.find(row => row.id === draft.projectId);
  if (!project || (project.status === 'closed' && project.id !== item?.projectId)) return issue('projectId', 'Choisissez un projet ouvert pour enregistrer ce travail.');
  const task = workspace.projectTasks.find(row => row.id === draft.taskId);
  if (draft.taskId && (!task || task.projectId !== project.id || (['done', 'cancelled'].includes(task.status) && task.id !== item?.taskId))) return issue('taskId', 'Choisissez une tâche ouverte de ce projet, ou « Sans tâche précise ».');
  const employee = workspace.employees.find(row => row.id === draft.employeeId);
  if (!employee || (!employee.active && employee.id !== item?.employeeId)) return issue('employeeId', 'Choisissez le collaborateur qui a effectué ce travail.');
  if (!timer) {
    if (!isSalesDate(draft.date)) return issue('date', 'Choisissez la date à laquelle le travail a été effectué.');
    if (whole(draft.hours.trim() || '0') === undefined) return issue('hours', 'Indiquez les heures entières ici, puis les minutes dans le champ suivant. Pour 1 h 30, saisissez 1 heure et 30 minutes.');
    const minutes = whole(draft.minutes.trim() || '0');
    if (minutes === undefined || minutes > 59) return issue('minutes', 'Indiquez de 0 à 59 minutes. Pour 90 minutes de travail, saisissez 1 heure et 30 minutes.');
    if (!workedMinutes(draft.hours, draft.minutes)) return issue('hours', 'Indiquez une durée de travail supérieure à zéro.');
    if (whole(draft.breakMinutes) === undefined) return issue('breakMinutes', 'Indiquez la pause en minutes entières. Saisissez 0 si aucune pause n’a été prise.');
  }
  if (!draft.billable) return issue('billable', 'Précisez si ce temps sera facturé au client ou s’il s’agit de travail interne.');
  if (draft.billable === 'yes' && !payrollDecimal(draft.billingRate)) return issue('billingRate', 'Indiquez le prix facturé au client pour une heure, supérieur à zéro. Exemple : 95,50 CHF.');
  if (payrollDecimal(draft.costRate) === undefined) return issue('costRate', 'Indiquez le coût d’une heure pour votre entreprise. Vous pouvez saisir 0 si ce travail ne génère pas de coût.');
  if (!timer && !['entered', 'approved', 'locked'].includes(draft.status)) return issue('status', 'Choisissez « À vérifier » ou « Approuvées » pour ces heures.');
  const duration = timer ? 60 : workedMinutes(draft.hours, draft.minutes)!;
  if (!Number.isSafeInteger(duration * (payrollDecimal(draft.costRate) ?? 0) + 30)) return issue('costRate', 'Le coût calculé est trop élevé. Vérifiez le coût horaire et la durée.');
  if (draft.billable === 'yes' && !Number.isSafeInteger(duration * (payrollDecimal(draft.billingRate) ?? 0) + 30)) return issue('billingRate', 'Le montant calculé est trop élevé. Vérifiez le tarif et la durée.');
  if (draft.note.length > 5000) return issue('note', 'Raccourcissez la note à 5 000 caractères au maximum.');
}
export function timeEntryInput(draft: TimeEntryDraft) {
  return {
    projectId: draft.projectId, taskId: draft.taskId || null, employeeId: draft.employeeId,
    date: draft.date, minutes: workedMinutes(draft.hours, draft.minutes), breakMinutes: Number(draft.breakMinutes),
    billable: draft.billable === 'yes', billingRateCents: draft.billable === 'yes' ? payrollDecimal(draft.billingRate)! : 0,
    costRateCents: payrollDecimal(draft.costRate)!, status: draft.status, note: draft.note.trim(),
  };
}
