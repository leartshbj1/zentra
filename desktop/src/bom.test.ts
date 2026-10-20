import { describe, expect, it } from 'vitest';
import { billsFromRaw, componentNeed, maxProducible, productionOrdersFromRaw, requirements } from './bom';
import type { CatalogItem } from './types';

const item = (id: string, patch: Partial<CatalogItem> = {}): CatalogItem => ({ id, kind: 'product', sku: '', name: id, description: '', unit: 'pce', salesPriceCents: 0, purchaseCostCents: 0, vatBp: 0,
  trackStock: true, stockQuantityMilli: 0, reorderLevelMilli: 0, archivedAt: null, createdAt: '', updatedAt: '', ...patch } as CatalogItem);
const [bom] = billsFromRaw([{ id: 'b', catalog_item_id: 'table', output_quantity_milli: 1_000, notes: '' }],
  [{ bom_id: 'b', position: 1, component_item_id: 'leg', quantity_milli: 4_000 }, { bom_id: 'b', position: 0, component_item_id: 'top', quantity_milli: 1_000 }, { bom_id: 'b', position: 2, component_item_id: 'screw', quantity_milli: 16_000 }]);
const items = [item('top', { purchaseCostCents: 12_000 }), item('leg', { purchaseCostCents: 1_850 }), item('screw', { trackStock: false, purchaseCostCents: 15 })];
const stock: Record<string, number> = { top: 3_000, leg: 10_000 };

describe('bills of materials', () => {
  it('keeps the lines in order', () => {
    expect(bom.lines.map(line => line.componentItemId)).toEqual(['top', 'leg', 'screw']);
  });

  it('rounds needs up like the native app', () => {
    expect(componentNeed(4_000, 3_000, 1_000)).toBe(12_000);
    expect(componentNeed(1_000, 1_000, 3_000)).toBe(334);
  });

  it('lists needs, stock and cost for a production', () => {
    const rows = requirements(bom, 2_000, items, row => stock[row.id] ?? 0);
    expect(rows.map(row => [row.componentItemId, row.needMilli, row.availableMilli, row.costCents])).toEqual([['top', 2_000, 3_000, 24_000], ['leg', 8_000, 10_000, 14_800], ['screw', 32_000, null, 480]]);
  });

  it('finds how many can be made', () => {
    expect(maxProducible(bom, items, row => stock[row.id] ?? 0)).toBe(2);
    expect(maxProducible({ ...bom, lines: [{ componentItemId: 'screw', quantityMilli: 1 }] }, items, () => 0)).toBe(0);
  });

  it('reads production history', () => {
    const [order] = productionOrdersFromRaw([{ id: 'p', catalog_item_id: 'table', quantity_milli: 2_000, production_date: '2026-10-05', reference: 'OF-1', components_json: '[{"catalog_item_id":"top","name":"Plateau","quantity_milli":2000,"tracked":true}]' }]);
    expect(order.components[0]).toEqual({ catalogItemId: 'top', name: 'Plateau', quantityMilli: 2_000, tracked: true });
    expect(productionOrdersFromRaw([{ id: 'x', components_json: 'not json' }])[0].components).toEqual([]);
  });
});
