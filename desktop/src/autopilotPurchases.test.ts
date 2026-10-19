import { describe, expect, it } from 'vitest';
import { invoicesToPay, lastOrderLine, lowStockItems, supplierOrderProposal } from './autopilotPurchases';
import type { MailSignal } from './autopilotSignals';
import type { CatalogItem, Supplier, SupplierInvoice, SupplierOrder } from './types';

const invoice = (id: string, dueDate: string, values: Partial<SupplierInvoice> = {}) => ({ id, dueDate, documentStatus: 'validated', balanceCents: 100, ...values }) as SupplierInvoice;
const line = (values: Record<string, unknown>) => ({ id: 'l', catalogItemId: 'a', quantityMilli: 5000, remainingReceivableMilli: 0, ...values });
const order = (id: string, values: Partial<SupplierOrder> & { lines?: unknown[] }) => ({ id, supplierId: 'sup', status: 'confirmed', orderDate: '2026-10-01', lines: [], ...values }) as SupplierOrder;
const signal = (subject: string): MailSignal => ({ kind: 'supplier_order', sourceId: 's', receivedAt: 1, subject, evidence: '', quoteReference: null, invoiceReference: null,
  amountCents: null, currency: null, documentType: null, sender: { email: 'billing@acme.ch', name: null, company: null, phone: null, street: null, postcode: null, city: null, source: 'envelope' }, requiresHumanValidation: true });

describe('purchases Autopilote prepares', () => {
  it('lists validated invoices with a balance due within 5 days, earliest first', () => {
    const rows = [invoice('late', '2026-10-15'), invoice('soon', '2026-10-24'), invoice('later', '2026-11-30'), invoice('draft', '2026-10-15', { documentStatus: 'draft' }), invoice('paid', '2026-10-15', { balanceCents: 0 })];
    expect(invoicesToPay(rows, '2026-10-20').map(row => row.id)).toEqual(['late', 'soon']);
  });
  it('finds low stock not already on order, and the last order line to repeat', () => {
    const items = [{ id: 'a', trackStock: true, reorderLevelMilli: 2000, stockQuantityMilli: 1000 }, { id: 'b', trackStock: true, reorderLevelMilli: 2000, stockQuantityMilli: 1000 },
      { id: 'c', trackStock: true, reorderLevelMilli: 2000, stockQuantityMilli: 5000 }] as CatalogItem[];
    const orders = [order('o1', { status: 'confirmed', lines: [line({ catalogItemId: 'b', remainingReceivableMilli: 1000 })] }), order('o0', { status: 'closed', orderDate: '2026-09-01', lines: [line({})] })];
    expect(lowStockItems(items, [], orders).map(row => row.item.id)).toEqual(['a']);
    expect(lastOrderLine('a', orders)?.order.id).toBe('o0');
  });
  it('matches a shipping notice to the single open order of the supplier', () => {
    const suppliers = [{ id: 'sup', name: 'Acme', email: 'billing@acme.ch' } as Supplier];
    const open = [order('o1', { lines: [line({ remainingReceivableMilli: 1000 })] })];
    expect(supplierOrderProposal(signal('Votre commande a été expédiée'), suppliers, open)).toMatchObject({ shipped: true, order: { id: 'o1' } });
    expect(supplierOrderProposal(signal('Confirmation de commande'), suppliers, [...open, order('o2', { lines: [line({ remainingReceivableMilli: 1 })] })])).toMatchObject({ shipped: false, order: null, several: true });
  });
});
