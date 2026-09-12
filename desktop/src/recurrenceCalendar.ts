import { nextRecurringDate } from './recurrenceUi';
import type { RecurringDocumentFrequency, RecurringDocumentSchedule } from './RecurringDocumentsPanel';

function dateParts(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
  return year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? { year, month, day, date } : null;
}
export function recurringPaymentDate(value: string, days: number): string | null {
  const parsed = dateParts(value);
  if (!parsed || !Number.isInteger(days) || days < 0 || days > 365) return null;
  parsed.date.setUTCDate(parsed.day + days);
  return parsed.date.getUTCFullYear() <= 9999 ? parsed.date.toISOString().slice(0, 10) : null;
}
export function recurringCalendarPreview(input: { startDate: string; nextDate?: string; endDate: string | null; frequency: RecurringDocumentFrequency; paymentTermsDays: number }, today: string, limit = 12) {
  const anchor = dateParts(input.startDate), end = input.endDate ? dateParts(input.endDate) : null;
  if (!anchor || !dateParts(input.nextDate || input.startDate) || !dateParts(today) || (input.endDate && (!end || input.endDate < input.startDate)) || !['monthly', 'quarterly', 'yearly'].includes(input.frequency) || recurringPaymentDate(input.startDate, input.paymentTermsDays) === null) return null;
  const rhythm = { frequency: input.frequency, anchorDay: anchor.day, anchorIsMonthEnd: anchor.day === new Date(Date.UTC(anchor.year, anchor.month, 0)).getUTCDate() };
  const dates: Array<{ scheduledFor: string; paymentDueOn: string | null }> = [];
  let next: string | null = input.nextDate || input.startDate;
  for (let i = 0; i < 3 && next && (!input.endDate || next <= input.endDate); i++) {
    dates.push({ scheduledFor: next, paymentDueOn: recurringPaymentDate(next, input.paymentTermsDays) });
    next = nextRecurringDate(next, rhythm);
  }
  next = input.nextDate || input.startDate;
  let dueCount = 0;
  while (next && next <= today && (!input.endDate || next <= input.endDate) && dueCount < 120_000) {
    dueCount++;
    const following = nextRecurringDate(next, rhythm);
    if (!following || following <= next) break;
    next = following;
  }
  return { dates, dueCount, firstBatchCount: Math.min(dueCount, Math.max(1, Math.trunc(limit) || 12)), monthEnd: rhythm.anchorIsMonthEnd };
}

export function recurringEndDateIssue(schedule: RecurringDocumentSchedule, endDate: string): { message: string; minimum?: string } | null {
  if (schedule.status === 'completed') return { message: 'Cette planification est terminée. Fermez cette fenêtre pour consulter son historique.' };
  if (!endDate) return null;
  if (!dateParts(endDate)) return { message: 'Choisissez une date réelle dans le calendrier, ou laissez vide pour continuer sans date de fin.' };
  const latest = schedule.occurrences.map(row => row.scheduledFor).filter(date => dateParts(date)).sort().at(-1);
  const minimum = latest && latest > schedule.startDate ? latest : schedule.startDate;
  if (endDate < minimum) return { minimum, message: latest && latest > schedule.startDate ? `Une facture a déjà été préparée pour le ${latest.split('-').reverse().join('.')}. La fin doit être à cette date ou après.` : 'La fin doit être à la date de début de la planification ou après.' };
  return null;
}
export function recurringEndDateOutcome(schedule: RecurringDocumentSchedule, endDate: string | null) {
  const completed = Boolean(endDate && schedule.nextOccurrenceOn && endDate < schedule.nextOccurrenceOn);
  return { completed, status: completed ? 'completed' as const : schedule.status === 'active' ? 'active' as const : 'paused' as const };
}
