import { describe, expect, it } from 'vitest';
import {
  reminderActionResultFromRaw,
  reminderFromRaw,
  reminderPreviewFromRaw,
  reminderScanResultFromRaw,
  reminderTemplateFromRaw,
} from './bridge';

const reminderRow = {
  id: 'reminder-1',
  invoice_id: 'invoice-1',
  template_id: 'template-1',
  level: 2,
  scheduled_date: '2026-09-01',
  status: 'due',
  subject: 'Relance F-2026-1',
  body: 'Solde ouvert',
  invoice_number: 'F-2026-1',
  currency: 'CHF',
  invoice_total_cents: 15_000,
  balance_cents: 15_000,
  live_balance_cents: 9_000,
  payment_deadline_days: 10,
  snapshot_stale: 1,
  client_name: 'Client SA',
  client_email: 'finance@example.invalid',
};

describe('contrat frontend des relances supervisées', () => {
  it('mappe les nouveaux délais et le solde actuel', () => {
    expect(
      reminderTemplateFromRaw({
        id: 'template-1',
        level: 2,
        name: 'Première relance',
        subject: 'Objet',
        body: 'Message',
        days_after_due: 21,
        payment_deadline_days: 12,
        active: 1,
      }),
    ).toMatchObject({
      daysAfterDue: 21,
      paymentDeadlineDays: 12,
      active: true,
    });
    expect(reminderFromRaw(reminderRow)).toMatchObject({
      balanceCents: 15_000,
      liveBalanceCents: 9_000,
      snapshotStale: true,
      clientEmail: 'finance@example.invalid',
    });
  });

  it('lit les relances créées depuis la clé backend created', () => {
    const result = reminderScanResultFromRaw({
      as_of: '2026-09-01',
      enabled: 1,
      created: [reminderRow],
      cancelled: ['reminder-old'],
      review: [
        {
          invoice_id: 'invoice-2',
          reminder_id: 'reminder-2',
          reason: 'already_open',
        },
      ],
      idempotent: 0,
    });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.id).toBe('reminder-1');
    expect(result.cancelled).toEqual(['reminder-old']);
    expect(result.review[0]).toEqual({
      invoiceId: 'invoice-2',
      reminderId: 'reminder-2',
      reason: 'already_open',
    });
  });

  it('mappe un aperçu figé avec le solde revérifié', () => {
    const preview = reminderPreviewFromRaw({
      reminder_id: 'reminder-1',
      invoice_id: 'invoice-1',
      invoice_number: 'F-2026-1',
      level: 2,
      due_date: '2026-08-01',
      scheduled_date: '2026-08-22',
      prepared_on: '2026-09-01',
      payment_deadline_date: '2026-09-11',
      payment_deadline_days: 10,
      currency: 'CHF',
      snapshot_balance_cents: 15_000,
      current_balance_cents: 9_000,
      snapshot_stale: 1,
      template_review_required: 1,
      recipient_email: 'finance@example.invalid',
      client: {
        name: 'Client SA',
        address_line1: 'Rue du Test 1',
        postal_code: '1000',
        city: 'Lausanne',
        country: 'CH',
      },
      sender: {
        name: 'Zentra Test',
        company: 'Entreprise SA',
        logo_path: 'C:/branding/logo.png',
      },
      subject: 'Relance F-2026-1',
      body: 'Merci de régler CHF 90.00.',
      preview_sha256: 'a'.repeat(64),
    });
    expect(preview).toMatchObject({
      currentBalanceCents: 9_000,
      snapshotStale: true,
      templateReviewRequired: true,
      paymentDeadlineDate: '2026-09-11',
      client: { name: 'Client SA', city: 'Lausanne' },
      sender: { company: 'Entreprise SA', logoPath: 'C:/branding/logo.png' },
    });
    expect(preview.previewSha256).toHaveLength(64);
  });

  it('distingue une action enregistrée d’un blocage après règlement', () => {
    expect(
      reminderActionResultFromRaw({
        blocked: 0,
        delivery: { id: 'delivery-1' },
        reminder: { ...reminderRow, status: 'completed' },
        idempotent: 0,
      }),
    ).toMatchObject({
      blocked: false,
      deliveryId: 'delivery-1',
      reminder: { status: 'completed' },
    });
    expect(
      reminderActionResultFromRaw({
        blocked: 1,
        reason: 'settled',
        reminder: { ...reminderRow, status: 'cancelled' },
        idempotent: 1,
      }),
    ).toMatchObject({
      blocked: true,
      reason: 'settled',
      deliveryId: '',
      idempotent: true,
    });
  });
});
