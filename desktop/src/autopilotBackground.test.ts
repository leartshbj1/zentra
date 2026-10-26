import { describe, expect, it } from 'vitest';
import { backgroundSchedule } from './autopilotBackground';
import type { Quote, Reminder, SupplierInvoice } from './types';

const reminder = (over: Partial<Reminder>): Reminder => ({ id: 'r1', invoiceId: 'i1', templateId: null, level: 1, scheduledDate: '2026-11-03', status: 'planned', subject: '', body: '', notes: '',
  invoiceNumber: 'F-2026-0012', clientName: 'Dupont SA', currency: 'CHF', invoiceTotalCents: 20000, balanceCents: 17800, paymentDeadlineDays: 30, liveBalanceCents: null, snapshotStale: false,
  clientEmail: '', clientPhone: '', clientAddressLine1: '', clientAddressLine2: '', clientPostalCode: '', clientCity: '', clientCountry: 'CH', lastDeliveryAction: '', ...over } as Reminder);
const quote = (over: Partial<Quote>): Quote => ({ id: 'q1', clientId: 'c1', number: 'D-2026-0040', status: 'issued', issueDate: '2026-10-20', validUntil: '2026-11-20', currency: 'CHF', ...over } as Quote);
const supplier = (over: Partial<SupplierInvoice>): SupplierInvoice => ({ id: 's1', supplierName: 'Swisscom', reference: 'R-2026-118', dueDate: '2026-11-15', currency: 'CHF', documentStatus: 'validated', balanceCents: 8990, ...over } as SupplierInvoice);
const base = { reminders: [] as Reminder[], quotes: [] as Quote[], clientNames: { c1: 'Martin' }, followUps: {}, supplierInvoices: [] as SupplierInvoice[], vat: null, today: '2026-10-26' };

describe('Autopilote schedule for computers that are off', () => {
  it('sends the next reminder of each open invoice, once per invoice', () => {
    const items = backgroundSchedule({ ...base, reminders: [reminder({}), reminder({ id: 'r2', scheduledDate: '2026-11-17', level: 2 }), reminder({ id: 'r3', invoiceId: 'i2', status: 'completed' })] });
    expect(items).toEqual([{ kind: 'invoice_overdue', id: 'inv:i1', dueOn: '2026-11-03', party: 'Dupont SA', reference: 'F-2026-0012', amountCents: 17800 }]);
  });

  it('follows up a quote 7 days after issue, or 3 days before it expires when that comes first', () => {
    expect(backgroundSchedule({ ...base, quotes: [quote({})] })[0]).toMatchObject({ kind: 'quote_follow_up', dueOn: '2026-10-27', party: 'Martin', amountCents: null });
    expect(backgroundSchedule({ ...base, quotes: [quote({ validUntil: '2026-10-28' })] })[0].dueOn).toBe('2026-10-25');
    // After one follow-up, the next one is 3 days before validity ends; a draft or an expired quote is left out.
    expect(backgroundSchedule({ ...base, quotes: [quote({})], followUps: { 'quote:q1': { sentCount: 1 } } })[0].dueOn).toBe('2026-11-17');
    expect(backgroundSchedule({ ...base, quotes: [quote({ status: 'draft' }), quote({ id: 'q2', validUntil: '2026-10-01' })] })).toEqual([]);
  });

  it('reminds validated supplier invoices 5 days early and the closed VAT period the day after it ends', () => {
    const items = backgroundSchedule({ ...base, supplierInvoices: [supplier({}), supplier({ id: 's2', documentStatus: 'draft' }), supplier({ id: 's3', balanceCents: 0 })],
      vat: { from: '2026-07-01', to: '2026-09-30' } });
    expect(items).toEqual([
      { kind: 'vat_due', id: 'vat:2026-07-01', dueOn: '2026-10-01', party: '', reference: 'T3 2026', amountCents: null },
      { kind: 'supplier_due', id: 'sinv:s1', dueOn: '2026-11-10', party: 'Swisscom', reference: 'R-2026-118', amountCents: 8990 },
    ]);
  });

  it('keeps the server limits: 200 items, safe ids, short texts without control characters', () => {
    const many = Array.from({ length: 250 }, (_, index) => reminder({ id: `r${index}`, invoiceId: `i ${index}`, clientName: 'Nom\ttrès long '.repeat(10) }));
    const items = backgroundSchedule({ ...base, reminders: many });
    expect(items).toHaveLength(200);
    expect(items.every(item => /^[A-Za-z0-9_.:-]{1,80}$/.test(item.id) && item.party.length <= 80 && !/[\u0000-\u001f]/.test(item.party))).toBe(true);
  });
});
