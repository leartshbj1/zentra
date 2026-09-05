import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_OPEN_TIMEOUT_MS, NATIVE_READY_EVENT, waitForNativeStartup, withinAppOpeningDeadline } from './appOpening';

afterEach(() => { vi.useRealTimers(); });

describe('ouverture de l’espace local', () => {
  it('retrouve un moteur prêt quand le signal initial est absent', async () => {
    vi.useFakeTimers();
    const target = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {}, __ZENTRA_NATIVE_READY__: false });
    const probe = vi.fn().mockResolvedValue(true);
    const finished = vi.fn();
    void waitForNativeStartup(target, probe).then(finished);
    await vi.advanceTimersByTimeAsync(5000);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(target.__ZENTRA_NATIVE_READY__).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reprend une sonde perdue puis ignore sa réponse tardive', async () => {
    vi.useFakeTimers();
    const target = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {}, __ZENTRA_NATIVE_READY__: false });
    let late!: (ready: boolean) => void;
    const probe = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { late = resolve; })).mockResolvedValue(true);
    const finished = vi.fn();
    const pending = waitForNativeStartup(target, probe).then(finished);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(probe).toHaveBeenCalledTimes(2);
    late(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(target.__ZENTRA_NATIVE_READY__).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('attend une confirmation positive après indisponibilité et refus', async () => {
    vi.useFakeTimers();
    const target = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {}, __ZENTRA_NATIVE_READY__: false });
    const probe = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('Passerelle en cours d’ouverture')).mockResolvedValue(true);
    const finished = vi.fn();
    const pending = waitForNativeStartup(target, probe).then(finished);
    await vi.advanceTimersByTimeAsync(2000);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(probe).toHaveBeenCalledTimes(3);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('arrête les sondes au délai global et ne valide pas une ancienne sonde', async () => {
    vi.useFakeTimers();
    const target = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {}, __ZENTRA_NATIVE_READY__: false });
    const callbacks: Array<(ready: boolean) => void> = [];
    const probe = vi.fn().mockImplementation(() => new Promise<boolean>(resolve => { callbacks.push(resolve); }));
    const expired = expect(waitForNativeStartup(target, probe)).rejects.toThrow('Réessayez');
    await vi.advanceTimersByTimeAsync(APP_OPEN_TIMEOUT_MS);
    await expired;
    const count = probe.mock.calls.length;
    callbacks.forEach(resolve => resolve(true));
    await vi.advanceTimersByTimeAsync(APP_OPEN_TIMEOUT_MS);
    expect(target.__ZENTRA_NATIVE_READY__).toBe(false);
    expect(probe).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
    await expect(waitForNativeStartup(Object.assign(target, { __ZENTRA_NATIVE_READY__: true }), probe)).resolves.toBeUndefined();
  });

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
