import type { FixedAssetRow } from './fixedAssets';
import { availabilityForCatalogItem, nextSalesOrderAction, salesOrderLineProgress } from './orderFlow';
import type { CatalogItem, SalesOrder, StockMovement, Workspace } from './types';

/**
 * Amortissements de l'exercice : en décembre pour l'année en cours, de janvier
 * à mars pour l'année écoulée. Les montants sont ceux que l'app native calcule.
 */
export function depreciationDue(rows: readonly FixedAssetRow[], today: string): { year: number; rows: FixedAssetRow[]; totalCents: number } | null {
  const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7));
  const closing = month === 12 ? year : month <= 3 ? year - 1 : null;
  if (closing === null) return null;
  const due = rows.filter(row => !row.cancelled && !row.blocker && row.nextAmountCents > 0 && row.nextYear <= closing);
  return due.length ? { year: closing, rows: due, totalCents: due.reduce((sum, row) => sum + row.nextAmountCents, 0) } : null;
}

/** Inventaire de fin d'année (1er décembre – 15 janvier) : produits suivis en stock sans comptage depuis le 1er décembre. */
export function inventoryDue(items: readonly CatalogItem[], movements: readonly Pick<StockMovement, 'catalogItemId' | 'movementType' | 'movementDate'>[], today: string): { year: number; items: CatalogItem[] } | null {
  const year = Number(today.slice(0, 4)), monthDay = today.slice(5);
  const inventoryYear = monthDay >= '12-01' ? year : monthDay <= '01-15' ? year - 1 : null;
  if (inventoryYear === null) return null;
  const since = `${inventoryYear}-12-01`;
  const counted = new Set(movements.filter(row => row.movementType === 'correction' && row.movementDate >= since).map(row => row.catalogItemId));
  const pending = items.filter(item => !item.archivedAt && item.kind === 'product' && item.trackStock && !counted.has(item.id));
  return pending.length ? { year: inventoryYear, items: pending } : null;
}

/** Commandes confirmées dont tout le reste à livrer est en stock : le bon de livraison peut partir. */
export function ordersReadyToDeliver(workspace: Pick<Workspace, 'salesOrders' | 'deliveryNotes' | 'invoices' | 'salesOrderInvoiceBatches' | 'salesOrderInvoiceAllocations' | 'stockReservationEvents' | 'stockAvailability' | 'catalogItems'>): SalesOrder[] {
  return workspace.salesOrders.filter(order => {
    if (nextSalesOrderAction(order, workspace) !== 'create_delivery') return false;
    const remaining = order.lines.filter(line => line.fulfillmentMode !== 'direct').map(line => ({ line, milli: salesOrderLineProgress(order, line, workspace).remainingToDeliverMilli })).filter(row => row.milli > 0);
    return remaining.length > 0 && remaining.every(({ line, milli }) => {
      const item = workspace.catalogItems.find(row => row.id === line.catalogItemId);
      if (!item || item.kind !== 'product' || !item.trackStock) return true;
      return availabilityForCatalogItem(item, workspace.stockReservationEvents, workspace.stockAvailability).onHandMilli >= milli;
    });
  });
}
