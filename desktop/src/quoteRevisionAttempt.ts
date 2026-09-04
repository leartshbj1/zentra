import { createId } from './utils';

export type QuoteRevisionAttempt = {
  requestId: string;
  quoteFingerprint: string;
};

type AttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const QUOTE_REVISION_ATTEMPTS_STORAGE_KEY =
  'zentra.quote-revision-attempts.v1';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function browserStorage(): AttemptStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function parseAttempts(raw: string | null): QuoteRevisionAttempt[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('invalid attempt registry');
  const attempts = parsed.map((value) => {
    const candidate = value as Partial<QuoteRevisionAttempt>;
    if (
      !candidate
      || typeof candidate.requestId !== 'string'
      || !UUID_PATTERN.test(candidate.requestId)
      || typeof candidate.quoteFingerprint !== 'string'
      || !SHA256_PATTERN.test(candidate.quoteFingerprint)
    ) throw new Error('invalid attempt');
    return {
      requestId: candidate.requestId.toLowerCase(),
      quoteFingerprint: candidate.quoteFingerprint,
    };
  });
  if (new Set(attempts.map((attempt) => attempt.quoteFingerprint)).size !== attempts.length) {
    throw new Error('duplicate attempt');
  }
  return attempts;
}

async function quoteFingerprint(quoteId: string) {
  if (!UUID_PATTERN.test(quoteId.trim())) {
    throw new Error('Le devis à réviser possède un identifiant invalide.');
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'Web Crypto est indisponible; la révision n’a pas été envoyée afin d’éviter un doublon.',
    );
  }
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(quoteId.trim().toLowerCase()),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function prepareQuoteRevisionAttempt(
  quoteId: string,
  requestIdFactory: () => string = createId,
  storage: AttemptStorage | null = browserStorage(),
): Promise<QuoteRevisionAttempt> {
  const fingerprint = await quoteFingerprint(quoteId);
  if (!storage) {
    throw new Error(
      'Le stockage local est indisponible; la révision n’a pas été envoyée afin d’éviter un doublon après redémarrage.',
    );
  }
  try {
    const attempts = parseAttempts(
      storage.getItem(QUOTE_REVISION_ATTEMPTS_STORAGE_KEY),
    );
    const existing = attempts.find(
      (attempt) => attempt.quoteFingerprint === fingerprint,
    );
    if (existing) return existing;
    const requestId = requestIdFactory().toLowerCase();
    if (!UUID_PATTERN.test(requestId)) throw new Error('invalid request id');
    const attempt = { requestId, quoteFingerprint: fingerprint };
    storage.setItem(
      QUOTE_REVISION_ATTEMPTS_STORAGE_KEY,
      JSON.stringify([...attempts, attempt]),
    );
    const persisted = parseAttempts(
      storage.getItem(QUOTE_REVISION_ATTEMPTS_STORAGE_KEY),
    );
    if (!persisted.some((candidate) =>
      candidate.requestId === attempt.requestId
      && candidate.quoteFingerprint === attempt.quoteFingerprint
    )) throw new Error('attempt not persisted');
    return attempt;
  } catch {
    throw new Error(
      'La tentative de révision ne peut pas être sécurisée localement; aucun devis n’a été créé.',
    );
  }
}

export function clearQuoteRevisionAttempt(
  completed: QuoteRevisionAttempt,
  storage: AttemptStorage | null = browserStorage(),
) {
  const cleanupError = () => new Error(
    'La révision est déjà créée, mais son marqueur de reprise n’a pas pu être supprimé. Réessayez le même devis pour terminer le nettoyage sans créer de doublon.',
  );
  if (!storage) throw cleanupError();
  try {
    const attempts = parseAttempts(
      storage.getItem(QUOTE_REVISION_ATTEMPTS_STORAGE_KEY),
    );
    const matching = attempts.find(
      (attempt) => attempt.quoteFingerprint === completed.quoteFingerprint,
    );
    if (!matching) return;
    if (matching.requestId !== completed.requestId) throw cleanupError();
    const remaining = attempts.filter(
      (attempt) => attempt.quoteFingerprint !== completed.quoteFingerprint,
    );
    if (remaining.length) {
      storage.setItem(
        QUOTE_REVISION_ATTEMPTS_STORAGE_KEY,
        JSON.stringify(remaining),
      );
    } else {
      storage.removeItem(QUOTE_REVISION_ATTEMPTS_STORAGE_KEY);
    }
    const after = parseAttempts(
      storage.getItem(QUOTE_REVISION_ATTEMPTS_STORAGE_KEY),
    );
    if (after.some((attempt) =>
      attempt.requestId === completed.requestId
      && attempt.quoteFingerprint === completed.quoteFingerprint
    )) throw cleanupError();
  } catch {
    throw cleanupError();
  }
}
