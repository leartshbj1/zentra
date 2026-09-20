import { AccountPublicError } from './account-security';

export const FOUNDER_DOMAIN = 'zentra-founder-access-v1\n';
export const FOUNDER_PATH = '/api/founder/access';
export const FOUNDER_MAX_DAYS = 3660;
export const SOLO_PLAN = 'zentra-solo-monthly-49-chf';

export function grantEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AccountPublicError('Saisissez une adresse e-mail complète.');
  }
  return email;
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function accessExpiry(
  duration: unknown,
  customDate: unknown,
  now: number,
): number {
  const start = new Date(now * 1000);
  if (duration === '14_days') return now + 14 * 86400;
  if (duration === 'one_month') {
    const day = start.getUTCDate();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() + 1);
    const last = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
    ).getUTCDate();
    start.setUTCDate(Math.min(day, last));
    return Math.floor(start.getTime() / 1000);
  }
  if (
    duration !== 'custom' ||
    typeof customDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(customDate)
  ) {
    throw new AccountPublicError(
      'Choisissez 14 jours, un mois ou une date personnalisée.',
    );
  }
  const nextDay = new Date(customDate + 'T00:00:00Z');
  if (
    !Number.isFinite(nextDay.getTime()) ||
    nextDay.toISOString().slice(0, 10) !== customDate
  ) {
    throw new AccountPublicError('La date choisie est invalide.');
  }
  // End of the selected Swiss calendar day, including daylight saving time.
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const utcMidnight = nextDay.getTime();
  const offsetText = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich',
    timeZoneName: 'shortOffset',
  })
    .formatToParts(nextDay)
    .find((part) => part.type === 'timeZoneName')?.value;
  const offset = Number(offsetText?.replace('GMT', '') ?? NaN);
  if (!Number.isFinite(offset))
    throw new AccountPublicError('La date ne peut pas être calculée.', 503);
  const end = Math.floor((utcMidnight - offset * 3600000) / 1000) - 1;
  if (end <= now || end > now + FOUNDER_MAX_DAYS * 86400)
    throw new AccountPublicError(
      'Choisissez une date future, dans les dix prochaines années.',
    );
  return end;
}

export type FounderAction = {
  product?: 'support';
  plan?: 'starter' | 'team' | 'business';
  operation: 'lookup' | 'list' | 'grant' | 'revoke';
  email?: string;
  duration?: '14_days' | 'one_month' | 'custom';
  customDate?: string;
  operationId?: string;
  expectedRevision?: number;
  note?: string;
};

export function parseAction(value: unknown): FounderAction {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AccountPublicError('Commande invalide.');
  const a = value as Record<string, unknown>;
  if (
    Object.keys(a).some(
      (key) =>
        ![
          'operation',
          'email',
          'duration',
          'customDate',
          'operationId',
          'expectedRevision',
          'note',
          'product',
          'plan',
        ].includes(key),
    )
  )
    throw new AccountPublicError('Champ de commande inconnu.');
  if (!['lookup', 'list', 'grant', 'revoke'].includes(String(a.operation)))
    throw new AccountPublicError('Commande inconnue.');
  const action: FounderAction = {
    operation: a.operation as FounderAction['operation'],
  };
  if (a.product !== undefined && a.product !== 'support')
    throw new AccountPublicError('Produit inconnu.');
  if (a.product === 'support') action.product = 'support';
  if (
    a.plan !== undefined &&
    (a.product !== 'support' || a.operation !== 'grant')
  )
    throw new AccountPublicError('Formule inattendue.');
  if (a.product === 'support' && a.operation === 'grant') {
    if (!['starter', 'team', 'business'].includes(String(a.plan)))
      throw new AccountPublicError('Choisissez une formule Zentra Support.');
    action.plan = a.plan as FounderAction['plan'];
  }
  if (action.operation !== 'list') action.email = grantEmail(a.email);
  if (action.operation === 'grant' || action.operation === 'revoke') {
    if (
      !isUuid(a.operationId) ||
      !Number.isSafeInteger(a.expectedRevision) ||
      Number(a.expectedRevision) < 0
    )
      throw new AccountPublicError(
        'Relisez le compte avant de confirmer cette modification.',
      );
    if (
      typeof a.note !== 'string' ||
      a.note.length > 300 ||
      a.note.split('').some((char) => char.charCodeAt(0) < 32)
    )
      throw new AccountPublicError(
        'La note est limitée à 300 caractères sur une ligne.',
      );
    action.operationId = a.operationId;
    action.expectedRevision = Number(a.expectedRevision);
    action.note = a.note.trim();
    if (action.operation === 'grant') {
      if (!['14_days', 'one_month', 'custom'].includes(String(a.duration)))
        throw new AccountPublicError('Durée invalide.');
      action.duration = a.duration as FounderAction['duration'];
      action.customDate =
        action.duration === 'custom' && typeof a.customDate === 'string'
          ? a.customDate
          : '';
    }
  }
  return action;
}
