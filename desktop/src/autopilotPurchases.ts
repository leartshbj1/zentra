import type { MailSignal } from './autopilotSignals';
import type { CatalogItem, StockAvailability, Supplier, SupplierInvoice, SupplierOrder, SupplierOrderLine } from './types';

/** Purchases Autopilote prepares: invoices to pay soon, low stock, deliveries announced by suppliers. */
const lower = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();
const addDays = (iso: string, days: number) => new Date(Date.parse(iso + 'T12:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);

/** Validated supplier invoices with a balance, overdue or due within 5 days, earliest first. */
export function invoicesToPay(invoices: readonly SupplierInvoice[], today: string): SupplierInvoice[] {
  const limit = addDays(today, 5);
  return invoices.filter(invoice => invoice.documentStatus === 'validated' && invoice.balanceCents > 0 && !!invoice.dueDate && invoice.dueDate <= limit)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/** Stocked items at or under their threshold that no open supplier order already covers. */
export function lowStockItems(items: readonly CatalogItem[], availability: readonly StockAvailability[], orders: readonly SupplierOrder[]) {
  const open = new Set(orders.filter(order => order.status === 'draft' || order.status === 'confirmed')
    .flatMap(order => order.lines.filter(line => line.remainingReceivableMilli > 0 || order.status === 'draft').map(line => line.catalogItemId)));
  return items.flatMap(item => {
    if (item.archivedAt || !item.trackStock || item.reorderLevelMilli <= 0 || open.has(item.id)) return [];
    const onHand = availability.find(row => row.catalogItemId === item.id)?.onHandMilli ?? item.stockQuantityMilli;
    return onHand <= item.reorderLevelMilli ? [{ item, onHandMilli: onHand }] : [];
  });
}

/** The supplier and line to reorder from: the latest order of this item, else none. */
export function lastOrderLine(itemId: string, orders: readonly SupplierOrder[]): Readonly<{ order: SupplierOrder; line: SupplierOrderLine }> | null {
  const rows = orders.filter(order => order.status !== 'cancelled').flatMap(order => order.lines.filter(line => line.catalogItemId === itemId).map(line => ({ order, line })))
    .sort((a, b) => b.order.orderDate.localeCompare(a.order.orderDate));
  return rows[0] ?? null;
}

const SHIPPED = /exp[ée]di|livraison|versand|versandt|geliefert|spedit|consegna|shipped|shipping|dispatch/i;
/** A supplier's order mail: confirmed or shipped, matched to its open order when there is only one. */
export function supplierOrderProposal(signal: MailSignal, suppliers: readonly Supplier[], orders: readonly SupplierOrder[]) {
  const email = lower(signal.sender?.email), company = lower(signal.sender?.company);
  const supplier = suppliers.find(row => !row.archivedAt && email && lower(row.email) === email)
    ?? suppliers.find(row => !row.archivedAt && company && lower(row.name) === company) ?? null;
  const open = supplier ? orders.filter(order => order.supplierId === supplier.id && order.status === 'confirmed'
    && order.lines.some(line => line.remainingReceivableMilli > 0)) : [];
  return { supplier, shipped: SHIPPED.test(signal.subject + ' ' + signal.evidence), order: open.length === 1 ? open[0] : null, several: open.length > 1 };
}
