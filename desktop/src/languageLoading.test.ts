import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translations } from './translations';
import { languageAssets } from 'virtual:zentra-language-assets';
import { interfaceKeys } from 'virtual:zentra-language-keys';

const key = 'zentra.interface.language.v1';
let saved: Map<string, string>;
let storageListener: (event: { key: string | null }) => void;
function response(language: 'de' | 'it' | 'en') {
  const index = ['de','it','en'].indexOf(language);
  return new Response(JSON.stringify(Object.fromEntries(Object.entries(translations).map(([source, targets]) => [source, targets[index]]))));
}
beforeEach(() => {
  vi.resetModules(); saved = new Map();
  vi.stubGlobal('localStorage', { getItem: (name: string) => saved.get(name) ?? null, setItem: (name: string, value: string) => saved.set(name, value) });
  vi.stubGlobal('document', { documentElement: { lang: '' } });
  vi.stubGlobal('window', { addEventListener: (_: string, listener: typeof storageListener) => { storageListener = listener; } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('packaged language loading', () => {
  it('opens French without fetching another language', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const language = await import('./language'); await language.initializeAppLanguage();
    expect(language.getLanguageState().ready).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
  it('waits for the stored language before making the app ready and only loads that pack', async () => {
    saved.set(key, 'de'); let finish!: (response: Response) => void;
    const fetch = vi.fn((_url: string) => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetch);
    const language = await import('./language'); const boot = language.initializeAppLanguage();
    expect(language.getLanguageState().ready).toBe(false); expect(document.documentElement.lang).toBe('de-CH');
    finish(response('de')); await boot;
    expect(language.getAppLanguage()).toBe('de'); expect(language.t('Factures')).toBe('Rechnungen');
    expect(language.getLanguageState().ready).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(languageAssets.de);
  });
  it('preserves the previous language and saved choice on a read error, then retries without reloading', async () => {
    saved.set(key, 'fr'); const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(response('it')); vi.stubGlobal('fetch', fetch);
    const language = await import('./language');
    await expect(language.setAppLanguage('it')).rejects.toThrow();
    expect(language.getAppLanguage()).toBe('fr'); expect(saved.get(key)).toBe('fr');
    expect(language.getLanguageState().failed).toBe('it');
    await language.setAppLanguage('it'); expect(language.t('Factures')).toBe('Fatture'); expect(saved.get(key)).toBe('it');
    expect(language.getLanguageState().failed).toBeNull(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps only the latest selection when a previous pack finishes later', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })).mockResolvedValueOnce(response('en')));
    const language = await import('./language'); const older = language.setAppLanguage('de');
    await language.setAppLanguage('en'); finish(response('de')); await older;
    expect(language.getAppLanguage()).toBe('en'); expect(saved.get(key)).toBe('en'); expect(document.documentElement.lang).toBe('en-CH');
  });
  it('shares an in-flight read and caches a successful pack for later changes', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetch);
    const language = await import('./language'); const first = language.setAppLanguage('de'), second = language.setAppLanguage('de');
    finish(response('de')); await Promise.all([first, second]);
    await language.setAppLanguage('fr'); await language.setAppLanguage('de'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('allows an explicit French fallback if the stored language fails during startup', async () => {
    saved.set(key, 'de'); vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('read failed')));
    const language = await import('./language'); await expect(language.initializeAppLanguage()).rejects.toThrow();
    expect(language.getLanguageState().ready).toBe(false); expect(saved.get(key)).toBe('de');
    await language.setAppLanguage('fr'); expect(language.getLanguageState().ready).toBe(true);
    expect(saved.get(key)).toBe('fr'); expect(language.getLanguageState().failed).toBeNull();
  });
  it('ends a stalled read and allows the next attempt instead of leaving the controls busy', async () => {
    const language = await import('./language'); vi.useFakeTimers();
    const fetch = vi.fn().mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })).mockResolvedValueOnce(response('en')); vi.stubGlobal('fetch', fetch);
    const attempt = expect(language.setAppLanguage('en')).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(12_000); await attempt;
    expect(language.getLanguageState().pending).toBeNull(); expect(language.getAppLanguage()).toBe('fr');
    await language.setAppLanguage('en'); expect(language.getAppLanguage()).toBe('en');
  });
  it.each([null, [], {}, { Factures: 7 }, { Factures: '' }])('rejects invalid pack data without changing the selected language: %j', async data => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data))));
    const language = await import('./language'); await expect(language.setAppLanguage('en')).rejects.toThrow('Invalid language asset');
    expect(language.getAppLanguage()).toBe('fr'); expect(saved.has(key)).toBe(false);
  });
  it('uses the latest cross-window preference without rewriting storage', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const language = await import('./language'); const selection = language.setAppLanguage('de');
    saved.set(key, 'fr'); storageListener({ key }); await Promise.resolve();
    finish(response('de')); await selection;
    expect(language.getAppLanguage()).toBe('fr'); expect(saved.get(key)).toBe('fr');
  });
  it('reports cross-window read failures and does not emit an unhandled rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('read failed')));
    const language = await import('./language'); saved.set(key, 'en'); storageListener({ key });
    await vi.waitFor(() => expect(language.getLanguageState().failed).toBe('en'));
    expect(language.getAppLanguage()).toBe('fr'); expect(language.getLanguageState().ready).toBe(true);
  });
  it('does not accept prototype names as translated interface messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('en')));
    const language = await import('./language'); await language.setAppLanguage('en');
    expect(language.t('toString')).toBe('toString'); expect(language.t('__proto__')).toBe('__proto__');
  });
  it('preserves every authored key for safe native error handling without shipping all translations as JS', () => {
    expect([...interfaceKeys]).toEqual(Object.keys(translations));
    expect(interfaceKeys.has('SQLITE_BUSY: database locked')).toBe(false);
  });
});
