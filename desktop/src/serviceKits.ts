/**
 * Kits de prestations : une prestation du catalogue composée de matériel et
 * de main-d'œuvre. Même calcul que `src-tauri/src/service_kits.rs` (quantité
 * en millièmes × prix unitaire, au centime) pour l'aperçu à l'écran.
 */
export type ServiceKitLine = { kind: 'material' | 'labor'; componentItemId: string | null; description: string; quantityMilli: number; unitPriceCents: number; unitCostCents: number };
export type ServiceKit = { catalogItemId: string; notes: string; lines: ServiceKitLine[] };

type RawRow = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value));
const integer = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0);

export function serviceKitsFromRaw(kits: readonly RawRow[], lines: readonly RawRow[]): ServiceKit[] {
  return kits.map(row => ({
    catalogItemId: text(row.catalog_item_id), notes: text(row.notes),
    lines: lines.filter(line => line.kit_item_id === row.catalog_item_id).sort((a, b) => integer(a.position) - integer(b.position)).map(line => ({
      kind: line.kind === 'labor' ? 'labor' : 'material', componentItemId: text(line.component_item_id) || null, description: text(line.description),
      quantityMilli: integer(line.quantity_milli), unitPriceCents: integer(line.unit_price_cents), unitCostCents: integer(line.unit_cost_cents),
    })),
  }));
}

/** Montant d'une ligne : quantité (millièmes) × prix unitaire, arrondi au centime. */
export function kitLineAmount(quantityMilli: number, unitCents: number): number {
  return Number((BigInt(quantityMilli) * BigInt(unitCents) + 500n) / 1_000n);
}

export function kitTotals(lines: readonly ServiceKitLine[]): { priceCents: number; costCents: number; laborMinutes: number; materialCostCents: number } {
  return lines.reduce((total, line) => ({
    priceCents: total.priceCents + kitLineAmount(line.quantityMilli, line.unitPriceCents),
    costCents: total.costCents + kitLineAmount(line.quantityMilli, line.unitCostCents),
    laborMinutes: total.laborMinutes + (line.kind === 'labor' ? Math.round((line.quantityMilli * 60) / 1_000) : 0),
    materialCostCents: total.materialCostCents + (line.kind === 'material' ? kitLineAmount(line.quantityMilli, line.unitCostCents) : 0),
  }), { priceCents: 0, costCents: 0, laborMinutes: 0, materialCostCents: 0 });
}
