import { activeCatalogItems, catalogItemToDocumentLine } from './catalog';
import type { DocumentLine, Workspace } from './types';

/**
 * Deterministic "usual items" of one client, computed from documents already
 * stored on this device. Same rules as the Autopilote server suggestion:
 * only documents the client accepted or was billed for count, an item must
 * appear in at least two of the most recent ones, the quantity is the lower
 * median, and prices, units and VAT always come from the CURRENT catalogue.
 * The result only pre-fills editable lines; a person validates them.
 */
export type UsualArticleLine = Readonly<{ line: DocumentLine; documentCount: number; quantityStable: boolean }>;
export type UsualArticles = Readonly<{ countedDocuments: number; lines: readonly UsualArticleLine[] }>;

const LOOKBACK_DOCUMENTS = 12;
const MIN_DOCUMENTS = 2;
const MAX_SUGGESTIONS = 8;

function lowerMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

export function findUsualArticles(
  workspace: Pick<Workspace, 'quotes' | 'invoices' | 'catalogItems'>,
  clientId: string,
  currency: string,
  excludeDocumentId?: string,
): UsualArticles {
  const empty: UsualArticles = { countedDocuments: 0, lines: [] };
  // Catalogue prices are kept in CHF and are never converted.
  if (!clientId || currency !== 'CHF') return empty;
  const invoices = workspace.invoices.filter(invoice => invoice.clientId === clientId && invoice.currency === currency
    && invoice.id !== excludeDocumentId && invoice.type !== 'credit_note' && ['issued', 'partially_paid', 'paid'].includes(invoice.status));
  // An accepted quote that was then invoiced is the same order: count it once.
  const invoicedQuotes = new Set(invoices.map(invoice => invoice.quoteId).filter(Boolean));
  const quotes = workspace.quotes.filter(quote => quote.clientId === clientId && quote.currency === currency
    && quote.id !== excludeDocumentId && quote.status === 'accepted' && !invoicedQuotes.has(quote.id));
  const documents = [...quotes, ...invoices]
    .map(document => {
      const quantities = new Map<string, number>();
      for (const line of document.lines) {
        if (!line.catalogItemId || !(line.quantity > 0)) continue;
        quantities.set(line.catalogItemId, (quantities.get(line.catalogItemId) ?? 0) + Math.round(line.quantity * 1000));
      }
      return { id: document.id, date: document.issueDate, quantities };
    })
    .filter(document => document.quantities.size > 0)
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
    .slice(0, LOOKBACK_DOCUMENTS);

  const usage = new Map<string, { quantities: number[]; lastUsedAt: string }>();
  for (const document of documents) {
    for (const [itemId, quantity] of document.quantities) {
      const entry = usage.get(itemId) ?? { quantities: [], lastUsedAt: document.date };
      entry.quantities.push(quantity);
      usage.set(itemId, entry);
    }
  }
  const catalogue = new Map(activeCatalogItems(workspace.catalogItems).map(item => [item.id, item]));
  const lines: (UsualArticleLine & { lastUsedAt: string; itemId: string })[] = [];
  for (const [itemId, entry] of usage) {
    const item = catalogue.get(itemId);
    // An archived or deleted reference is never replaced by a guess.
    if (entry.quantities.length < MIN_DOCUMENTS || !item) continue;
    const quantityMilli = lowerMedian(entry.quantities);
    lines.push({
      itemId,
      lastUsedAt: entry.lastUsedAt,
      documentCount: entry.quantities.length,
      quantityStable: entry.quantities.every(value => value === quantityMilli),
      line: { ...catalogItemToDocumentLine(item), quantity: quantityMilli / 1000 },
    });
  }
  lines.sort((a, b) => b.documentCount - a.documentCount || b.lastUsedAt.localeCompare(a.lastUsedAt) || a.itemId.localeCompare(b.itemId));
  return {
    countedDocuments: documents.length,
    lines: lines.slice(0, MAX_SUGGESTIONS).map(({ line, documentCount, quantityStable }) => ({ line, documentCount, quantityStable })),
  };
}

/** Adds the usual lines once, replacing the empty starter line and skipping references already present. */
export function withUsualArticles(current: readonly DocumentLine[], usual: UsualArticles): DocumentLine[] {
  const present = new Set(current.map(line => line.catalogItemId).filter(Boolean));
  const additions = usual.lines.map(entry => entry.line).filter(line => !present.has(line.catalogItemId));
  const onlyEmpty = current.length === 1 && !current[0].description.trim() && current[0].quantity === 0;
  return onlyEmpty ? additions.length ? additions : [...current] : [...current, ...additions];
}
