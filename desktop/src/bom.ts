import type { CatalogItem } from './types';

/** Nomenclature : les composants d'un produit fini, pour un lot de `outputQuantityMilli`. */
export type BillOfMaterials = { id: string; catalogItemId: string; outputQuantityMilli: number; notes: string; lines: { componentItemId: string; quantityMilli: number }[] };
export type ProductionOrder = { id: string; catalogItemId: string; quantityMilli: number; productionDate: string; reference: string; components: { catalogItemId: string; name: string; quantityMilli: number; tracked: boolean }[] };

type RawRow = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function billsFromRaw(boms: readonly RawRow[], lines: readonly RawRow[]): BillOfMaterials[] {
  return boms.map(row => ({
    id: text(row.id), catalogItemId: text(row.catalog_item_id), outputQuantityMilli: number(row.output_quantity_milli) || 1_000, notes: text(row.notes),
    lines: lines.filter(line => line.bom_id === row.id).sort((a, b) => number(a.position) - number(b.position)).map(line => ({ componentItemId: text(line.component_item_id), quantityMilli: number(line.quantity_milli) })),
  }));
}

export function productionOrdersFromRaw(rows: readonly RawRow[]): ProductionOrder[] {
  return rows.map(row => {
    let components: ProductionOrder['components'] = [];
    try {
      const parsed = JSON.parse(text(row.components_json) || '[]') as RawRow[];
      components = parsed.map(item => ({ catalogItemId: text(item.catalog_item_id), name: text(item.name), quantityMilli: number(item.quantity_milli), tracked: item.tracked === true }));
    } catch { components = []; }
    return { id: text(row.id), catalogItemId: text(row.catalog_item_id), quantityMilli: number(row.quantity_milli), productionDate: text(row.production_date), reference: text(row.reference), components };
  }).sort((a, b) => b.productionDate.localeCompare(a.productionDate));
}

/** Même calcul que l'app native : ligne × quantité ÷ lot, au millième supérieur. */
export function componentNeed(lineMilli: number, quantityMilli: number, outputMilli: number): number {
  const numerator = BigInt(lineMilli) * BigInt(quantityMilli), output = BigInt(outputMilli);
  return Number((numerator + output - 1n) / output);
}

export type ComponentRequirement = { item: CatalogItem | undefined; componentItemId: string; needMilli: number; availableMilli: number | null; costCents: number };

/** Besoins, disponibilité (articles suivis seulement) et coût des composants pour une production. */
export function requirements(bom: BillOfMaterials, quantityMilli: number, items: readonly CatalogItem[], available: (item: CatalogItem) => number): ComponentRequirement[] {
  return bom.lines.map(line => {
    const item = items.find(row => row.id === line.componentItemId);
    const needMilli = componentNeed(line.quantityMilli, quantityMilli, bom.outputQuantityMilli);
    return { item, componentItemId: line.componentItemId, needMilli, availableMilli: item?.kind === 'product' && item.trackStock ? available(item) : null,
      costCents: Math.round((item?.purchaseCostCents ?? 0) * needMilli / 1000) };
  });
}

/** Le plus grand nombre de produits finis faisable avec le stock disponible, en unités entières. */
export function maxProducible(bom: BillOfMaterials, items: readonly CatalogItem[], available: (item: CatalogItem) => number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const line of bom.lines) {
    const item = items.find(row => row.id === line.componentItemId);
    if (!item || item.kind !== 'product' || !item.trackStock) continue;
    const perUnit = componentNeed(line.quantityMilli, 1_000, bom.outputQuantityMilli);
    best = Math.min(best, Math.floor(available(item) / perUnit));
  }
  return Number.isFinite(best) ? Math.max(0, best) : 0;
}
