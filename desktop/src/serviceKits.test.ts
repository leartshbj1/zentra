import { describe, expect, it } from 'vitest';
import { kitLineAmount, kitTotals, serviceKitsFromRaw } from './serviceKits';

describe('kits de prestations', () => {
  it('additionne matériel et main-d’œuvre comme l’app native', () => {
    const [kit] = serviceKitsFromRaw([{ catalog_item_id: 'k', notes: '' }], [
      { kit_item_id: 'k', position: 2, kind: 'labor', description: 'Électricien', quantity_milli: 750, unit_price_cents: 9_600, unit_cost_cents: 6_500 },
      { kit_item_id: 'k', position: 0, kind: 'material', component_item_id: 'socket', description: 'Prise T13', quantity_milli: 1_000, unit_price_cents: 1_250, unit_cost_cents: 875 },
      { kit_item_id: 'k', position: 1, kind: 'material', component_item_id: 'box', description: 'Boîte', quantity_milli: 1_000, unit_price_cents: 320, unit_cost_cents: 180 },
      { kit_item_id: 'other', position: 0, kind: 'material', description: 'Autre', quantity_milli: 1_000, unit_price_cents: 1, unit_cost_cents: 1 },
    ]);
    expect(kit.lines.map(line => line.description)).toEqual(['Prise T13', 'Boîte', 'Électricien']);
    expect(kitTotals(kit.lines)).toEqual({ priceCents: 8_770, costCents: 5_930, laborMinutes: 45, materialCostCents: 1_055 });
    expect(kitLineAmount(333, 100)).toBe(33);
    expect(kitLineAmount(335, 100)).toBe(34);
  });
});
