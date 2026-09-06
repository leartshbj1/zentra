type DatedDocument = { issueDate: string; createdAt: string; number: string; id: string };

export const documentOrders = {
  'created-desc': 'Création : récente d’abord',
  'created-asc': 'Création : ancienne d’abord',
  'date-desc': 'Date : récente d’abord',
  'date-asc': 'Date : ancienne d’abord',
} as const;
export type DocumentOrder = keyof typeof documentOrders;
type DocumentList = 'quotes' | 'invoices';

function timestamp(value: string): number | null {
  // SQLite timestamps are UTC; normalize them for Safari as well as Chromium.
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
    ? value.replace(' ', 'T') + 'Z' : value;
  const result = Date.parse(normalized);
  return Number.isFinite(result) ? result : null;
}

/** Creation order is independent of a document's editable issue date. */
export function sortDocuments<T extends DatedDocument>(documents: readonly T[], order: DocumentOrder = 'created-desc'): T[] {
  const direction = order.endsWith('asc') ? 1 : -1;
  const byCreation = order.startsWith('created');
  return documents.map(document => {
    const created = timestamp(document.createdAt);
    const issued = timestamp(document.issueDate);
    return { document, created, primary: byCreation ? created ?? issued : issued ?? created };
  }).sort((left, right) => {
    // Undated legacy records stay last in either direction.
    if (left.primary === null && right.primary !== null) return 1;
    if (right.primary === null && left.primary !== null) return -1;
    return direction * ((left.primary ?? 0) - (right.primary ?? 0))
      || direction * ((left.created ?? 0) - (right.created ?? 0))
      || direction * left.document.number.localeCompare(right.document.number, 'fr-CH', { numeric: true })
      || left.document.id.localeCompare(right.document.id);
  }).map(({ document }) => document);
}

export function newestDocumentsFirst<T extends DatedDocument>(documents: readonly T[]): T[] {
  return sortDocuments(documents);
}

export function readDocumentOrder(entity: DocumentList): DocumentOrder {
  try {
    const value = localStorage.getItem(`zentra.documents.order.${entity}`);
    if (value && Object.hasOwn(documentOrders, value)) return value as DocumentOrder;
  } catch { /* Storage may be unavailable; the list remains usable. */ }
  return 'created-desc';
}

export function saveDocumentOrder(entity: DocumentList, order: DocumentOrder): void {
  try { localStorage.setItem(`zentra.documents.order.${entity}`, order); } catch { /* Session state still applies. */ }
}
