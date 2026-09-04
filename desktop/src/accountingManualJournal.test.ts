import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: ((value: unknown) => void) | null = null;
  },
  invoke: invokeMock,
}));

import {
  clearManualJournalAttempt,
  loadManualJournalAttempt,
  MANUAL_JOURNAL_ATTEMPT_STORAGE_KEY,
  prepareManualJournalAttempt,
} from './accountingManualJournal';
import { desktopApi } from './bridge';

const submission = {
  entryDate: '2026-09-04',
  description: 'Régularisation contrôlée',
  lines: [
    {
      accountId: 'bank',
      debitCents: 10_000,
      creditCents: 0,
      memo: 'Débit',
    },
    {
      accountId: 'revenue',
      debitCents: 0,
      creditCents: 10_000,
      memo: 'Crédit',
    },
  ],
};

describe('reprise de saisie comptable manuelle', () => {
  it('conserve le requestId après une réponse perdue pour le même contenu', async () => {
    const storage = memoryStorage();
    const requestIdFactory = vi
      .fn()
      .mockReturnValue('11111111-1111-4111-8111-111111111111');
    const first = await prepareManualJournalAttempt(
      null,
      submission,
      requestIdFactory,
      storage,
    );
    const replay = await prepareManualJournalAttempt(
      first,
      structuredClone(submission),
      requestIdFactory,
      storage,
    );

    expect(replay.requestId).toBe(first.requestId);
    expect(requestIdFactory).toHaveBeenCalledTimes(1);

    const normalizedReplay = await prepareManualJournalAttempt(
      replay,
      { ...submission, description: ` ${submission.description} ` },
      requestIdFactory,
      storage,
    );
    expect(normalizedReplay.requestId).toBe(first.requestId);
    expect(requestIdFactory).toHaveBeenCalledTimes(1);

  });

  it('bloque une saisie modifiée après réponse perdue ou rechargement', async () => {
    const storage = memoryStorage();
    const requestIdFactory = vi.fn(
      () => '11111111-1111-4111-8111-111111111111',
    );
    const first = await prepareManualJournalAttempt(
      null,
      submission,
      requestIdFactory,
      storage,
    );

    await expect(
      prepareManualJournalAttempt(
        null,
        { ...submission, description: 'Saisie modifiée après réponse perdue' },
        requestIdFactory,
        storage,
      ),
    ).rejects.toThrow('peut déjà être comptabilisée');
    expect(loadManualJournalAttempt(storage)).toEqual(first);
    expect(requestIdFactory).toHaveBeenCalledTimes(1);
  });

  it('restaure le requestId après reload sans persister les données comptables', async () => {
    const storage = memoryStorage();
    const requestIdFactory = vi.fn(() => '11111111-1111-4111-8111-111111111111');
    const first = await prepareManualJournalAttempt(
      null,
      submission,
      requestIdFactory,
      storage,
    );

    const persisted = storage.getItem(MANUAL_JOURNAL_ATTEMPT_STORAGE_KEY);
    expect(persisted).not.toContain(submission.description);
    expect(persisted).not.toContain(submission.lines[0].accountId);
    expect(JSON.parse(persisted || '{}')).toEqual({
      requestId: first.requestId,
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const restoredAfterReload = loadManualJournalAttempt(storage);
    const replay = await prepareManualJournalAttempt(
      restoredAfterReload,
      structuredClone(submission),
      requestIdFactory,
      storage,
    );
    expect(replay.requestId).toBe(first.requestId);
    expect(requestIdFactory).toHaveBeenCalledTimes(1);

    clearManualJournalAttempt(replay, storage);
    expect(loadManualJournalAttempt(storage)).toBeNull();
  });

  it('refuse l’envoi si la tentative ne peut pas être persistée', async () => {
    const storage = memoryStorage();
    storage.setItem = () => { throw new Error('quota'); };

    await expect(prepareManualJournalAttempt(
      null,
      submission,
      () => '11111111-1111-4111-8111-111111111111',
      storage,
    )).rejects.toThrow('n’a pas été envoyée');
  });

  it('refuse un nouveau requestId si le marqueur persistant est corrompu', async () => {
    const storage = memoryStorage();
    const requestIdFactory = vi.fn(
      () => '11111111-1111-4111-8111-111111111111',
    );
    storage.setItem(MANUAL_JOURNAL_ATTEMPT_STORAGE_KEY, '{illisible');

    await expect(
      prepareManualJournalAttempt(null, submission, requestIdFactory, storage),
    ).rejects.toThrow('marqueur de reprise comptable est illisible');
    expect(requestIdFactory).not.toHaveBeenCalled();
    expect(storage.getItem(MANUAL_JOURNAL_ATTEMPT_STORAGE_KEY)).toBe('{illisible');
  });

  it('signale explicitement un marqueur post-commit impossible à supprimer', async () => {
    const storage = memoryStorage();
    const attempt = await prepareManualJournalAttempt(
      null,
      submission,
      () => '11111111-1111-4111-8111-111111111111',
      storage,
    );
    storage.removeItem = () => { throw new Error('verrouillé'); };

    expect(() => clearManualJournalAttempt(attempt, storage)).toThrow(
      'L’écriture est déjà comptabilisée',
    );
    expect(loadManualJournalAttempt(storage)).toEqual(attempt);
  });

  it('transmet le requestId séparément du contenu comptable à Tauri', async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});

    await desktopApi.postManualJournalEntry({
      ...submission,
      requestId: '11111111-1111-4111-8111-111111111111',
    });

    expect(invokeMock).toHaveBeenCalledWith('post_manual_journal_entry', {
      requestId: '11111111-1111-4111-8111-111111111111',
      input: {
        entry_date: '2026-09-04',
        description: 'Régularisation contrôlée',
        currency: 'CHF',
        lines: [
          expect.objectContaining({
            account_id: 'bank',
            debit_cents: 10_000,
            credit_cents: 0,
          }),
          expect.objectContaining({
            account_id: 'revenue',
            debit_cents: 0,
            credit_cents: 10_000,
          }),
        ],
      },
    });
  });
});

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}
