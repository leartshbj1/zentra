import { describe, expect, it } from 'vitest';
import { depreciationDue, inventoryDue, ordersReadyToDeliver } from './autopilotYearEnd';
import { proposeForSignal, type MailSignal } from './autopilotSignals';
import type { FixedAssetRow } from './fixedAssets';
import type { CatalogItem } from './types';

const row = (id: string, nextYear: number, nextAmountCents: number, patch: Partial<FixedAssetRow> = {}): FixedAssetRow => ({
  asset: { id, name: id, reference: '', date: '2024-01-10', costCents: 500_000, residualCents: 0, rateBp: 2_000, method: 'linear', mode: 'purchase', assetAccountId: 'a', depreciationAccountId: 'd', counterpartAccountId: 'c' },
  depreciatedCents: 0, bookValueCents: 500_000, cancelled: false, nextYear, nextAmountCents, blocker: null, history: [], ...patch });
const item = (id: string, patch: Partial<CatalogItem> = {}): CatalogItem => ({ id, kind: 'product', sku: '', name: id, description: '', unit: 'pce', salesPriceCents: 0, purchaseCostCents: 0, vatBp: 0,
  trackStock: true, stockQuantityMilli: 5_000, reorderLevelMilli: 0, archivedAt: null, createdAt: '', updatedAt: '', ...patch } as CatalogItem);

describe('year end and delivery cards', () => {
  it('asks for the year’s depreciation in December and until March', () => {
    const rows = [row('van', 2026, 100_000), row('pc', 2026, 30_000), row('old', 2027, 10_000), row('blocked', 2026, 5_000, { blocker: 'Comptes manquants' }), row('sold', 2026, 5_000, { cancelled: true })];
    expect(depreciationDue(rows, '2026-12-15')).toMatchObject({ year: 2026, totalCents: 130_000 });
    expect(depreciationDue(rows, '2027-02-01')?.rows.map(entry => entry.asset.id)).toEqual(['van', 'pc']);
    expect(depreciationDue(rows, '2026-10-20')).toBeNull();
    expect(depreciationDue([row('done', 2027, 100_000)], '2027-01-10')).toBeNull();
  });

  it('lists products still to count for the year-end inventory', () => {
    const items = [item('a'), item('b'), item('service', { kind: 'service' }), item('untracked', { trackStock: false })];
    const movements = [{ catalogItemId: 'a', movementType: 'correction' as const, movementDate: '2026-12-03' }, { catalogItemId: 'b', movementType: 'correction' as const, movementDate: '2026-11-20' }];
    expect(inventoryDue(items, movements, '2026-12-10')?.items.map(entry => entry.id)).toEqual(['b']);
    expect(inventoryDue(items, movements, '2027-01-10')).toMatchObject({ year: 2026 });
    expect(inventoryDue(items, movements, '2027-01-20')).toBeNull();
  });

  it('finds confirmed orders whose remaining delivery is in stock', () => {
    const line = (id: string, catalogItemId: string, quantityMilli: number) => ({ id, salesOrderId: 'o', catalogItemId, position: 0, description: id, quantityMilli, cancelledQuantityMilli: 0, unit: 'pce',
      unitPriceCents: 0, discountBp: 0, vatBp: 0, lineGrossCents: 0, fulfillmentMode: 'stock' });
    const order = (id: string, lines: unknown[]) => ({ id, status: 'confirmed', lines }) as never;
    const workspace = { salesOrders: [order('ready', [line('l1', 'a', 2_000)]), order('short', [line('l2', 'a', 9_000)])], deliveryNotes: [], invoices: [], salesOrderInvoiceBatches: [], salesOrderInvoiceAllocations: [],
      stockReservationEvents: [], stockAvailability: [], catalogItems: [item('a')] } as never;
    expect(ordersReadyToDeliver(workspace).map((entry: { id: string }) => entry.id)).toEqual(['ready']);
  });

  it('prepares a credit note when a complaint names an issued invoice', () => {
    const signal = { kind: 'follow_up', sourceId: 's', receivedAt: 1, subject: 'Réclamation', evidence: 'La facture F-2026-0016 compte deux heures de trop.', quoteReference: null, invoiceReference: 'F-2026-0016',
      amountCents: null, currency: null, documentType: null, sender: null, requiresHumanValidation: true } as unknown as MailSignal;
    const invoice = { id: 'i', number: 'F-2026-0016', type: 'standard', status: 'issued', clientId: 'c' } as never;
    const data = { invoices: [invoice], payments: [], quotes: [], clients: [], suppliers: [], supplierInvoices: [] };
    expect(proposeForSignal(signal, data)).toMatchObject({ action: 'credit_note', invoice: { id: 'i' } });
    expect(proposeForSignal({ ...signal, invoiceReference: null } as MailSignal, data)).toMatchObject({ action: 'follow_up' });
  });
});
