import { shiftDate, weekDates } from './agenda';
import type { Absence, AgendaEvent, Employee, Project } from './types';

/** Ligne « À attribuer » du planning : rendez-vous sans collaborateur. */
export const UNASSIGNED = '';

export type PlanningRange = { mode: 'day' | 'week'; dates: string[] };

export function planningRange(mode: 'day' | 'week', date: string): PlanningRange {
  return { mode, dates: mode === 'day' ? [date] : weekDates(date) };
}

export function shiftPlanning(mode: 'day' | 'week', date: string, step: number): string {
  return shiftDate(date, step * (mode === 'day' ? 1 : 7));
}

/** Collaborateurs encore employés à la date donnée, par nom. */
export function activeEmployees(employees: readonly Employee[], date: string): Employee[] {
  return employees.filter(employee => (!employee.employmentEnd || employee.employmentEnd >= date) && (!employee.employmentStart || employee.employmentStart <= date))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Absence qui couvre ce jour pour ce collaborateur. */
export function absenceOn(absences: readonly Absence[], employeeId: string, date: string): Absence | null {
  return absences.find(row => row.employeeId === employeeId && row.startDate <= date && row.endDate >= date) ?? null;
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
export const timeFromMinutes = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;

export function eventsOn(events: readonly AgendaEvent[], employeeId: string, date: string): AgendaEvent[] {
  return events
    .filter(event => event.status !== 'cancelled' && (event.employeeId ?? UNASSIGNED) === employeeId && event.startDate <= date && event.endDate >= date)
    .sort((left, right) => Number(!left.allDay) - Number(!right.allDay) || (left.startTime ?? '').localeCompare(right.startTime ?? '') || left.title.localeCompare(right.title));
}

/** Durée en jours d'un rendez-vous (0 pour un seul jour). */
const spanDays = (event: Pick<AgendaEvent, 'startDate' | 'endDate'>) =>
  Math.round((Date.parse(`${event.endDate}T12:00:00Z`) - Date.parse(`${event.startDate}T12:00:00Z`)) / 86_400_000);

export type PlanningMove = { employeeId: string; date: string; startTime?: string | null };

/**
 * Déplace un rendez-vous : même durée, nouveau jour, nouveau collaborateur et,
 * en vue jour, nouvelle heure (au quart d'heure). Retourne null si rien ne change
 * ou si l'heure sortirait de la journée.
 */
export function movedEvent(event: AgendaEvent, move: PlanningMove): AgendaEvent | null {
  const endDate = shiftDate(move.date, spanDays(event));
  let { startTime, endTime } = event;
  if (!event.allDay && move.startTime && event.startTime && event.endTime) {
    const start = Math.round(minutes(move.startTime) / 15) * 15;
    const length = event.startDate === event.endDate ? minutes(event.endTime) - minutes(event.startTime) : 0;
    if (start < 0 || (length > 0 && start + length > 24 * 60 - 1)) return null;
    startTime = timeFromMinutes(start);
    if (length > 0) endTime = timeFromMinutes(start + length);
  }
  const employeeId = move.employeeId || null;
  if (move.date === event.startDate && employeeId === event.employeeId && startTime === event.startTime) return null;
  return { ...event, startDate: move.date, endDate, startTime, endTime, employeeId };
}

/** Ce qui empêche de poser le rendez-vous : une absence du collaborateur sur l'un des jours. */
export function moveConflict(event: Pick<AgendaEvent, 'startDate' | 'endDate'>, employeeId: string, absences: readonly Absence[]): Absence | null {
  if (!employeeId) return null;
  for (let date = event.startDate; date <= event.endDate; date = shiftDate(date, 1)) {
    const absence = absenceOn(absences, employeeId, date);
    if (absence) return absence;
  }
  return null;
}

/** Chantiers ouverts sans aucun rendez-vous dans la période : à glisser dans le planning. */
export function projectsToPlan(projects: readonly Project[], events: readonly AgendaEvent[], dates: readonly string[]): Project[] {
  const first = dates[0], last = dates[dates.length - 1];
  const planned = new Set(events.filter(event => event.projectId && event.status !== 'cancelled' && event.startDate <= last && event.endDate >= first).map(event => event.projectId));
  return projects.filter(project => ['planned', 'in_progress'].includes(project.status) && !planned.has(project.id) && !project.archivedAt)
    .sort((left, right) => (left.plannedStart || '9999').localeCompare(right.plannedStart || '9999') || left.name.localeCompare(right.name));
}

/** Position d'un rendez-vous dans la vue jour (en % de la plage horaire affichée). */
export function dayPosition(event: Pick<AgendaEvent, 'allDay' | 'startTime' | 'endTime'>, firstHour: number, lastHour: number): { left: number; width: number } | null {
  if (event.allDay || !event.startTime || !event.endTime) return null;
  const from = firstHour * 60, to = lastHour * 60, span = to - from;
  const start = Math.max(from, Math.min(to, minutes(event.startTime)));
  const end = Math.max(start + 15, Math.min(to, minutes(event.endTime) || to));
  return { left: ((start - from) / span) * 100, width: Math.max(((end - start) / span) * 100, 100 / ((lastHour - firstHour) * 4)) };
}

/** Heure correspondant à une position horizontale dans la vue jour, au quart d'heure. */
export function timeAtRatio(ratio: number, firstHour: number, lastHour: number): string {
  const span = (lastHour - firstHour) * 60;
  const value = firstHour * 60 + Math.round((Math.max(0, Math.min(1, ratio)) * span) / 15) * 15;
  return timeFromMinutes(Math.min(value, lastHour * 60 - 15));
}

/** La semaine du lundi au vendredi ; samedi et dimanche seulement s'ils ont un rendez-vous ou une absence. */
export function visibleDays(dates: readonly string[], events: readonly AgendaEvent[], absences: readonly Absence[]): string[] {
  if (dates.length !== 7) return [...dates];
  const used = (date: string) => events.some(event => event.status !== 'cancelled' && event.startDate <= date && event.endDate >= date)
    || absences.some(row => row.startDate <= date && row.endDate >= date);
  return dates.filter((date, index) => index < 5 || used(date));
}
