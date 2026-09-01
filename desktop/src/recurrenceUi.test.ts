import { describe, expect, it } from 'vitest';
import type { RecurrenceSchedule, SalesOrder, Workspace } from './types';
import {
  nextRecurringDate,
  pendingRecurringOccurrenceCount,
  processRecurrenceScheduleBatch,
  recurrenceOrderEligibility,
  recurrenceSchedulesDue,
} from './recurrenceUi';

const schedule: RecurrenceSchedule = {
  id: 'schedule-1',
  sourceSalesOrderId: 'order-1',
  frequency: 'monthly',
  anchorDate: '2028-01-31',
  anchorDay: 31,
  anchorIsMonthEnd: true,
  paymentTermsDays: 30,
  nextScheduledFor: '2028-01-31',
  endDate: null,
  status: 'active',
  reviewReason: null,
  sourceOrderSnapshotSha256: 'a'.repeat(64),
  sourceSnapshotSha256: 'b'.repeat(64),
  completedAt: null,
  createdAt: '2028-01-01T00:00:00Z',
  updatedAt: '2028-01-01T00:00:00Z',
};

const order: SalesOrder = {
  id: 'order-1',
  clientId: 'client-1',
  projectId: null,
  quoteId: null,
  number: 'CMD-1',
  title: 'Maintenance',
  status: 'confirmed',
  orderDate: '2028-01-01',
  currency: 'CHF',
  subtotalCents: 10000,
  discountCents: 0,
  vatCents: 810,
  totalCents: 10810,
  notes: '',
  terms: '',
  confirmedAt: '2028-01-01T00:00:00Z',
  closedAt: null,
  cancelledAt: null,
  createdAt: '2028-01-01T00:00:00Z',
  updatedAt: '2028-01-01T00:00:00Z',
  lines: [
    {
      id: 'line-1',
      salesOrderId: 'order-1',
      catalogItemId: null,
      position: 0,
      description: 'Maintenance',
      quantityMilli: 1000,
      cancelledQuantityMilli: 0,
      unit: 'forfait',
      unitPriceCents: 10000,
      discountBp: 0,
      vatBp: 810,
      lineGrossCents: 10000,
      lineNetCents: 10000,
      lineVatCents: 810,
      lineTotalCents: 10810,
      fulfillmentMode: 'direct',
    },
  ],
  snapshot: {} as SalesOrder['snapshot'],
};

const workspaceContext = {
  catalogItems: [],
  deliveryNotes: [],
  salesOrderInvoiceBatches: [],
} satisfies Pick<
  Workspace,
  'catalogItems' | 'deliveryNotes' | 'salesOrderInvoiceBatches'
>;

describe('récurrence côté interface', () => {
  it('conserve la fin de mois, y compris en année bissextile', () => {
    expect(nextRecurringDate('2028-01-31', schedule)).toBe('2028-02-29');
    expect(nextRecurringDate('2028-02-29', schedule)).toBe('2028-03-31');
  });

  it('compte les échéances dues à partir de la prochaine occurrence', () => {
    expect(pendingRecurringOccurrenceCount(schedule, '2028-03-31')).toBe(3);
    expect(
      pendingRecurringOccurrenceCount(
        { ...schedule, status: 'completed' },
        '2028-03-31',
      ),
    ).toBe(0);
  });

  it('ne lance automatiquement que les planifications actives et dues', () => {
    expect(
      recurrenceSchedulesDue(
        [
          schedule,
          { ...schedule, id: 'paused', status: 'paused' },
          {
            ...schedule,
            id: 'future',
            nextScheduledFor: '2028-04-30',
          },
        ],
        '2028-03-31',
      ).map((item) => item.id),
    ).toEqual(['schedule-1']);
  });

  it('conserve les succès quand une planification suivante échoue', async () => {
    const succeededWorkspace = { marker: 'schedule-1-persisted' };
    const published: string[] = [];
    const result = await processRecurrenceScheduleBatch({
      schedules: [schedule, { ...schedule, id: 'schedule-2' }],
      throughDate: '2028-01-31',
      requestIdFor: (item) => `request-${item.id}`,
      generate: async (input) => {
        if (input.scheduleId === 'schedule-2') throw new Error('disque plein');
        return succeededWorkspace;
      },
      onSuccess: (_workspace, item) => {
        published.push(item.id);
      },
    });

    expect(result.latestResult).toBe(succeededWorkspace);
    expect(result.succeededScheduleIds).toEqual(['schedule-1']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.scheduleId).toBe('schedule-2');
    expect(published).toEqual(['schedule-1']);
  });

  it('accepte une commande CHF directe sans historique standard', () => {
    expect(recurrenceOrderEligibility(order, workspaceContext)).toEqual({
      eligible: true,
      reasons: [],
    });
  });

  it('explique les conflits de livraison, stock, facture et annulation', () => {
    const result = recurrenceOrderEligibility(
      {
        ...order,
        lines: [
          {
            ...order.lines[0],
            catalogItemId: 'item-1',
            cancelledQuantityMilli: 100,
            fulfillmentMode: 'stocked_delivery',
          },
        ],
      },
      {
        catalogItems: [{ id: 'item-1', trackStock: true }] as Workspace['catalogItems'],
        deliveryNotes: [
          { salesOrderId: order.id },
        ] as Workspace['deliveryNotes'],
        salesOrderInvoiceBatches: [
          { salesOrderId: order.id },
        ] as Workspace['salesOrderInvoiceBatches'],
      },
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(' ')).toContain('facturation directe');
    expect(result.reasons.join(' ')).toContain('suivi en stock');
    expect(result.reasons.join(' ')).toContain('bon de livraison');
    expect(result.reasons.join(' ')).toContain('facturation standard');
    expect(result.reasons.join(' ')).toContain('quantité annulée');
  });
});
