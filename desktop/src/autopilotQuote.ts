import type { AutopilotReviewSuggestion } from './autopilotReview';
import type { AutopilotLineLink } from './autopilotLinks';
import { phraseQuantity } from './autopilotLinks';
import type { CatalogItem, Client, DocumentLine } from './types';

/**
 * "Créer le devis" on a request in review: the quote is written in one step,
 * with its client and lines, instead of opening the quote form.
 */

/** The lines Autopilote matched, plus the lines the person linked to an article. */
export function autopilotQuoteLines(suggestion: AutopilotReviewSuggestion, links: Readonly<Record<string, AutopilotLineLink>>,
  catalogItems: readonly CatalogItem[], newId: () => string): DocumentLine[] {
  const matched = suggestion.lines.map(line => {
    const article = catalogItems.find(row => row.id === line.articleId);
    return { id: newId(), catalogItemId: article ? article.id : null, description: line.description,
      quantity: line.quantityMilli / 1000, unit: line.unit, unitPriceCents: line.unitPriceCents, discountBp: 0, vatRateBp: line.taxRateBp };
  });
  const linked = (suggestion.unmatched ?? []).flatMap(phrase => {
    const link = links[phrase], article = link && catalogItems.find(row => row.id === link.articleId && !row.archivedAt);
    return article ? [{ id: newId(), catalogItemId: article.id, description: article.name, quantity: phraseQuantity(phrase),
      unit: article.unit, unitPriceCents: article.salesPriceCents, discountBp: 0, vatRateBp: article.vatBp }] : [];
  });
  return [...matched, ...linked];
}

const normal = (value: string | undefined | null, locale: string) => (value ?? '').trim().toLocaleLowerCase(locale);

/** The existing client for this request: same e-mail address first, else the same name or company. */
export function findAutopilotClient(clients: readonly Client[], customer: Readonly<{ name?: string; email?: string }>, locale: string): Client | undefined {
  const active = clients.filter(row => !row.archivedAt);
  const email = normal(customer.email, locale);
  if (email) { const byEmail = active.find(row => normal(row.email, locale) === email); if (byEmail) return byEmail; }
  const name = normal(customer.name, locale);
  return name ? active.find(row => [row.company, row.name, row.contactPerson].some(value => normal(value, locale) === name)) : undefined;
}

/** A client created from the request; the address can be completed later. */
export function autopilotNewClient(id: string, customer: Readonly<{ name?: string; email?: string; company?: string }>) {
  const company = customer.company?.trim() ?? '', person = customer.name?.trim() ?? '', email = customer.email?.trim() ?? '';
  const name = company || person || email;
  if (!name) return null;
  return { id, name, contactPerson: person, company, email, phone: '', addressLine1: '', addressLine2: '', postalCode: '', city: '', canton: '', country: 'CH', notes: '' };
}

/** Quotes created from a request, kept on this device so a second click opens the same quote. */
export type AutopilotCreatedQuote = Readonly<{ quoteId: string; clientId: string }>;
type Store = Record<string, Record<string, AutopilotCreatedQuote>>;
const KEY = 'zentra.autopilot.created-quotes.v1';
const MAX = 200;
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160;
function read(): Store {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Store : {};
  } catch { return {}; }
}
export function autopilotCreatedQuote(organizationId: string, proposalId: string): AutopilotCreatedQuote | null {
  const entry = read()[organizationId]?.[proposalId];
  return entry && isId(entry.quoteId) && isId(entry.clientId) ? entry : null;
}
export function saveAutopilotCreatedQuote(organizationId: string, proposalId: string, entry: AutopilotCreatedQuote | null) {
  const store = read(), company = { ...(store[organizationId] ?? {}) };
  if (entry) company[proposalId] = entry; else delete company[proposalId];
  const ids = Object.keys(company);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX))) delete company[old];
  store[organizationId] = company;
  try { window.localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* best effort */ }
}
