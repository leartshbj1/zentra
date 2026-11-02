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

export function reminderSmsDraftUri(preview: {
  recipientPhone: string;
  smsBody: string;
}): string | null {
  const recipient = preview.recipientPhone
    .replace(/[^\d+]/g, '')
    .replace(/(?!^)\+/g, '');
  if (!recipient || !preview.smsBody.trim()) return null;
  return `sms:${recipient}?body=${encodeURIComponent(preview.smsBody)}`;
}


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




const statusLabels: Record<ReminderStatus, string> = {
  planned: 'Planifiée',
  due: 'À envoyer',
  completed: 'Envoyée et clôturée',
  cancelled: 'Clôturée sans envoi',
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


export function reminderHistoryActionLabel(action: string) {
  return historyLabels[action] ?? 'Action inconnue';
}
