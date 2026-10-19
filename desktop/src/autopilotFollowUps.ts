import type { MailSignal } from './autopilotSignals';
import type { Quote, Reminder } from './types';

/**
 * Autopilote prepares reminders and quote follow-ups; a person sends each one.
 * What this device decided (postponed, ignored, sent) is kept here per company.
 */
type Entry = Readonly<{ until?: string; ignored?: true; sentCount?: number; lastSentAt?: string }>;
type Store = Record<string, Record<string, Entry>>;
const KEY = 'zentra.autopilot.follow-ups.v1';
const MAX = 500;
function read(): Store {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Store : {};
  } catch { return {}; }
}
export function followUpEntries(organizationId: string): Readonly<Record<string, Entry>> { return read()[organizationId] ?? {}; }
export function saveFollowUp(organizationId: string, key: string, change: (entry: Entry) => Entry) {
  const store = read(), company = { ...(store[organizationId] ?? {}) };
  company[key] = change(company[key] ?? {});
  const ids = Object.keys(company);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX))) delete company[old];
  store[organizationId] = company;
  try { window.localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* best effort */ }
}
export const reminderKey = (id: string) => `reminder:${id}`;
export const quoteKey = (id: string) => `quote:${id}`;

export function addDays(iso: string, days: number) {
  const date = new Date(iso + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86_400_000);
const reference = (value: string) => value.toLocaleLowerCase('fr-CH').replace(/\s+/g, '');
const lower = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

/** What a client's recent mail says about this reminder's invoice. */
export type ReminderContext = 'paid' | 'promised' | 'complaint' | null;
export function reminderContext(reminder: Reminder, signals: readonly MailSignal[]): Readonly<{ context: ReminderContext; signal: MailSignal | null }> {
  const number = reminder.invoiceNumber ? reference(reminder.invoiceNumber) : '', email = lower(reminder.clientEmail);
  const sameInvoice = (signal: MailSignal) => signal.invoiceReference
    ? !!number && reference(signal.invoiceReference) === number
    : !!email && lower(signal.sender?.email) === email && (signal.amountCents === null || signal.amountCents === reminder.balanceCents);
  const sameClient = (signal: MailSignal) => !!email && lower(signal.sender?.email) === email;
  const found = (kind: MailSignal['kind'], match: (signal: MailSignal) => boolean) => signals.find(signal => signal.kind === kind && match(signal)) ?? null;
  const paid = found('payment_announced', sameInvoice); if (paid) return { context: 'paid', signal: paid };
  const promised = found('payment_promised', sameInvoice); if (promised) return { context: 'promised', signal: promised };
  const complaint = found('follow_up', sameClient); if (complaint) return { context: 'complaint', signal: complaint };
  return { context: null, signal: null };
}

/** Due reminders still to show: not postponed, ignored or already sent from here. */
export function remindersToShow(reminders: readonly Reminder[], entries: Readonly<Record<string, Entry>>, today: string) {
  return reminders.filter(reminder => {
    const entry = entries[reminderKey(reminder.id)];
    return reminder.status === 'due' && !entry?.ignored && !entry?.sentCount && !(entry?.until && entry.until > today);
  });
}
export function daysOverdue(reminder: Reminder, today: string) { return reminder.dueDate ? Math.max(0, daysBetween(reminder.dueDate, today)) : 0; }

/**
 * Issued quotes without an answer: follow up 7 days after issue, then 3 days
 * before validity ends (two at most); once expired, offer to close them.
 */
export function quotesToFollowUp(quotes: readonly Quote[], signals: readonly MailSignal[], clientEmails: Readonly<Record<string, string>>,
  entries: Readonly<Record<string, Entry>>, today: string): readonly Readonly<{ quote: Quote; step: 'follow_up' | 'close' }>[] {
  return quotes.flatMap((quote): { quote: Quote; step: 'follow_up' | 'close' }[] => {
    if (quote.status !== 'issued' || !quote.number) return [];
    const entry = entries[quoteKey(quote.id)];
    if (entry?.ignored || (entry?.until && entry.until > today)) return [];
    const number = reference(quote.number), email = lower(clientEmails[quote.clientId]);
    const answered = signals.some(signal => (signal.quoteReference && reference(signal.quoteReference) === number)
      || (!!email && lower(signal.sender?.email) === email && (signal.kind === 'quote_accepted' || signal.kind === 'quote_declined')));
    if (answered) return [];
    if (quote.validUntil && today > quote.validUntil) return [{ quote, step: 'close' as const }];
    const sent = entry?.sentCount ?? 0;
    if (sent >= 2) return [];
    const first = addDays(quote.issueDate, 7), last = quote.validUntil ? addDays(quote.validUntil, -3) : '';
    const due = sent === 0 ? today >= first || (!!last && today >= last) : !!last && today >= last && (entry?.lastSentAt ?? '') < last;
    return due ? [{ quote, step: 'follow_up' as const }] : [];
  });
}
