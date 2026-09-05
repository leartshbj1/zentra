// Isolated simulated persistence for browser acceptance. Excluded from production.
import { desktopApi } from '../src/bridge';
import { refreshWorkspaceAfterMutation } from '../src/workspaceMutation';
import { supplierDraftLineTotals } from '../src/PurchaseOrdersScreen';
import type { SupplierCreditNote, SupplierInvoice, SupplierOrder, SupplierReceipt, Workspace } from '../src/types';

export function installPurchaseFulfillmentFixture(initial: Workspace) {
  const now = '2026-09-05T10:00:00Z';
  initial.settings!.organization.vatRegistered = !new URLSearchParams(location.search).has('nonRegistered');
  initial.settings!.billing.vatRatesBp = new URLSearchParams(location.search).has('oldVat') ? [0] : [810, 260, 0];
  initial.suppliers = [{ id: 'supplier-purchase-qa', name: 'Fournitures du Léman SA', contactName: '', email: '', phone: '', address: 'Rue du Lac 4, Lausanne', uidNumber: '', iban: '', currency: 'CHF', paymentTermsDays: 30, notes: '', archivedAt: null, createdAt: now, updatedAt: now }];
  initial.catalogItems = [{ id: 'product-purchase-qa', kind: 'product', sku: 'MAT-001', name: 'Panneaux acoustiques en bois pour la salle de réunion', description: '', unit: 'pièces', salesPriceCents: 15000, purchaseCostCents: 10000, vatBp: new URLSearchParams(location.search).has('oldVat') ? 770 : 810, trackStock: true, stockQuantityMilli: 5000, reorderLevelMilli: 1000, archivedAt: null, createdAt: now, updatedAt: now }];
  initial.accountingSettings = { enabled: true, arAccountId: 'ar', revenueAccountId: 'revenue', vatPayableAccountId: 'vat-out', vatDeferredPayableAccountId: 'vat-deferred', bankAccountId: 'bank', expenseAccountId: 'expense', vatReceivableAccountId: 'vat-in', wagesExpenseAccountId: 'wages', wagesPayableAccountId: 'wages-payable', socialExpenseAccountId: 'social', socialPayableAccountId: 'social-payable', supplierPayableAccountId: 'ap' };
  const invoice: SupplierInvoice = {
    id: 'invoice-purchase-qa', supplierId: initial.suppliers[0].id, projectId: null, documentDate: '2026-09-05', dueDate: '2026-10-05', supplierName: initial.suppliers[0].name, reference: 'FA-F-2026-0092', currency: 'CHF', documentStatus: 'draft', paymentStatus: 'pending', netCents: 20000, vatCents: 1620, totalCents: 21620, paidCents: 0, creditedCents: 0, balanceCents: 21620, matchStatus: 'unmatched', validatedAt: null, validationJournalEntryId: null, note: 'Première livraison partielle', payments: [], attachments: [], createdAt: now, updatedAt: now,
    lines: [{ id: 'invoice-line-purchase-qa', supplierInvoiceId: 'invoice-purchase-qa', position: 0, description: initial.catalogItems[0].name, quantityMilli: 2000, unit: 'pièces', unitPriceCents: 10000, discountBp: 0, vatBp: 810, netCents: 20000, vatCents: 1620, totalCents: 21620, category: 'Marchandises', expenseAccountId: 'expense', postedExpenseAccountId: null, projectId: null }],
  };
  initial.supplierInvoices = [invoice];
  let persisted = structuredClone(initial);
  let readFailures = 0;
  const writes = new Set<string>();
  const reminderSettings = desktopApi.getReminderSettings;
  desktopApi.getReminderSettings = async () => {
    sessionStorage.setItem('qa-purchase-reminder-checks', String(Number(sessionStorage.getItem('qa-purchase-reminder-checks') || 0) + 1));
    return reminderSettings();
  };
  const log = (operation: string, input: unknown) => {
    const key = `qa-purchase-${operation}-attempts`;
    sessionStorage.setItem(key, JSON.stringify([...JSON.parse(sessionStorage.getItem(key) || '[]'), structuredClone(input)]));
  };
  const failure = (operation: string) => {
    const mode = sessionStorage.getItem(`qa-purchase-${operation}-failure`);
    sessionStorage.removeItem(`qa-purchase-${operation}-failure`);
    if (mode === 'reject') throw new Error(`Refus ${operation} : la période comptable est fermée.`);
    return mode;
  };
  desktopApi.loadWorkspace = async () => {
    sessionStorage.setItem('qa-purchase-read-count', String(Number(sessionStorage.getItem('qa-purchase-read-count') || 0) + 1));
    if (sessionStorage.getItem('qa-purchase-hold-next-read') === '1') {
      sessionStorage.removeItem('qa-purchase-hold-next-read');
      await new Promise<void>((resolve) => window.addEventListener('qa-release-workspace-read', () => resolve(), { once: true }));
    }
    if (readFailures > 0 || sessionStorage.getItem('qa-purchase-block-reads') === '1') {
      readFailures = Math.max(0, readFailures - 1);
      throw new Error('Lecture temporairement indisponible.');
    }
    return structuredClone(persisted);
  };
  const afterWrite = async (mode: string | null) => {
    readFailures = mode === 'refresh_twice' || mode === 'refresh_held' ? 2 : mode === 'refresh_once' ? 1 : 0;
    if (mode === 'refresh_held') sessionStorage.setItem('qa-purchase-hold-next-read', '1');
    sessionStorage.setItem('qa-purchase-persisted', JSON.stringify({ orders: persisted.supplierOrders.length, receipts: persisted.supplierReceipts.length, issued: persisted.supplierReceipts.filter((receipt) => receipt.status === 'issued').length, stock: persisted.catalogItems[0].stockQuantityMilli, matches: persisted.supplierInvoiceMatches, validated: persisted.supplierInvoices.filter((row) => row.documentStatus === 'validated').length }));
    return refreshWorkspaceAfterMutation(desktopApi.loadWorkspace);
  };
  desktopApi.saveSupplierInvoiceDraft = async (input) => {
    log('invoice-draft', input); const mode = failure('invoice-draft'); const id = input.id || crypto.randomUUID();
    const lines = input.items.map((line, position) => ({ ...line, ...supplierDraftLineTotals(line), id: line.id || `${id}-line-${position}`, supplierInvoiceId: id, position, postedExpenseAccountId: null }));
    const row = { ...structuredClone(invoice), id, supplierId: input.supplierId, documentDate: input.date, dueDate: input.dueDate, reference: input.reference || '', note: input.note || '', projectId: input.projectId || null, lines, netCents: lines.reduce((sum, line) => sum + line.netCents, 0), vatCents: lines.reduce((sum, line) => sum + line.vatCents, 0), totalCents: lines.reduce((sum, line) => sum + line.totalCents, 0) } as SupplierInvoice;
    row.balanceCents = row.totalCents;
    persisted.supplierInvoices = [...persisted.supplierInvoices.filter((entry) => entry.id !== id), row];
    sessionStorage.setItem('qa-purchase-saved-invoice', JSON.stringify(row));
    return afterWrite(mode);
  };
  desktopApi.saveSupplierCreditNoteDraft = async (input) => {
    log('credit-draft', input); const mode = failure('credit-draft'); const id = input.id || crypto.randomUUID();
    const lines = input.items.map((line, position) => ({ ...line, ...supplierDraftLineTotals(line), id: line.id || `${id}-line-${position}`, supplierCreditNoteId: id, position, postedExpenseAccountId: null }));
    const credit = { id, supplierId: input.supplierId, documentDate: input.documentDate, number: '', reference: input.reference || '', note: input.note || '', status: 'draft', currency: 'CHF', supplierName: initial.suppliers[0].name, items: lines, netCents: lines.reduce((sum, line) => sum + line.netCents, 0), vatCents: lines.reduce((sum, line) => sum + line.vatCents, 0), totalCents: lines.reduce((sum, line) => sum + line.totalCents, 0), allocations: [], allocatedCents: 0, validatedAt: null, validationJournalEntryId: null, createdAt: now, updatedAt: now } as SupplierCreditNote;
    persisted.supplierCreditNotes = [...persisted.supplierCreditNotes.filter((entry) => entry.id !== id), credit];
    sessionStorage.setItem('qa-purchase-saved-credit', JSON.stringify(credit));
    return afterWrite(mode);
  };
  desktopApi.saveSupplierOrderDraft = async (input) => {
    log('order', input); const mode = failure('order'); const id = input.id || crypto.randomUUID();
    const lines = input.lines.map((line, position) => {
      const totals = supplierDraftLineTotals(line);
      return { ...line, id: line.id || `${id}-line-${position}`, supplierOrderId: id, catalogItemId: line.catalogItemId || null, expenseAccountId: line.expenseAccountId || null, projectId: line.projectId || null, cancelledQuantityMilli: 0, receivedQuantityMilli: 0, matchedQuantityMilli: 0, remainingReceivableMilli: line.quantityMilli, remainingMatchableMilli: 0, lineNetCents: totals.netCents, lineVatCents: totals.vatCents, lineTotalCents: totals.totalCents };
    });
    const order: SupplierOrder = { id, supplierId: input.supplierId, projectId: input.projectId || null, number: '', title: input.title, status: 'draft', orderDate: input.orderDate, currency: input.currency || 'CHF', subtotalCents: lines.reduce((sum, line) => sum + line.lineNetCents, 0), discountCents: 0, vatCents: lines.reduce((sum, line) => sum + line.lineVatCents, 0), totalCents: lines.reduce((sum, line) => sum + line.lineTotalCents, 0), notes: input.notes || '', terms: input.terms || '', confirmedAt: null, closedAt: null, cancelledAt: null, cancellationReason: '', createdAt: now, updatedAt: now, lines };
    persisted.supplierOrders = [...persisted.supplierOrders.filter((row) => row.id !== id), order];
    return afterWrite(mode);
  };
  desktopApi.confirmSupplierOrder = async (requestId, supplierOrderId) => {
    log('confirm', { requestId, supplierOrderId }); const mode = failure('confirm');
    const order = persisted.supplierOrders.find((row) => row.id === supplierOrderId)!;
    if (!writes.has(requestId)) { if (order.status !== 'draft') throw new Error('Commande déjà confirmée.'); order.status = 'confirmed'; order.number = 'CF-2026-001'; order.confirmedAt = now; writes.add(requestId); }
    return afterWrite(mode);
  };
  desktopApi.saveSupplierReceiptDraft = async (input) => {
    log('receipt', input); const mode = failure('receipt'); const id = input.id || crypto.randomUUID();
    const order = persisted.supplierOrders.find((row) => row.id === input.supplierOrderId)!;
    const receipt: SupplierReceipt = { id, supplierOrderId: order.id, number: '', status: 'draft', receiptDate: input.receiptDate, reference: input.reference || '', notes: input.notes || '', issuedAt: null, reversedAt: null, reversalReason: '', createdAt: now, updatedAt: now, lines: input.lines.map((line, position) => { const source = order.lines.find((row) => row.id === line.supplierOrderLineId)!; return { ...line, id: `${id}-line-${position}`, supplierReceiptId: id, position, description: source.description, unit: source.unit }; }) };
    persisted.supplierReceipts = [...persisted.supplierReceipts.filter((row) => row.id !== id), receipt];
    return afterWrite(mode);
  };
  desktopApi.issueSupplierReceipt = async (requestId, supplierReceiptId) => {
    log('issue', { requestId, supplierReceiptId }); const mode = failure('issue');
    const receipt = persisted.supplierReceipts.find((row) => row.id === supplierReceiptId)!;
    if (!writes.has(requestId)) { if (receipt.status !== 'draft') throw new Error('Réception déjà émise.'); receipt.status = 'issued'; receipt.number = 'REC-2026-001'; receipt.issuedAt = now; persisted.catalogItems[0].stockQuantityMilli += receipt.lines.reduce((sum, line) => sum + line.quantityMilli, 0); writes.add(requestId); }
    return afterWrite(mode);
  };
  desktopApi.reverseSupplierReceipt = async (requestId, supplierReceiptId, reason) => {
    log('reverse', { requestId, supplierReceiptId, reason }); const mode = failure('reverse');
    const receipt = persisted.supplierReceipts.find((row) => row.id === supplierReceiptId)!;
    if (!writes.has(requestId)) { receipt.status = 'reversed'; receipt.reversedAt = now; receipt.reversalReason = reason; persisted.catalogItems[0].stockQuantityMilli -= receipt.lines.reduce((sum, line) => sum + line.quantityMilli, 0); writes.add(requestId); }
    return afterWrite(mode);
  };
  desktopApi.saveSupplierInvoiceMatch = async (input) => {
    log('match', input); const mode = failure('match');
    if (!writes.has(input.requestId)) {
      persisted.supplierInvoiceMatches = [...persisted.supplierInvoiceMatches.filter((row) => row.supplierInvoiceId !== input.supplierInvoiceId), ...input.allocations.map((allocation) => ({ ...allocation, id: crypto.randomUUID(), requestId: input.requestId, supplierInvoiceId: input.supplierInvoiceId, supplierOrderId: allocation.supplierOrderId || input.supplierOrderId, supplierReceiptLineId: allocation.supplierReceiptLineId || null, netCents: 20000, vatCents: 1620, totalCents: 21620, createdAt: now }))];
      persisted.supplierInvoices[0].matchStatus = input.allocations.length ? 'matched' : 'unmatched'; writes.add(input.requestId);
    }
    return afterWrite(mode);
  };
  desktopApi.validateSupplierInvoice = async (id) => {
    log('validate', { id }); const mode = failure('validate');
    const row = persisted.supplierInvoices.find((entry) => entry.id === id)!;
    row.documentStatus = 'validated'; row.validatedAt = now; row.validationJournalEntryId = 'journal-purchase-qa';
    return afterWrite(mode);
  };
}
