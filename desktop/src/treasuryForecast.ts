// Prévision de trésorerie à 30, 60 et 90 jours, calculée par l'app à partir
// de ce qui est déjà saisi : factures ouvertes, factures fournisseurs et
// dépenses à payer, salaires du dernier mois, factures récurrentes et
// contrats fournisseurs. Aucune estimation par IA.
import { addMonths, contractDueDates } from './contracts';
import type { Contract, Workspace } from './types';
import { invoiceOpenBalance, payslipTotals } from './utils';

export type ForecastKind = 'invoice' | 'overdue' | 'supplier' | 'expense' | 'payroll' | 'recurring' | 'contract' | 'vat';

export type ForecastEvent = { date: string; kind: ForecastKind; label: string; amountCents: number };

export type Forecast = {
  start: string;
  startCents: number;
  events: ForecastEvent[];
  /** Solde prévu à J+30, J+60, J+90. */
  at: Record<30 | 60 | 90, number>;
  /** Point le plus bas sur 30 jours, avec la plus grosse sortie de ce jour-là. */
  low: { date: string; cents: number; cause: ForecastEvent | null };
};

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
export const plusDays = (iso: string, days: number) => new Date(day(iso).getTime() + days * 86_400_000).toISOString().slice(0, 10);

type Source = Pick<Workspace, 'invoices' | 'payments' | 'supplierInvoices' | 'expenses' | 'payslips' | 'recurrenceSchedules' | 'salesOrders'> & { contracts?: readonly Contract[] };

/** Retards : un client en retard paie rarement le jour même ; l'app le compte dans une semaine. */
const OVERDUE_DELAY_DAYS = 7;

export function forecastEvents(workspace: Source, today: string, horizon = 90): ForecastEvent[] {
  const end = plusDays(today, horizon);
  const events: ForecastEvent[] = [];
  for (const invoice of workspace.invoices) {
    if (!invoice.number || invoice.type === 'credit_note' || ['draft', 'paid', 'cancelled'].includes(invoice.status)) continue;
    if ((invoice.currency || 'CHF') !== 'CHF') continue;
    const open = invoiceOpenBalance(invoice, workspace.invoices, workspace.payments);
    if (open <= 0) continue;
    const late = !invoice.dueDate || invoice.dueDate < today;
    const date = late ? plusDays(today, OVERDUE_DELAY_DAYS) : invoice.dueDate;
    if (date <= end) events.push({ date, kind: late ? 'overdue' : 'invoice', label: invoice.number, amountCents: open });
  }
  for (const invoice of workspace.supplierInvoices) {
    if (invoice.documentStatus !== 'validated' || invoice.balanceCents <= 0 || (invoice.currency || 'CHF') !== 'CHF') continue;
    const date = invoice.dueDate < today ? today : invoice.dueDate;
    if (date <= end) events.push({ date, kind: 'supplier', label: invoice.supplierName, amountCents: -invoice.balanceCents });
  }
  for (const expense of workspace.expenses) {
    if (expense.paymentStatus !== 'pending' || !expense.dueDate) continue;
    const date = expense.dueDate < today ? today : expense.dueDate;
    if (date <= end) events.push({ date, kind: 'expense', label: expense.supplier || expense.category || '', amountCents: -expense.totalCents });
  }
  // Salaires : le net du dernier mois payé, chaque mois au même jour.
  const periods = [...new Set(workspace.payslips.filter((slip) => slip.status !== 'incomplete').map((slip) => slip.period))].sort();
  const lastPeriod = periods[periods.length - 1];
  if (lastPeriod) {
    const slips = workspace.payslips.filter((slip) => slip.period === lastPeriod && slip.status !== 'incomplete');
    const net = slips.reduce((sum, slip) => sum + payslipTotals(slip).net, 0);
    const paidOn = slips.map((slip) => slip.paymentDate).filter(Boolean).sort().pop();
    const payday = paidOn ? Number(paidOn.slice(8, 10)) : 25;
    if (net > 0) {
      for (let month = 0; month <= Math.ceil(horizon / 28); month += 1) {
        const anchor = addMonths(`${today.slice(0, 8)}01`, month);
        const last = Number(plusDays(addMonths(anchor, 1), -1).slice(8, 10));
        const date = `${anchor.slice(0, 8)}${String(Math.min(payday, last)).padStart(2, '0')}`;
        const alreadyPaid = paidOn && date.slice(0, 7) <= paidOn.slice(0, 7);
        if (date >= today && date <= end && !alreadyPaid) events.push({ date, kind: 'payroll', label: '', amountCents: -net });
      }
    }
  }
  // Factures récurrentes : montant de la commande d'origine, à chaque échéance.
  for (const schedule of workspace.recurrenceSchedules) {
    if (schedule.status !== 'active') continue;
    const order = workspace.salesOrders.find((row) => row.id === schedule.sourceSalesOrderId);
    if (!order || (order.currency || 'CHF') !== 'CHF' || order.totalCents <= 0) continue;
    const step = schedule.frequency === 'monthly' ? 1 : schedule.frequency === 'quarterly' ? 3 : 12;
    for (let index = 0; index < 400; index += 1) {
      const issued = addMonths(schedule.nextScheduledFor, index * step);
      if (schedule.endDate && issued > schedule.endDate) break;
      const date = plusDays(issued, schedule.paymentTermsDays);
      if (date > end) break;
      if (date >= today) events.push({ date, kind: 'recurring', label: order.number || '', amountCents: order.totalCents });
    }
  }
  for (const contract of workspace.contracts ?? []) {
    if (contract.side !== 'supplier' || contract.amountCents <= 0 || contract.currency !== 'CHF') continue;
    for (const date of contractDueDates(contract, today, end)) events.push({ date, kind: 'contract', label: contract.title, amountCents: -contract.amountCents });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.amountCents - b.amountCents);
}

export function treasuryForecast(workspace: Source, startCents: number, today: string, extra: readonly ForecastEvent[] = []): Forecast {
  const events = [...forecastEvents(workspace, today, 90), ...extra.filter((event) => event.date >= today && event.date <= plusDays(today, 90))]
    .sort((a, b) => a.date.localeCompare(b.date) || a.amountCents - b.amountCents);
  const balanceAt = (date: string) => startCents + events.filter((event) => event.date <= date).reduce((sum, event) => sum + event.amountCents, 0);
  let low = { date: today, cents: startCents, cause: null as ForecastEvent | null };
  for (const date of [...new Set(events.map((event) => event.date))]) {
    if (date > plusDays(today, 30)) break;
    const cents = balanceAt(date);
    if (cents < low.cents) {
      const outflows = events.filter((event) => event.date === date && event.amountCents < 0).sort((a, b) => a.amountCents - b.amountCents);
      low = { date, cents, cause: outflows[0] ?? null };
    }
  }
  return { start: today, startCents, events, at: { 30: balanceAt(plusDays(today, 30)), 60: balanceAt(plusDays(today, 60)), 90: balanceAt(plusDays(today, 90)) }, low };
}

/** Solde de départ saisi par l'utilisateur, gardé sur cet appareil avec sa date. */
const START_KEY = 'zentra.treasury.start.v1';

export function savedStart(organizationId: string): { cents: number; date: string } | null {
  try {
    const value = (JSON.parse(localStorage.getItem(START_KEY) || '{}') as Record<string, { cents: number; date: string }>)[organizationId];
    return value && Number.isInteger(value.cents) && /^\d{4}-\d{2}-\d{2}$/.test(value.date) ? value : null;
  } catch {
    return null;
  }
}

export function saveStart(organizationId: string, cents: number, date: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(START_KEY) || '{}') as Record<string, unknown>;
    all[organizationId] = { cents, date };
    localStorage.setItem(START_KEY, JSON.stringify(all));
  } catch {
    // Saisi à nouveau la prochaine fois.
  }
}
