import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_OPEN_TIMEOUT_MS, withinAppOpeningDeadline } from './appOpening';

afterEach(() => { vi.useRealTimers(); });

describe('ouverture de l’espace local', () => {
  it('rend immédiatement les données disponibles et libère son délai', async () => {
    vi.useFakeTimers();
    await expect(withinAppOpeningDeadline(Promise.resolve('espace'))).resolves.toBe('espace');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('conserve l’erreur native et libère son délai', async () => {
    vi.useFakeTimers();
    const reason = new Error('Base locale inaccessible');
    await expect(withinAppOpeningDeadline(Promise.reject(reason))).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('termine un appel bloqué et ignore sa réponse tardive', async () => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    const result = withinAppOpeningDeadline(new Promise<string>((resolve) => { finish = resolve; }));
    const failed = expect(result).rejects.toThrow('L’ouverture prend trop de temps');
    await vi.advanceTimersByTimeAsync(APP_OPEN_TIMEOUT_MS);
    await failed;
    finish('ancien espace');
    await expect(result).rejects.toThrow('Réessayez');
    expect(vi.getTimerCount()).toBe(0);
  });
});
