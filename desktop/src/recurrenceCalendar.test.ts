import { describe, expect, it } from 'vitest';
import { recurringCalendarPreview, recurringEndDateIssue, recurringEndDateOutcome, recurringPaymentDate } from './recurrenceCalendar';
import type { RecurringDocumentSchedule } from './RecurringDocumentsPanel';

const input = { startDate: '2028-01-31', endDate: null, frequency: 'monthly' as const, paymentTermsDays: 15 };
const schedule: RecurringDocumentSchedule = {
  id: 'schedule', sourceSalesOrderId: 'order', status: 'active', startDate: input.startDate, frequency: 'monthly', endDate: null, paymentTermsDays: 15, nextOccurrenceOn: '2028-04-30', pendingCatchUpCount: 0,
  occurrences: ['2028-03-31', '2028-01-31'].map((scheduledFor, index) => ({ id: `occurrence-${index}`, scheduleId: 'schedule', scheduledFor, invoiceId: `invoice-${index}`, requestId: `request-${index}`, payloadSha256: 'a'.repeat(64), sourceSnapshotSha256: 'b'.repeat(64), createdAt: `${scheduledFor}T12:00:00Z`, invoiceStatus: 'draft', invoiceNumber: null })),
};
describe('expliquer les dates des factures récurrentes', () => {
  it('garde les fins de mois et calcule les dates de paiement en année bissextile', () => {
    expect(recurringCalendarPreview(input, '2028-01-15')).toMatchObject({ monthEnd: true, dueCount: 0, dates: [
      { scheduledFor: '2028-01-31', paymentDueOn: '2028-02-15' },
      { scheduledFor: '2028-02-29', paymentDueOn: '2028-03-15' },
      { scheduledFor: '2028-03-31', paymentDueOn: '2028-04-15' },
    ] });
  });
  it('reprend le jour original après un mois court sans le transformer en fin de mois', () => {
    expect(recurringCalendarPreview({ ...input, startDate: '2028-01-30', nextDate: '2028-02-29' }, '2028-02-20')?.dates.map(d => d.scheduledFor)).toEqual(['2028-02-29', '2028-03-30', '2028-04-30']);
  });
  it('respecte les rythmes trimestriels et annuels et la dernière date incluse', () => {
    expect(recurringCalendarPreview({ ...input, frequency: 'quarterly', endDate: '2028-07-31' }, '2028-01-15')?.dates.map(d => d.scheduledFor)).toEqual(['2028-01-31', '2028-04-30', '2028-07-31']);
    expect(recurringCalendarPreview({ ...input, startDate: '2028-02-29', frequency: 'yearly' }, '2028-01-15')?.dates.map(d => d.scheduledFor)).toEqual(['2028-02-29', '2029-02-28', '2030-02-28']);
  });
  it('compte le rattrapage y compris aujourd’hui, avec la limite du premier lot', () => {
    expect(recurringCalendarPreview({ ...input, startDate: '2025-01-31' }, '2026-08-31')).toMatchObject({ dueCount: 20, firstBatchCount: 12 });
    expect(recurringCalendarPreview({ ...input, startDate: '2025-01-31', endDate: '2025-03-31' }, '2026-08-31')).toMatchObject({ dueCount: 3, firstBatchCount: 3 });
  });
  it('n’affiche pas de dates inventées pour une saisie invalide ou hors limites', () => {
    expect(recurringCalendarPreview({ ...input, startDate: '2028-02-30' }, '2028-01-15')).toBeNull();
    expect(recurringCalendarPreview({ ...input, endDate: '2027-12-31' }, '2028-01-15')).toBeNull();
    expect(recurringPaymentDate('9999-12-31', 1)).toBeNull();
    expect(recurringPaymentDate('2028-01-31', 0)).toBe('2028-01-31');
  });
  it('protège toutes les occurrences existantes, indépendamment de leur ordre', () => {
    expect(recurringEndDateIssue(schedule, '2028-03-01')).toMatchObject({ minimum: '2028-03-31' });
    expect(recurringEndDateIssue(schedule, '2028-03-31')).toBeNull();
    expect(recurringEndDateIssue(schedule, '')).toBeNull();
    expect(recurringEndDateIssue({ ...schedule, status: 'completed' }, '')?.message).toContain('terminée');
  });
  it('explique l’arrêt définitif sans supprimer la prochaine date lorsqu’elle égale la fin', () => {
    expect(recurringEndDateOutcome(schedule, '2028-03-31')).toEqual({ status: 'completed', completed: true });
    expect(recurringEndDateOutcome(schedule, '2028-04-30')).toEqual({ status: 'active', completed: false });
    expect(recurringEndDateOutcome({ ...schedule, status: 'review_required' }, null)).toEqual({ status: 'paused', completed: false });
    expect(recurringEndDateOutcome({ ...schedule, status: 'paused' }, '2028-08-31')).toEqual({ status: 'paused', completed: false });
  });
});
