/** Canonical company activity DTO. The private native ISO-date DTO needs an
 * explicit adapter and is deliberately not accepted here. This is a historical
 * creation event; it does not describe the quote's current editable status. */
export type ConfirmedQuoteActivity = Readonly<{
  activityId: string;
  proposalId: string;
  quoteId: string;
  confirmedAt: number;
  kind: 'quote_draft_created';
  requiresHumanValidation: true;
}>;

export type ConfirmedQuoteActivityPage = Readonly<{
  organizationId: string;
  items: readonly ConfirmedQuoteActivity[];
  nextCursor: string | null;
}>;

const identifier = (value: unknown): value is string => typeof value === 'string'
  && value.length >= 1 && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(value);
const quoteId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

function exact(raw: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return null;
  const ownKeys = Reflect.ownKeys(raw);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(raw, key);
    if (!field?.enumerable || !('value' in field)) return null;
    fields[key] = field.value;
  }
  return fields;
}

/** Reject a whole inconsistent page, including cross-company retained data.
 * Copies data properties without running getters, and never infers an event
 * from workflow state or counters. The current organization is independent of
 * the retained response, so changing workspace immediately removes its rows. */
export function normalizeConfirmedQuoteActivityPage(raw: unknown, organizationId?: string): ConfirmedQuoteActivityPage | null {
  try {
    if (!identifier(organizationId)) return null;
    const page = exact(raw, ['organizationId', 'items', 'nextCursor']);
    if (!page || page.organizationId !== organizationId) return null;
    if (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor.length < 1
      || page.nextCursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(page.nextCursor))) return null;
    if (!Array.isArray(page.items) || Object.getPrototypeOf(page.items) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(page.items, 'length')?.value as unknown;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length > 50
      || Reflect.ownKeys(page.items).length !== length + 1) return null;
    const items: ConfirmedQuoteActivity[] = [];
    const identities = [new Map<string, string>(), new Map<string, string>(), new Map<string, string>()];
    for (let index = 0; index < length; index++) {
      const field = Object.getOwnPropertyDescriptor(page.items, String(index));
      if (!field?.enumerable || !('value' in field)) return null;
      const item = exact(field.value, ['activityId', 'proposalId', 'quoteId', 'confirmedAt', 'kind', 'requiresHumanValidation']);
      if (!item || !identifier(item.activityId) || !identifier(item.proposalId) || !quoteId(item.quoteId)
        || typeof item.confirmedAt !== 'number' || !Number.isSafeInteger(item.confirmedAt)
        || item.confirmedAt < 1 || item.confirmedAt > 253402300799
        || item.kind !== 'quote_draft_created' || item.requiresHumanValidation !== true) return null;
      const captured: ConfirmedQuoteActivity = Object.freeze({
        activityId: item.activityId, proposalId: item.proposalId, quoteId: item.quoteId,
        confirmedAt: item.confirmedAt, kind: 'quote_draft_created', requiresHumanValidation: true,
      });
      const tuple = JSON.stringify(captured);
      const keys = [captured.activityId, captured.proposalId, captured.quoteId];
      for (let at = 0; at < keys.length; at++) {
        const previous = identities[at].get(keys[at]);
        if (previous !== undefined && previous !== tuple) return null;
      }
      if (!identities[0].has(captured.activityId)) items.push(captured);
      keys.forEach((key, at) => identities[at].set(key, tuple));
    }
    return Object.freeze({ organizationId, items: Object.freeze(items), nextCursor: page.nextCursor as string | null });
  } catch {
    return null;
  }
}

export function confirmedQuoteActivityKey(organizationId: string, proposalId: string): string {
  return JSON.stringify(['quote', organizationId, proposalId]);
}

const copy = {
  fr: { filter: 'Devis', prepared: 'Devis préparé', open: 'Ouvrir le devis', unavailable: 'Activité des devis indisponible' },
  de: { filter: 'Offerten', prepared: 'Offerte vorbereitet', open: 'Offerte öffnen', unavailable: 'Offertenaktivität nicht verfügbar' },
  it: { filter: 'Preventivi', prepared: 'Preventivo preparato', open: 'Apri preventivo', unavailable: 'Attività dei preventivi non disponibile' },
  en: { filter: 'Quotes', prepared: 'Quote prepared', open: 'Open quote', unavailable: 'Quote activity unavailable' },
} as const;

export function confirmedQuoteActivityCopy(language: string) {
  return copy[language as keyof typeof copy] ?? copy.fr;
}
