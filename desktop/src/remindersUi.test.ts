import { describe, expect, it } from 'vitest';
import type { ReminderHistory } from './types';
import {
  compareReminderBalanceSnapshot,
  reminderHistoryActionLabel,
  reminderPreviewSessionKey,
  reminderSmsDraftUri,
  reminderUrgency,
  sortRemindersByUrgency,
  validateReminderAsOfDate,
  type ReminderUrgencyItem,
} from './remindersUi';


describe('date de contrôle des relances', () => {
  it('refuse une date future et accepte la date du jour', () => {
    expect(validateReminderAsOfDate('2026-09-02', '2026-09-01')).toBe(
      'La date de contrôle ne peut pas être située dans le futur.',
    );
    expect(validateReminderAsOfDate('2026-09-01', '2026-09-01')).toBeNull();
  });

  it('refuse une date civile inexistante et une date locale invérifiable', () => {
    expect(validateReminderAsOfDate('2026-02-30', '2026-09-01')).toBe(
      'Indiquez une date de contrôle valide.',
    );
    expect(validateReminderAsOfDate('2026-09-01', 'invalide')).toBe(
      'La date locale du jour n’a pas pu être vérifiée.',
    );
  });
});

describe('tri et urgence', () => {
  const reminder = (
    id: string,
    status: ReminderUrgencyItem['status'],
    scheduledDate: string,
    level = 1,
  ): ReminderUrgencyItem => ({ id, status, scheduledDate, level });

  it('distingue contrôle requis, retard, aujourd’hui, avenir et clôture', () => {
    const today = '2026-09-01';
    expect(reminderUrgency(reminder('bad', 'due', 'invalide'), today)).toBe(
      'review_required',
    );
    expect(reminderUrgency(reminder('late', 'due', '2026-08-30'), today)).toBe(
      'overdue',
    );
    expect(reminderUrgency(reminder('today', 'due', today), today)).toBe(
      'today',
    );
    expect(
      reminderUrgency(reminder('future', 'planned', '2026-09-10'), today),
    ).toBe('upcoming');
    expect(
      reminderUrgency(reminder('done', 'completed', 'invalide'), today),
    ).toBe('closed');
  });

  it('place les anomalies et les éléments les plus anciens avant la suite', () => {
    const source = [
      reminder('closed-old', 'completed', '2026-07-01'),
      reminder('future', 'planned', '2026-09-10'),
      reminder('late-recent', 'due', '2026-08-31'),
      reminder('today-level-1', 'due', '2026-09-01', 1),
      reminder('invalid', 'due', 'date-invalide'),
      reminder('late-old', 'due', '2026-08-20'),
      reminder('today-level-3', 'due', '2026-09-01', 3),
      reminder('closed-new', 'cancelled', '2026-08-01'),
    ];

    expect(
      sortRemindersByUrgency(source, '2026-09-01').map((item) => item.id),
    ).toEqual([
      'invalid',
      'late-old',
      'late-recent',
      'today-level-3',
      'today-level-1',
      'future',
      'closed-new',
      'closed-old',
    ]);
    expect(source[0]?.id).toBe('closed-old');
  });
});

describe('solde figé et solde actuel', () => {
  it('ouvre une nouvelle session de relecture dès que le document change', () => {
    expect(reminderPreviewSessionKey('rappel-1', 'hash-a')).toBe(
      'rappel-1:hash-a',
    );
    expect(reminderPreviewSessionKey('rappel-1', 'hash-b')).not.toBe(
      reminderPreviewSessionKey('rappel-1', 'hash-a'),
    );
    expect(reminderPreviewSessionKey('rappel-2', 'hash-a')).not.toBe(
      reminderPreviewSessionKey('rappel-1', 'hash-a'),
    );
  });

  it('conserve un snapshot identique comme actuel', () => {
    expect(compareReminderBalanceSnapshot(12_500, 12_500)).toEqual({
      state: 'current',
      isStale: false,
      requiresReview: false,
      snapshotBalanceCents: 12_500,
      liveBalanceCents: 12_500,
      deltaCents: 0,
    });
  });

  it('détecte un paiement partiel et une facture soldée', () => {
    expect(compareReminderBalanceSnapshot(12_500, 8_000)).toMatchObject({
      state: 'changed',
      isStale: true,
      requiresReview: true,
      deltaCents: -4_500,
    });
    expect(compareReminderBalanceSnapshot(12_500, 0)).toMatchObject({
      state: 'settled',
      isStale: true,
      requiresReview: true,
      deltaCents: -12_500,
    });
  });

  it('échoue de façon sûre lorsque le solde actuel est indisponible', () => {
    expect(compareReminderBalanceSnapshot(12_500, undefined)).toMatchObject({
      state: 'unavailable',
      isStale: false,
      requiresReview: true,
      liveBalanceCents: null,
      deltaCents: null,
    });
  });
});

describe('brouillon SMS local', () => {
  it('nettoie le numéro et encode exactement le contenu revérifié', () => {
    const previous = reminderSmsDraftUri({
      recipientPhone: '+41 79 000 00 00',
      smsBody: 'Ancien solde: CHF 200.00',
    });
    const refreshed = reminderSmsDraftUri({
      recipientPhone: '+41 (79) 123 45 67',
      smsBody: 'Solde revérifié: CHF 125.00',
    });

    expect(refreshed).toBe(
      'sms:+41791234567?body=Solde%20rev%C3%A9rifi%C3%A9%3A%20CHF%20125.00',
    );
    expect(refreshed).not.toBe(previous);
  });

  it('refuse un destinataire ou un message vide', () => {
    expect(reminderSmsDraftUri({ recipientPhone: '', smsBody: 'Rappel' })).toBeNull();
    expect(reminderSmsDraftUri({ recipientPhone: '+41 79', smsBody: '   ' })).toBeNull();
  });
});


describe('libellés français', () => {

  it('couvre toutes les actions actuellement typées', () => {
    const actions: ReminderHistory['action'][] = [
      'created',
      'due',
      'completed',
      'cancelled',
      'printed',
      'exported',
      'mail_draft_created',
      'sent_manually',
      'refreshed',
      'note',
    ];
    for (const action of actions) {
      expect(reminderHistoryActionLabel(action)).not.toBe('Action inconnue');
    }
  });
});
