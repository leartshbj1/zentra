import type { CustomerEngagementSettings } from './customerEngagement';
import type { AgendaEvent, Invoice, Quote } from './types';

/** Acompte d'un devis, payé sur la page Payrexx de l'entreprise. */
export type QuoteDepositLink = { id: string; quoteId: string; url: string; percentBp: number; amountCents: number; currency: 'CHF' | 'EUR'; status: 'open' | 'paid' | 'failed' | 'cancelled'; invoiceId: string | null; paymentId: string | null; createdAt: string };
/** Demande de rendez-vous reçue du portail client. */
export type PortalBookingRequest = { id: string; clientId: string | null; startAt: string; minutes: number; contactName: string; phone: string; message: string; status: 'pending' | 'accepted' | 'declined'; agendaEventId: string | null; receivedAt: string };
export type PortalSlot = { start: string; minutes: number };
export type PortalBookingItem = { bookingId: string; clientKey: string; start: string; minutes: number; contactName: string; phone: string; message: string; at: number };

type RawRow = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function depositLinkFromRaw(row: RawRow): QuoteDepositLink {
  const status = text(row.status);
  return { id: text(row.id), quoteId: text(row.quote_id), url: text(row.url), percentBp: count(row.percent_bp), amountCents: count(row.amount_cents), currency: row.currency === 'EUR' ? 'EUR' : 'CHF',
    status: status === 'paid' || status === 'failed' || status === 'cancelled' ? status : 'open', invoiceId: text(row.invoice_id) || null, paymentId: text(row.payment_id) || null, createdAt: text(row.created_at) };
}

export function bookingRequestFromRaw(row: RawRow): PortalBookingRequest {
  const status = text(row.status);
  return { id: text(row.id), clientId: text(row.client_id) || null, startAt: text(row.start_at), minutes: count(row.minutes), contactName: text(row.contact_name), phone: text(row.phone),
    message: text(row.message), status: status === 'accepted' || status === 'declined' ? status : 'pending', agendaEventId: text(row.agenda_event_id) || null, receivedAt: text(row.received_at) };
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Créneaux libres à publier : jours et heures choisis dans les réglages, sur
 * les semaines proposées, sans chevaucher un rendez-vous de l'agenda (ni une
 * journée entière déjà prise), à partir de demain. Seuls le début et la durée
 * quittent l'appareil, jamais le contenu de l'agenda.
 */
export function freeSlots(settings: CustomerEngagementSettings, events: readonly AgendaEvent[], pending: readonly PortalBookingRequest[], today: string, limit = 400): PortalSlot[] {
  if (!settings.bookingEnabled) return [];
  const slots: PortalSlot[] = [];
  const taken = new Set(pending.filter(row => row.status !== 'declined').map(row => row.startAt));
  const from = minutes(settings.bookingStart), to = minutes(settings.bookingEnd), length = settings.bookingMinutes;
  for (let offset = 1; offset <= settings.bookingWeeks * 7 && slots.length < limit; offset++) {
    const day = addDays(today, offset);
    const weekday = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
    if (!(settings.bookingDays & (1 << weekday))) continue;
    const busy = events.filter(event => event.status !== 'cancelled' && event.startDate <= day && event.endDate >= day);
    if (busy.some(event => event.allDay)) continue;
    for (let start = from; start + length <= to && slots.length < limit; start += length) {
      const end = start + length;
      if (busy.some(event => event.startTime && event.endTime && minutes(event.startTime) < end && minutes(event.endTime) > start)) continue;
      const startAt = `${day}T${clock(start)}`;
      if (!taken.has(startAt)) slots.push({ start: startAt, minutes: length });
    }
  }
  return slots;
}

/** Empreinte des créneaux : on ne republie que s'ils changent. */
export const slotsFingerprint = (slots: readonly PortalSlot[]) => slots.map(slot => `${slot.start}/${slot.minutes}`).join(',');

/** Acomptes payés en ligne, pas encore rapprochés : avec la facture d'acompte du devis si elle est émise. */
export function depositsToRecord(links: readonly QuoteDepositLink[], quotes: readonly Quote[], invoices: readonly Invoice[]) {
  return links.filter(link => link.status === 'paid' && !link.paymentId).flatMap(link => {
    const quote = quotes.find(row => row.id === link.quoteId);
    if (!quote) return [];
    const invoice = invoices.find(row => row.quoteId === quote.id && row.type === 'deposit' && ['issued', 'partially_paid'].includes(row.status));
    return [{ link, quote, invoice: invoice ?? null }];
  });
}

/** Montant de l'acompte, calculé par l'app comme le natif : pourcentage du total TTC, arrondi au centime. */
export const depositAmount = (totalCents: number, percentBp: number) => Math.floor((totalCents * percentBp + 5_000) / 10_000);
