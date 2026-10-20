import type { DeliveryNote, SalesOrder, StockMovement } from './types';

export type Warehouse = { id: string; code: string; name: string; isDefault: boolean; archivedAt: string | null };
export type StockTransfer = { id: string; catalogItemId: string; fromWarehouseId: string; toWarehouseId: string; quantityMilli: number; transferDate: string; note: string };
export type ItemTracking = { catalogItemId: string; mode: 'lot' | 'serial' };
export type StockLot = { id: string; catalogItemId: string; mode: 'lot' | 'serial'; code: string; expiryDate: string | null; warehouseId: string | null; createdAt: string };
export type LotMovement = { id: string; lotId: string; quantityMilli: number; movementDate: string; sourceType: 'entry' | 'exit' | 'receipt' | 'delivery'; sourceId: string | null; reference: string };
export type StockLocations = {
  warehouses: Warehouse[];
  movementWarehouses: Record<string, string>;
  transfers: StockTransfer[];
  tracking: ItemTracking[];
  lots: StockLot[];
  lotMovements: LotMovement[];
};

type RawRow = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const mode = (value: unknown): 'lot' | 'serial' => (value === 'serial' ? 'serial' : 'lot');

export function stockLocationsFromRaw(raw: { warehouses?: RawRow[]; stock_movement_warehouses?: RawRow[]; stock_transfers?: RawRow[]; catalog_item_tracking?: RawRow[]; stock_lots?: RawRow[]; stock_lot_movements?: RawRow[] }): StockLocations {
  return {
    warehouses: (raw.warehouses ?? []).map(row => ({ id: text(row.id), code: text(row.code), name: text(row.name), isDefault: row.is_default === 1 || row.is_default === true, archivedAt: text(row.archived_at) || null })),
    movementWarehouses: Object.fromEntries((raw.stock_movement_warehouses ?? []).map(row => [text(row.stock_movement_id), text(row.warehouse_id)])),
    transfers: (raw.stock_transfers ?? []).map(row => ({ id: text(row.id), catalogItemId: text(row.catalog_item_id), fromWarehouseId: text(row.from_warehouse_id), toWarehouseId: text(row.to_warehouse_id),
      quantityMilli: number(row.quantity_milli), transferDate: text(row.transfer_date), note: text(row.note) })),
    tracking: (raw.catalog_item_tracking ?? []).map(row => ({ catalogItemId: text(row.catalog_item_id), mode: mode(row.mode) })),
    lots: (raw.stock_lots ?? []).map(row => ({ id: text(row.id), catalogItemId: text(row.catalog_item_id), mode: mode(row.mode), code: text(row.code), expiryDate: text(row.expiry_date) || null,
      warehouseId: text(row.warehouse_id) || null, createdAt: text(row.created_at) })),
    lotMovements: (raw.stock_lot_movements ?? []).map(row => ({ id: text(row.id), lotId: text(row.lot_id), quantityMilli: number(row.quantity_milli), movementDate: text(row.movement_date),
      sourceType: (['entry', 'exit', 'receipt', 'delivery'] as const).find(value => value === row.source_type) ?? 'entry', sourceId: text(row.source_id) || null, reference: text(row.reference) })),
  };
}

/** Stock par article et par dépôt : mouvements placés (sinon dépôt principal) et transferts, comme l'app native. */
export function warehouseStock(locations: StockLocations, movements: readonly Pick<StockMovement, 'id' | 'catalogItemId' | 'quantityDeltaMilli'>[]): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  const fallback = locations.warehouses.find(row => row.isDefault)?.id;
  const add = (item: string, warehouse: string | undefined, milli: number) => {
    if (!warehouse) return;
    const row = result.get(item) ?? new Map<string, number>();
    row.set(warehouse, (row.get(warehouse) ?? 0) + milli);
    result.set(item, row);
  };
  for (const movement of movements) add(movement.catalogItemId, locations.movementWarehouses[movement.id] ?? fallback, movement.quantityDeltaMilli);
  for (const transfer of locations.transfers) {
    add(transfer.catalogItemId, transfer.fromWarehouseId, -transfer.quantityMilli);
    add(transfer.catalogItemId, transfer.toWarehouseId, transfer.quantityMilli);
  }
  return result;
}

export type LotBalance = { lot: StockLot; balanceMilli: number; lastReference: string };
export function lotBalances(locations: StockLocations, catalogItemId?: string): LotBalance[] {
  return locations.lots.filter(lot => !catalogItemId || lot.catalogItemId === catalogItemId).map(lot => {
    const moves = locations.lotMovements.filter(row => row.lotId === lot.id);
    const last = [...moves].sort((a, b) => a.movementDate.localeCompare(b.movementDate)).at(-1);
    return { lot, balanceMilli: moves.reduce((sum, row) => sum + row.quantityMilli, 0), lastReference: last?.reference ?? '' };
  }).sort((a, b) => (a.lot.expiryDate ?? '9999').localeCompare(b.lot.expiryDate ?? '9999') || a.lot.code.localeCompare(b.lot.code));
}

/** Lots encore en stock qui expirent dans les `days` jours (ou déjà expirés). */
export function expiringLots(balances: readonly LotBalance[], today: string, days = 30): LotBalance[] {
  const limit = new Date(Date.parse(today + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);
  return balances.filter(row => row.balanceMilli > 0 && row.lot.expiryDate && row.lot.expiryDate <= limit);
}

/** Bons de livraison émis avec des articles suivis dont les lots ou numéros n'ont pas été notés. */
export function deliveriesToTrace(notes: readonly DeliveryNote[], orders: readonly Pick<SalesOrder, 'lines'>[], locations: StockLocations): Array<{ note: DeliveryNote; catalogItemIds: string[] }> {
  const tracked = new Set(locations.tracking.map(row => row.catalogItemId));
  if (!tracked.size) return [];
  const lineItem = new Map(orders.flatMap(order => order.lines.map(line => [line.id, line.catalogItemId] as const)));
  return notes.filter(note => note.status === 'issued').flatMap(note => {
    const items = [...new Set(note.lines.map(line => lineItem.get(line.salesOrderLineId)).filter((id): id is string => !!id && tracked.has(id)))];
    const traced = new Set(locations.lotMovements.filter(row => row.sourceType === 'delivery' && row.sourceId === note.id)
      .map(row => locations.lots.find(lot => lot.id === row.lotId)?.catalogItemId));
    const missing = items.filter(id => !traced.has(id));
    return missing.length ? [{ note, catalogItemIds: missing }] : [];
  });
}

/** Une ligne par numéro de série (espaces, virgules ou retours à la ligne). */
export function splitSerials(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/).map(code => code.trim()).filter(Boolean))];
}
