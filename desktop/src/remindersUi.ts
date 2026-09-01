import type {
  ReminderHistory,
  ReminderStatus,
  ReminderTemplate,
} from './types';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoDate(value: string) {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return { year, month, day };
}

export function validateReminderAsOfDate(asOf: string, today: string) {
  if (!parseIsoDate(asOf)) return 'Indiquez une date de contrôle valide.';
  if (!parseIsoDate(today))
    return 'La date locale du jour n’a pas pu être vérifiée.';
  if (asOf > today)
    return 'La date de contrôle ne peut pas être située dans le futur.';
  return null;
}

export type ReminderUrgency =
  | 'review_required'
  | 'overdue'
  | 'today'
  | 'upcoming'
  | 'closed';

export type ReminderUrgencyItem = {
  id: string;
  status: ReminderStatus;
  scheduledDate: string;
  level: number;
};

export function reminderUrgency(
  reminder: Pick<ReminderUrgencyItem, 'status' | 'scheduledDate'>,
  today: string,
): ReminderUrgency {
  if (reminder.status === 'completed' || reminder.status === 'cancelled')
    return 'closed';
  if (!parseIsoDate(reminder.scheduledDate) || !parseIsoDate(today))
    return 'review_required';
  if (reminder.scheduledDate < today) return 'overdue';
  if (reminder.scheduledDate === today) return 'today';
  return 'upcoming';
}

const urgencyOrder: Record<ReminderUrgency, number> = {
  review_required: 0,
  overdue: 1,
  today: 2,
  upcoming: 3,
  closed: 4,
};

export function sortRemindersByUrgency<T extends ReminderUrgencyItem>(
  reminders: readonly T[],
  today: string,
): T[] {
  return [...reminders].sort((left, right) => {
    const leftUrgency = reminderUrgency(left, today);
    const rightUrgency = reminderUrgency(right, today);
    const urgencyDifference =
      urgencyOrder[leftUrgency] - urgencyOrder[rightUrgency];
    if (urgencyDifference) return urgencyDifference;

    const dateDifference = left.scheduledDate.localeCompare(right.scheduledDate);
    if (dateDifference)
      return leftUrgency === 'closed' ? -dateDifference : dateDifference;

    const levelDifference = right.level - left.level;
    if (levelDifference) return levelDifference;
    return left.id.localeCompare(right.id);
  });
}

export type ReminderBalanceSnapshotState =
  | 'current'
  | 'changed'
  | 'settled'
  | 'unavailable';

export type ReminderBalanceSnapshotComparison = {
  state: ReminderBalanceSnapshotState;
  isStale: boolean;
  requiresReview: boolean;
  snapshotBalanceCents: number;
  liveBalanceCents: number | null;
  deltaCents: number | null;
};

export function compareReminderBalanceSnapshot(
  snapshotBalanceCents: number,
  liveBalanceCents: number | null | undefined,
): ReminderBalanceSnapshotComparison {
  if (
    !Number.isSafeInteger(snapshotBalanceCents) ||
    liveBalanceCents === null ||
    liveBalanceCents === undefined ||
    !Number.isSafeInteger(liveBalanceCents) ||
    liveBalanceCents < 0
  ) {
    return {
      state: 'unavailable',
      isStale: false,
      requiresReview: true,
      snapshotBalanceCents,
      liveBalanceCents: null,
      deltaCents: null,
    };
  }

  const deltaCents = liveBalanceCents - snapshotBalanceCents;
  const state: ReminderBalanceSnapshotState =
    liveBalanceCents === 0
      ? 'settled'
      : deltaCents === 0
        ? 'current'
        : 'changed';
  return {
    state,
    isStale: state === 'changed' || state === 'settled',
    requiresReview: state !== 'current',
    snapshotBalanceCents,
    liveBalanceCents,
    deltaCents,
  };
}

export function reminderPreviewSessionKey(
  reminderId: string,
  previewSha256: string,
): string {
  return `${reminderId}:${previewSha256}`;
}

export type ReminderCycleLevelDraft = Pick<
  ReminderTemplate,
  'level' | 'name' | 'subject' | 'body' | 'daysAfterDue'
>;

export type ReminderCycleField =
  | 'level'
  | 'name'
  | 'subject'
  | 'body'
  | 'daysAfterDue';

export type ReminderCycleValidationIssue = {
  code:
    | 'cycle_size'
    | 'duplicate_level'
    | 'missing_level'
    | 'invalid_level'
    | 'invalid_delay'
    | 'non_increasing_delay'
    | 'required'
    | 'too_long';
  message: string;
  index?: number;
  field?: ReminderCycleField;
};

export type ReminderCycleValidation = {
  valid: boolean;
  issues: ReminderCycleValidationIssue[];
};

const textLimits: ReadonlyArray<
  readonly [ReminderCycleField, number, string]
> = [
  ['name', 120, 'Le nom'],
  ['subject', 300, 'L’objet'],
  ['body', 10_000, 'Le message'],
];

export function validateReminderCycle(
  levels: readonly ReminderCycleLevelDraft[],
): ReminderCycleValidation {
  const issues: ReminderCycleValidationIssue[] = [];
  if (levels.length !== 3) {
    issues.push({
      code: 'cycle_size',
      message: 'Le cycle doit contenir exactement trois niveaux de relance.',
    });
  }

  const indexesByLevel = new Map<number, number[]>();
  levels.forEach((draft, index) => {
    if (!Number.isInteger(draft.level) || draft.level < 1 || draft.level > 3) {
      issues.push({
        code: 'invalid_level',
        index,
        field: 'level',
        message: 'Le niveau doit être un nombre entier compris entre 1 et 3.',
      });
    } else {
      const indexes = indexesByLevel.get(draft.level) ?? [];
      indexes.push(index);
      indexesByLevel.set(draft.level, indexes);
    }

    if (!Number.isInteger(draft.daysAfterDue) || draft.daysAfterDue < 0) {
      issues.push({
        code: 'invalid_delay',
        index,
        field: 'daysAfterDue',
        message:
          'Le délai après échéance doit être un nombre entier positif ou nul.',
      });
    }

    for (const [field, limit, label] of textLimits) {
      const value = String(draft[field]).trim();
      if (!value) {
        issues.push({
          code: 'required',
          index,
          field,
          message: `${label} du niveau ${draft.level || index + 1} est obligatoire.`,
        });
      } else if (Array.from(value).length > limit) {
        issues.push({
          code: 'too_long',
          index,
          field,
          message: `${label} est limité à ${limit.toLocaleString('fr-CH')} caractères.`,
        });
      }
    }
  });

  for (const level of [1, 2, 3]) {
    const indexes = indexesByLevel.get(level) ?? [];
    if (!indexes.length) {
      issues.push({
        code: 'missing_level',
        field: 'level',
        message: `Le niveau ${level} est manquant.`,
      });
    } else if (indexes.length > 1) {
      for (const index of indexes) {
        issues.push({
          code: 'duplicate_level',
          index,
          field: 'level',
          message: `Le niveau ${level} ne peut apparaître qu’une seule fois.`,
        });
      }
    }
  }

  for (const level of [2, 3]) {
    const previousIndexes = indexesByLevel.get(level - 1);
    const currentIndexes = indexesByLevel.get(level);
    if (previousIndexes?.length !== 1 || currentIndexes?.length !== 1) continue;
    const previous = levels[previousIndexes[0]];
    const currentIndex = currentIndexes[0];
    const current = levels[currentIndex];
    if (
      !previous ||
      !current ||
      !Number.isInteger(previous.daysAfterDue) ||
      previous.daysAfterDue < 0 ||
      !Number.isInteger(current.daysAfterDue) ||
      current.daysAfterDue < 0
    )
      continue;
    if (current.daysAfterDue <= previous.daysAfterDue) {
      issues.push({
        code: 'non_increasing_delay',
        index: currentIndex,
        field: 'daysAfterDue',
        message: `Le délai du niveau ${level} doit être strictement supérieur à celui du niveau ${level - 1}.`,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

const statusLabels: Record<ReminderStatus, string> = {
  planned: 'Planifiée',
  due: 'À envoyer',
  completed: 'Envoyée et clôturée',
  cancelled: 'Clôturée sans envoi',
};

const urgencyLabels: Record<ReminderUrgency, string> = {
  review_required: 'À contrôler',
  overdue: 'En retard',
  today: 'À envoyer aujourd’hui',
  upcoming: 'À venir',
  closed: 'Clôturée',
};

const historyLabels: Record<ReminderHistory['action'], string> = {
  created: 'Relance créée',
  due: 'Arrivée à échéance',
  completed: 'Envoi terminé',
  cancelled: 'Clôture sans envoi',
  printed: 'Impression confirmée',
  exported: 'Document exporté',
  mail_draft_created: 'Ouverture du client e-mail demandée',
  sent_manually: 'Envoi manuel confirmé',
  refreshed: 'Données actualisées',
  note: 'Note ajoutée',
};

export function reminderStatusLabel(status: ReminderStatus | string) {
  return statusLabels[status as ReminderStatus] ?? 'Statut inconnu';
}

export function reminderUrgencyLabel(urgency: ReminderUrgency) {
  return urgencyLabels[urgency];
}

export function reminderHistoryActionLabel(action: string) {
  return historyLabels[action] ?? 'Action inconnue';
}
