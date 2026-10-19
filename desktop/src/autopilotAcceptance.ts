import type { AutopilotSender } from './autopilotReview';
import type { Client, Invoice, Quote } from './types';

/**
 * A client mail that accepts a quote, read by the server (30 days, FR/DE/IT/EN).
 * The server does not know local quotes: the app finds the quote and the
 * person still confirms by creating then sending the invoice.
 */
export type AutopilotAcceptance = Readonly<{
  sourceId: string; receivedAt: number; quoteReference: string | null; evidence: string;
  sender: AutopilotSender | null; requiresHumanValidation: true;
}>;

const reference = (value: string) => value.toLocaleLowerCase('fr-CH').replace(/\s+/g, '');
const email = (value: string | undefined | null) => (value ?? '').trim().toLowerCase();
const sentQuote = (quote: Quote) => quote.status === 'issued' || quote.status === 'accepted';

/**
 * The quote this mail accepts: the one numbered as quoted in the mail, else the
 * latest sent quote of the client with that address that is not invoiced yet.
 * Exactly one match is used; none or several are left to the person.
 */
export function matchAcceptance(acceptance: AutopilotAcceptance, quotes: readonly Quote[], clients: readonly Client[],
  invoices: readonly Invoice[]): Readonly<{ quote: Quote }> | Readonly<{ candidates: readonly Quote[] }> {
  const live = quotes.filter(quote => quote.status !== 'cancelled' && quote.status !== 'draft');
  if (acceptance.quoteReference) {
    const wanted = reference(acceptance.quoteReference);
    const numbered = live.filter(quote => quote.number && reference(quote.number) === wanted);
    if (numbered.length === 1) return { quote: numbered[0] };
    if (numbered.length > 1) return { candidates: numbered };
  }
  const address = email(acceptance.sender?.email);
  const owners = new Set(address ? clients.filter(client => !client.archivedAt && email(client.email) === address).map(client => client.id) : []);
  const invoiced = new Set(invoices.filter(invoice => invoice.quoteId && invoice.status !== 'cancelled' && invoice.type !== 'credit_note').map(invoice => invoice.quoteId!));
  const open = live.filter(quote => owners.has(quote.clientId) && sentQuote(quote) && !invoiced.has(quote.id))
    .sort((a, b) => (b.issueDate + b.createdAt).localeCompare(a.issueDate + a.createdAt));
  if (open.length) return { quote: open[0] };
  return { candidates: live.filter(quote => sentQuote(quote) && !invoiced.has(quote.id)).slice(0, 20) };
}

/** What this device did with each acceptance mail, so it is handled once. */
export type AcceptanceDecision = Readonly<{ quoteId: string | null; state: 'accepted' | 'choose' | 'dismissed' }>;
type Store = Record<string, Record<string, AcceptanceDecision>>;
const KEY = 'zentra.autopilot.acceptances.v1';
const MAX = 300;
function read(): Store {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Store : {};
  } catch { return {}; }
}
export function acceptanceDecisions(organizationId: string): Readonly<Record<string, AcceptanceDecision>> {
  const rows = read()[organizationId] ?? {};
  return Object.fromEntries(Object.entries(rows).filter(([, row]) => row && ['accepted', 'choose', 'dismissed'].includes(row.state)
    && (row.quoteId === null || typeof row.quoteId === 'string')));
}
export function saveAcceptanceDecision(organizationId: string, sourceId: string, decision: AcceptanceDecision) {
  const store = read(), company = { ...(store[organizationId] ?? {}), [sourceId]: decision };
  const ids = Object.keys(company);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX))) delete company[old];
  store[organizationId] = company;
  try { window.localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* best effort */ }
}
/** The created-quotes key under which an acceptance outside any request follows its invoice. */
export const acceptanceKey = (sourceId: string) => `acceptance:${sourceId}`;
