import { desktopApi } from '../src/bridge';
import { posApi, posDayFromRaw } from '../src/openApi';
import { lineAmounts } from '../src/pos';
import type { CatalogItem, Workspace } from '../src/types';

/** Comptoir de recette : une journée avec trois tickets, dont un annulé, et Payrexx actif. */
export function installPosFixture(data: Workspace) {
  const article = (id: string, name: string, price: number, vatBp: number, unit = 'pce'): CatalogItem => ({ id, sku: id.toUpperCase(), name, description: '', unit, kind: 'product', salesPriceCents: price, purchaseCostCents: 0, vatBp, trackStock: true, stockQuantityMilli: 20_000, reorderLevelMilli: 2000, archivedAt: null });
  data.catalogItems = [article('caf-500', 'Café en grains 500 g', 1850, 260), article('the-250', 'Thé vert 250 g', 1290, 260), article('tasse', 'Tasse en grès', 2400, 810), article('air-28', 'Chambre à air 28 pouces', 1200, 810), article('frein', 'Patins de frein', 1650, 810), { ...article('repar', 'Réparation de vélo', 4500, 810, 'h'), kind: 'service', trackStock: false, stockQuantityMilli: 0 }, ...data.catalogItems];
  const today = new Date().toISOString().slice(0, 10);
  const line = (id: string, ticketId: string, description: string, quantityMilli: number, unitPriceCents: number, vatBp: number) => {
    const amounts = lineAmounts({ quantityMilli, unitPriceCents, discountBp: 0, vatBp });
    return { id, ticket_id: ticketId, position: 0, catalog_item_id: null, description, quantity_milli: quantityMilli, unit: 'pce', unit_price_cents: unitPriceCents, discount_bp: 0, vat_bp: vatBp,
      line_net_cents: amounts.netCents, line_vat_cents: amounts.vatCents, line_total_cents: amounts.totalCents, stock_moved: 1 };
  };
  const lines = [line('l1', 't1', 'Café en grains 500 g', 2000, 1850, 260), line('l2', 't2', 'Réparation de vélo', 1000, 4500, 810), line('l3', 't3', 'Chambre à air', 1000, 1200, 810)];
  const ticket = (id: string, number: string, method: string, total: number, extra: Record<string, unknown> = {}) => ({ id, number, kind: 'sale', ticket_date: today, payment_method: method, currency: 'CHF', subtotal_cents: 0, vat_cents: 0, total_cents: total, created_at: `${today}T0${id.slice(1)}:00:00Z`, ...extra });
  const tickets = [
    ticket('t1', 'T-2026-00041-3F2A', 'cash', 3796, { received_cents: 5000, change_cents: 1204 }),
    ticket('t2', 'T-2026-00042-9C10', 'payrexx', 4865, { payment_reference: '81234' }),
    ticket('t3', 'T-2026-00043-77AB', 'terminal', 1297),
    { id: 'v3', number: 'A-2026-00043-77AB', kind: 'void', ticket_date: today, payment_method: 'terminal', currency: 'CHF', total_cents: 1297, voids_ticket_id: 't3', created_at: `${today}T09:00:00Z` },
  ];
  posApi.day = async (date) => posDayFromRaw({ date, tickets: date === today ? tickets : [], lines: date === today ? lines : [], totals: date === today ? { cash_cents: 3796, payrexx_cents: 4865, terminal_cents: 0, total_cents: 8661, ticket_count: 2 } : {}, closing: null });
  desktopApi.getOnlinePaymentSettings = async () => ({ enabled: true, provider: 'payrexx', instance: 'atelier', secretPresent: true });
}
