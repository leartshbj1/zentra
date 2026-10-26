import type { MailSignal } from './autopilotSignals';
import type { Quote, Reminder } from './types';

/**
 * Autopilote prepares reminders and quote follow-ups; a person sends each one.
 * What this device decided (postponed, ignored, sent) is kept here per company.
 */
type Entry = Readonly<{ until?: string; ignored?: true; sentCount?: number; lastSentAt?: string; askedName?: string; askedEmployeeId?: string }>;
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

const PROMISE_MONTHS: Record<string, number> = {
  janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12,
  januar: 1, februar: 2, märz: 3, april: 4, juni: 6, juli: 7, august: 8, oktober: 10, dezember: 12,
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7, agosto: 8, settembre: 9, ottobre: 10, dicembre: 12,
  january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, october: 10, december: 12,
};
const PROMISE_WEEKDAYS: Record<string, number> = {
  dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6,
  sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6,
  domenica: 0, lunedì: 1, martedì: 2, mercoledì: 3, giovedì: 4, venerdì: 5, sabato: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The date a client promised to pay by, read from their own sentence and the day
 * the mail arrived ("le 30 octobre", "30.10.", "vendredi", "la semaine prochaine",
 * "fin du mois"). Null when the sentence names no date: the reminder then waits a week.
 */
export function promisedDate(evidence: string, receivedAt: number): string | null {
  const base = new Date(Math.floor(receivedAt * 1000 / 86_400_000) * 86_400_000);
  const text = evidence.toLowerCase();
  const day = (offset: number) => isoDay(new Date(base.getTime() + offset * 86_400_000));
  const numeric = /(?<!\d)(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d/]|\.\d)/u.exec(text);
  const named = new RegExp(`(?<!\\d)(\\d{1,2})(?:er|\\.)?\\s+(${Object.keys(PROMISE_MONTHS).join('|')})(?:\\s+(\\d{4}))?(?![\\p{L}])`, 'u').exec(text);
  const parts = numeric ? [Number(numeric[1]), Number(numeric[2]), numeric[3]] as const : named ? [Number(named[1]), PROMISE_MONTHS[named[2]], named[3]] as const : null;
  if (parts) {
    const [d, m, rawYear] = parts;
    let year = rawYear ? Number(rawYear.length === 2 ? `20${rawYear}` : rawYear) : base.getUTCFullYear();
    let date = new Date(Date.UTC(year, m - 1, d));
    if (!rawYear && date < base) date = new Date(Date.UTC(++year, m - 1, d));
    return date.getUTCDate() === d && date.getUTCMonth() === m - 1 ? isoDay(date) : null;
  }
  if (/(?<![\p{L}])(?:demain|morgen|domani|tomorrow)(?![\p{L}])/u.test(text)) return day(1);
  if (/(?:semaine prochaine|nächste[nr]? woche|settimana prossima|prossima settimana|next week)/u.test(text)) return day(7);
  if (/(?:fin (?:du |de ce )?mois|ende (?:des )?monat|monatsende|fine (?:del )?mese|end of (?:the )?month)/u.test(text)) {
    return isoDay(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)));
  }
  for (const [word, weekday] of Object.entries(PROMISE_WEEKDAYS)) {
    if (!new RegExp(`(?<![\\p{L}])${word}(?![\\p{L}])`, 'u').test(text)) continue;
    return day((weekday - base.getUTCDay() + 7) % 7 || 7);
  }
  return null;
}


/**
 * How a client usually pays, from their invoices already paid in full: the average
 * number of days after the due date (0 when on time). Null with fewer than two invoices.
 */
export function paymentHabit(clientId: string, invoices: readonly Readonly<{ id: string; clientId: string; dueDate: string; type: string; status: string }>[],
  payments: readonly Readonly<{ invoiceId: string; date: string }>[]): Readonly<{ samples: number; averageLateDays: number }> | null {
  const late: number[] = [];
  for (const invoice of invoices) {
    if (invoice.clientId !== clientId || invoice.status !== 'paid' || invoice.type === 'credit_note' || !invoice.dueDate) continue;
    const dates = payments.filter(payment => payment.invoiceId === invoice.id && payment.date).map(payment => payment.date).sort();
    const last = dates[dates.length - 1];
    if (!last) continue;
    late.push(Math.max(0, Math.round((Date.parse(last + 'T12:00:00Z') - Date.parse(invoice.dueDate + 'T12:00:00Z')) / 86_400_000)));
  }
  if (late.length < 2) return null;
  return { samples: late.length, averageLateDays: Math.round(late.reduce((sum, days) => sum + days, 0) / late.length) };
}
