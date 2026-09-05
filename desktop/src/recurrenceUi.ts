import type { RecurrenceSchedule, SalesOrder, Workspace } from './types';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoDate(value: string) {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return { year, month, day };
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function nextRecurringDate(
  current: string,
  schedule: Pick<
    RecurrenceSchedule,
    'frequency' | 'anchorDay' | 'anchorIsMonthEnd'
  >,
) {
  const parsed = parseIsoDate(current);
  if (!parsed) return null;
  const months =
    schedule.frequency === 'monthly'
      ? 1
      : schedule.frequency === 'quarterly'
        ? 3
        : 12;
  const monthIndex = parsed.year * 12 + parsed.month - 1 + months;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  if (year > 9999) return null;
  const lastDay = daysInMonth(year, month);
  const day = schedule.anchorIsMonthEnd
    ? lastDay
    : Math.min(Math.max(1, schedule.anchorDay), lastDay);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function pendingRecurringOccurrenceCount(
  schedule: RecurrenceSchedule,
  throughDate: string,
) {
  if (schedule.status === 'completed' || !parseIsoDate(throughDate)) return 0;
  let next = schedule.nextScheduledFor;
  if (!parseIsoDate(next)) return 0;
  let count = 0;
  // La plage de dates SQLite est bornée à l'année 9999. Cette garde évite
  // néanmoins toute boucle non bornée si une base locale a été altérée.
  while (
    next <= throughDate &&
    (!schedule.endDate || next <= schedule.endDate) &&
    count < 120_000
  ) {
    count += 1;
    const following = nextRecurringDate(next, schedule);
    if (!following || following <= next) break;
    next = following;
  }
  return count;
}

export function recurrenceSchedulesDue(
  schedules: readonly RecurrenceSchedule[],
  throughDate: string,
) {
  if (!parseIsoDate(throughDate)) return [];
  return schedules.filter(
    (schedule) =>
      schedule.status === 'active' &&
      Boolean(parseIsoDate(schedule.nextScheduledFor)) &&
      schedule.nextScheduledFor <= throughDate &&
      (!schedule.endDate || schedule.nextScheduledFor <= schedule.endDate),
  );
}

export type RecurrenceScheduleBatchInput = {
  requestId: string;
  scheduleId: string;
  throughDate: string;
};

export type RecurrenceScheduleBatchFailure = {
  scheduleId: string;
  reason: unknown;
};

export async function processRecurrenceScheduleBatch<T>({
  schedules,
  throughDate,
  requestIdFor,
  generate,
  onSuccess,
  shouldContinue,
}: {
  schedules: readonly RecurrenceSchedule[];
  throughDate: string;
  requestIdFor: (schedule: RecurrenceSchedule) => string;
  generate: (input: RecurrenceScheduleBatchInput) => Promise<T>;
  shouldContinue?: () => boolean;
  onSuccess?: (
    result: T,
    schedule: RecurrenceSchedule,
  ) => void | Promise<void>;
}) {
  let latestResult: T | null = null;
  const succeededScheduleIds: string[] = [];
  const failures: RecurrenceScheduleBatchFailure[] = [];
  for (const schedule of schedules) {
    if (shouldContinue && !shouldContinue()) break;
    try {
      const result = await generate({
        requestId: requestIdFor(schedule),
        scheduleId: schedule.id,
        throughDate,
      });
      latestResult = result;
      succeededScheduleIds.push(schedule.id);
      await onSuccess?.(result, schedule);
    } catch (reason) {
      failures.push({ scheduleId: schedule.id, reason });
    }
  }
  return { latestResult, succeededScheduleIds, failures };
}

export function recurrenceOrderEligibility(
  order: SalesOrder,
  workspace: Pick<
    Workspace,
    | 'catalogItems'
    | 'deliveryNotes'
    | 'salesOrderInvoiceBatches'
  >,
) {
  const reasons: string[] = [];
  if (order.currency !== 'CHF')
    reasons.push('Le modèle récurrent doit être établi en CHF.');
  if (!order.lines.length)
    reasons.push('Ajoutez au moins une ligne à la commande modèle.');
  if (order.lines.some((line) => line.fulfillmentMode !== 'direct'))
    reasons.push(
      'Utilisez uniquement des lignes en facturation directe, sans livraison.',
    );
  if (
    order.lines.some((line) => {
      if (!line.catalogItemId) return false;
      return workspace.catalogItems.some(
        (item) => item.id === line.catalogItemId && item.trackStock,
      );
    })
  )
    reasons.push(
      'Un article suivi en stock ne peut pas servir de modèle récurrent.',
    );
  if (!order.snapshot && order.status === 'confirmed')
    reasons.push('Le contenu confirmé de la commande n’est pas disponible.');
  if (
    workspace.deliveryNotes.some((note) => note.salesOrderId === order.id)
  )
    reasons.push('Cette commande possède déjà un bon de livraison.');
  if (
    workspace.salesOrderInvoiceBatches.some(
      (batch) => batch.salesOrderId === order.id,
    )
  )
    reasons.push('Cette commande est déjà entrée dans la facturation standard.');
  if (order.lines.some((line) => line.cancelledQuantityMilli > 0))
    reasons.push('Cette commande contient déjà une quantité annulée.');
  return { eligible: reasons.length === 0, reasons };
}
