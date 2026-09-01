import { describe, expect, it } from 'vitest';
import type { ReminderHistory } from './types';
import {
  compareReminderBalanceSnapshot,
  reminderHistoryActionLabel,
  reminderPreviewSessionKey,
  reminderStatusLabel,
  reminderUrgency,
  reminderUrgencyLabel,
  sortRemindersByUrgency,
  validateReminderAsOfDate,
  validateReminderCycle,
  type ReminderCycleLevelDraft,
  type ReminderUrgencyItem,
} from './remindersUi';

const validCycle: ReminderCycleLevelDraft[] = [
  {
    level: 1,
    name: 'Premier rappel',
    subject: 'Rappel concernant votre facture',
    body: 'Le règlement de votre facture reste ouvert.',
    daysAfterDue: 5,
  },
  {
    level: 2,
    name: 'Deuxième rappel',
    subject: 'Deuxième rappel concernant votre facture',
    body: 'Nous vous remercions de vérifier le règlement.',
    daysAfterDue: 15,
  },
  {
    level: 3,
    name: 'Dernier rappel',
    subject: 'Dernier rappel concernant votre facture',
    body: 'Merci de nous contacter ou de régler le solde ouvert.',
    daysAfterDue: 30,
  },
];

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

describe('cycle explicite de trois niveaux', () => {
  it('accepte trois niveaux uniques aux délais strictement croissants', () => {
    expect(validateReminderCycle(validCycle)).toEqual({
      valid: true,
      issues: [],
    });
    expect(
      validateReminderCycle([validCycle[2], validCycle[0], validCycle[1]]),
    ).toEqual({ valid: true, issues: [] });
  });

  it('refuse un niveau dupliqué et signale le niveau manquant', () => {
    const result = validateReminderCycle([
      validCycle[0],
      { ...validCycle[1], level: 1 },
      validCycle[2],
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.filter((issue) => issue.code === 'duplicate_level')).toHaveLength(2);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'missing_level', message: 'Le niveau 2 est manquant.' }),
    );
  });

  it('refuse les délais égaux, décroissants ou non entiers', () => {
    const result = validateReminderCycle([
      validCycle[0],
      { ...validCycle[1], daysAfterDue: 5 },
      { ...validCycle[2], daysAfterDue: 4.5 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'non_increasing_delay',
        index: 1,
        field: 'daysAfterDue',
      }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid_delay',
        index: 2,
        field: 'daysAfterDue',
      }),
    );

    const decreasing = validateReminderCycle([
      validCycle[0],
      validCycle[1],
      { ...validCycle[2], daysAfterDue: 10 },
    ]);
    expect(decreasing.issues).toContainEqual(
      expect.objectContaining({
        code: 'non_increasing_delay',
        index: 2,
        field: 'daysAfterDue',
      }),
    );
  });

  it('refuse un cycle incomplet et les textes vides', () => {
    const result = validateReminderCycle([
      { ...validCycle[0], subject: '   ' },
      validCycle[1],
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'cycle_size' }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'required',
        index: 0,
        field: 'subject',
      }),
    );
  });
});

describe('libellés français', () => {
  it('traduit les statuts, urgences et actions sans exposer le code brut', () => {
    expect(reminderStatusLabel('planned')).toBe('Planifiée');
    expect(reminderStatusLabel('due')).toBe('À envoyer');
    expect(reminderStatusLabel('completed')).toBe('Envoyée et clôturée');
    expect(reminderStatusLabel('cancelled')).toBe('Clôturée sans envoi');
    expect(reminderStatusLabel('unknown')).toBe('Statut inconnu');
    expect(reminderUrgencyLabel('review_required')).toBe('À contrôler');
    expect(reminderUrgencyLabel('today')).toBe('À envoyer aujourd’hui');
    expect(reminderHistoryActionLabel('sent_manually')).toBe(
      'Envoi manuel confirmé',
    );
    expect(reminderHistoryActionLabel('printed')).toBe('Impression confirmée');
    expect(reminderHistoryActionLabel('mail_draft_created')).toBe(
      'Ouverture du client e-mail demandée',
    );
    expect(reminderHistoryActionLabel('unknown')).toBe('Action inconnue');
  });

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
