import type { AccountingPeriod } from './types';
import { formatDate } from './utils';

export type PeriodDraft = Pick<AccountingPeriod, 'id' | 'name' | 'dateFrom' | 'dateTo'>;
export type PeriodIssue = { field: 'name' | 'dateFrom' | 'dateTo'; message: string; overlappingId?: string; suggestedStart?: string };

export function isPeriodDate(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function closedThrough(periods: AccountingPeriod[]): string {
  return periods.filter(period => period.status === 'closed' && isPeriodDate(period.dateTo)).map(period => period.dateTo).sort().at(-1) || '';
}

export function nextPeriodDay(value: string): string | undefined {
  if (!isPeriodDate(value) || value === '9999-12-31') return undefined;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0); date.setUTCHours(0, 0, 0, 0); date.setUTCFullYear(year, month - 1, day + 1);
  return date.toISOString().slice(0, 10);
}

export function calendarYearDraft(draft: PeriodDraft, year: number): PeriodDraft {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return draft;
  const label = String(year).padStart(4, '0');
  const automaticName = !draft.name.trim() || /^Exercice [0-9]{4}$/.test(draft.name);
  return { ...draft, name: automaticName ? `Exercice ${label}` : draft.name, dateFrom: `${label}-01-01`, dateTo: `${label}-12-31` };
}

export function periodDraftIssue(draft: PeriodDraft, periods: AccountingPeriod[]): PeriodIssue | null {
  if (!draft.name.trim()) return { field: 'name', message: 'Donnez un nom à cet exercice, par exemple « Exercice 2026 ».' };
  if (Array.from(draft.name.trim()).length > 120) return { field: 'name', message: 'Choisissez un nom de 120 caractères au maximum.' };
  if (!isPeriodDate(draft.dateFrom)) return { field: 'dateFrom', message: 'Choisissez la première date de cet exercice dans le calendrier.' };
  if (!isPeriodDate(draft.dateTo)) return { field: 'dateTo', message: 'Choisissez la dernière date de cet exercice dans le calendrier.' };
  if (draft.dateFrom > draft.dateTo) return { field: 'dateTo', message: 'La fin doit être le même jour que le début ou après celui-ci.' };
  if (periods.some(period => period.id === draft.id && period.status === 'closed')) return { field: 'dateFrom', message: 'Cet exercice est déjà clôturé. Ses dates et son nom sont verrouillés.' };
  const boundary = closedThrough(periods);
  if (boundary && draft.dateFrom <= boundary) {
    const next = nextPeriodDay(boundary);
    return { field: 'dateFrom', message: `Les comptes sont verrouillés jusqu’au ${formatDate(boundary)}, y compris avant le début des exercices clôturés. Choisissez un début après cette date.`, suggestedStart: next && next <= draft.dateTo ? next : undefined };
  }
  const overlap = [...periods].sort((a, b) => a.dateFrom.localeCompare(b.dateFrom)).find(period => period.id !== draft.id && period.dateTo >= draft.dateFrom && period.dateFrom <= draft.dateTo);
  if (overlap) return { field: 'dateFrom', message: `Ces dates recouvrent « ${overlap.name} » (${formatDate(overlap.dateFrom)} au ${formatDate(overlap.dateTo)}). Utilisez cet exercice ou choisissez des dates sans chevauchement.`, overlappingId: overlap.id };
  return null;
}
