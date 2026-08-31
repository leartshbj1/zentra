import type { CatalogItem, DocumentLine } from './types';
import { createId, searchText } from './utils';

export type CatalogKindFilter = 'all' | CatalogItem['kind'];
export type CatalogVisibilityFilter = 'active' | 'archived' | 'all';

export function activeCatalogItems(items: CatalogItem[]): CatalogItem[] {
  return items
    .filter((item) => !item.archivedAt)
    .sort(compareCatalogItems);
}

export function filterCatalogItems(
  items: CatalogItem[],
  query: string,
  kind: CatalogKindFilter,
  visibility: CatalogVisibilityFilter,
): CatalogItem[] {
  return items
    .filter((item) => kind === 'all' || item.kind === kind)
    .filter((item) => visibility === 'all' || (visibility === 'archived' ? Boolean(item.archivedAt) : !item.archivedAt))
    .filter((item) => searchText([item.sku, item.name, item.description, item.unit], query))
    .sort(compareCatalogItems);
}

export function catalogItemToDocumentLine(item: CatalogItem, id = createId()): DocumentLine {
  const description = item.description.trim();
  return {
    id,
    catalogItemId: item.id,
    description: description ? `${item.name} — ${description}` : item.name,
    quantity: 1,
    unit: item.unit,
    unitPriceCents: item.salesPriceCents,
    discountBp: 0,
    vatRateBp: item.vatBp,
  };
}

export function isCatalogItemLowOnStock(item: CatalogItem): boolean {
  return item.kind === 'product' && item.trackStock && item.reorderLevelMilli > 0 && item.stockQuantityMilli <= item.reorderLevelMilli;
}

export function catalogQuantityFromInput(value: FormDataEntryValue | null): number {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 1_000)) : 0;
}

export function formatCatalogQuantity(milli: number): string {
  return new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 3 }).format(milli / 1_000);
}

function compareCatalogItems(left: CatalogItem, right: CatalogItem): number {
  return left.name.localeCompare(right.name, 'fr-CH', { sensitivity: 'base' }) || (left.sku ?? '').localeCompare(right.sku ?? '', 'fr-CH');
}
