import type { CatalogItem, DocumentLine, StockMovement, StockMovementType } from './types';
import { createId, searchText } from './utils';

export type CatalogKindFilter = 'all' | CatalogItem['kind'];
export type CatalogVisibilityFilter = 'active' | 'archived' | 'all';

const MAX_STOCK_QUANTITY_MILLI = 9_000_000_000_000_000;

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
  const identity = [item.sku?.trim(), item.name.trim()].filter(Boolean).join(' · ');
  return {
    id,
    catalogItemId: item.id,
    // La description devient le snapshot lisible du catalogue dans le devis ou
    // la facture. Y inclure la référence évite qu'elle disparaisse du PDF si la
    // fiche catalogue est renommée plus tard; l'utilisateur peut toujours
    // adapter librement cette ligne avant l'émission.
    description: description ? `${identity} — ${description}` : identity,
    quantity: 1,
    unit: item.unit,
    unitPriceCents: item.salesPriceCents,
    discountBp: 0,
    vatRateBp: item.vatBp,
  };
}

export function isCatalogItemLowOnStock(
  item: CatalogItem,
  availableMilli = item.stockQuantityMilli,
): boolean {
  return item.kind === 'product'
    && item.trackStock
    && (availableMilli <= 0
      || (item.reorderLevelMilli > 0 && availableMilli <= item.reorderLevelMilli));
}

export function catalogQuantityFromInput(value: FormDataEntryValue | null): number {
  return Math.max(0, stockQuantityFromInput(value) ?? 0);
}

export function stockQuantityFromInput(value: FormDataEntryValue | null): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().replace(',', '.');
  if (!/^[+-]?(?:\d+|\d*\.\d{1,3})$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  const milli = Math.round(parsed * 1_000);
  return Number.isSafeInteger(milli) ? milli : null;
}

export function formatCatalogQuantity(milli: number): string {
  return new Intl.NumberFormat('fr-CH', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(milli / 1_000);
}

export function catalogStockData(
  kind: CatalogItem['kind'],
  reorderLevelMilli: number,
  editing: boolean,
): { trackStock: boolean; reorderLevelMilli: number; stockQuantityMilli?: number } {
  const stock = {
    trackStock: kind === 'product',
    reorderLevelMilli: kind === 'product' ? Math.max(0, reorderLevelMilli) : 0,
  };
  return editing ? stock : { ...stock, stockQuantityMilli: 0 };
}

export function stockBalanceAfter(
  currentBalanceMilli: number,
  movementType: StockMovementType,
  enteredQuantityMilli: number,
): number {
  const delta = movementType === 'exit' ? -enteredQuantityMilli : enteredQuantityMilli;
  return currentBalanceMilli + delta;
}

export function stockMovementError(
  item: CatalogItem,
  movementType: StockMovementType,
  enteredQuantityMilli: number | null,
  reservedQuantityMilli = 0,
): string {
  if (item.kind !== 'product' || !item.trackStock) {
    return 'Seuls les produits avec suivi de stock acceptent un mouvement.';
  }
  if (enteredQuantityMilli === null) {
    return 'Saisissez une quantité valide avec au maximum trois décimales.';
  }
  if (movementType === 'correction') {
    if (enteredQuantityMilli === 0) return 'Une correction ne peut pas être égale à zéro.';
  } else if (enteredQuantityMilli <= 0) {
    return 'La quantité doit être strictement positive.';
  }
  if (Math.abs(enteredQuantityMilli) > MAX_STOCK_QUANTITY_MILLI) {
    return 'La quantité dépasse la capacité du registre de stock.';
  }
  const balanceAfter = stockBalanceAfter(
    item.stockQuantityMilli,
    movementType,
    enteredQuantityMilli,
  );
  if (balanceAfter < reservedQuantityMilli) {
    const availableMilli = Math.max(
      0,
      item.stockQuantityMilli - reservedQuantityMilli,
    );
    return `Stock insuffisant : ${formatCatalogQuantity(availableMilli)} ${item.unit} disponible${availableMilli === 1_000 ? '' : 's'}. ${formatCatalogQuantity(reservedQuantityMilli)} ${item.unit} réservé${reservedQuantityMilli === 1_000 ? '' : 's'} aux commandes.`;
  }
  if (balanceAfter > MAX_STOCK_QUANTITY_MILLI) {
    return 'Le solde obtenu dépasse la capacité du registre de stock.';
  }
  return '';
}

export function stockMovementsForItem(
  movements: StockMovement[],
  catalogItemId: string,
): StockMovement[] {
  return movements
    .filter((movement) => movement.catalogItemId === catalogItemId)
    .sort((left, right) => right.sequence - left.sequence);
}

function compareCatalogItems(left: CatalogItem, right: CatalogItem): number {
  return left.name.localeCompare(right.name, 'fr-CH', { sensitivity: 'base' }) || (left.sku ?? '').localeCompare(right.sku ?? '', 'fr-CH');
}
