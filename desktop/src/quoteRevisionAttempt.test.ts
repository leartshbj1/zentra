import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: ((value: unknown) => void) | null = null;
  },
  invoke: invokeMock,
}));

import {
  clearQuoteRevisionAttempt,
  prepareQuoteRevisionAttempt,
  QUOTE_REVISION_ATTEMPTS_STORAGE_KEY,
} from './quoteRevisionAttempt';
import { desktopApi } from './bridge';

const quoteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requestId = '11111111-1111-4111-8111-111111111111';

describe('reprise idempotente d’une révision de devis', () => {
  it('réutilise le même requestId après double clic ou rechargement', async () => {
    const storage = memoryStorage();
    const factory = vi.fn(() => requestId);
    const first = await prepareQuoteRevisionAttempt(quoteId, factory, storage);
    const afterReload = await prepareQuoteRevisionAttempt(quoteId, factory, storage);

    expect(afterReload).toEqual(first);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(storage.getItem(QUOTE_REVISION_ATTEMPTS_STORAGE_KEY)).not.toContain(quoteId);
  });

  it('conserve séparément les réponses perdues de plusieurs devis', async () => {
    const storage = memoryStorage();
    const factory = vi
      .fn()
      .mockReturnValueOnce(requestId)
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const first = await prepareQuoteRevisionAttempt(quoteId, factory, storage);
    const second = await prepareQuoteRevisionAttempt(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      factory,
      storage,
    );

    clearQuoteRevisionAttempt(second, storage);
    expect(await prepareQuoteRevisionAttempt(quoteId, factory, storage)).toEqual(first);
  });

  it('bloque l’envoi si le marqueur ne peut pas être persisté', async () => {
    const storage = memoryStorage();
    storage.setItem = () => { throw new Error('quota'); };

    await expect(
      prepareQuoteRevisionAttempt(quoteId, () => requestId, storage),
    ).rejects.toThrow('aucun devis n’a été créé');
  });

  it('garde le marqueur et signale un nettoyage post-commit impossible', async () => {
    const storage = memoryStorage();
    const attempt = await prepareQuoteRevisionAttempt(
      quoteId,
      () => requestId,
      storage,
    );
    storage.removeItem = () => { throw new Error('verrouillé'); };

    expect(() => clearQuoteRevisionAttempt(attempt, storage)).toThrow(
      'La révision est déjà créée',
    );
    expect(await prepareQuoteRevisionAttempt(quoteId, () => requestId, storage)).toEqual(
      attempt,
    );
  });

  it('transmet le requestId stable séparément du devis au pont Tauri', async () => {
    invokeMock.mockReset();
    invokeMock
      .mockResolvedValueOnce({ revision: { id: 'revision-1' } })
      .mockResolvedValueOnce({});

    await desktopApi.createQuoteRevision(requestId, quoteId);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'create_quote_revision', {
      requestId,
      id: quoteId,
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
