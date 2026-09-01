import { describe, expect, it } from 'vitest';
import type {
  CatalogItem,
  DeliveryNote,
  Invoice,
  Quote,
  SalesOrder,
  SalesOrderInvoiceAllocation,
  SalesOrderInvoiceBatch,
  StockReservationEvent,
} from './types';
import {
  availabilityForCatalogItem,
  canCancelSalesOrderCompletely,
  canReverseDeliveryNote,
  cancellableSalesOrderRemainder,
  confirmationShortages,
  defaultInvoiceAllocations,
  deliveryDateValidationError,
  nextSalesOrderAction,
  quoteRequiresSalesOrder,
  salesOrderInvoiceDateValidationError,
  salesOrderLineProgress,
  salesOrderProgress,
} from './orderFlow';

const product: CatalogItem = {
  id: 'product-1',
  kind: 'product',
  sku: 'P-1',
  name: 'Panneau',
  description: '',
  unit: 'pièce',
  salesPriceCents: 1_000,
  purchaseCostCents: 500,
  vatBp: 810,
  trackStock: true,
  stockQuantityMilli: 10_000,
  reorderLevelMilli: 2_000,
  createdAt: '',
  updatedAt: '',
};

const service: CatalogItem = {
  ...product,
  id: 'service-1',
  kind: 'service',
  name: 'Pose',
  trackStock: false,
  stockQuantityMilli: 0,
};

const baseOrder: SalesOrder = {
  id: 'order-1',
  clientId: 'client-1',
  projectId: null,
  quoteId: 'quote-1',
  number: 'CMD-2026-1',
  title: 'Commande test',
  status: 'confirmed',
  orderDate: '2026-09-01',
  currency: 'CHF',
  subtotalCents: 5_000,
  discountCents: 0,
  vatCents: 405,
  totalCents: 5_405,
  notes: '',
  terms: '',
  confirmedAt: '2026-09-01T10:00:00Z',
  closedAt: null,
  cancelledAt: null,
  createdAt: '2026-09-01T09:00:00Z',
  updatedAt: '2026-09-01T10:00:00Z',
  lines: [
    {
      id: 'order-line-1',
      salesOrderId: 'order-1',
      catalogItemId: product.id,
      position: 0,
      description: product.name,
      quantityMilli: 5_000,
      cancelledQuantityMilli: 0,
      unit: product.unit,
      unitPriceCents: product.salesPriceCents,
      discountBp: 0,
      vatBp: 810,
      lineGrossCents: 5_000,
      lineNetCents: 5_000,
      lineVatCents: 405,
      lineTotalCents: 5_405,
      fulfillmentMode: 'stocked_delivery',
    },
  ],
};

const reservation: StockReservationEvent = {
  sequence: 1,
  id: 'reservation-1',
  catalogItemId: product.id,
  salesOrderId: baseOrder.id,
  salesOrderLineId: baseOrder.lines[0].id,
  deliveryNoteLineId: null,
  eventType: 'reserve',
  quantityDeltaMilli: 5_000,
  lineReservedAfterMilli: 5_000,
  catalogReservedAfterMilli: 5_000,
  reason: 'Commande confirmée',
  createdAt: '2026-09-01T10:00:00Z',
};

function delivery(
  quantityMilli: number,
  status: DeliveryNote['status'] = 'issued',
): DeliveryNote {
  return {
    id: 'delivery-1',
    salesOrderId: baseOrder.id,
    number: status === 'draft' ? '' : 'BL-2026-1',
    status,
    deliveryDate: '2026-09-02',
    reference: '',
    notes: '',
    issuedAt: status === 'draft' ? null : '2026-09-02T10:00:00Z',
    reversedAt: null,
    createdAt: '2026-09-02T09:00:00Z',
    updatedAt: '2026-09-02T10:00:00Z',
    lines: [
      {
        id: 'delivery-line-1',
        deliveryNoteId: 'delivery-1',
        salesOrderLineId: 'order-line-1',
        position: 0,
        quantityMilli,
        description: 'Panneau',
        unit: 'pièce',
      },
    ],
  };
}

function invoice(status: Invoice['status']): Invoice {
  return {
    id: 'invoice-1',
    number: status === 'draft' ? '' : 'F-2026-1',
    clientId: baseOrder.clientId,
    projectId: null,
    quoteId: baseOrder.quoteId,
    originalInvoiceId: null,
    title: 'Situation',
    type: 'progress',
    issueDate: '2026-09-02',
    dueDate: '2026-10-02',
    serviceDateFrom: '2026-09-02',
    serviceDateTo: '2026-09-02',
    status,
    lines: [],
    notes: '',
    createdAt: '2026-09-02T10:00:00Z',
  };
}

function batch(role: SalesOrderInvoiceBatch['role'] = 'partial'): SalesOrderInvoiceBatch {
  return {
    id: 'batch-1',
    salesOrderId: baseOrder.id,
    invoiceId: 'invoice-1',
    role,
    createdAt: '2026-09-02T10:00:00Z',
  };
}

function allocation(quantityMilli: number): SalesOrderInvoiceAllocation {
  return {
    id: 'allocation-1',
    batchId: 'batch-1',
    salesOrderLineId: 'order-line-1',
    deliveryNoteLineId: 'delivery-line-1',
    invoiceItemId: 'invoice-line-1',
    quantityMilli,
    grossCentsSnapshot: quantityMilli,
    netCentsSnapshot: quantityMilli,
    vatCentsSnapshot: Math.round(quantityMilli * 0.081),
    totalCentsSnapshot: Math.round(quantityMilli * 1.081),
    createdAt: '2026-09-02T10:00:00Z',
  };
}

const flow = (
  deliveryNotes: DeliveryNote[] = [],
  invoices: Invoice[] = [],
  batches: SalesOrderInvoiceBatch[] = [],
  allocations: SalesOrderInvoiceAllocation[] = [],
) => ({
  deliveryNotes,
  invoices,
  salesOrderInvoiceBatches: batches,
  salesOrderInvoiceAllocations: allocations,
  stockReservationEvents: [reservation],
});

describe('flux commande client', () => {
  it('oriente un devis produit vers une commande et un devis service vers le flux simple', () => {
    const quote: Quote = {
      id: 'quote-1',
      number: 'D-1',
      clientId: 'client-1',
      projectId: null,
      title: 'Offre',
      issueDate: '2026-09-01',
      validUntil: '2026-09-30',
      status: 'accepted',
      lines: [
        {
          id: 'quote-line-1',
          catalogItemId: product.id,
          description: product.name,
          quantity: 1,
          unit: 'pièce',
          unitPriceCents: 1_000,
          vatRateBp: 810,
        },
      ],
      notes: '',
      createdAt: '',
    };
    expect(quoteRequiresSalesOrder(quote, [product, service])).toBe(true);
    expect(
      quoteRequiresSalesOrder(
        { ...quote, lines: [{ ...quote.lines[0], catalogItemId: service.id }] },
        [product, service],
      ),
    ).toBe(false);
  });

  it('calcule en main, réservé et disponible sans inventer de stock', () => {
    expect(availabilityForCatalogItem(product, [reservation])).toEqual({
      catalogItemId: product.id,
      onHandMilli: 10_000,
      reservedMilli: 5_000,
      availableMilli: 5_000,
    });
    expect(
      confirmationShortages(
        { ...baseOrder, lines: [{ ...baseOrder.lines[0], quantityMilli: 6_000 }] },
        [product],
        [reservation],
      )[0],
    ).toMatchObject({ requiredMilli: 6_000, availableMilli: 5_000 });
  });

  it('guide successivement confirmation, livraison partielle et facture suivante', () => {
    expect(nextSalesOrderAction({ ...baseOrder, status: 'draft' }, flow())).toBe(
      'confirm',
    );
    expect(nextSalesOrderAction(baseOrder, flow())).toBe('create_delivery');
    expect(nextSalesOrderAction(baseOrder, flow([delivery(2_000)]))).toBe(
      'create_partial_invoice',
    );
    expect(nextSalesOrderAction(baseOrder, flow([delivery(5_000)]))).toBe(
      'create_final_invoice',
    );
  });

  it('demande d’abord d’émettre les brouillons logistiques et financiers', () => {
    expect(nextSalesOrderAction(baseOrder, flow([delivery(2_000, 'draft')]))).toBe(
      'issue_delivery',
    );
    expect(
      nextSalesOrderAction(
        baseOrder,
        flow([delivery(2_000)], [invoice('draft')], [batch()], [allocation(2_000)]),
      ),
    ).toBe('issue_invoice');
    expect(
      nextSalesOrderAction(
        baseOrder,
        flow([delivery(5_000)], [invoice('draft')], [batch('final')], [allocation(5_000)]),
      ),
    ).toBe('issue_invoice');
    expect(
      nextSalesOrderAction(
        { ...baseOrder, status: 'closed', closedAt: '2026-09-03T10:00:00Z' },
        flow([delivery(5_000)], [invoice('issued')], [batch('final')], [allocation(5_000)]),
      ),
    ).toBe('none');
  });

  it('ne propose que la quantité livrée encore non allouée', () => {
    const workspace = flow(
      [delivery(5_000)],
      [invoice('issued')],
      [batch()],
      [allocation(2_000)],
    );
    expect(defaultInvoiceAllocations(baseOrder, workspace)).toEqual([
      {
        salesOrderLineId: 'order-line-1',
        deliveryNoteLineId: 'delivery-line-1',
        quantityMilli: 3_000,
      },
    ]);
    expect(
      salesOrderLineProgress(baseOrder, baseOrder.lines[0], workspace),
    ).toMatchObject({
      deliveredQuantityMilli: 5_000,
      allocatedQuantityMilli: 2_000,
      invoicedQuantityMilli: 2_000,
      remainingToDeliverMilli: 0,
      remainingToInvoiceMilli: 3_000,
    });
    expect(salesOrderProgress(baseOrder, workspace)).toMatchObject({
      deliveryPercent: 100,
      invoicePreparedPercent: 40,
      invoicePercent: 40,
    });
  });

  it('distingue les quantités préparées en brouillon des factures réellement émises', () => {
    const draftWorkspace = flow(
      [delivery(5_000)],
      [invoice('draft')],
      [batch('final')],
      [allocation(5_000)],
    );
    expect(salesOrderProgress(baseOrder, draftWorkspace)).toMatchObject({
      invoicePreparedCompletedLines: 1,
      invoicePreparedPercent: 100,
      invoiceCompletedLines: 0,
      invoicePercent: 0,
    });

    const issuedWorkspace = flow(
      [delivery(5_000)],
      [invoice('issued')],
      [batch('final')],
      [allocation(5_000)],
    );
    expect(salesOrderProgress(baseOrder, issuedWorkspace)).toMatchObject({
      invoicePreparedCompletedLines: 1,
      invoicePreparedPercent: 100,
      invoiceCompletedLines: 1,
      invoicePercent: 100,
    });
  });

  it('valide les chronologies de livraison et de facturation avant le backend', () => {
    expect(deliveryDateValidationError(baseOrder.orderDate, '2026-08-31')).toBe(
      'La date de livraison ne peut pas précéder la date de la commande.',
    );
    expect(deliveryDateValidationError(baseOrder.orderDate, '2026-09-01')).toBe('');
    expect(
      salesOrderInvoiceDateValidationError({
        issueDate: '2026-09-10',
        dueDate: '2026-09-09',
        serviceDateFrom: '2026-09-01',
        serviceDateTo: '2026-09-10',
      }),
    ).toBe('L’échéance ne peut pas précéder la date d’émission.');
    expect(
      salesOrderInvoiceDateValidationError({
        issueDate: '2026-09-10',
        dueDate: '2026-10-10',
        serviceDateFrom: '2026-09-11',
        serviceDateTo: '2026-09-10',
      }),
    ).toBe('La fin de prestation ne peut pas précéder son début.');
  });

  it('n’expose les reprises que lorsque le backend peut encore les accepter', () => {
    expect(
      canCancelSalesOrderCompletely({ ...baseOrder, status: 'draft' }, flow()),
    ).toBe(true);
    expect(canCancelSalesOrderCompletely(baseOrder, flow())).toBe(true);
    expect(
      canCancelSalesOrderCompletely(baseOrder, flow([delivery(2_000)])),
    ).toBe(false);
    expect(cancellableSalesOrderRemainder(baseOrder, flow([delivery(2_000)]))).toEqual([
      { salesOrderLineId: 'order-line-1', quantityMilli: 3_000 },
    ]);
    expect(canReverseDeliveryNote(delivery(2_000), baseOrder, flow())).toBe(true);
    expect(
      canReverseDeliveryNote(
        delivery(2_000),
        baseOrder,
        flow([delivery(2_000)], [invoice('draft')], [batch()], [allocation(2_000)]),
      ),
    ).toBe(false);
  });
});
