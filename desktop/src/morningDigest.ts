// Résumé du matin : quand l'utilisateur l'active, l'app envoie au serveur le
// nombre de cartes « À valider » et leurs titres (huit au plus). Le serveur
// les envoie par e-mail à 7 h. Rien d'autre ne quitte l'appareil.

export type MorningDigestItem = { title: string; detail: string };
export type MorningDigestInput = { enabled: boolean; locale: 'fr' | 'de' | 'it' | 'en'; timeZone: string; count: number; items: MorningDigestItem[] };
export type MorningDigestState = { enabled: boolean; emailConfigured: boolean; pushConfigured: boolean; lastSentOn: string | null };

const KEY = 'zentra.autopilot.digest.v1';
const MAX_ITEMS = 8;
/** Même contenu : renvoyé au plus toutes les 6 heures pour rester à jour la veille au soir. */
const REFRESH_MS = 6 * 3_600_000;

const clean = (value: string, max: number) => [...value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('');

export function digestInput(cards: readonly { title: string; detail?: string }[], locale: string, timeZone: string, enabled = true): MorningDigestInput {
  const language = (['fr', 'de', 'it', 'en'] as const).find((value) => locale.toLowerCase().startsWith(value)) ?? 'fr';
  const items = enabled ? cards.map((card) => ({ title: clean(card.title, 200), detail: clean(card.detail ?? '', 300) })).filter((item) => item.title).slice(0, MAX_ITEMS) : [];
  return { enabled, locale: language, timeZone: /^[A-Za-z0-9/_+-]{1,64}$/.test(timeZone) ? timeZone : 'Europe/Zurich', count: enabled ? Math.min(cards.length, 999) : 0, items };
}

export function digestSignature(input: MorningDigestInput): string {
  return JSON.stringify([input.enabled, input.locale, input.timeZone, input.count, input.items]);
}

export type SavedDigest = { enabled: boolean; signature?: string; sentAt?: number; emailConfigured?: boolean; lastSentOn?: string | null };
type Saved = SavedDigest;

export function savedDigest(organizationId: string): Saved {
  try {
    const value = (JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Saved>)[organizationId];
    return value && typeof value.enabled === 'boolean' ? value : { enabled: false };
  } catch {
    return { enabled: false };
  }
}

export function saveDigest(organizationId: string, value: Saved): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Saved>;
    all[organizationId] = value;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Renvoyé à la prochaine ouverture.
  }
}

/** Faut-il renvoyer le résumé ? Seulement s'il a changé, ou après 6 heures. */
export function digestDue(saved: Saved, signature: string, now: number): boolean {
  if (!saved.enabled) return false;
  return saved.signature !== signature || !saved.sentAt || now - saved.sentAt >= REFRESH_MS;
}
