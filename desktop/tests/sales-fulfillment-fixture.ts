// Isolated simulated persistence for browser acceptance, never imported by production.
import { desktopApi } from '../src/bridge';
import { refreshWorkspaceAfterMutation } from '../src/workspaceMutation';
import type { DeliveryNote, Invoice, SalesOrder, Workspace } from '../src/types';

export function installSalesFulfillmentFixture(initial: Workspace) {
  const order: SalesOrder = {
    id: 'sales-order-qa', number: 'CMD-2026-001', title: 'Aménagement du bureau et installation des équipements',
    clientId: initial.clients[0].id, projectId: null, quoteId: null, status: 'confirmed', orderDate: '2026-01-05', currency: 'CHF',
    subtotalCents: 110000, discountCents: 0, vatCents: 8910, totalCents: 118910, notes: '', terms: '',
    confirmedAt: '2026-01-05T10:00:00Z', closedAt: null, cancelledAt: null, createdAt: '2026-01-05T10:00:00Z', updatedAt: '2026-01-05T10:00:00Z',
    lines: [
      { id: 'sales-line-product', salesOrderId: 'sales-order-qa', catalogItemId: null, position: 0, description: 'Panneaux acoustiques pour la salle de réunion', quantityMilli: 10000, cancelledQuantityMilli: 0, unit: 'pièces', unitPriceCents: 10000, discountBp: 0, vatBp: 810, lineGrossCents: 100000, lineNetCents: 100000, lineVatCents: 8100, lineTotalCents: 108100, fulfillmentMode: 'untracked_delivery' },
      { id: 'sales-line-service', salesOrderId: 'sales-order-qa', catalogItemId: null, position: 1, description: 'Installation et contrôle sur place', quantityMilli: 1000, cancelledQuantityMilli: 0, unit: 'forfait', unitPriceCents: 10000, discountBp: 0, vatBp: 810, lineGrossCents: 10000, lineNetCents: 10000, lineVatCents: 810, lineTotalCents: 10810, fulfillmentMode: 'direct' },
    ],
  };
  initial.salesOrders = [order];
  let persisted = structuredClone(initial);
  let readFailures = 0;
  const now = '2026-09-05T10:00:00Z';
  const writes = new Map<string, string>();
  const log = (operation: string, input: unknown) => {
    const key = `qa-sales-${operation}-attempts`;
    const list = JSON.parse(sessionStorage.getItem(key) || '[]');
    list.push(structuredClone(input)); sessionStorage.setItem(key, JSON.stringify(list));
  };
  const failure = (operation: string) => {
    const value = sessionStorage.getItem(`qa-sales-${operation}-failure`);
    sessionStorage.removeItem(`qa-sales-${operation}-failure`);
    if (value === 'reject') throw new Error(`Refus ${operation} : la période comptable est fermée.`);
    return value;
  };
  desktopApi.loadWorkspace = async () => {
    if (readFailures > 0) { readFailures -= 1; throw new Error('Lecture temporairement indisponible.'); }
    return structuredClone(persisted);
  };
  const afterWrite = async (mode: string | null) => {
    readFailures = mode === 'refresh_twice' ? 2 : mode === 'refresh_once' ? 1 : 0;
    sessionStorage.setItem('qa-sales-persisted', JSON.stringify({ deliveries: persisted.deliveryNotes.length, invoices: persisted.invoices.length, issued: persisted.deliveryNotes.filter((note) => note.status === 'issued').length }));
    return refreshWorkspaceAfterMutation(desktopApi.loadWorkspace);
  };
  desktopApi.saveDeliveryNoteDraft = async (input) => {
    log('save', input); const mode = failure('save');
    const id = input.id || crypto.randomUUID();
    const note: DeliveryNote = { id, salesOrderId: input.salesOrderId, number: '', status: 'draft', deliveryDate: input.deliveryDate, reference: input.reference || '', notes: input.notes || '', issuedAt: null, reversedAt: null, createdAt: now, updatedAt: now,
      lines: input.lines.map((line, position) => { const source = order.lines.find((entry) => entry.id === line.salesOrderLineId)!; return { id: `${id}-line-${position}`, deliveryNoteId: id, salesOrderLineId: line.salesOrderLineId, position, quantityMilli: line.quantityMilli, description: source.description, unit: source.unit }; }),
    };
    persisted.deliveryNotes = [...persisted.deliveryNotes.filter((entry) => entry.id !== id), note];
    return afterWrite(mode);
  };
  desktopApi.issueDeliveryNote = async (requestId, deliveryNoteId) => {
    log('issue', { requestId, deliveryNoteId }); const mode = failure('issue');
    const note = persisted.deliveryNotes.find((entry) => entry.id === deliveryNoteId)!;
    if (!writes.has(requestId)) {
      if (note.status !== 'draft') throw new Error('Ce bon est déjà émis.');
      note.status = 'issued'; note.number = 'BL-2026-001'; note.issuedAt = now;
      writes.set(requestId, deliveryNoteId);
    }
    return afterWrite(mode);
  };
  desktopApi.previewSalesOrderInvoice = async (input) => {
    const allocations = persisted.salesOrderInvoiceAllocations;
    const final = order.lines.every((line) => allocations.filter((allocation) => allocation.salesOrderLineId === line.id).reduce((sum, allocation) => sum + allocation.quantityMilli, 0) + input.allocations.filter((allocation) => allocation.salesOrderLineId === line.id).reduce((sum, allocation) => sum + allocation.quantityMilli, 0) >= line.quantityMilli);
    const net = input.allocations.reduce((sum, allocation) => sum + Math.round(order.lines.find((line) => line.id === allocation.salesOrderLineId)!.unitPriceCents * allocation.quantityMilli / 1000), 0);
    return { role: final ? 'final' : 'partial', subtotalCents: net, discountCents: 0, vatCents: Math.round(net * 0.081), totalCents: net + Math.round(net * 0.081), blockers: [] };
  };
  desktopApi.createSalesOrderInvoice = async (input) => {
    log('invoice', input); const mode = failure('invoice');
    if (!writes.has(input.requestId)) {
      const id = crypto.randomUUID(); const batchId = crypto.randomUUID();
      const preview = await desktopApi.previewSalesOrderInvoice(input);
      const invoice = { id, clientId: order.clientId, projectId: null, quoteId: null, originalInvoiceId: null, number: '', title: 'Facture de situation · Aménagement du bureau', type: 'standard', status: 'draft', currency: 'CHF', issueDate: input.issueDate || '2026-09-05', dueDate: input.dueDate || '2026-10-05', serviceDateFrom: input.serviceDateFrom, serviceDateTo: input.serviceDateTo, depositPercentageBp: null, depositBasisLines: null, notes: '', terms: '', createdAt: now,
        lines: input.allocations.map((allocation, index) => { const source = order.lines.find((line) => line.id === allocation.salesOrderLineId)!; return { id: `${id}-line-${index}`, description: source.description, quantity: allocation.quantityMilli / 1000, unit: source.unit, unitPriceCents: source.unitPriceCents, discountBp: 0, vatRateBp: source.vatBp }; }),
      } as Invoice;
      persisted.invoices.push(invoice);
      persisted.salesOrderInvoiceBatches.push({ id: batchId, salesOrderId: order.id, invoiceId: id, role: preview.role, createdAt: now });
      persisted.salesOrderInvoiceAllocations.push(...input.allocations.map((allocation, index) => ({ ...allocation, id: crypto.randomUUID(), batchId, invoiceItemId: `${id}-line-${index}`, grossCentsSnapshot: 0, netCentsSnapshot: 0, vatCentsSnapshot: 0, totalCentsSnapshot: 0, createdAt: now })));
      writes.set(input.requestId, id);
    }
    return afterWrite(mode);
  };
  desktopApi.reverseDeliveryNote = async (requestId, deliveryNoteId, reason) => {
    log('reverse', { requestId, deliveryNoteId, reason }); const mode = failure('reverse');
    if (!writes.has(requestId)) {
      const note = persisted.deliveryNotes.find((entry) => entry.id === deliveryNoteId)!;
      note.status = 'reversed'; note.reversedAt = now; writes.set(requestId, deliveryNoteId);
    }
    return afterWrite(mode);
  };
}
