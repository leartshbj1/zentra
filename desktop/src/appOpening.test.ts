import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_OPEN_TIMEOUT_MS, NATIVE_READY_EVENT, waitForNativeStartup, withinAppOpeningDeadline } from './appOpening';

afterEach(() => { vi.useRealTimers(); });

describe('ouverture de l’espace local', () => {
  it('accepte un moteur déjà prêt sans attendre un nouvel événement', async () => {
    vi.useFakeTimers();
    const target = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {}, __ZENTRA_NATIVE_READY__: true });
    await expect(waitForNativeStartup(target)).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('attend le signal natif confirmé et libère son abonnement', async () => {
    vi.useFakeTimers();
    const target = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {}, __ZENTRA_NATIVE_READY__: false });
    const remove = vi.spyOn(target, 'removeEventListener');
    const finished = vi.fn();
    const pending = waitForNativeStartup(target).then(finished);
    target.dispatchEvent(new Event(NATIVE_READY_EVENT));
    await vi.advanceTimersByTimeAsync(1000);
    expect(finished).not.toHaveBeenCalled();
    target.__ZENTRA_NATIVE_READY__ = true;
    target.dispatchEvent(new Event(NATIVE_READY_EVENT));
    await pending;
    expect(finished).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('libère le signal expiré puis accepte un moteur prêt au nouvel essai', async () => {
    vi.useFakeTimers();
    const target = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {}, __ZENTRA_NATIVE_READY__: false });
    const remove = vi.spyOn(target, 'removeEventListener');
    const expired = expect(waitForNativeStartup(target)).rejects.toThrow('Réessayez');
    await vi.advanceTimersByTimeAsync(APP_OPEN_TIMEOUT_MS);
    await expired;
    expect(remove).toHaveBeenCalledTimes(1);
    target.__ZENTRA_NATIVE_READY__ = true;
    await expect(waitForNativeStartup(target)).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('laisse les interfaces de navigateur sans moteur natif démarrer', async () => {
    await expect(waitForNativeStartup(new EventTarget())).resolves.toBeUndefined();
  });

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
