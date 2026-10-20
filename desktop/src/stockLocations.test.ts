import { describe, expect, it } from 'vitest';
import { deliveriesToTrace, expiringLots, lotBalances, splitSerials, stockLocationsFromRaw, warehouseStock } from './stockLocations';
import type { DeliveryNote } from './types';

const locations = stockLocationsFromRaw({
  warehouses: [{ id: 'main', code: 'ATELIER', name: 'Atelier', is_default: 1, archived_at: null }, { id: 'van', code: 'VAN-1', name: 'Camionnette', is_default: 0 }],
  stock_movement_warehouses: [{ stock_movement_id: 'm3', warehouse_id: 'van' }],
  stock_transfers: [{ id: 't1', catalog_item_id: 'pipe', from_warehouse_id: 'main', to_warehouse_id: 'van', quantity_milli: 4_000, transfer_date: '2026-10-02', note: '' }],
  catalog_item_tracking: [{ catalog_item_id: 'valve', mode: 'serial' }, { catalog_item_id: 'glue', mode: 'lot' }],
  stock_lots: [
    { id: 'l1', catalog_item_id: 'glue', mode: 'lot', code: 'L-2210', expiry_date: '2026-11-10', created_at: '2026-09-01' },
    { id: 'l2', catalog_item_id: 'glue', mode: 'lot', code: 'L-2301', expiry_date: '2027-06-01', created_at: '2026-10-01' },
    { id: 's1', catalog_item_id: 'valve', mode: 'serial', code: 'SN-1', expiry_date: null, created_at: '2026-10-01' },
  ],
  stock_lot_movements: [
    { id: 'a', lot_id: 'l1', quantity_milli: 5_000, movement_date: '2026-09-01', source_type: 'receipt', reference: 'REC-1' },
    { id: 'b', lot_id: 'l1', quantity_milli: -2_000, movement_date: '2026-10-03', source_type: 'delivery', source_id: 'dn-1', reference: 'BL-1' },
    { id: 'c', lot_id: 'l2', quantity_milli: 3_000, movement_date: '2026-10-01', source_type: 'entry', reference: '' },
    { id: 'd', lot_id: 's1', quantity_milli: 1_000, movement_date: '2026-10-01', source_type: 'receipt', reference: 'REC-2' },
  ],
});

describe('stock locations', () => {
  it('splits stock by warehouse like the native app', () => {
    const stock = warehouseStock(locations, [
      { id: 'm1', catalogItemId: 'pipe', quantityDeltaMilli: 10_000 },
      { id: 'm2', catalogItemId: 'pipe', quantityDeltaMilli: -1_000 },
      { id: 'm3', catalogItemId: 'pipe', quantityDeltaMilli: 2_000 },
    ]);
    expect(Object.fromEntries(stock.get('pipe')!)).toEqual({ main: 5_000, van: 6_000 });
  });

  it('keeps lot balances and finds those about to expire', () => {
    const balances = lotBalances(locations, 'glue');
    expect(balances.map(row => [row.lot.code, row.balanceMilli, row.lastReference])).toEqual([['L-2210', 3_000, 'BL-1'], ['L-2301', 3_000, '']]);
    expect(expiringLots(balances, '2026-10-20').map(row => row.lot.code)).toEqual(['L-2210']);
    expect(expiringLots(balances, '2026-09-01')).toEqual([]);
  });

  it('asks to trace deliveries of tracked items', () => {
    const note = (id: string, lineIds: string[]): DeliveryNote => ({ id, salesOrderId: 'so', number: id.toUpperCase(), status: 'issued', deliveryDate: '2026-10-03', reference: '', notes: '', issuedAt: '', reversedAt: null,
      createdAt: '', updatedAt: '', lines: lineIds.map((salesOrderLineId, position) => ({ id: id + position, deliveryNoteId: id, salesOrderLineId, position, quantityMilli: 1_000, description: 'x', unit: 'pce' })) });
    const orders = [{ lines: [{ id: 'ol-glue', catalogItemId: 'glue' }, { id: 'ol-valve', catalogItemId: 'valve' }, { id: 'ol-pipe', catalogItemId: 'pipe' }] }] as never;
    const result = deliveriesToTrace([note('dn-1', ['ol-glue', 'ol-valve', 'ol-pipe']), note('dn-2', ['ol-pipe'])], orders, locations);
    expect(result.map(row => [row.note.id, row.catalogItemIds])).toEqual([['dn-1', ['valve']]]);
  });

  it('reads serial numbers typed or pasted', () => {
    expect(splitSerials('SN-1, SN-2\nSN-3  SN-2')).toEqual(['SN-1', 'SN-2', 'SN-3']);
  });
});
