// Absences, soldes de vacances et notes de frais : calculs faits par l'app.
import type { Absence, Employee, ExpenseClaim, LeaveSettings } from './types';

const DAY = 86_400_000;
const parse = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Droit légal minimal suisse : 4 semaines (5 jusqu'à 20 ans) ; l'entreprise peut en donner plus. */
export const DEFAULT_VACATION_DAYS = 20;

export function vacationBalance(employeeId: string, settings: readonly LeaveSettings[], absences: readonly Absence[], year: number) {
  const own = settings.find((row) => row.employeeId === employeeId);
  const entitlement = (own?.vacationDaysPerYear ?? DEFAULT_VACATION_DAYS) + (own?.carriedOverDays ?? 0);
  const taken = absences
    .filter((row) => row.employeeId === employeeId && row.kind === 'vacation' && row.startDate.startsWith(String(year)))
    .reduce((sum, row) => sum + row.days, 0);
  return { entitlement, taken, remaining: Math.round((entitlement - taken) * 10) / 10 };
}

export type SickSpell = { employeeId: string; start: string; end: string; days: number; absenceIds: string[]; declared: boolean };

/** Arrêts maladie qui se suivent sans interruption, durée en jours calendaires jusqu'à aujourd'hui. */
export function sickSpells(absences: readonly Absence[], today: string): SickSpell[] {
  const spells: SickSpell[] = [];
  const sick = absences.filter((row) => row.kind === 'sick' && row.startDate <= today).sort((a, b) => a.employeeId.localeCompare(b.employeeId) || a.startDate.localeCompare(b.startDate));
  for (const row of sick) {
    const end = row.endDate < today ? row.endDate : today;
    const last = spells[spells.length - 1];
    if (last && last.employeeId === row.employeeId && parse(row.startDate) <= parse(last.end) + DAY) {
      if (end > last.end) last.end = end;
      last.absenceIds.push(row.id);
      last.declared ||= Boolean(row.ijmDeclaredAt);
    } else {
      spells.push({ employeeId: row.employeeId, start: row.startDate, end, days: 0, absenceIds: [row.id], declared: Boolean(row.ijmDeclaredAt) });
    }
  }
  for (const spell of spells) spell.days = Math.round((parse(spell.end) - parse(spell.start)) / DAY) + 1;
  return spells;
}

/** Arrêts de plus de 30 jours encore en cours et pas encore déclarés à l'assurance IJM. */
export function ijmToDeclare(absences: readonly Absence[], today: string, threshold = 30): SickSpell[] {
  return sickSpells(absences, today).filter((spell) => spell.days > threshold && !spell.declared && spell.end >= iso(parse(today) - 7 * DAY));
}

export function pendingClaims(claims: readonly ExpenseClaim[]) {
  const submitted = claims.filter((claim) => claim.status === 'submitted');
  return { count: submitted.length, totalCents: submitted.reduce((sum, claim) => sum + claim.amountCents, 0) };
}

export function negativeBalances(employees: readonly Employee[], settings: readonly LeaveSettings[], absences: readonly Absence[], year: number) {
  return employees
    .filter((employee) => !employee.archivedAt)
    .map((employee) => ({ employee, balance: vacationBalance(employee.id, settings, absences, year) }))
    .filter((row) => row.balance.remaining < 0);
}

/** Jours ouvrés (lundi à vendredi) entre deux dates incluses : proposition par défaut pour une absence. */
export function workingDays(start: string, end: string): number {
  if (!start || !end || end < start) return 0;
  let count = 0;
  for (let time = parse(start); time <= parse(end); time += DAY) {
    const day = new Date(time).getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}
