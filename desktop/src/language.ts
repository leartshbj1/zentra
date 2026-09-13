import { useSyncExternalStore } from 'react';
import { translations } from './translations';

export const appLanguages = ['fr', 'de', 'it', 'en'] as const;
export type AppLanguage = typeof appLanguages[number];
export const languageNames: Record<AppLanguage, string> = { fr:'Français', de:'Deutsch', it:'Italiano', en:'English' };
export const languageStorageKey = 'zentra.interface.language.v1';
const locales: Record<AppLanguage, string> = { fr:'fr-CH', de:'de-CH', it:'it-CH', en:'en-CH' };
export function parseLanguage(value: unknown): AppLanguage | null { return appLanguages.includes(value as AppLanguage) ? value as AppLanguage : null; }
function storedLanguage(): AppLanguage { try { return parseLanguage(localStorage.getItem(languageStorageKey)) ?? 'fr'; } catch { return 'fr'; } }
let current = storedLanguage();
const listeners = new Set<() => void>();
function publish(language: AppLanguage) {
  current = language;
  if (typeof document !== 'undefined') document.documentElement.lang = locales[language];
  for (const listener of listeners) listener();
}
if (typeof document !== 'undefined') {
  document.documentElement.lang = locales[current];
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', event => { if (event.key === languageStorageKey || event.key === null) publish(storedLanguage()); });
}
export function getAppLanguage(): AppLanguage { return current; }
export function getAppLocale(): string { return locales[current]; }
export function setAppLanguage(value: AppLanguage): boolean {
  const language = parseLanguage(value); if (!language) return false;
  let persisted = true;
  try { localStorage.setItem(languageStorageKey, language); } catch { persisted = false; }
  publish(language); return persisted;
}
export function useAppLanguage(): AppLanguage {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, getAppLanguage, () => 'fr');
}
/** Only pass interface messages. Customer names, notes, amounts and document contents stay verbatim. */
export function t(source: string, values?: Record<string, string | number>, language: AppLanguage = current): string {
  const trimmed = source.trim();
  if (!trimmed) return source;
  const entry = translations[trimmed];
  const translated = language === 'fr' || !entry ? trimmed : entry[language === 'de' ? 0 : language === 'it' ? 1 : 2];
  const message = values ? translated.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, key: string) => Object.hasOwn(values,key) ? String(values[key]) : placeholder) : translated;
  return (source.match(/^\s*/)?.[0] ?? '') + message + (source.match(/\s*$/)?.[0] ?? '');
}
