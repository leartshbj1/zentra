import { useSyncExternalStore } from 'react';
import { languageAssets } from 'virtual:zentra-language-assets';
import { diagnosticOperation, recordDiagnostic } from './diagnostics';

export const appLanguages = ['fr', 'de', 'it', 'en'] as const;
export type AppLanguage = typeof appLanguages[number];
export type InterfaceMessage = { source: string; values?: Record<string, string | number> };
export const languageNames: Record<AppLanguage, string> = { fr:'Français', de:'Deutsch', it:'Italiano', en:'English' };
export const languageStorageKey = 'zentra.interface.language.v1';
const locales: Record<AppLanguage, string> = { fr:'fr-CH', de:'de-CH', it:'it-CH', en:'en-CH' };
export function parseLanguage(value: unknown): AppLanguage | null { return appLanguages.includes(value as AppLanguage) ? value as AppLanguage : null; }
function storedLanguage(): AppLanguage { try { return parseLanguage(localStorage.getItem(languageStorageKey)) ?? 'fr'; } catch { return 'fr'; } }
const initialLanguage = storedLanguage();
let current: AppLanguage = 'fr';
type LanguageState = { language: AppLanguage; pending: AppLanguage | null; failed: AppLanguage | null; persisted: boolean | null; ready: boolean };
let state: LanguageState = { language: current, pending: null, failed: null, persisted: null, ready: initialLanguage === 'fr' };
const packs = new Map<AppLanguage, Readonly<Record<string, string>>>();
const loading = new Map<AppLanguage, Promise<void>>();
let request = 0;
const listeners = new Set<() => void>();
function publish(patch: Partial<LanguageState>) {
  state = { ...state, ...patch };
  current = state.language;
  if (typeof document !== 'undefined') document.documentElement.lang = locales[state.ready ? current : initialLanguage];
  for (const listener of listeners) listener();
}
if (typeof document !== 'undefined') document.documentElement.lang = locales[initialLanguage];

async function loadLanguage(language: AppLanguage): Promise<void> {
  if (language === 'fr' || packs.has(language)) return;
  const existing = loading.get(language);
  if (existing) return existing;
  const task = diagnosticOperation('app', 'language.pack_read', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      // These URLs point to packaged assets on the same origin, never a translation service.
      const response = await fetch(languageAssets[language], { signal: controller.signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error('Language asset unavailable');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length ||
        Object.values(data).some(value => typeof value !== 'string' || !value.trim())) throw new Error('Invalid language asset');
      packs.set(language, Object.freeze(data as Record<string, string>));
    } finally { clearTimeout(timeout); }
  });
  loading.set(language, task);
  try { await task; } finally { if (loading.get(language) === task) loading.delete(language); }
}

async function selectLanguage(language: AppLanguage, persist: boolean): Promise<boolean> {
  const id = ++request;
  publish({ pending: language, failed: null, persisted: null });
  try { await loadLanguage(language); }
  catch (error) {
    if (id !== request) return false;
    publish({ pending: null, failed: language });
    throw error;
  }
  // A slower previous choice must never overwrite the most recent one or its saved preference.
  if (id !== request) return false;
  let persisted = true;
  if (persist) {
    const incident = recordDiagnostic({ area: 'app', operation: 'language.preference_write', phase: 'start' });
    try {
      localStorage.setItem(languageStorageKey, language);
      recordDiagnostic({ id: incident, area: 'app', operation: 'language.preference_write', phase: 'success' });
    } catch {
      persisted = false;
      recordDiagnostic({ id: incident, area: 'app', operation: 'language.preference_write', phase: 'failure', errorCode: 'STORAGE' });
    }
  }
  publish({ language, pending: null, failed: null, persisted: persist ? persisted : null, ready: true });
  return persisted;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', event => {
    if (event.key === languageStorageKey || event.key === null) void selectLanguage(storedLanguage(), false).catch(() => { /* Shared state offers retry. */ });
  });
}
export function getAppLanguage(): AppLanguage { return current; }
export function getAppLocale(): string { return locales[current]; }
export function getLanguageState(): LanguageState { return state; }
export async function initializeAppLanguage(): Promise<void> {
  if (state.ready) return;
  await selectLanguage(initialLanguage, false);
}
export async function setAppLanguage(value: AppLanguage): Promise<boolean> {
  const language = parseLanguage(value); if (!language) return false;
  return selectLanguage(language, true);
}
export function useLanguageState(): LanguageState {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, getLanguageState, getLanguageState);
}
export function useAppLanguage(): AppLanguage {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, getAppLanguage, () => 'fr');
}
/** Only pass interface messages. Customer names, notes, amounts and document contents stay verbatim. */
export function t(source: string, values?: Record<string, string | number>, language: AppLanguage = current): string {
  const trimmed = source.trim();
  if (!trimmed) return source;
  const dictionary = packs.get(language);
  const translated = language !== 'fr' && dictionary && Object.hasOwn(dictionary, trimmed) ? dictionary[trimmed] : trimmed;
  const message = values ? translated.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, key: string) => Object.hasOwn(values,key) ? String(values[key]) : placeholder) : translated;
  return (source.match(/^\s*/)?.[0] ?? '') + message + (source.match(/\s*$/)?.[0] ?? '');
}
