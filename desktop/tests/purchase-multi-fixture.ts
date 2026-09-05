import type { SupplierInvoice, SupplierOrder, Workspace } from '../src/types';

/** Real interface acceptance data; the independent Rust tests validate persistence and accounting. */
export function seedMultiOrderPurchase(initial: Workspace, invoice: SupplierInvoice) {
  const now = '2026-09-05T10:00:00Z';
  invoice.reference = 'FA-GROUPEE-2026-0095';
  invoice.note = 'Deux commandes et deux réceptions partielles';
  invoice.lines.push({ ...invoice.lines[0], id: 'invoice-line-service', position: 1, description: 'Pose et réglages', quantityMilli: 1000, unitPriceCents: 15000, netCents: 15000, vatCents: 1215, totalCents: 16215, category: 'Prestations' });
  invoice.netCents = 35000; invoice.vatCents = 2835; invoice.totalCents = invoice.balanceCents = 37835;
  const orders: SupplierOrder[] = invoice.lines.map((item, position) => {
    const id = `order-multi-${position + 1}`;
    return {
      id, supplierId: invoice.supplierId, projectId: null, number: `CF-2026-00${position + 1}`, title: position ? 'Pose et réglages' : 'Panneaux pour le bureau', status: 'confirmed', orderDate: '2026-09-01', currency: 'CHF', subtotalCents: item.netCents, discountCents: 0, vatCents: item.vatCents, totalCents: item.totalCents, notes: '', terms: '', confirmedAt: now, closedAt: null, cancelledAt: null, cancellationReason: '', createdAt: now, updatedAt: now,
      lines: [{ id: `${id}-line`, supplierOrderId: id, catalogItemId: position ? null : initial.catalogItems[0].id, position: 0, description: item.description, quantityMilli: item.quantityMilli, cancelledQuantityMilli: 0, receivedQuantityMilli: position ? 0 : 2000, matchedQuantityMilli: 0, remainingReceivableMilli: 0, remainingMatchableMilli: item.quantityMilli, unit: item.unit, unitPriceCents: item.unitPriceCents, discountBp: 0, vatBp: item.vatBp, lineNetCents: item.netCents, lineVatCents: item.vatCents, lineTotalCents: item.totalCents, category: item.category, expenseAccountId: item.expenseAccountId, projectId: null, fulfillmentMode: position ? 'direct' : 'stocked_receipt' }],
    };
  });
  initial.supplierOrders = [
    ...orders,
    { ...structuredClone(orders[1]), id: 'wrong-currency', number: 'CF-EUR', currency: 'EUR', lines: [{ ...orders[1].lines[0], id: 'line-eur', supplierOrderId: 'wrong-currency' }] },
    { ...structuredClone(orders[1]), id: 'future-order', number: 'CF-FUTURE', orderDate: '2026-10-01', lines: [{ ...orders[1].lines[0], id: 'line-future', supplierOrderId: 'future-order' }] },
    { ...structuredClone(orders[1]), id: 'foreign-order', number: 'CF-AUTRE-FOURNISSEUR', supplierId: 'foreign-supplier', lines: [{ ...orders[1].lines[0], id: 'line-foreign', supplierOrderId: 'foreign-order' }] },
  ];
  initial.supplierReceipts = [1, 2].map((position) => ({
    id: `receipt-multi-${position}`, supplierOrderId: orders[0].id, number: `REC-2026-00${position}`, status: 'issued', receiptDate: `2026-09-0${position + 1}`, reference: `BL-${position}`, notes: '', issuedAt: now, reversedAt: null, reversalReason: '', createdAt: now, updatedAt: now,
    lines: [{ id: `receipt-multi-${position}-line`, supplierReceiptId: `receipt-multi-${position}`, supplierOrderLineId: orders[0].lines[0].id, position: 0, quantityMilli: 1000, description: invoice.lines[0].description, unit: 'pièces' }],
  }));
  initial.catalogItems[0].stockQuantityMilli = 7000;
}
