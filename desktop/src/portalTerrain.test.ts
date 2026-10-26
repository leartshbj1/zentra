import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGAGEMENT } from './customerEngagement';
import { depositAmount, depositsToRecord, freeSlots, type PortalBookingRequest, type QuoteDepositLink } from './portalTerrain';
import type { AgendaEvent, Invoice, Quote } from './types';

const settings = { ...DEFAULT_ENGAGEMENT, bookingEnabled: true, bookingDays: 0b11111, bookingStart: '08:00', bookingEnd: '12:00', bookingMinutes: 60, bookingWeeks: 1 };
const event = (patch: Partial<AgendaEvent>): AgendaEvent => ({ id: 'e', title: 'Privé', startDate: '2026-10-27', endDate: '2026-10-27', allDay: false, startTime: '09:00', endTime: '10:30',
  kind: 'visit', status: 'scheduled', location: '', notes: '', projectId: null, employeeId: null, createdAt: '', updatedAt: '', ...patch });

describe('portal slots and deposits', () => {
  it('offers working-day slots from tomorrow, around the agenda', () => {
    // Dimanche 25 octobre : lundi 26 au vendredi 30, 4 créneaux par matinée.
    const slots = freeSlots(settings, [], [], '2026-10-25');
    expect(slots).toHaveLength(20);
    expect(slots[0]).toEqual({ start: '2026-10-26T08:00', minutes: 60 });
    const busy = freeSlots(settings, [event({}), event({ id: 'f', startDate: '2026-10-28', endDate: '2026-10-28', allDay: true, startTime: null, endTime: null })], [], '2026-10-25');
    expect(busy.filter(slot => slot.start.startsWith('2026-10-27')).map(slot => slot.start.slice(11))).toEqual(['08:00', '11:00']);
    expect(busy.some(slot => slot.start.startsWith('2026-10-28'))).toBe(false);
    const requested: PortalBookingRequest[] = [{ id: 'b', clientId: null, startAt: '2026-10-26T08:00', minutes: 60, contactName: 'X', phone: '', message: '', status: 'pending', agendaEventId: null, receivedAt: '' }];
    expect(freeSlots(settings, [], requested, '2026-10-25')[0].start).toBe('2026-10-26T09:00');
    expect(freeSlots({ ...settings, bookingEnabled: false }, [], [], '2026-10-25')).toEqual([]);
  });

  it('computes the deposit and finds the deposit invoice to reconcile', () => {
    expect(depositAmount(1_200_000, 3_000)).toBe(360_000);
    expect(depositAmount(123_457, 3_000)).toBe(37_037);
    const link: QuoteDepositLink = { id: 'l', quoteId: 'q', url: 'https://a.payrexx.com/?p=1', percentBp: 3000, amountCents: 360_000, currency: 'CHF', status: 'paid', invoiceId: null, paymentId: null, createdAt: '' };
    const quotes = [{ id: 'q', number: 'D-1' }] as Quote[];
    expect(depositsToRecord([link], quotes, [])[0].invoice).toBeNull();
    const invoices = [{ id: 'i', quoteId: 'q', type: 'deposit', status: 'issued' }] as Invoice[];
    expect(depositsToRecord([link], quotes, invoices)[0].invoice?.id).toBe('i');
    expect(depositsToRecord([{ ...link, paymentId: 'p' }], quotes, invoices)).toEqual([]);
  });
});
