import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { languageAssets } from 'virtual:zentra-language-assets';

const nativeInvoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeInvoke }));
const languageKey = 'zentra.interface.language.v1';
const privateText = 'customer@example.ch password=synthetic-secret /private/customer/document.pdf';
let stored: Map<string, string>;
const pack = () => new Response(JSON.stringify({ Factures: 'Invoices' }));
const api = async () => ({ language: await import('./language'), diagnostics: await import('./diagnostics') });
beforeEach(() => {
  vi.resetModules(); nativeInvoke.mockReset(); stored = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  vi.stubGlobal('document', { documentElement: { lang: '' } });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('private language operation diagnostics', () => {
  it('records one pack read shared by concurrent selections and no new read for the cached pack', async () => {
    let finish!: (value: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetch);
    const { language, diagnostics } = await api();
    const first = language.setAppLanguage('en'), second = language.setAppLanguage('en');
    finish(pack()); await Promise.all([first, second]);
    await language.setAppLanguage('fr'); await language.setAppLanguage('en');
    expect(fetch).toHaveBeenCalledTimes(1);
    const read = diagnostics.recentDiagnosticEvents().filter(event => event.operation === 'language.pack_read');
    expect(read.map(event => event.phase)).toEqual(['start', 'success']);
    expect(read[0].id).toBe(read[1].id);
    expect(read[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(diagnostics.recentDiagnosticEvents())).not.toContain(languageAssets.en);
    expect(nativeInvoke).not.toHaveBeenCalled();
  });
  it('retains the original read error, records its incident and permits a distinct explicit retry', async () => {
    const original = new Error(`network failure ${privateText}`);
    const fetch = vi.fn().mockRejectedValueOnce(original).mockResolvedValueOnce(pack()); vi.stubGlobal('fetch', fetch);
    const { language, diagnostics } = await api();
    await expect(language.setAppLanguage('en')).rejects.toBe(original);
    expect(language.getAppLanguage()).toBe('fr'); expect(stored.has(languageKey)).toBe(false);
    const first = diagnostics.recentDiagnosticEvents();
    expect(first.map(event => [event.operation, event.phase])).toEqual([['language.pack_read', 'start'], ['language.pack_read', 'failure']]);
    expect(first[0].id).toBe(first[1].id); expect(first[1].errorCode).toBe('NETWORK');
    expect(diagnostics.resolveErrorIncident(original).code).toBe(`ZT-${first[1].id}`);
    expect(await language.setAppLanguage('en')).toBe(true);
    const reads = diagnostics.recentDiagnosticEvents().filter(event => event.operation === 'language.pack_read');
    expect(reads.map(event => event.phase)).toEqual(['start', 'failure', 'start', 'success']);
    expect(reads[2].id).not.toBe(reads[0].id); expect(reads[2].id).toBe(reads[3].id);
    expect(JSON.stringify(diagnostics.recentDiagnosticEvents())).not.toMatch(/customer|password|synthetic-secret|private|document\.pdf/);
  });
  it('diagnoses malformed packaged content without storing the content or changing the selected language', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ secret: { value: privateText } }))));
    const { language, diagnostics } = await api();
    await expect(language.setAppLanguage('en')).rejects.toThrow('Invalid language asset');
    expect(language.getAppLanguage()).toBe('fr'); expect(stored.size).toBe(0);
    const events = diagnostics.recentDiagnosticEvents();
    expect(events.map(event => [event.operation, event.phase])).toEqual([['language.pack_read', 'start'], ['language.pack_read', 'failure']]);
    expect(JSON.stringify(events)).not.toMatch(/secret|customer|password|private|document\.pdf/);
  });
  it('ends and diagnoses a stalled local read once without blocking the next attempt', async () => {
    vi.useFakeTimers();
    const original = new Error(`aborted ${privateText}`);
    const fetch = vi.fn().mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(original));
    })).mockResolvedValueOnce(pack()); vi.stubGlobal('fetch', fetch);
    const { language, diagnostics } = await api();
    const attempt = expect(language.setAppLanguage('en')).rejects.toBe(original);
    await vi.advanceTimersByTimeAsync(12_000); await attempt;
    expect(language.getLanguageState().pending).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    expect(diagnostics.recentDiagnosticEvents().map(event => event.phase)).toEqual(['start', 'failure']);
    expect(await language.setAppLanguage('en')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(diagnostics.recentDiagnosticEvents())).not.toMatch(/customer|password|synthetic-secret|private|document\.pdf/);
  });
  it('reports preference storage failure while keeping the new session language usable', async () => {
    const original = new Error(`disk full ${privateText}`);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw original; } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pack()));
    const { language, diagnostics } = await api();
    expect(await language.setAppLanguage('en')).toBe(false);
    expect(language.getAppLanguage()).toBe('en'); expect(language.getLanguageState().persisted).toBe(false);
    const writes = diagnostics.recentDiagnosticEvents().filter(event => event.operation === 'language.preference_write');
    expect(writes.map(event => event.phase)).toEqual(['start', 'failure']);
    expect(writes[0].id).toBe(writes[1].id); expect(writes[1].errorCode).toBe('STORAGE');
    expect(JSON.stringify(diagnostics.recentDiagnosticEvents())).not.toMatch(/customer|password|synthetic-secret|private|document\.pdf/);
  });
  it('logs an explicit French preference without fetching and records successful persistence', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { language, diagnostics } = await api();
    await language.initializeAppLanguage(); expect(diagnostics.recentDiagnosticEvents()).toHaveLength(0);
    expect(await language.setAppLanguage('fr')).toBe(true);
    expect(fetch).not.toHaveBeenCalled(); expect(stored.get(languageKey)).toBe('fr');
    const events = diagnostics.recentDiagnosticEvents();
    expect(events.map(event => [event.operation, event.phase])).toEqual([['language.preference_write', 'start'], ['language.preference_write', 'success']]);
    expect(events[0].id).toBe(events[1].id);
  });
  it('does not write a preference during startup and diagnoses only its packaged read', async () => {
    stored.set(languageKey, 'en'); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pack()));
    const { language, diagnostics } = await api();
    await language.initializeAppLanguage();
    expect(language.getLanguageState().ready).toBe(true);
    expect(diagnostics.recentDiagnosticEvents().map(event => [event.operation, event.phase])).toEqual([['language.pack_read', 'start'], ['language.pack_read', 'success']]);
  });
});
