import type { AppointmentInboxItem, AppointmentInboxState } from './AppointmentInbox';
import { automationLabel } from './automationPresentation';

/** Keep retained responses from another workspace out of the visible journal. */
export function scopedAppointments(state: AppointmentInboxState | null | undefined, organizationId?: string) {
  if (!organizationId || !state?.active || state.organizationId !== organizationId) return [];
  return state.items.filter(item => item.organizationId === organizationId);
}

export function appointmentActivityStatus(item: AppointmentInboxItem) {
  if (item.state === 'imported') return item.extraction.status === 'cancelled' ? 'appointmentCancelled'
    : item.automatic === true ? 'appointmentAutomatic' : 'appointmentImported';
  if (item.state === 'ignored') return 'appointmentIgnored';
  if (item.state === 'processing') return 'appointmentProcessing';
  if (item.state === 'ready') return 'appointmentReady';
  if (item.state === 'review' || item.state === 'needs_review') return 'review';
  return 'waiting';
}

function realDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

/** These are extracted Swiss wall-clock values, not device-zone timestamps. */
export function appointmentSchedule(item: AppointmentInboxItem, language: string) {
  const {startDate, endDate, startTime, endTime, allDay} = item.extraction;
  const start = realDate(startDate), end = realDate(endDate);
  if (!start) return automationLabel('unavailableDate', language);
  const format = (date: Date) => new Intl.DateTimeFormat(`${language}-CH`, {dateStyle:'medium',timeZone:'UTC'}).format(date);
  const clock = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : '';
  const a = allDay ? '' : clock(startTime), b = allDay ? '' : clock(endTime);
  const from = format(start) + (a ? ` · ${a}` : '');
  const to = end && endDate > startDate ? format(end) + (b ? ` · ${b}` : '')
    : end && endDate === startDate && b && (!a || b > a) ? b : '';
  return from + (to ? ` – ${to}` : '') + (allDay ? ` · ${automationLabel('allDay', language)}` : '');
}
