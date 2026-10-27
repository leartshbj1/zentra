import { useCallback, useEffect, useState } from 'react';

/**
 * Ce que la personne a déjà ouvert dans Autopilote, sur cet appareil. Un
 * élément arrivé de l'extérieur (demande de devis par e-mail, brouillon déposé
 * par l'API ou un assistant MCP, paiement annoncé) reste « Nouveau » tant
 * qu'il n'a pas été ouvert, trois jours au plus. Présentation seulement :
 * rien ne change dans les données de l'entreprise.
 */

const KEY = 'zentra.autopilot.seen.v1';
const EVENT = 'zentra-autopilot-seen';
const FOCUS_EVENT = 'zentra-autopilot-focus';
/** Au-delà, un élément n'est plus une nouveauté, même jamais ouvert. */
export const FRESH_SECONDS = 3 * 86_400;
const KEEP_SECONDS = 30 * 86_400;
const MAX_IDS = 800;

export type SeenMap = Readonly<Record<string, number>>;

function readAll(): Record<string, Record<string, number>> {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}');
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
}

export function seenItems(organizationId: string): SeenMap {
  const map = readAll()[organizationId];
  return map && typeof map === 'object' ? map : {};
}

/** Marque des éléments comme vus (ouverts) ; les plus anciens repères sont oubliés. */
export function markSeen(organizationId: string, ids: readonly string[], now = Date.now()): void {
  const current = seenItems(organizationId);
  const fresh = ids.filter((id) => !current[id]);
  if (!fresh.length) return;
  const seconds = Math.floor(now / 1000);
  const kept = Object.entries({ ...current, ...Object.fromEntries(fresh.map((id) => [id, seconds])) })
    .filter(([, at]) => seconds - at < KEEP_SECONDS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_IDS);
  try {
    const all = readAll();
    all[organizationId] = Object.fromEntries(kept);
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Repère de cet appareil seulement : sans stockage, tout reste simplement « Nouveau ».
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: organizationId }));
}

/** Arrivé il y a moins de trois jours et jamais ouvert. */
export function isFresh(id: string, at: number | undefined, seen: SeenMap, now = Date.now()): boolean {
  return typeof at === 'number' && at > 0 && !seen[id] && now / 1000 - at < FRESH_SECONDS;
}

/** Les éléments vus, relus quand une autre partie de l'app en marque. */
export function useAutopilotSeen(organizationId: string | null | undefined) {
  const [seen, setSeen] = useState<SeenMap>(() => (organizationId ? seenItems(organizationId) : {}));
  useEffect(() => {
    if (!organizationId) { setSeen({}); return; }
    const read = () => setSeen(seenItems(organizationId));
    read();
    const onChange = (event: Event) => { if ((event as CustomEvent).detail === organizationId) read(); };
    window.addEventListener(EVENT, onChange);
    window.addEventListener('storage', read);
    return () => { window.removeEventListener(EVENT, onChange); window.removeEventListener('storage', read); };
  }, [organizationId]);
  const mark = useCallback((ids: readonly string[]) => { if (organizationId) markSeen(organizationId, ids); }, [organizationId]);
  return { seen, markSeen: mark };
}

/**
 * Ouvrir un élément précis d'« Aujourd'hui » depuis ailleurs (les notifications).
 * La demande attend que la page soit affichée.
 */
let pendingFocus: string | null = null;
export function requestAutopilotFocus(id: string): void {
  pendingFocus = id;
  window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: id }));
}
/** The item asked for, without forgetting it (React may render twice). */
export function peekAutopilotFocus(): string | null {
  return pendingFocus;
}
export function takeAutopilotFocus(): string | null {
  const id = pendingFocus;
  pendingFocus = null;
  return id;
}
export function onAutopilotFocus(listener: (id: string) => void): () => void {
  const handle = (event: Event) => { pendingFocus = null; listener(String((event as CustomEvent).detail)); };
  window.addEventListener(FOCUS_EVENT, handle);
  return () => window.removeEventListener(FOCUS_EVENT, handle);
}
