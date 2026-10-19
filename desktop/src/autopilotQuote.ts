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

/** Who the request is from: the sender read by the server, else the customer name Autopilote found. */
export type AutopilotCustomer = Readonly<{ name?: string; company?: string; email?: string; phone?: string; street?: string; postcode?: string; city?: string }>;
export function autopilotCustomer(suggestion: AutopilotReviewSuggestion): AutopilotCustomer {
  const sender = suggestion.sender, value = (field: string | null | undefined) => field?.trim() || undefined;
  return { name: value(sender?.name) ?? value(suggestion.customer?.name), company: value(sender?.company), email: value(sender?.email),
    phone: value(sender?.phone), street: value(sender?.street), postcode: value(sender?.postcode), city: value(sender?.city) };
}

/**
 * The existing client for this request, looking in order at the e-mail address,
 * the company, then the name. A single match is used; several are left to the person.
 */
export function findAutopilotClient(clients: readonly Client[], customer: AutopilotCustomer, locale: string): Client | 'ambiguous' | undefined {
  const active = clients.filter(row => !row.archivedAt);
  const tests: [string, (row: Client) => (string | undefined | null)[]][] = [
    [normal(customer.email, locale), row => [row.email]],
    [normal(customer.company, locale), row => [row.company, row.name]],
    [normal(customer.name, locale), row => [row.name, row.contactPerson, row.company]],
  ];
  for (const [wanted, fields] of tests) {
    if (!wanted) continue;
    const found = active.filter(row => fields(row).some(field => normal(field, locale) === wanted));
    if (found.length === 1) return found[0];
    if (found.length > 1) return 'ambiguous';
  }
  return undefined;
}

/** A client created from the request with what the signature gave; the rest can be completed later. */
export function autopilotNewClient(id: string, customer: AutopilotCustomer) {
  const company = customer.company ?? '', person = customer.name ?? '', email = customer.email ?? '';
  const name = company || person || email;
  if (!name) return null;
  return { id, name, contactPerson: person, company, email, phone: customer.phone ?? '', addressLine1: customer.street ?? '', addressLine2: '',
    postalCode: customer.postcode ?? '', city: customer.city ?? '', canton: '', country: 'CH', notes: '' };
}

/** Quotes created from a request, kept on this device so a second click opens the same quote. */
export type AutopilotCreatedQuote = Readonly<{ quoteId: string; clientId: string;
  /** Unix ms when the quote e-mail was accepted; the request is then done. */ sentAt?: number;
  /** The invoice made once the client accepted the quote, and when it was sent. */ invoiceId?: string; invoiceSentAt?: number }>;
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
  if (!entry || !isId(entry.quoteId) || !isId(entry.clientId)) return null;
  const time = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
  const sentAt = time(entry.sentAt), invoiceSentAt = time(entry.invoiceSentAt), invoiceId = isId(entry.invoiceId) ? entry.invoiceId : undefined;
  return { quoteId: entry.quoteId, clientId: entry.clientId, ...(sentAt ? { sentAt } : {}),
    ...(invoiceId ? { invoiceId } : {}), ...(invoiceId && invoiceSentAt ? { invoiceSentAt } : {}) };
}
/** The quote (or, later, the invoice) of this request was sent by e-mail. */
export function markAutopilotQuoteSent(organizationId: string, proposalId: string, sentAt: number, kind: 'quote' | 'invoice' = 'quote') {
  const entry = autopilotCreatedQuote(organizationId, proposalId);
  if (!entry) return;
  if (kind === 'quote' && !entry.sentAt) saveAutopilotCreatedQuote(organizationId, proposalId, { ...entry, sentAt });
  if (kind === 'invoice' && entry.invoiceId && !entry.invoiceSentAt) saveAutopilotCreatedQuote(organizationId, proposalId, { ...entry, invoiceSentAt: sentAt });
}
export function linkAutopilotInvoice(organizationId: string, proposalId: string, invoiceId: string) {
  const entry = autopilotCreatedQuote(organizationId, proposalId);
  if (entry && !entry.invoiceId) saveAutopilotCreatedQuote(organizationId, proposalId, { ...entry, invoiceId });
}
/**
 * Where a request stands once its quote exists: waiting to be sent, sent
 * (done), accepted by the client (to invoice), or invoiced and sent (done).
 */
export function autopilotRequestStage(quote: Readonly<{ sentAt?: number; accepted?: boolean; invoiceSentAt?: number }> | null): 'open' | 'accepted' | 'done' {
  if (!quote) return 'open';
  if (quote.invoiceSentAt) return 'done';
  if (quote.accepted) return 'accepted';
  return quote.sentAt ? 'done' : 'open';
}
export function saveAutopilotCreatedQuote(organizationId: string, proposalId: string, entry: AutopilotCreatedQuote | null) {
  const store = read(), company = { ...(store[organizationId] ?? {}) };
  if (entry) company[proposalId] = entry; else delete company[proposalId];
  const ids = Object.keys(company);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX))) delete company[old];
  store[organizationId] = company;
  try { window.localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* best effort */ }
}
