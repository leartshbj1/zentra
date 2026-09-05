// Browser-only simulated persistence. Native recurrence rules have separate SQLite tests.
import { desktopApi } from '../src/bridge';
import { nextRecurringDate } from '../src/recurrenceUi';
import { refreshWorkspaceAfterMutation } from '../src/workspaceMutation';
import type { Invoice, RecurrenceSchedule, SalesOrder, Workspace } from '../src/types';

export function installRecurrenceFixture(initial: Workspace) {
  const now = '2026-09-05T10:00:00Z';
  initial.settings!.organization.vatRegistered = true;
  initial.settings!.billing.vatRatesBp = [810, 260, 0];
  const order: SalesOrder = {
    id: 'recurring-order', number: 'CMD-2026-042', title: 'Entretien mensuel des installations et assistance technique',
    clientId: initial.clients[0].id, projectId: null, quoteId: null, status: 'confirmed', orderDate: '2025-01-01', currency: 'CHF',
    subtotalCents: 10000, discountCents: 0, vatCents: 810, totalCents: 10810, notes: '', terms: '',
    confirmedAt: now, closedAt: null, cancelledAt: null, createdAt: now, updatedAt: now,
    snapshot: {} as SalesOrder['snapshot'],
    lines: [{ id: 'recurring-line', salesOrderId: 'recurring-order', catalogItemId: null, position: 0, description: 'Maintenance et assistance', quantityMilli: 1000, cancelledQuantityMilli: 0, unit: 'forfait', unitPriceCents: 10000, discountBp: 0, vatBp: 810, lineGrossCents: 10000, lineNetCents: 10000, lineVatCents: 810, lineTotalCents: 10810, fulfillmentMode: 'direct' }],
  };
  initial.salesOrders = [order];
  const automatic = new URLSearchParams(location.search).has('automatic');
  if (automatic) {
    initial.salesOrders.push({ ...structuredClone(order), id: 'second-order', number: 'CMD-2026-043', title: 'Deuxième contrat de maintenance' });
    initial.recurrenceSchedules = ['recurring-order', 'second-order'].map((id, index) => ({ id: `schedule-${index}`, sourceSalesOrderId: id, frequency: 'monthly', anchorDate: '2026-09-01', anchorDay: 1, anchorIsMonthEnd: false, paymentTermsDays: 30, nextScheduledFor: '2026-09-01', endDate: null, status: 'active', reviewReason: null, sourceOrderSnapshotSha256: 'a'.repeat(64), sourceSnapshotSha256: 'b'.repeat(64), completedAt: null, createdAt: now, updatedAt: now }));
    sessionStorage.setItem('qa-recurrence-generate-failure', 'refresh_twice');
    sessionStorage.setItem('qa-recurrence-block-reads', '1');
    sessionStorage.setItem('qa-recurrence-hold-next-read', '1');
  }
  let persisted = structuredClone(initial);
  const requests = new Map<string, string>();
  let readFailures = 0;
  const log = (operation: string, input: unknown) => {
    const key = `qa-recurrence-${operation}-attempts`;
    const list = JSON.parse(sessionStorage.getItem(key) || '[]');
    list.push(input); sessionStorage.setItem(key, JSON.stringify(list));
  };
  const failure = (operation: string) => {
    const value = sessionStorage.getItem(`qa-recurrence-${operation}-failure`);
    sessionStorage.removeItem(`qa-recurrence-${operation}-failure`);
    if (value === 'reject') throw new Error(`La planification n’a pas été enregistrée : refus ${operation} simulé.`);
    return value;
  };
  const remember = () => sessionStorage.setItem('qa-recurrence-persisted', JSON.stringify(persisted));
  remember();
  desktopApi.loadWorkspace = async () => {
    sessionStorage.setItem('qa-recurrence-read-count', String(Number(sessionStorage.getItem('qa-recurrence-read-count') || 0) + 1));
    if (sessionStorage.getItem('qa-recurrence-hold-next-read') === '1') {
      sessionStorage.removeItem('qa-recurrence-hold-next-read');
      await new Promise<void>((resolve) => window.addEventListener('qa-release-recurrence-read', () => resolve(), { once: true }));
    }
    if (readFailures > 0 || sessionStorage.getItem('qa-recurrence-block-reads') === '1') {
      readFailures = Math.max(0, readFailures - 1);
      throw new Error('Lecture de la planification temporairement indisponible.');
    }
    return structuredClone(persisted);
  };
  const afterWrite = async (mode: string | null) => {
    readFailures = mode === 'refresh_twice' ? 2 : mode === 'refresh_once' ? 1 : 0;
    remember();
    return refreshWorkspaceAfterMutation(desktopApi.loadWorkspace);
  };
  desktopApi.createRecurrenceSchedule = async (input) => {
    log('create', input); const mode = failure('create');
    if (!requests.has(input.requestId)) {
      if (persisted.recurrenceSchedules.some((item) => item.sourceSalesOrderId === input.sourceSalesOrderId)) throw new Error('Une seule planification par commande.');
      const date = new Date(`${input.startDate}T12:00:00Z`);
      const schedule: RecurrenceSchedule = { id: 'schedule-new', sourceSalesOrderId: input.sourceSalesOrderId, frequency: input.frequency, anchorDate: input.startDate, anchorDay: date.getUTCDate(), anchorIsMonthEnd: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate() === date.getUTCDate(), paymentTermsDays: input.paymentTermsDays, nextScheduledFor: input.startDate, endDate: input.endDate || null, status: 'active', reviewReason: null, sourceOrderSnapshotSha256: 'a'.repeat(64), sourceSnapshotSha256: 'b'.repeat(64), completedAt: null, createdAt: now, updatedAt: now };
      persisted.recurrenceSchedules.push(schedule); requests.set(input.requestId, schedule.id);
    }
    return afterWrite(mode);
  };
  desktopApi.updateRecurrenceSchedule = async (input) => {
    log('update', input); const mode = failure('update');
    if (!requests.has(input.requestId)) {
      const schedule = persisted.recurrenceSchedules.find((item) => item.id === input.scheduleId)!;
      if (schedule.status === 'completed') throw new Error('Une planification terminée ne peut pas reprendre.');
      schedule.status = input.status; schedule.endDate = input.endDate || null; schedule.reviewReason = null;
      schedule.updatedAt = new Date().toISOString();
      if (input.status === 'completed') schedule.completedAt = now;
      requests.set(input.requestId, schedule.id);
    }
    return afterWrite(mode);
  };
  desktopApi.generateRecurrenceOccurrences = async (input) => {
    log('generate', input); const mode = failure('generate');
    const schedule = persisted.recurrenceSchedules.find((item) => item.id === input.scheduleId)!;
    if (!requests.has(input.requestId) && schedule.status === 'active') {
      let generated = 0;
      while (schedule.nextScheduledFor <= input.throughDate && (!schedule.endDate || schedule.nextScheduledFor <= schedule.endDate) && generated < 12) {
        const scheduledFor = schedule.nextScheduledFor;
        const id = `${schedule.id}-${scheduledFor}`;
        if (!persisted.recurrenceOccurrences.some((item) => item.id === id)) {
          const invoiceId = `invoice-${id}`;
          const due = new Date(`${scheduledFor}T12:00:00Z`); due.setUTCDate(due.getUTCDate() + schedule.paymentTermsDays);
          const invoice = { id: invoiceId, clientId: order.clientId, projectId: null, quoteId: null, originalInvoiceId: null, number: '', title: `Maintenance · ${scheduledFor}`, type: 'standard', status: 'draft', currency: 'CHF', issueDate: scheduledFor, dueDate: due.toISOString().slice(0, 10), serviceDateFrom: scheduledFor, serviceDateTo: scheduledFor, depositPercentageBp: null, depositBasisLines: null, notes: '', terms: '', createdAt: now, lines: [{ id: `${invoiceId}-line`, description: 'Maintenance et assistance', quantity: 1, unit: 'forfait', unitPriceCents: 10000, discountBp: 0, vatRateBp: 810 }] } as Invoice;
          persisted.invoices.push(invoice);
          persisted.recurrenceOccurrences.push({ sequence: persisted.recurrenceOccurrences.length + 1, id, scheduleId: schedule.id, scheduledFor, invoiceId, status: 'draft_created', message: null, requestId: input.requestId, payloadSha256: 'c'.repeat(64), sourceSnapshotSha256: schedule.sourceSnapshotSha256, createdAt: now, invoiceStatus: 'draft', invoiceNumber: null });
        }
        schedule.nextScheduledFor = nextRecurringDate(scheduledFor, schedule)!; generated++;
      }
      if (schedule.endDate && schedule.nextScheduledFor > schedule.endDate) schedule.status = 'completed';
      else if (schedule.nextScheduledFor <= input.throughDate) { schedule.status = 'review_required'; schedule.reviewReason = 'Le lot de 12 brouillons est prêt. Contrôlez-le avant de reprendre.'; }
      requests.set(input.requestId, schedule.id);
    }
    return afterWrite(mode);
  };
}
