import { createId } from './utils';

export type ManualJournalSubmission = {
  entryDate: string;
  description: string;
  lines: Array<{
    accountId: string;
    debitCents: number;
    creditCents: number;
    memo?: string;
    projectId?: string;
    clientId?: string;
    employeeId?: string;
  }>;
};

export type ManualJournalAttempt = {
  requestId: string;
  fingerprint: string;
};

type ManualJournalAttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const MANUAL_JOURNAL_ATTEMPT_STORAGE_KEY = 'zentra.manual-journal-attempt.v1';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function browserStorage(): ManualJournalAttemptStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function canonicalSubmissionJson(submission: ManualJournalSubmission) {
  return JSON.stringify({
    entryDate: submission.entryDate,
    description: submission.description.trim(),
    lines: submission.lines.map((line) => ({
      accountId: line.accountId,
      debitCents: line.debitCents,
      creditCents: line.creditCents,
      memo: line.memo || '',
      projectId: line.projectId || '',
      clientId: line.clientId || '',
      employeeId: line.employeeId || '',
    })),
  });
}

async function submissionFingerprint(submission: ManualJournalSubmission) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto est indisponible; l’écriture ne peut pas être envoyée de façon idempotente.');
  }
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalSubmissionJson(submission)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function parseManualJournalAttempt(raw: string | null): ManualJournalAttempt | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<ManualJournalAttempt>;
  if (
    typeof parsed.requestId !== 'string'
    || !UUID_PATTERN.test(parsed.requestId)
    || typeof parsed.fingerprint !== 'string'
    || !SHA256_PATTERN.test(parsed.fingerprint)
  ) return null;
  return { requestId: parsed.requestId, fingerprint: parsed.fingerprint };
}

function loadManualJournalAttemptStrict(
  storage: ManualJournalAttemptStorage,
): ManualJournalAttempt | null {
  const raw = storage.getItem(MANUAL_JOURNAL_ATTEMPT_STORAGE_KEY);
  if (raw === null) return null;
  const attempt = parseManualJournalAttempt(raw);
  if (!attempt) throw new Error('invalid manual journal attempt');
  return attempt;
}

export function loadManualJournalAttempt(
  storage: ManualJournalAttemptStorage | null = browserStorage(),
): ManualJournalAttempt | null {
  if (!storage) return null;
  try {
    return parseManualJournalAttempt(
      storage.getItem(MANUAL_JOURNAL_ATTEMPT_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

function persistManualJournalAttempt(
  attempt: ManualJournalAttempt,
  storage: ManualJournalAttemptStorage | null,
) {
  if (!storage) {
    throw new Error('Le stockage local est indisponible; l’écriture n’a pas été envoyée afin d’éviter un doublon après redémarrage.');
  }
  try {
    storage.setItem(MANUAL_JOURNAL_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
  } catch {
    throw new Error('La tentative comptable ne peut pas être sécurisée localement; l’écriture n’a pas été envoyée.');
  }
}

export function clearManualJournalAttempt(
  completed: ManualJournalAttempt,
  storage: ManualJournalAttemptStorage | null = browserStorage(),
) {
  const cleanupError = () => new Error(
    'L’écriture est déjà comptabilisée, mais son marqueur de reprise n’a pas pu être supprimé. Réessayez sans modifier la saisie afin de terminer le nettoyage sans créer de doublon.',
  );
  if (!storage) throw cleanupError();
  try {
    const persisted = parseManualJournalAttempt(
      storage.getItem(MANUAL_JOURNAL_ATTEMPT_STORAGE_KEY),
    );
    if (
      persisted?.requestId === completed.requestId
      && persisted.fingerprint === completed.fingerprint
    ) {
      storage.removeItem(MANUAL_JOURNAL_ATTEMPT_STORAGE_KEY);
      const remaining = parseManualJournalAttempt(
        storage.getItem(MANUAL_JOURNAL_ATTEMPT_STORAGE_KEY),
      );
      if (
        remaining?.requestId === completed.requestId
        && remaining.fingerprint === completed.fingerprint
      ) throw cleanupError();
    }
  } catch {
    throw cleanupError();
  }
}

export async function prepareManualJournalAttempt(
  current: ManualJournalAttempt | null,
  submission: ManualJournalSubmission,
  requestIdFactory: () => string = createId,
  storage: ManualJournalAttemptStorage | null = browserStorage(),
): Promise<ManualJournalAttempt> {
  const fingerprint = await submissionFingerprint(submission);
  let persisted: ManualJournalAttempt | null = null;
  if (storage) {
    try {
      persisted = loadManualJournalAttemptStrict(storage);
    } catch {
      throw new Error(
        'Le marqueur de reprise comptable est illisible; aucune écriture n’a été envoyée afin d’éviter un doublon. Contrôlez d’abord le journal avant toute nouvelle saisie.',
      );
    }
  }
  if (
    current
    && persisted
    && (
      current.requestId !== persisted.requestId
      || current.fingerprint !== persisted.fingerprint
    )
  ) {
    throw new Error(
      'Le marqueur de reprise comptable a changé; aucune écriture n’a été envoyée afin d’éviter un doublon.',
    );
  }
  const reusable = current ?? persisted;
  if (reusable && reusable.fingerprint !== fingerprint) {
    throw new Error(
      'Une écriture précédente peut déjà être comptabilisée. Rétablissez exactement la saisie originale et réessayez pour vérifier son résultat; Zentra refuse de la remplacer par une nouvelle tentative afin d’éviter un doublon.',
    );
  }
  const attempt = reusable ?? { requestId: requestIdFactory(), fingerprint };
  persistManualJournalAttempt(attempt, storage);
  return attempt;
}
