import { diagnosticInvoke as invoke } from './diagnostics';
import { addDays, quoteKey, type followUpEntries } from './autopilotFollowUps';
import type { Quote, Reminder, SupplierInvoice } from './types';

/**
 * Autopilote quand les ordinateurs sont éteints : le serveur lit les mails et
 * prépare les devis la nuit, et rappelle les échéances au bon jour sur le
 * téléphone. L'app active le réglage, le renouvelle chaque jour et envoie
 * l'échéancier calculé ici avec les règles des cartes Autopilote.
 */
export const BACKGROUND_CONSENT_VERSION = 'autopilot-background-2026-10-26';
export type BackgroundState = 'idle' | 'prepared' | 'paused' | 'renewal_needed' | 'unavailable' | null;
export type BackgroundStatus = Readonly<{
  organizationId: string; consentVersion: string | null; enabled: boolean; grantedAt: number | null; expiresAt: number | null;
  lastRunAt: number | null; lastState: BackgroundState; waiting: number;
}>;
export type ScheduleKind = 'invoice_overdue' | 'quote_follow_up' | 'supplier_due' | 'vat_due';
export type ScheduleItem = Readonly<{ kind: ScheduleKind; id: string; dueOn: string; party: string; reference: string; amountCents: number | null }>;

export const backgroundApi = {
  call: (operation: 'status' | 'enable' | 'disable') => invoke<BackgroundStatus>('autopilot_background', { operation }),
  schedule: (items: readonly ScheduleItem[]) => invoke<{ stored: number }>('autopilot_schedule', { items }),
};

const MAX_ITEMS = 200;
const clean = (value: string, max: number) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const safeId = (prefix: string, id: string) => `${prefix}:${id}`.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
const chf = (currency: string, cents: number) => currency === 'CHF' && Number.isSafeInteger(cents) ? cents : null;

/** One entry per open invoice: the next planned reminder of its cycle. */
function invoiceItems(reminders: readonly Reminder[]): ScheduleItem[] {
  const next = new Map<string, Reminder>();
  for (const reminder of reminders) {
    if ((reminder.status !== 'planned' && reminder.status !== 'due') || reminder.balanceCents <= 0 || !reminder.scheduledDate) continue;
    const current = next.get(reminder.invoiceId);
    if (!current || reminder.scheduledDate < current.scheduledDate) next.set(reminder.invoiceId, reminder);
  }
  return [...next.values()].map(reminder => ({ kind: 'invoice_overdue', id: safeId('inv', reminder.invoiceId), dueOn: reminder.scheduledDate,
    party: clean(reminder.clientName ?? '', 80), reference: clean(reminder.invoiceNumber ?? '', 40), amountCents: chf(reminder.currency, reminder.balanceCents) }));
}

/** Issued quotes without an answer: 7 days after issue, or 3 days before validity ends, as the follow-up cards. */
function quoteItems(quotes: readonly Quote[], clientNames: Readonly<Record<string, string>>, entries: ReturnType<typeof followUpEntries>, today: string): ScheduleItem[] {
  return quotes.flatMap(quote => {
    if (quote.status !== 'issued' || !quote.number || (quote.validUntil && today > quote.validUntil)) return [];
    const entry = entries[quoteKey(quote.id)];
    if (entry?.ignored || (entry?.sentCount ?? 0) >= 2) return [];
    const first = addDays(quote.issueDate, 7), last = quote.validUntil ? addDays(quote.validUntil, -3) : '';
    const dueOn = (entry?.sentCount ?? 0) === 0 ? (last && last < first ? last : first) : last;
    if (!dueOn) return [];
    const postponed = entry?.until && entry.until > dueOn ? entry.until : dueOn;
    return [{ kind: 'quote_follow_up' as const, id: safeId('quo', quote.id), dueOn: postponed, party: clean(clientNames[quote.clientId] ?? '', 80),
      reference: clean(quote.number, 40), amountCents: null }];
  });
}

/** Validated supplier invoices still open: five days before they fall due. */
function supplierItems(invoices: readonly SupplierInvoice[]): ScheduleItem[] {
  return invoices.flatMap(invoice => invoice.documentStatus === 'validated' && invoice.balanceCents > 0 && invoice.dueDate
    ? [{ kind: 'supplier_due' as const, id: safeId('sinv', invoice.id), dueOn: addDays(invoice.dueDate, -5), party: clean(invoice.supplierName, 80),
      reference: clean(invoice.reference, 40), amountCents: chf(invoice.currency, invoice.balanceCents) }]
    : []);
}

/** The VAT period that closed and was not exported: from the day after it ends. */
function vatItem(vat: Readonly<{ from: string; to: string }> | null): ScheduleItem[] {
  if (!vat) return [];
  const month = Number(vat.to.slice(5, 7)), months = (Number(vat.to.slice(0, 4)) * 12 + month) - (Number(vat.from.slice(0, 4)) * 12 + Number(vat.from.slice(5, 7))) + 1;
  const year = vat.to.slice(0, 4);
  const reference = months === 3 ? `T${Math.ceil(month / 3)} ${year}` : months === 12 ? year : months === 6 ? `S${month <= 6 ? 1 : 2} ${year}` : `${vat.to.slice(5, 7)}.${year}`;
  return [{ kind: 'vat_due', id: safeId('vat', vat.from), dueOn: addDays(vat.to, 1), party: '', reference, amountCents: null }];
}

export function backgroundSchedule(input: Readonly<{
  reminders: readonly Reminder[]; quotes: readonly Quote[]; clientNames: Readonly<Record<string, string>>;
  followUps: ReturnType<typeof followUpEntries>; supplierInvoices: readonly SupplierInvoice[]; vat: Readonly<{ from: string; to: string }> | null; today: string;
}>): ScheduleItem[] {
  const items = [...invoiceItems(input.reminders), ...quoteItems(input.quotes, input.clientNames, input.followUps, input.today),
    ...supplierItems(input.supplierInvoices), ...vatItem(input.vat)];
  // Closest due dates first, so the 200 kept are the ones that matter soonest.
  // Ids must stay unique after cleaning, or the server refuses the whole schedule.
  const seen = new Set<string>();
  return items.sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id))
    .filter(item => !seen.has(item.id) && !!seen.add(item.id)).slice(0, MAX_ITEMS);
}
