import { describe, expect, it } from 'vitest';
import type {
  SupplierInvoice,
  SupplierInvoiceMatch,
  SupplierOrder,
  SupplierReceipt,
} from './types';
import {
  supplierInvoiceOrderMatchAmountMismatch,
  supplierOrderDisplayStatus,
  supplierOrderLineProgress,
  supplierOrderNextAction,
  supplierOrderProgress,
  supplierReceiptDateValidationError,
  supplierThreeWayMatchStatus,
} from './purchaseOrderFlow';

const order: SupplierOrder = {
  id: 'po-1',
  supplierId: 'supplier-1',
  projectId: 'project-1',
  number: 'CF-2026-001',
  title: 'Matériaux et transport',
  status: 'confirmed',
  orderDate: '2026-09-01',
  currency: 'CHF',
  subtotalCents: 12_000,
  discountCents: 0,
  vatCents: 972,
  totalCents: 12_972,
  notes: '',
  terms: '',
  confirmedAt: '2026-09-01T09:00:00Z',
  closedAt: null,
  cancelledAt: null,
  cancellationReason: '',
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-01T09:00:00Z',
  lines: [
    {
      id: 'po-line-product',
      supplierOrderId: 'po-1',
      catalogItemId: 'product-1',
      position: 0,
      description: 'Panneaux',
      quantityMilli: 10_000,
      cancelledQuantityMilli: 0,
      receivedQuantityMilli: 0,
      matchedQuantityMilli: 0,
      remainingReceivableMilli: 10_000,
      remainingMatchableMilli: 10_000,
      unit: 'pièce',
      unitPriceCents: 1_000,
      discountBp: 0,
      vatBp: 810,
      lineNetCents: 10_000,
      lineVatCents: 810,
      lineTotalCents: 10_810,
      category: 'Matériaux',
      expenseAccountId: 'account-4000',
      projectId: 'project-1',
      fulfillmentMode: 'stocked_receipt',
    },
    {
      id: 'po-line-service',
      supplierOrderId: 'po-1',
      catalogItemId: null,
      position: 1,
      description: 'Transport',
      quantityMilli: 1_000,
      cancelledQuantityMilli: 0,
      receivedQuantityMilli: 0,
      matchedQuantityMilli: 0,
      remainingReceivableMilli: 0,
      remainingMatchableMilli: 1_000,
      unit: 'forfait',
      unitPriceCents: 2_000,
      discountBp: 0,
      vatBp: 810,
      lineNetCents: 2_000,
      lineVatCents: 162,
      lineTotalCents: 2_162,
      category: 'Transport',
      expenseAccountId: 'account-4200',
      projectId: 'project-1',
      fulfillmentMode: 'direct',
    },
  ],
};

function receipt(
  quantityMilli: number,
  status: SupplierReceipt['status'] = 'issued',
): SupplierReceipt {
  return {
    id: 'receipt-1',
    supplierOrderId: order.id,
    number: status === 'draft' ? '' : 'RF-2026-001',
    status,
    receiptDate: '2026-09-02',
    reference: '',
    notes: '',
    issuedAt: status === 'issued' ? '2026-09-02T10:00:00Z' : null,
    reversedAt: status === 'reversed' ? '2026-09-03T10:00:00Z' : null,
    reversalReason: status === 'reversed' ? 'Marchandise retournée' : '',
    createdAt: '2026-09-02T09:00:00Z',
    updatedAt: '2026-09-02T10:00:00Z',
    lines: [
      {
        id: 'receipt-line-1',
        supplierReceiptId: 'receipt-1',
        supplierOrderLineId: 'po-line-product',
        position: 0,
        quantityMilli,
        description: 'Panneaux',
        unit: 'pièce',
      },
    ],
  };
}

function supplierInvoice(supplierId = order.supplierId): SupplierInvoice {
  return {
    id: 'supplier-invoice-1',
    supplierId,
    projectId: 'project-1',
    documentDate: '2026-09-02',
    dueDate: '2026-10-02',
    supplierName: 'Matériaux SA',
    reference: 'FAC-42',
    currency: 'CHF',
    documentStatus: 'validated',
    paymentStatus: 'pending',
    netCents: 12_000,
    vatCents: 972,
    totalCents: 12_972,
    paidCents: 0,
    creditedCents: 0,
    balanceCents: 12_972,
    matchStatus: 'matched',
    validatedAt: '2026-09-02T11:00:00Z',
    validationJournalEntryId: 'journal-1',
    note: '',
    lines: [
      {
        id: 'invoice-line-product',
        supplierInvoiceId: 'supplier-invoice-1',
        position: 0,
        description: 'Panneaux',
        quantityMilli: 10_000,
        unit: 'pièce',
        unitPriceCents: 1_000,
        discountBp: 0,
        vatBp: 810,
        netCents: 10_000,
        vatCents: 810,
        totalCents: 10_810,
        category: 'Matériaux',
        expenseAccountId: 'account-4000',
        projectId: 'project-1',
      },
      {
        id: 'invoice-line-service',
        supplierInvoiceId: 'supplier-invoice-1',
        position: 1,
        description: 'Transport',
        quantityMilli: 1_000,
        unit: 'forfait',
        unitPriceCents: 2_000,
        discountBp: 0,
        vatBp: 810,
        netCents: 2_000,
        vatCents: 162,
        totalCents: 2_162,
        category: 'Transport',
        expenseAccountId: 'account-4200',
        projectId: 'project-1',
      },
    ],
    payments: [],
    attachments: [],
    createdAt: '2026-09-02T10:30:00Z',
    updatedAt: '2026-09-02T11:00:00Z',
  };
}

function match(
  id: string,
  lineId: string,
  invoiceLineId: string,
  quantityMilli: number,
  netCents: number,
  vatCents: number,
  receiptLineId: string | null,
): SupplierInvoiceMatch {
  return {
    id,
    requestId: `request-${id}`,
    supplierInvoiceId: 'supplier-invoice-1',
    supplierInvoiceItemId: invoiceLineId,
    supplierOrderId: order.id,
    supplierOrderLineId: lineId,
    supplierReceiptLineId: receiptLineId,
    quantityMilli,
    netCents,
    vatCents,
    totalCents: netCents + vatCents,
    createdAt: '2026-09-02T11:00:00Z',
  };
}

const flow = (
  supplierReceipts: SupplierReceipt[] = [],
  supplierInvoices: SupplierInvoice[] = [],
  supplierInvoiceMatches: SupplierInvoiceMatch[] = [],
  supplierOrders: SupplierOrder[] = [order],
) => ({
  supplierOrders,
  supplierReceipts,
  supplierInvoices,
  supplierInvoiceMatches,
});

describe('flux achats fournisseurs', () => {
  it('guide sans ressaisie de la confirmation jusqu’au rapprochement', () => {
    expect(supplierOrderNextAction({ ...order, status: 'draft' }, flow())).toBe(
      'confirm',
    );
    expect(supplierOrderNextAction(order, flow())).toBe('create_receipt');
    expect(
      supplierOrderNextAction(order, flow([receipt(5_000, 'draft')])),
    ).toBe('issue_receipt');
    expect(supplierOrderNextAction(order, flow([receipt(5_000)]))).toBe(
      'create_receipt',
    );
  });

  it('calcule une réception partielle et exclut une réception annulée', () => {
    const partial = supplierOrderLineProgress(
      order,
      order.lines[0],
      flow([receipt(4_000)]),
    );
    expect(partial).toMatchObject({
      effectiveQuantityMilli: 10_000,
      receivedQuantityMilli: 4_000,
      remainingToReceiveMilli: 6_000,
      matchableNowMilli: 4_000,
    });
    expect(
      supplierOrderLineProgress(
        order,
        order.lines[0],
        flow([receipt(10_000, 'reversed')]),
      ).receivedQuantityMilli,
    ).toBe(0);
  });

  it('n’exige aucune réception pour une prestation directe', () => {
    const progress = supplierOrderLineProgress(order, order.lines[1], flow());
    expect(progress).toMatchObject({
      remainingToReceiveMilli: 0,
      matchableNowMilli: 1_000,
      remainingToMatchMilli: 1_000,
    });
  });

  it('devient vert seulement lorsque commande, réception et facture concordent', () => {
    const matches = [
      match(
        'match-product',
        'po-line-product',
        'invoice-line-product',
        10_000,
        10_000,
        810,
        'receipt-line-1',
      ),
      match(
        'match-service',
        'po-line-service',
        'invoice-line-service',
        1_000,
        2_000,
        162,
        null,
      ),
    ];
    const workspace = flow([receipt(10_000)], [supplierInvoice()], matches);
    expect(supplierThreeWayMatchStatus(order, workspace)).toEqual({
      status: 'green',
      label: 'Commande, réception et facture concordent',
      issues: [],
    });
    expect(supplierOrderProgress(order, workspace)).toMatchObject({
      receiptPercent: 100,
      matchPercent: 100,
    });
    expect(supplierOrderNextAction(order, workspace)).toBe('none');
    expect(supplierOrderDisplayStatus(order, workspace).label).toBe(
      'Rapprochement complet',
    );
  });

  it('refuse deux écarts tolérés séparément mais cumulés sur deux commandes', () => {
    const invoice = supplierInvoice();
    const globallyMismatchedInvoice = {
      ...invoice,
      netCents: invoice.netCents + 2,
      totalCents: invoice.totalCents + 2,
      balanceCents: invoice.balanceCents + 2,
      lines: invoice.lines.map((line) => ({
        ...line,
        netCents: line.netCents + 1,
        totalCents: line.totalCents + 1,
      })),
    };
    const secondOrder: SupplierOrder = {
      ...order,
      id: 'po-2',
      number: 'CF-2026-002',
      lines: [
        {
          ...order.lines[1],
          id: 'po-2-line-service',
          supplierOrderId: 'po-2',
        },
      ],
    };
    const matches = [
      match(
        'match-product-global-rounding',
        'po-line-product',
        'invoice-line-product',
        10_000,
        10_001,
        810,
        'receipt-line-1',
      ),
      {
        ...match(
          'match-service-global-rounding',
          'po-2-line-service',
          'invoice-line-service',
          1_000,
          2_001,
          162,
          null,
        ),
        supplierOrderId: secondOrder.id,
      },
    ];
    const workspace = flow(
      [receipt(10_000)],
      [globallyMismatchedInvoice],
      matches,
      [order, secondOrder],
    );

    expect(
      supplierInvoiceOrderMatchAmountMismatch(
        globallyMismatchedInvoice.id,
        order,
        workspace,
      ),
    ).toBe(true);
    const status = supplierThreeWayMatchStatus(order, workspace);
    expect(status.status).toBe('red');
    expect(status.issues.join(' ')).toContain('tolérance globale');
  });

  it('garde le rapprochement logistique exact après imputation d’un avoir', () => {
    const creditedInvoice = {
      ...supplierInvoice(),
      creditedCents: 2_162,
      balanceCents: 10_810,
    };
    const matches = [
      match(
        'match-product-credit',
        'po-line-product',
        'invoice-line-product',
        10_000,
        10_000,
        810,
        'receipt-line-1',
      ),
      match(
        'match-service-credit',
        'po-line-service',
        'invoice-line-service',
        1_000,
        2_000,
        162,
        null,
      ),
    ];
    expect(
      supplierThreeWayMatchStatus(
        order,
        flow([receipt(10_000)], [creditedInvoice], matches),
      ).status,
    ).toBe('green');
  });

  it('accepte une facture partielle quand ses lignes hors commande restent séparées', () => {
    const invoiceWithFreight = {
      ...supplierInvoice(),
      matchStatus: 'partial' as const,
      netCents: 12_500,
      vatCents: 1_013,
      totalCents: 13_513,
      balanceCents: 13_513,
      lines: [
        ...supplierInvoice().lines,
        {
          ...supplierInvoice().lines[1],
          id: 'invoice-line-fee',
          description: 'Frais administratifs hors commande',
          quantityMilli: 1_000,
          unitPriceCents: 500,
          netCents: 500,
          vatCents: 41,
          totalCents: 541,
        },
      ],
    };
    const matches = [
      match(
        'match-product-partial',
        'po-line-product',
        'invoice-line-product',
        10_000,
        10_000,
        810,
        'receipt-line-1',
      ),
      match(
        'match-service-partial',
        'po-line-service',
        'invoice-line-service',
        1_000,
        2_000,
        162,
        null,
      ),
    ];
    const closedOrder = {
      ...order,
      status: 'closed' as const,
      closedAt: '2026-09-02T11:00:00Z',
    };

    expect(
      supplierThreeWayMatchStatus(
        closedOrder,
        flow([receipt(10_000)], [invoiceWithFreight], matches),
      ),
    ).toEqual({
      status: 'green',
      label: 'Commande, réception et facture concordent',
      issues: [],
    });
  });

  it('signale un fournisseur différent et un dépassement de quantité', () => {
    const badMatch = match(
      'match-too-much',
      'po-line-product',
      'invoice-line-product',
      11_000,
      11_000,
      891,
      'receipt-line-1',
    );
    const result = supplierThreeWayMatchStatus(
      order,
      flow([receipt(10_000)], [supplierInvoice('supplier-other')], [badMatch]),
    );
    expect(result.status).toBe('red');
    expect(result.issues.join(' ')).toContain('fournisseur');
    expect(result.issues.join(' ')).toContain('dépasse');
  });

  it('refuse un rapprochement adossé à une réception annulée', () => {
    const result = supplierThreeWayMatchStatus(
      order,
      flow(
        [receipt(10_000, 'reversed')],
        [supplierInvoice()],
        [
          match(
            'match-reversed',
            'po-line-product',
            'invoice-line-product',
            10_000,
            10_000,
            810,
            'receipt-line-1',
          ),
        ],
      ),
    );
    expect(result).toMatchObject({ status: 'red' });
    expect(result.issues.join(' ')).toContain('non émise ou annulée');
  });

  it('valide les dates de réception avant tout appel au backend', () => {
    expect(
      supplierReceiptDateValidationError('2026-09-01', '', '2026-09-10'),
    ).toBe('Indiquez la date de réception.');
    expect(
      supplierReceiptDateValidationError(
        '2026-09-01',
        '2026-08-31',
        '2026-09-10',
      ),
    ).toBe('La date de réception ne peut pas précéder la date de la commande.');
    expect(
      supplierReceiptDateValidationError(
        '2026-09-01',
        '2026-09-11',
        '2026-09-10',
      ),
    ).toBe('La date de réception ne peut pas être dans le futur.');
    expect(
      supplierReceiptDateValidationError(
        '2026-09-01',
        '2026-09-10',
        '2026-09-10',
      ),
    ).toBe('');
  });
});
