import { describe, expect, it } from 'vitest';
import {
  createRecurrenceScheduleMutation,
  generateRecurrenceOccurrencesMutation,
  recurrenceOccurrenceFromRaw,
  recurrenceScheduleFromRaw,
  updateRecurrenceScheduleMutation,
} from './bridge';

const requestId = '7b63030f-8076-4d70-acd7-6db15d296895';
const scheduleId = '16812141-27b2-49eb-a3a4-e80c8459ed45';
const salesOrderId = 'f76ce004-4dcf-47c5-ad3d-d9ab73f32d7d';

describe('contrat frontend de la facturation récurrente', () => {
  it('convertit la création camelCase vers le contrat Rust snake_case', () => {
    expect(
      createRecurrenceScheduleMutation({
        requestId: ` ${requestId} `,
        sourceSalesOrderId: ` ${salesOrderId} `,
        frequency: 'quarterly',
        startDate: ' 2026-09-30 ',
        endDate: '',
        paymentTermsDays: 30,
      }),
    ).toEqual({
      command: 'create_recurrence_schedule',
      args: {
        input: {
          request_id: requestId,
          source_sales_order_id: salesOrderId,
          frequency: 'quarterly',
          start_date: '2026-09-30',
          end_date: null,
          payment_terms_days: 30,
        },
      },
    });
  });

  it('refuse côté client un délai hors de la plage locale 0..365', () => {
    expect(() =>
      createRecurrenceScheduleMutation({
        requestId,
        sourceSalesOrderId: salesOrderId,
        frequency: 'monthly',
        startDate: '2026-09-01',
        paymentTermsDays: 366,
      }),
    ).toThrow(/0 et 365/);
    expect(() =>
      createRecurrenceScheduleMutation({
        requestId,
        sourceSalesOrderId: salesOrderId,
        frequency: 'monthly',
        startDate: '2026-09-01',
        paymentTermsDays: 30.5,
      }),
    ).toThrow(/nombre entier/);
  });

  it('transmet la pause, la fin manuelle et le lancement supervisé', () => {
    expect(
      updateRecurrenceScheduleMutation({
        requestId,
        scheduleId,
        status: 'completed',
        endDate: '2026-12-31',
      }),
    ).toEqual({
      command: 'update_recurrence_schedule',
      args: {
        input: {
          request_id: requestId,
          schedule_id: scheduleId,
          status: 'completed',
          end_date: '2026-12-31',
        },
      },
    });
    expect(
      generateRecurrenceOccurrencesMutation({
        requestId,
        scheduleId,
        throughDate: ' 2026-09-01 ',
      }),
    ).toEqual({
      command: 'generate_recurrence_occurrences',
      args: {
        input: {
          request_id: requestId,
          schedule_id: scheduleId,
          through_date: '2026-09-01',
        },
      },
    });
  });

  it('normalise les lignes de workspace sans exposer le snapshot JSON lourd', () => {
    const schedule = recurrenceScheduleFromRaw({
      id: scheduleId,
      source_sales_order_id: salesOrderId,
      frequency: 'yearly',
      anchor_date: '2026-02-28',
      anchor_day: 28,
      anchor_is_month_end: 1,
      payment_terms_days: 45,
      next_scheduled_for: '2027-02-28',
      end_date: null,
      status: 'active',
      review_reason: null,
      source_order_snapshot_sha256: 'a'.repeat(64),
      source_snapshot_sha256: 'b'.repeat(64),
      source_snapshot_json: '{"secret":"must-not-leak"}',
      completed_at: null,
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-09-01T10:00:00Z',
    });
    expect(schedule).toMatchObject({
      frequency: 'yearly',
      anchorIsMonthEnd: true,
      paymentTermsDays: 45,
      status: 'active',
    });
    expect(schedule).not.toHaveProperty('sourceSnapshotJson');

    expect(
      recurrenceOccurrenceFromRaw({
        sequence: 2,
        id: 'occurrence-2',
        schedule_id: scheduleId,
        scheduled_for: '2027-02-28',
        invoice_id: 'invoice-2',
        status: 'draft_created',
        message: null,
        request_id: requestId,
        payload_sha256: 'c'.repeat(64),
        source_snapshot_sha256: 'b'.repeat(64),
        created_at: '2027-02-28T08:00:00Z',
        invoice_status: 'brouillon',
        invoice_number: 'FAC-2027-0002',
      }),
    ).toMatchObject({
      sequence: 2,
      status: 'draft_created',
      invoiceStatus: 'draft',
      invoiceNumber: 'FAC-2027-0002',
    });
  });

  it('bascule les valeurs de planification inconnues en revue manuelle', () => {
    expect(
      recurrenceScheduleFromRaw({ frequency: 'weekly', status: 'mystery' }),
    ).toMatchObject({
      frequency: 'monthly',
      status: 'review_required',
      reviewReason: expect.stringMatching(/contrôlée/),
    });
    expect(recurrenceOccurrenceFromRaw({ status: 'mystery' }).status).toBe(
      'unknown',
    );
  });
});
