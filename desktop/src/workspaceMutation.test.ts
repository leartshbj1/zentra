import { beforeEach, describe, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

const request = '39c85c22-7fc0-42d0-95f9-c1ad536fe2cf';
const operations = [
  { command: 'create_recurrence_schedule', run: () => desktopApi.createRecurrenceSchedule({ requestId: request, sourceSalesOrderId: 'order', frequency: 'monthly', startDate: '2026-09-01', endDate: null, paymentTermsDays: 30 }) },
  { command: 'update_recurrence_schedule', run: () => desktopApi.updateRecurrenceSchedule({ requestId: request, scheduleId: 'schedule', status: 'paused', endDate: null }) },
  { command: 'generate_recurrence_occurrences', run: () => desktopApi.generateRecurrenceOccurrences({ requestId: request, scheduleId: 'schedule', throughDate: '2026-09-05' }) },
  { command: 'save_delivery_note_draft', run: () => desktopApi.saveDeliveryNoteDraft({ id: request, salesOrderId: 'order', deliveryDate: '2026-09-05', lines: [{ salesOrderLineId: 'line', quantityMilli: 2000 }] }) },
  { command: 'issue_delivery_note', run: () => desktopApi.issueDeliveryNote(request, 'delivery') },
  { command: 'reverse_delivery_note', run: () => desktopApi.reverseDeliveryNote(request, 'delivery', 'Retour client') },
  { command: 'confirm_sales_order', run: () => desktopApi.confirmSalesOrder(request, 'order') },
  { command: 'create_sales_order_invoice', run: () => desktopApi.createSalesOrderInvoice({ requestId: request, salesOrderId: 'order', serviceDateFrom: '2026-09-01', serviceDateTo: '2026-09-05', allocations: [{ salesOrderLineId: 'line', deliveryNoteLineId: 'delivery-line', quantityMilli: 2000 }] }) },
  { command: 'save_supplier_order_draft', run: () => desktopApi.saveSupplierOrderDraft({ id: request, supplierId: 'supplier', title: 'Marchandises', orderDate: '2026-09-01', lines: [] }) },
  { command: 'confirm_supplier_order', run: () => desktopApi.confirmSupplierOrder(request, 'order') },
  { command: 'cancel_supplier_order_remainder', run: () => desktopApi.cancelSupplierOrderRemainder(request, 'order', 'Solde annulé', []) },
  { command: 'save_supplier_receipt_draft', run: () => desktopApi.saveSupplierReceiptDraft({ id: request, supplierOrderId: 'order', receiptDate: '2026-09-02', lines: [] }) },
  { command: 'issue_supplier_receipt', run: () => desktopApi.issueSupplierReceipt(request, 'receipt') },
  { command: 'reverse_supplier_receipt', run: () => desktopApi.reverseSupplierReceipt(request, 'receipt', 'Retour au fournisseur') },
  { command: 'save_supplier_invoice_match', run: () => desktopApi.saveSupplierInvoiceMatch({ requestId: request, supplierInvoiceId: 'invoice', supplierOrderId: 'order', allocations: [] }) },
  { command: 'save_supplier_credit_note_draft', run: () => desktopApi.saveSupplierCreditNoteDraft({ id: request, supplierId: 'supplier', documentDate: '2026-09-02', items: [], allocations: [] }) },
  { command: 'validate_supplier_credit_note', run: () => desktopApi.validateSupplierCreditNote(request, 'credit') },
  { command: 'delete_supplier_credit_note_draft', run: () => desktopApi.deleteSupplierCreditNoteDraft('credit') },
  { command: 'apply_supplier_credit', run: () => desktopApi.applySupplierCredit(request, 'credit', 'invoice', 1000, '2026-09-02') },
  { command: 'reverse_supplier_credit_allocation', run: () => desktopApi.reverseSupplierCreditAllocation(request, 'allocation', 'Correction de facture', '2026-09-03') },
  { command: 'reclassify_supplier_invoice_expense', run: () => desktopApi.reclassifySupplierInvoiceExpense({ requestId: request, supplierInvoiceId: 'invoice', effectiveDate: '2026-09-02', reason: 'Correction de compte', lines: [] }) },
  { command: 'validate_supplier_invoice', run: () => desktopApi.validateSupplierInvoice('invoice') },
];

describe('reprise des ventes et achats après écriture locale confirmée', () => {
  beforeEach(() => { invokeMock.mockReset(); });
  it.each(operations)('$command distingue une écriture confirmée d’une lecture interrompue', async ({ command, run }) => {
    const cause = new Error('Lecture interrompue');
    invokeMock.mockImplementation(async (name: string) => {
      if (name === command) return {};
      if (name === 'get_app_state') throw cause;
      throw new Error(`unexpected ${name}`);
    });
    const error = await run().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect((error as WorkspaceRefreshAfterMutationError).refreshCause).toBe(cause);
    expect(invokeMock.mock.calls.map(([name]) => name)).toEqual([command, 'get_app_state']);
  });
  it.each(operations)('$command ne présente jamais un refus natif comme une écriture réussie', async ({ command, run }) => {
    const error = new Error('Période fermée');
    invokeMock.mockRejectedValue(error);
    await expect(run()).rejects.toBe(error);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe(command);
  });
  it('renvoie directement les données lorsque l’écriture et la lecture réussissent', async () => {
    invokeMock.mockImplementation(async (command: string) => command === 'get_app_state' ? { onboarding_completed: 0 } : {});
    const workspace = await operations.find((operation) => operation.command === 'save_delivery_note_draft')!.run();
    expect(workspace.onboardingCompleted).toBe(false);
    expect(invokeMock.mock.calls.map(([name]) => name)).toEqual(['save_delivery_note_draft', 'get_app_state']);
  });
});
