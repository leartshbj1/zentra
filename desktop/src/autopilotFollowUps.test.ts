// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { addDays, daysOverdue, followUpEntries, paymentHabit, promisedDate, quoteKey, quotesToFollowUp, reminderContext, reminderKey, remindersToShow, saveFollowUp } from './autopilotFollowUps';
import type { MailSignal } from './autopilotSignals';
import type { Quote, Reminder } from './types';

const reminder = (values: Partial<Reminder> = {}) => ({ id: 'r1', invoiceId: 'i1', level: 1, status: 'due', invoiceNumber: 'F-2026-0012', dueDate: '2026-10-01',
  clientName: 'Atelier Rive', clientEmail: 'marie@rive.ch', currency: 'CHF', balanceCents: 17800, liveBalanceCents: 17800, ...values }) as Reminder;
const signal = (values: Partial<MailSignal>): MailSignal => ({ kind: 'payment_announced', sourceId: 's1', receivedAt: 1, subject: '', evidence: 'Payé.',
  quoteReference: null, invoiceReference: null, amountCents: null, currency: null, documentType: null,
  sender: { email: 'marie@rive.ch', name: null, company: null, phone: null, street: null, postcode: null, city: null, source: 'envelope' }, requiresHumanValidation: true, ...values });
const quote = (values: Partial<Quote> = {}) => ({ id: 'q1', number: 'D-2026-0007', clientId: 'c1', status: 'issued', issueDate: '2026-10-01', validUntil: '2026-10-31', createdAt: 'a', ...values }) as Quote;

describe('reminders and quote follow-ups', () => {
  beforeEach(() => window.localStorage.clear());
  it('reads what the client wrote about the reminded invoice', () => {
    expect(reminderContext(reminder(), [signal({ invoiceReference: 'F-2026-0012' })]).context).toBe('paid');
    expect(reminderContext(reminder(), [signal({ kind: 'payment_promised', amountCents: 17800 })]).context).toBe('promised');
    expect(reminderContext(reminder(), [signal({ kind: 'payment_promised', amountCents: 5 })]).context).toBeNull();
    expect(reminderContext(reminder(), [signal({ kind: 'follow_up' })]).context).toBe('complaint');
    expect(reminderContext(reminder(), [signal({ invoiceReference: 'F-9' })]).context).toBeNull();
  });
  it('hides postponed, ignored and sent reminders', () => {
    saveFollowUp('org', reminderKey('r1'), entry => ({ ...entry, until: '2026-10-25' }));
    expect(remindersToShow([reminder()], followUpEntries('org'), '2026-10-20')).toHaveLength(0);
    expect(remindersToShow([reminder()], followUpEntries('org'), '2026-10-25')).toHaveLength(1);
    expect(daysOverdue(reminder(), '2026-10-20')).toBe(19);
    expect(addDays('2026-10-28', 7)).toBe('2026-11-04');
  });
  it('follows up a quote after 7 days and before it ends, twice at most, then offers to close it', () => {
    const emails = { c1: 'marie@rive.ch' };
    expect(quotesToFollowUp([quote()], [], emails, {}, '2026-10-05')).toEqual([]);
    expect(quotesToFollowUp([quote()], [], emails, {}, '2026-10-08')).toMatchObject([{ step: 'follow_up' }]);
    saveFollowUp('org', quoteKey('q1'), () => ({ sentCount: 1, lastSentAt: '2026-10-08' }));
    expect(quotesToFollowUp([quote()], [], emails, followUpEntries('org'), '2026-10-20')).toEqual([]);
    expect(quotesToFollowUp([quote()], [], emails, followUpEntries('org'), '2026-10-28')).toMatchObject([{ step: 'follow_up' }]);
    expect(quotesToFollowUp([quote()], [], emails, followUpEntries('org'), '2026-11-01')).toMatchObject([{ step: 'close' }]);
    expect(quotesToFollowUp([quote()], [signal({ kind: 'quote_declined' })], emails, {}, '2026-10-08')).toEqual([]);
  });
  it('lets a reply without a number answer only the client\'s latest quote', () => {
    const emails = { c1: 'marie@rive.ch' };
    const older = { ...quote(), id: 'q0', number: 'D-2026-0001', issueDate: '2026-09-20', validUntil: '2026-10-30' };
    const rows = quotesToFollowUp([older, quote()], [signal({ kind: 'quote_accepted' })], emails, {}, '2026-10-08');
    expect(rows.map(row => row.quote.id)).toEqual(['q0']);
  });
});

describe('promisedDate', () => {
  // Tuesday 20 October 2026, 10:00 UTC.
  const at = Date.UTC(2026, 9, 20, 10) / 1000;
  it.each([
    ['Nous réglerons le solde le 30 octobre.', '2026-10-30'],
    ['Je paierai le 3 janvier.', '2027-01-03'],
    ['Zahlung folgt am 15.11.2026', '2026-11-15'],
    ['Je vais payer vendredi.', '2026-10-23'],
    ['We will pay next week.', '2026-10-27'],
    ['Pagheremo a fine mese.', '2026-10-31'],
    ['Wir werden morgen überweisen.', '2026-10-21'],
    ['Je vais payer bientôt.', null],
    ['Facture F-2026-0012 de CHF 450.00', null],
  ])('%s', (text, expected) => {
    expect(promisedDate(text, at)).toBe(expected);
  });
});


describe('paymentHabit', () => {
  const invoice = (id: string, dueDate: string, status = 'paid') => ({ id, clientId: 'c1', dueDate, type: 'standard', status });
  it('averages the days after the due date of fully paid invoices, from two invoices on', () => {
    const invoices = [invoice('a', '2026-08-31'), invoice('b', '2026-09-30'), invoice('c', '2026-10-31', 'issued')];
    const payments = [{ invoiceId: 'a', date: '2026-09-10' }, { invoiceId: 'b', date: '2026-10-20' }, { invoiceId: 'b', date: '2026-10-05' }];
    expect(paymentHabit('c1', invoices, payments)).toEqual({ samples: 2, averageLateDays: 15 });
    expect(paymentHabit('c1', invoices.slice(0, 1), payments)).toBeNull();
    expect(paymentHabit('c1', [invoice('a', '2026-08-31'), invoice('b', '2026-09-30')], [{ invoiceId: 'a', date: '2026-08-20' }, { invoiceId: 'b', date: '2026-09-30' }]))
      .toEqual({ samples: 2, averageLateDays: 0 });
  });
});
