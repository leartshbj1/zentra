import type { Invoice, Quote, Workspace } from './types';
import { documentLineTotals, documentTotals } from './utils';

/** What the customer's page shows: the issued quote, never the local records. */
export type PortalPublishInput = {
  kind: 'quote';
  documentId: string;
  clientKey: string;
  number: string;
  title: string;
  clientName: string;
  companyName: string;
  issueDate: string;
  validUntil: string | null;
  currency: 'CHF' | 'EUR';
  totalCents: number;
  lines: { description: string; quantity: string; totalCents: number }[];
  pdfBase64: string | null;
  /** Acompte calculé par l'app et sa page Payrexx ; publié en schemaVersion 2. */
  deposit?: { amountCents: number; paymentUrl: string };
};
export type PortalLink = { url: string; clientUrl: string; expiresAt: string; publishedAt: number };
export type PortalEvent = { eventId: string; documentId: string; kind: 'accepted' | 'declined'; signerName: string; comment: string; at: number };
export type PortalPage = { organizationId: string; items: readonly PortalEvent[]; nextCursor: string | null };

const clip = (value: string, max: number) => [...value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()].slice(0, max).join('');

/** Le lien n'existe que pour un devis émis, encore ouvert, en CHF ou en EUR. */
export function canPublishQuote(quote: Quote): boolean {
  return quote.status === 'issued' && !!quote.number && quote.lines.length > 0 && (quote.currency === 'CHF' || quote.currency === 'EUR');
}

export function portalPublishInput(quote: Quote, workspace: Pick<Workspace, 'clients' | 'settings'>, pdfBase64: string | null): PortalPublishInput {
  const client = workspace.clients.find(row => row.id === quote.clientId);
  const company = workspace.settings?.organization?.legalName || '';
  return {
    kind: 'quote',
    documentId: quote.id,
    clientKey: quote.clientId,
    number: clip(quote.number, 64),
    title: clip(quote.title, 200),
    clientName: clip(client?.company || client?.name || '—', 200),
    companyName: clip(company || '—', 200),
    issueDate: quote.issueDate.slice(0, 10),
    validUntil: /^\d{4}-\d{2}-\d{2}/.test(quote.validUntil) ? quote.validUntil.slice(0, 10) : null,
    currency: quote.currency as 'CHF' | 'EUR',
    totalCents: documentTotals(quote.lines).totalCents,
    lines: quote.lines.slice(0, 200).map(line => ({
      description: clip(line.description, 500) || '—',
      quantity: clip(`${line.quantity}${line.unit ? ' ' + line.unit : ''}`, 32),
      totalCents: documentLineTotals(line).totalCents,
    })),
    pdfBase64: pdfBase64 && pdfBase64.length <= 7_000_000 && pdfBase64.startsWith('JVBERi0') ? pdfBase64 : null,
  };
}

export function bytesToBase64(bytes: ArrayLike<number>): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...Array.from({ length: Math.min(0x8000, bytes.length - start) }, (_, i) => bytes[start + i]));
  return btoa(binary);
}

/** Une réponse du client devient une carte tant que le devis attend encore sa décision. */
export type PortalCard = { event: PortalEvent; quote: Quote };
export function portalCards(events: readonly PortalEvent[], quotes: readonly Quote[], invoices: readonly Pick<Invoice, 'quoteId'>[]): PortalCard[] {
  const latest = new Map<string, PortalEvent>();
  for (const event of events) {
    const seen = latest.get(event.documentId);
    if (!seen || event.at >= seen.at) latest.set(event.documentId, event);
  }
  const cards: PortalCard[] = [];
  for (const event of [...latest.values()].sort((a, b) => b.at - a.at)) {
    const quote = quotes.find(row => row.id === event.documentId);
    if (!quote || invoices.some(row => row.quoteId === quote.id)) continue;
    if (event.kind === 'accepted' ? quote.status === 'issued' || quote.status === 'accepted' : quote.status === 'issued') cards.push({ event, quote });
  }
  return cards;
}

const storeKey = (organizationId: string) => `zentra.portal.v1.${organizationId}`;
type Stored = { links: Record<string, PortalLink>; events: Record<string, PortalEvent>; cursor: string | null };
export function savedPortal(organizationId: string): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey(organizationId)) ?? 'null') as Partial<Stored> | null;
    return { links: raw?.links ?? {}, events: raw?.events ?? {}, cursor: typeof raw?.cursor === 'string' ? raw.cursor : null };
  } catch {
    return { links: {}, events: {}, cursor: null };
  }
}
function savePortal(organizationId: string, value: Stored) {
  try { localStorage.setItem(storeKey(organizationId), JSON.stringify(value)); } catch { /* kept in memory until next read */ }
}
export function savePortalLink(organizationId: string, quoteId: string, link: PortalLink) {
  const stored = savedPortal(organizationId);
  savePortal(organizationId, { ...stored, links: { ...stored.links, [quoteId]: link } });
}
export function savePortalEvents(organizationId: string, page: PortalPage) {
  const stored = savedPortal(organizationId);
  const events = { ...stored.events };
  for (const event of page.items) events[event.eventId] = event;
  savePortal(organizationId, { ...stored, events, cursor: page.nextCursor ?? stored.cursor });
}
