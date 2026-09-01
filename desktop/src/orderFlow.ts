import type {
  CatalogItem,
  DeliveryNote,
  Invoice,
  Quote,
  SalesOrder,
  SalesOrderInvoiceAllocation,
  SalesOrderInvoiceBatch,
  SalesOrderLine,
  StockAvailability,
  StockReservationEvent,
} from './types';

export type SalesOrderLineProgress = {
  effectiveQuantityMilli: number;
  reservedQuantityMilli: number;
  deliveredQuantityMilli: number;
  allocatedQuantityMilli: number;
  invoicedQuantityMilli: number;
  remainingToDeliverMilli: number;
  remainingToInvoiceMilli: number;
};

export type SalesOrderProgress = {
  deliveryCompletedLines: number;
  deliveryLineCount: number;
  deliveryPercent: number;
  invoicePreparedCompletedLines: number;
  invoicePreparedPercent: number;
  invoiceCompletedLines: number;
  invoiceLineCount: number;
  invoicePercent: number;
};

export type SalesOrderInvoiceDates = {
  issueDate: string;
  dueDate: string;
  serviceDateFrom: string;
  serviceDateTo: string;
};

export type SalesOrderNextAction =
  | 'confirm'
  | 'issue_delivery'
  | 'create_delivery'
  | 'issue_invoice'
  | 'create_partial_invoice'
  | 'create_final_invoice'
  | 'none';

export type DeliveryAllocationDraft = {
  salesOrderLineId: string;
  quantityMilli: number;
};

export type InvoiceAllocationDraft = {
  salesOrderLineId: string;
  deliveryNoteLineId: string | null;
  quantityMilli: number;
};

export type RemainderCancellationDraft = {
  salesOrderLineId: string;
  quantityMilli: number;
};

type FlowWorkspace = {
  deliveryNotes: DeliveryNote[];
  invoices: Invoice[];
  salesOrderInvoiceBatches: SalesOrderInvoiceBatch[];
  salesOrderInvoiceAllocations: SalesOrderInvoiceAllocation[];
  stockReservationEvents: StockReservationEvent[];
};

const nonNegative = (value: number) => Math.max(0, Math.trunc(value));

export function availabilityForCatalogItem(
  item: CatalogItem,
  events: StockReservationEvent[],
  rows: StockAvailability[] = [],
): StockAvailability {
  const backend = rows.find((row) => row.catalogItemId === item.id);
  if (backend) return backend;
  const reservedMilli = events
    .filter((event) => event.catalogItemId === item.id)
    .reduce((total, event) => total + event.quantityDeltaMilli, 0);
  return {
    catalogItemId: item.id,
    onHandMilli: item.stockQuantityMilli,
    reservedMilli,
    availableMilli: item.stockQuantityMilli - reservedMilli,
  };
}

export function quoteRequiresSalesOrder(
  quote: Quote,
  catalogItems: CatalogItem[],
): boolean {
  const byId = new Map(catalogItems.map((item) => [item.id, item]));
  return quote.lines.some((line) => {
    const item = line.catalogItemId ? byId.get(line.catalogItemId) : undefined;
    return item?.kind === 'product';
  });
}

function activeBatches(order: SalesOrder, workspace: FlowWorkspace) {
  return workspace.salesOrderInvoiceBatches.filter((batch) => {
    if (batch.salesOrderId !== order.id) return false;
    const invoice = workspace.invoices.find((item) => item.id === batch.invoiceId);
    return Boolean(invoice && invoice.status !== 'cancelled');
  });
}

function allocationsForLine(
  order: SalesOrder,
  line: SalesOrderLine,
  workspace: FlowWorkspace,
) {
  const batchIds = new Set(activeBatches(order, workspace).map((batch) => batch.id));
  return workspace.salesOrderInvoiceAllocations.filter(
    (allocation) =>
      allocation.salesOrderLineId === line.id && batchIds.has(allocation.batchId),
  );
}

export function salesOrderLineProgress(
  order: SalesOrder,
  line: SalesOrderLine,
  workspace: FlowWorkspace,
): SalesOrderLineProgress {
  const effectiveQuantityMilli = nonNegative(
    line.quantityMilli - line.cancelledQuantityMilli,
  );
  const deliveredQuantityMilli = workspace.deliveryNotes
    .filter(
      (note) => note.salesOrderId === order.id && note.status === 'issued',
    )
    .flatMap((note) => note.lines)
    .filter((deliveryLine) => deliveryLine.salesOrderLineId === line.id)
    .reduce((total, deliveryLine) => total + deliveryLine.quantityMilli, 0);
  const allocations = allocationsForLine(order, line, workspace);
  const allocatedQuantityMilli = allocations.reduce(
    (total, allocation) => total + allocation.quantityMilli,
    0,
  );
  const emittedBatchIds = new Set(
    activeBatches(order, workspace)
      .filter((batch) => {
        const invoice = workspace.invoices.find((item) => item.id === batch.invoiceId);
        return invoice && invoice.status !== 'draft';
      })
      .map((batch) => batch.id),
  );
  const invoicedQuantityMilli = allocations
    .filter((allocation) => emittedBatchIds.has(allocation.batchId))
    .reduce((total, allocation) => total + allocation.quantityMilli, 0);
  const reservedQuantityMilli = line.catalogItemId
    ? workspace.stockReservationEvents
        .filter((event) => event.salesOrderLineId === line.id)
        .reduce((total, event) => total + event.quantityDeltaMilli, 0)
    : 0;
  const deliveredOrDirectMilli =
    line.fulfillmentMode === 'direct'
      ? effectiveQuantityMilli
      : deliveredQuantityMilli;
  return {
    effectiveQuantityMilli,
    reservedQuantityMilli: nonNegative(reservedQuantityMilli),
    deliveredQuantityMilli: nonNegative(deliveredQuantityMilli),
    allocatedQuantityMilli: nonNegative(allocatedQuantityMilli),
    invoicedQuantityMilli: nonNegative(invoicedQuantityMilli),
    remainingToDeliverMilli:
      line.fulfillmentMode === 'direct'
        ? 0
        : nonNegative(effectiveQuantityMilli - deliveredQuantityMilli),
    remainingToInvoiceMilli: nonNegative(
      deliveredOrDirectMilli - allocatedQuantityMilli,
    ),
  };
}

export function salesOrderProgress(
  order: SalesOrder,
  workspace: FlowWorkspace,
): SalesOrderProgress {
  const progresses = order.lines.map((line) => ({
    line,
    progress: salesOrderLineProgress(order, line, workspace),
  }));
  const deliveries = progresses.filter(
    ({ line }) => line.fulfillmentMode !== 'direct',
  );
  const ratio = (
    rows: typeof progresses,
    field:
      | 'deliveredQuantityMilli'
      | 'allocatedQuantityMilli'
      | 'invoicedQuantityMilli',
  ) => {
    if (!rows.length) return 100;
    return Math.round(
      (rows.reduce((total, row) => {
        const expected = row.progress.effectiveQuantityMilli;
        return total + (expected ? Math.min(1, row.progress[field] / expected) : 1);
      }, 0) /
        rows.length) *
        100,
    );
  };
  return {
    deliveryCompletedLines: deliveries.filter(
      ({ progress }) => progress.remainingToDeliverMilli === 0,
    ).length,
    deliveryLineCount: deliveries.length,
    deliveryPercent: ratio(deliveries, 'deliveredQuantityMilli'),
    invoicePreparedCompletedLines: progresses.filter(
      ({ progress }) =>
        progress.allocatedQuantityMilli >= progress.effectiveQuantityMilli,
    ).length,
    invoicePreparedPercent: ratio(progresses, 'allocatedQuantityMilli'),
    invoiceCompletedLines: progresses.filter(
      ({ progress }) =>
        progress.invoicedQuantityMilli >= progress.effectiveQuantityMilli,
    ).length,
    invoiceLineCount: progresses.length,
    invoicePercent: ratio(progresses, 'invoicedQuantityMilli'),
  };
}

export function deliveryDateValidationError(
  orderDate: string,
  deliveryDate: string,
): string {
  if (!deliveryDate) return 'Indiquez la date de livraison.';
  if (orderDate && deliveryDate < orderDate)
    return 'La date de livraison ne peut pas précéder la date de la commande.';
  return '';
}

export function salesOrderInvoiceDateValidationError({
  issueDate,
  dueDate,
  serviceDateFrom,
  serviceDateTo,
}: SalesOrderInvoiceDates): string {
  if (!issueDate) return 'Indiquez la date prévue d’émission.';
  if (!serviceDateFrom || !serviceDateTo)
    return 'Indiquez toute la période de prestation.';
  if (serviceDateTo < serviceDateFrom)
    return 'La fin de prestation ne peut pas précéder son début.';
  if (dueDate && dueDate < issueDate)
    return 'L’échéance ne peut pas précéder la date d’émission.';
  return '';
}

export function nextSalesOrderAction(
  order: SalesOrder,
  workspace: FlowWorkspace,
): SalesOrderNextAction {
  if (order.status === 'draft') return 'confirm';
  if (order.status === 'closed' || order.status === 'cancelled') return 'none';

  const orderDeliveries = workspace.deliveryNotes.filter(
    (note) => note.salesOrderId === order.id,
  );
  if (orderDeliveries.some((note) => note.status === 'draft'))
    return 'issue_delivery';

  const batches = activeBatches(order, workspace);
  if (
    batches.some((batch) =>
      workspace.invoices.some(
        (invoice) => invoice.id === batch.invoiceId && invoice.status === 'draft',
      ),
    )
  )
    return 'issue_invoice';

  const progresses = order.lines.map((line) => ({
    line,
    progress: salesOrderLineProgress(order, line, workspace),
  }));
  const hasDeliveredToInvoice = progresses.some(
    ({ line, progress }) =>
      line.fulfillmentMode !== 'direct' && progress.remainingToInvoiceMilli > 0,
  );
  const hasRemainingDelivery = progresses.some(
    ({ progress }) => progress.remainingToDeliverMilli > 0,
  );
  const hasAnythingToInvoice = progresses.some(
    ({ progress }) => progress.remainingToInvoiceMilli > 0,
  );
  if (hasDeliveredToInvoice)
    return hasRemainingDelivery ? 'create_partial_invoice' : 'create_final_invoice';
  if (hasRemainingDelivery) return 'create_delivery';
  if (hasAnythingToInvoice) return 'create_final_invoice';
  return 'none';
}

export function hasSalesOrderFulfillment(
  order: SalesOrder,
  workspace: FlowWorkspace,
): boolean {
  return (
    workspace.deliveryNotes.some(
      (note) =>
        note.salesOrderId === order.id &&
        (note.status === 'issued' || note.status === 'reversed'),
    ) ||
    workspace.salesOrderInvoiceBatches.some(
      (batch) => batch.salesOrderId === order.id,
    )
  );
}

export function canCancelSalesOrderCompletely(
  order: SalesOrder,
  workspace: FlowWorkspace,
): boolean {
  if (order.status === 'draft') return true;
  return order.status === 'confirmed' && !hasSalesOrderFulfillment(order, workspace);
}

export function cancellableSalesOrderRemainder(
  order: SalesOrder,
  workspace: FlowWorkspace,
): RemainderCancellationDraft[] {
  if (order.status !== 'confirmed') return [];
  return order.lines.flatMap((line) => {
    const progress = salesOrderLineProgress(order, line, workspace);
    const allocatedQuantityMilli = workspace.salesOrderInvoiceAllocations
      .filter((allocation) => allocation.salesOrderLineId === line.id)
      .reduce((total, allocation) => total + allocation.quantityMilli, 0);
    const quantityMilli = nonNegative(
      progress.effectiveQuantityMilli -
        Math.max(progress.deliveredQuantityMilli, allocatedQuantityMilli),
    );
    return quantityMilli > 0 ? [{ salesOrderLineId: line.id, quantityMilli }] : [];
  });
}

export function canReverseDeliveryNote(
  note: DeliveryNote,
  order: SalesOrder,
  workspace: FlowWorkspace,
): boolean {
  if (note.status !== 'issued' || order.status !== 'confirmed') return false;
  const deliveryLineIds = new Set(note.lines.map((line) => line.id));
  return !workspace.salesOrderInvoiceAllocations.some(
    (allocation) =>
      allocation.deliveryNoteLineId !== null &&
      deliveryLineIds.has(allocation.deliveryNoteLineId),
  );
}

export function defaultDeliveryAllocations(
  order: SalesOrder,
  workspace: FlowWorkspace,
): DeliveryAllocationDraft[] {
  return order.lines
    .filter((line) => line.fulfillmentMode !== 'direct')
    .map((line) => ({
      salesOrderLineId: line.id,
      quantityMilli: salesOrderLineProgress(order, line, workspace)
        .remainingToDeliverMilli,
    }))
    .filter((line) => line.quantityMilli > 0);
}

export function defaultInvoiceAllocations(
  order: SalesOrder,
  workspace: FlowWorkspace,
): InvoiceAllocationDraft[] {
  const activeBatchIds = new Set(activeBatches(order, workspace).map((batch) => batch.id));
  const activeAllocations = workspace.salesOrderInvoiceAllocations.filter((allocation) =>
    activeBatchIds.has(allocation.batchId),
  );
  const result: InvoiceAllocationDraft[] = [];
  for (const line of order.lines) {
    if (line.fulfillmentMode === 'direct') {
      const remaining = salesOrderLineProgress(order, line, workspace)
        .remainingToInvoiceMilli;
      if (remaining > 0)
        result.push({
          salesOrderLineId: line.id,
          deliveryNoteLineId: null,
          quantityMilli: remaining,
        });
      continue;
    }
    for (const note of workspace.deliveryNotes) {
      if (note.salesOrderId !== order.id || note.status !== 'issued') continue;
      for (const deliveryLine of note.lines) {
        if (deliveryLine.salesOrderLineId !== line.id) continue;
        const alreadyAllocated = activeAllocations
          .filter(
            (allocation) =>
              allocation.deliveryNoteLineId === deliveryLine.id &&
              allocation.salesOrderLineId === line.id,
          )
          .reduce((total, allocation) => total + allocation.quantityMilli, 0);
        const remaining = nonNegative(
          deliveryLine.quantityMilli - alreadyAllocated,
        );
        if (remaining > 0)
          result.push({
            salesOrderLineId: line.id,
            deliveryNoteLineId: deliveryLine.id,
            quantityMilli: remaining,
          });
      }
    }
  }
  return result;
}

export function confirmationShortages(
  order: SalesOrder,
  catalogItems: CatalogItem[],
  events: StockReservationEvent[],
  availabilityRows: StockAvailability[] = [],
): Array<{
  catalogItem: CatalogItem;
  requiredMilli: number;
  availableMilli: number;
}> {
  const required = new Map<string, number>();
  for (const line of order.lines) {
    if (line.fulfillmentMode !== 'stocked_delivery' || !line.catalogItemId)
      continue;
    required.set(
      line.catalogItemId,
      (required.get(line.catalogItemId) ?? 0) +
        nonNegative(line.quantityMilli - line.cancelledQuantityMilli),
    );
  }
  return [...required.entries()].flatMap(([catalogItemId, requiredMilli]) => {
    const catalogItem = catalogItems.find((item) => item.id === catalogItemId);
    if (!catalogItem) return [];
    const availableMilli = availabilityForCatalogItem(
      catalogItem,
      events,
      availabilityRows,
    ).availableMilli;
    return requiredMilli > availableMilli
      ? [{ catalogItem, requiredMilli, availableMilli }]
      : [];
  });
}

export function salesOrderDisplayStatus(
  order: SalesOrder,
  workspace: FlowWorkspace,
): { status: string; label: string } {
  if (order.status === 'draft') return { status: 'draft', label: 'À confirmer' };
  if (order.status === 'cancelled')
    return { status: 'cancelled', label: 'Annulée' };
  if (order.status === 'closed') return { status: 'closed', label: 'Facturée' };
  const progress = salesOrderProgress(order, workspace);
  if (progress.deliveryPercent === 0)
    return { status: 'confirmed', label: 'Réservée' };
  if (progress.deliveryPercent < 100)
    return { status: 'in_progress', label: 'Partiellement livrée' };
  if (progress.invoicePreparedPercent < 100)
    return { status: 'issued', label: 'Livrée · à facturer' };
  if (progress.invoicePreparedPercent > progress.invoicePercent)
    return { status: 'draft', label: 'Facture brouillon prête' };
  return { status: 'issued', label: 'Facturation en cours' };
}
