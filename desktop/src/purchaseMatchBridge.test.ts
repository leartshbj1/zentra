import { describe, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

describe('supplier invoice allocation transport', () => {
  it('sends each receipt and direct allocation once to its own order in one atomic native command', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'save_supplier_invoice_match') return { success: true };
      throw new Error('Read interrupted');
    });
    await expect(desktopApi.saveSupplierInvoiceMatch({
      requestId: 'match-1', supplierInvoiceId: 'invoice-1', supplierOrderId: 'order-a',
      allocations: [
        { supplierInvoiceItemId: 'panels', supplierOrderLineId: 'line-a', supplierReceiptLineId: 'receipt-a-1', quantityMilli: 1000 },
        { supplierOrderId: 'order-b', supplierInvoiceItemId: 'service', supplierOrderLineId: 'line-b', supplierReceiptLineId: null, quantityMilli: 1000 },
        { supplierOrderId: 'order-a', supplierInvoiceItemId: 'panels', supplierOrderLineId: 'line-a', supplierReceiptLineId: 'receipt-a-2', quantityMilli: 1000 },
      ],
    })).rejects.toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect(invokeMock.mock.calls.filter(([command]) => command === 'save_supplier_invoice_match')).toEqual([[
      'save_supplier_invoice_match', { input: {
        request_id: 'match-1', supplier_invoice_id: 'invoice-1', supplier_order_id: 'order-a',
        allocations: [
          { supplier_invoice_item_id: 'panels', supplier_order_line_id: 'line-a', supplier_receipt_line_id: 'receipt-a-1', quantity_milli: 1000 },
          { supplier_invoice_item_id: 'panels', supplier_order_line_id: 'line-a', supplier_receipt_line_id: 'receipt-a-2', quantity_milli: 1000 },
        ],
        order_allocations: [{ supplier_order_id: 'order-b', allocations: [{ supplier_invoice_item_id: 'service', supplier_order_line_id: 'line-b', supplier_receipt_line_id: null, quantity_milli: 1000 }] }],
      } },
    ]]);
  });
});
