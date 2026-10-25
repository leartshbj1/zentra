import { describe, expect, it } from 'vitest';
import { appointmentReminders, DEFAULT_ENGAGEMENT, engagementFromRaw, normalizedPhone, reminderSms, reviewCandidates, reviewMailto, type ReviewRequest } from './customerEngagement';
import type { AgendaEvent, Client, Invoice, Payment, Project } from './types';

const client = (id: string, patch: Partial<Client> = {}) => ({ id, name: `Client ${id}`, company: '', email: `${id}@example.invalid`, phone: '079 555 01 12', archivedAt: null, ...patch }) as Client;
const invoice = (id: string, clientId: string, patch: Partial<Invoice> = {}) => ({ id, clientId, status: 'paid', type: 'standard', number: `F-${id}`, ...patch }) as Invoice;
const payment = (invoiceId: string, date: string) => ({ id: `p-${invoiceId}`, invoiceId, date, amountCents: 1000 }) as Payment;
const settings = { ...DEFAULT_ENGAGEMENT, reviewUrl: 'https://g.page/r/atelier/review' };

describe('customer engagement', () => {
  it('normalises Swiss phone numbers like the native side', () => {
    expect(normalizedPhone('079 555 01 12')).toBe('+41795550112');
    expect(normalizedPhone('0041 (0)79')).toBeNull();
    expect(normalizedPhone('+33 6 12 34 56 78')).toBe('+33612345678');
    expect(normalizedPhone('')).toBeNull();
  });

  it('asks a review once per client after a recent paid invoice', () => {
    const invoices = [invoice('1', 'a'), invoice('2', 'a'), invoice('3', 'b'), invoice('4', 'c', { status: 'issued' }), invoice('5', 'd', { type: 'credit_note' })];
    const payments = [payment('1', '2026-10-01'), payment('2', '2026-10-20'), payment('3', '2026-08-01'), payment('5', '2026-10-20')];
    const clients = [client('a'), client('b'), client('c'), client('d')];
    expect(reviewCandidates(invoices, payments, clients, [], settings, '2026-10-25').map(row => [row.client.id, row.invoice.id])).toEqual([['a', '2']]);
    expect(reviewCandidates(invoices, payments, clients, [], DEFAULT_ENGAGEMENT, '2026-10-25')).toEqual([]);
    const asked: ReviewRequest[] = [{ id: 'r', clientId: 'a', invoiceId: null, channel: 'email', origin: 'validated', createdAt: '2026-03-01T10:00:00Z' }];
    expect(reviewCandidates(invoices, payments, clients, asked, settings, '2026-10-25')).toEqual([]);
    expect(reviewCandidates(invoices, payments, clients, asked, { ...settings, reviewCooldownDays: 90 }, '2026-10-25')).toHaveLength(1);
    expect(reviewCandidates(invoices, payments, [client('a', { email: '', phone: '' })], [], settings, '2026-10-25')).toEqual([]);
  });

  it('reminds tomorrow’s timed appointments once, through the project or the equipment', () => {
    const event = (id: string, patch: Partial<AgendaEvent> = {}) => ({ id, title: id, startDate: '2026-10-26', endDate: '2026-10-26', allDay: false, startTime: '08:00', endTime: '09:00',
      kind: 'visit', status: 'scheduled', location: '', notes: '', projectId: 'p1', employeeId: null, createdAt: '', updatedAt: '', ...patch }) as AgendaEvent;
    const projects = [{ id: 'p1', clientId: 'a' }] as Project[];
    const events = [event('e1'), event('e2', { projectId: null }), event('e3', { allDay: true, startTime: null, endTime: null }), event('e4', { startDate: '2026-10-27', endDate: '2026-10-27' }), event('e5', { status: 'cancelled' })];
    const equipment = [{ id: 'q1', clientId: 'b' }] as never, services = [{ id: 's1', equipmentId: 'q1', status: 'planned', serviceDate: '2026-10-26', agendaEventId: 'e2', notes: '' }] as never;
    const rows = appointmentReminders(events, projects, [client('a'), client('b')], equipment, services, [], '2026-10-25');
    expect(rows.map(row => [row.event.id, row.client.id, row.phone])).toEqual([['e1', 'a', '+41795550112'], ['e2', 'b', '+41795550112']]);
    const sent = [{ id: 'm', purpose: 'appointment_reminder', origin: 'validated', recipient: '', body: '', status: 'sent', error: null, relatedType: 'agenda_event', relatedId: 'e1', createdAt: '' }] as never;
    expect(appointmentReminders(events, projects, [client('a'), client('b')], equipment, services, sent, '2026-10-25').map(row => row.event.id)).toEqual(['e2']);
  });

  it('writes short messages without amounts', () => {
    expect(reminderSms('fr', 'lundi 26 octobre', '08:00', 'Atelier du Léman', '021 555 00 00')).toBe('Bonjour, nous vous rappelons notre rendez-vous de demain lundi 26 octobre à 08:00. Atelier du Léman 021 555 00 00');
    expect(reviewMailto('fr', 'a@example.invalid', 'Mme Keller', 'https://g.page/r/x', 'Atelier')).toContain('subject=Votre%20avis%20compte%20pour%20nous');
    expect(engagementFromRaw({ review_url: 'https://g.page/r/x', booking_enabled: 1, deposit_percent_bp: 3000 })).toMatchObject({ reviewUrl: 'https://g.page/r/x', bookingEnabled: true, depositPercentBp: 3000, bookingMinutes: 60 });
  });
});
