import type { DocumentLine } from './types';

/** Liste de prix : un rabais sur tout le catalogue et des prix fixes par article, pour des clients. */
export type PriceList = {
  id: string;
  name: string;
  discountBp: number;
  archivedAt: string | null;
  items: { catalogItemId: string; unitPriceCents: number }[];
  clientIds: string[];
};

type RawRow = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function priceListsFromRaw(lists: readonly RawRow[], items: readonly RawRow[], clients: readonly RawRow[]): PriceList[] {
  return lists.map(row => ({
    id: text(row.id),
    name: text(row.name),
    discountBp: number(row.discount_bp),
    archivedAt: text(row.archived_at) || null,
    items: items.filter(item => item.price_list_id === row.id).map(item => ({ catalogItemId: text(item.catalog_item_id), unitPriceCents: number(item.unit_price_cents) })),
    clientIds: clients.filter(client => client.price_list_id === row.id).map(client => text(client.client_id)),
  }));
}

/** La liste active d'un client, s'il en a une. */
export function clientPriceList(lists: readonly PriceList[] | undefined, clientId: string | null | undefined): PriceList | null {
  if (!clientId) return null;
  return (lists ?? []).find(list => !list.archivedAt && list.clientIds.includes(clientId)) ?? null;
}

/**
 * Prix d'une ligne du catalogue pour ce client : le prix fixe de la liste,
 * sinon le prix du catalogue avec le rabais de la liste, visible sur le document.
 */
export function applyPriceList(line: DocumentLine, list: PriceList | null): DocumentLine {
  if (!list || !line.catalogItemId) return line;
  const fixed = list.items.find(item => item.catalogItemId === line.catalogItemId);
  if (fixed) return { ...line, unitPriceCents: fixed.unitPriceCents, discountBp: 0 };
  return list.discountBp > 0 ? { ...line, discountBp: list.discountBp } : line;
}

/** Prix unitaire net de la liste (rapports sans colonne de rabais), arrondi au centime. */
export function listUnitPrice(catalogItemId: string, catalogPriceCents: number, list: PriceList | null): number {
  if (!list) return catalogPriceCents;
  const fixed = list.items.find(item => item.catalogItemId === catalogItemId);
  if (fixed) return fixed.unitPriceCents;
  return Math.round(catalogPriceCents * (10_000 - list.discountBp) / 10_000);
}

/** « 12.5 » ou « 12,5 » → 1250 points de base ; null si hors de 0 à 100 %. */
export function parseDiscountPercent(value: string): number | null {
  const match = /^\s*(\d{1,3})(?:[.,](\d{1,2}))?\s*$/.exec(value);
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bp <= 10_000 ? bp : null;
}
