import { describe, expect, it } from 'vitest';
import {
  allocateSupplierReceiptQuantity,
  existingInvoiceItemMatchDraft,
  nextMatchClearConfirmation,
  purchaseVatOptions,
  receiptAllocationUsageOutsideInvoice,
  replacementMatchableQuantity,
  supplierDraftLineTotals,
  supplierInvoiceNeedsAttention,
} from './PurchaseOrdersScreen';

describe('confirmation de retrait du rapprochement', () => {
  it('est réinitialisée dès que la sélection de facture change, même vers Choisir…', () => {
    let confirmation = nextMatchClearConfirmation('request');
    expect(confirmation).toBe(true);

    confirmation = nextMatchClearConfirmation('selection-change');
    expect(confirmation).toBe(false);
  });
});

describe('supplierInvoiceNeedsAttention', () => {
  const partialValidatedInvoice = {
    id: 'invoice-partial',
    documentStatus: 'validated' as const,
    matchStatus: 'partial' as const,
    paymentStatus: 'pending' as const,
    dueDate: '2026-10-01',
  };
  const matches = [
    {
      supplierInvoiceId: 'invoice-partial',
      supplierOrderId: 'order-1',
    },
  ];

  it('retire de la boîte à traiter une facture partielle dont la commande est clôturée', () => {
    expect(
      supplierInvoiceNeedsAttention(
        partialValidatedInvoice,
        matches,
        [{ id: 'order-1', status: 'closed' }],
        '2026-09-01',
      ),
    ).toBe(false);
  });

  it('conserve la facture si sa commande liée attend encore une action', () => {
    expect(
      supplierInvoiceNeedsAttention(
        partialValidatedInvoice,
        matches,
        [{ id: 'order-1', status: 'confirmed' }],
        '2026-09-01',
      ),
    ).toBe(true);
  });
});

describe('purchaseVatOptions', () => {
  it('force 0 % pour une entreprise non assujettie', () => {
    expect(purchaseVatOptions(false, [810])).toEqual([0]);
  });

  it('conserve uniquement les taux TVA configurés et valides', () => {
    expect(purchaseVatOptions(true, [260, 810, 0, 810, -1])).toEqual([
      260, 810, 0,
    ]);
  });
});

describe('existingInvoiceItemMatchDraft', () => {
  const matches = [
    {
      supplierInvoiceId: 'invoice-current',
      supplierInvoiceItemId: 'item-current',
      supplierOrderId: 'order-current',
      supplierOrderLineId: 'order-line-1',
      quantityMilli: 5_000,
    },
    {
      supplierInvoiceId: 'invoice-current',
      supplierInvoiceItemId: 'item-current',
      supplierOrderId: 'order-current',
      supplierOrderLineId: 'order-line-1',
      quantityMilli: 3_000,
    },
    {
      supplierInvoiceId: 'invoice-other',
      supplierInvoiceItemId: 'item-current',
      supplierOrderId: 'order-current',
      supplierOrderLineId: 'order-line-1',
      quantityMilli: 9_000,
    },
  ];

  it('recharge une ligne répartie sur plusieurs réceptions', () => {
    expect(
      existingInvoiceItemMatchDraft(
        matches,
        'invoice-current',
        'item-current',
        'order-current',
      ),
    ).toEqual({
      supplierOrderLineId: 'order-line-1',
      quantityMilli: 8_000,
    });
  });

  it('refuse de deviner si une ligne de facture couvre plusieurs lignes de commande', () => {
    expect(
      existingInvoiceItemMatchDraft(
        [
          ...matches,
          {
            ...matches[0],
            supplierOrderLineId: 'order-line-2',
          },
        ],
        'invoice-current',
        'item-current',
        'order-current',
      ),
    ).toBeNull();
  });
});

describe('allocateSupplierReceiptQuantity', () => {
  it('répartit dix unités sur deux réceptions partielles de cinq', () => {
    expect(
      allocateSupplierReceiptQuantity(
        10_000,
        [
          { id: 'receipt-line-1', quantityMilli: 5_000 },
          { id: 'receipt-line-2', quantityMilli: 5_000 },
        ],
        [],
      ),
    ).toEqual({
      allocations: [
        { supplierReceiptLineId: 'receipt-line-1', quantityMilli: 5_000 },
        { supplierReceiptLineId: 'receipt-line-2', quantityMilli: 5_000 },
      ],
      remainingMilli: 0,
    });
  });

  it('respecte les quantités déjà rapprochées et signale un reliquat', () => {
    expect(
      allocateSupplierReceiptQuantity(
        9_000,
        [
          { id: 'receipt-line-1', quantityMilli: 5_000 },
          { id: 'receipt-line-2', quantityMilli: 5_000 },
        ],
        [
          {
            supplierReceiptLineId: 'receipt-line-1',
            quantityMilli: 2_000,
          },
        ],
      ),
    ).toEqual({
      allocations: [
        { supplierReceiptLineId: 'receipt-line-1', quantityMilli: 3_000 },
        { supplierReceiptLineId: 'receipt-line-2', quantityMilli: 5_000 },
      ],
      remainingMilli: 1_000,
    });
  });
});

describe('receiptAllocationUsageOutsideInvoice', () => {
  it('ignore les anciennes allocations de la facture remplacée', () => {
    expect(
      receiptAllocationUsageOutsideInvoice(
        [
          {
            supplierInvoiceId: 'invoice-current',
            supplierReceiptLineId: 'receipt-line-1',
            quantityMilli: 5_000,
          },
          {
            supplierInvoiceId: 'invoice-other',
            supplierReceiptLineId: 'receipt-line-2',
            quantityMilli: 2_000,
          },
        ],
        'invoice-current',
      ),
    ).toEqual([
      {
        supplierReceiptLineId: 'receipt-line-2',
        quantityMilli: 2_000,
      },
    ]);
  });
});

describe('replacementMatchableQuantity', () => {
  it('rend à nouveau disponible un rapprochement complet remplacé', () => {
    expect(
      replacementMatchableQuantity(
        0,
        10_000,
        10_000,
        10_000,
        'stocked_receipt',
      ),
    ).toBe(10_000);
  });

  it('reste borné par la quantité effectivement reçue', () => {
    expect(
      replacementMatchableQuantity(
        2_000,
        5_000,
        10_000,
        6_000,
        'untracked_receipt',
      ),
    ).toBe(6_000);
  });
});

describe('supplierDraftLineTotals', () => {
  it('arrondit le rabais et la TVA une seule fois par ligne', () => {
    expect(
      supplierDraftLineTotals({
        quantityMilli: 2_500,
        unitPriceCents: 1_999,
        discountBp: 500,
        vatBp: 810,
      }),
    ).toEqual({
      grossCents: 4_998,
      discountCents: 250,
      netCents: 4_748,
      vatCents: 385,
      totalCents: 5_133,
    });
  });
});
