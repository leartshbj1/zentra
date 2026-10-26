import type { EquipmentService, InstalledEquipment } from './installedEquipment';
import type { AgendaEvent, Client, Invoice, Payment, Project } from './types';

export type CustomerEngagementSettings = {
  reviewUrl: string | null;
  reviewCooldownDays: number;
  reviewAuto: boolean;
  bookingEnabled: boolean;
  /** Bit 0 = lundi … bit 6 = dimanche. */
  bookingDays: number;
  bookingStart: string;
  bookingEnd: string;
  bookingMinutes: number;
  bookingWeeks: number;
  depositPercentBp: number;
};

export type SmsSettings = { enabled: boolean; provider: 'aspsms' | 'swisscom' | 'generic'; sender: string; account: string; endpoint: string | null; appointmentRemindersAuto: boolean; secretPresent: boolean };
export type SmsMessage = { id: string; purpose: string; origin: 'validated' | 'rule'; recipient: string; body: string; status: 'sent' | 'failed'; error: string | null; relatedType: string | null; relatedId: string | null; createdAt: string };
export type ReviewRequest = { id: string; clientId: string; invoiceId: string | null; channel: 'email' | 'sms' | 'copy'; origin: 'validated' | 'rule'; createdAt: string };

type RawRow = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const flag = (value: unknown) => value === true || value === 1;

export const DEFAULT_ENGAGEMENT: CustomerEngagementSettings = { reviewUrl: null, reviewCooldownDays: 365, reviewAuto: false, bookingEnabled: false, bookingDays: 31,
  bookingStart: '08:00', bookingEnd: '17:00', bookingMinutes: 60, bookingWeeks: 3, depositPercentBp: 0 };

export function engagementFromRaw(row: RawRow | undefined): CustomerEngagementSettings {
  if (!row) return { ...DEFAULT_ENGAGEMENT };
  return { reviewUrl: text(row.review_url) || null, reviewCooldownDays: count(row.review_cooldown_days, 365), reviewAuto: flag(row.review_auto), bookingEnabled: flag(row.booking_enabled),
    bookingDays: count(row.booking_days, 31), bookingStart: text(row.booking_start) || '08:00', bookingEnd: text(row.booking_end) || '17:00', bookingMinutes: count(row.booking_minutes, 60),
    bookingWeeks: count(row.booking_weeks, 3), depositPercentBp: count(row.deposit_percent_bp, 0) };
}

export function smsMessageFromRaw(row: RawRow): SmsMessage {
  return { id: text(row.id), purpose: text(row.purpose), origin: row.origin === 'rule' ? 'rule' : 'validated', recipient: text(row.recipient), body: text(row.body),
    status: row.status === 'sent' ? 'sent' : 'failed', error: text(row.error) || null, relatedType: text(row.related_type) || null, relatedId: text(row.related_id) || null, createdAt: text(row.created_at) };
}

export function reviewRequestFromRaw(row: RawRow): ReviewRequest {
  return { id: text(row.id), clientId: text(row.client_id), invoiceId: text(row.invoice_id) || null, channel: row.channel === 'sms' ? 'sms' : row.channel === 'copy' ? 'copy' : 'email',
    origin: row.origin === 'rule' ? 'rule' : 'validated', createdAt: text(row.created_at) };
}

/** Même règle que le natif : « 079 123 45 67 » → « +41791234567 », sinon null. */
export function normalizedPhone(value: string): string | null {
  const compact = value.replace(/[\s.\-/() ]/g, '');
  const international = compact.startsWith('00') ? `+${compact.slice(2)}` : compact.startsWith('0') ? `+41${compact.slice(1)}` : compact;
  return /^\+[1-9]\d{7,14}$/.test(international) ? international : null;
}

const day = (value: string) => Date.parse(`${value.slice(0, 10)}T12:00:00Z`);
const daysAgo = (date: string, today: string) => Math.round((day(today) - day(date)) / 86_400_000);

export type ReviewCandidate = { client: Client; invoice: Invoice; paidOn: string };

/**
 * Clients à qui demander un avis : une facture payée ces 30 derniers jours,
 * un lien d'avis enregistré, et aucune demande pendant la période choisie.
 * Un client = une carte, avec sa dernière facture payée.
 */
export function reviewCandidates(invoices: readonly Invoice[], payments: readonly Payment[], clients: readonly Client[], requests: readonly ReviewRequest[], settings: CustomerEngagementSettings, today: string): ReviewCandidate[] {
  if (!settings.reviewUrl) return [];
  const asked = new Set(requests.filter(row => daysAgo(row.createdAt, today) < settings.reviewCooldownDays).map(row => row.clientId));
  const best = new Map<string, ReviewCandidate>();
  for (const invoice of invoices) {
    if (invoice.status !== 'paid' || invoice.type === 'credit_note' || asked.has(invoice.clientId)) continue;
    const paidOn = payments.filter(row => row.invoiceId === invoice.id).map(row => row.date).sort().at(-1);
    if (!paidOn || daysAgo(paidOn, today) > 30 || daysAgo(paidOn, today) < 0) continue;
    const client = clients.find(row => row.id === invoice.clientId && !row.archivedAt);
    if (!client || (!client.email && !normalizedPhone(client.phone ?? ''))) continue;
    const current = best.get(client.id);
    if (!current || current.paidOn < paidOn) best.set(client.id, { client, invoice, paidOn });
  }
  return [...best.values()].sort((left, right) => right.paidOn.localeCompare(left.paidOn));
}

/** Le client d'un rendez-vous : par son projet, sinon par l'équipement dont c'est l'entretien. */
export function eventClient(event: AgendaEvent, projects: readonly Project[], clients: readonly Client[], equipment: readonly InstalledEquipment[], services: readonly EquipmentService[]): Client | null {
  const project = event.projectId ? projects.find(row => row.id === event.projectId) : undefined;
  const service = services.find(row => row.agendaEventId === event.id);
  const clientId = project?.clientId ?? (service ? equipment.find(row => row.id === service.equipmentId)?.clientId : undefined);
  return clientId ? clients.find(row => row.id === clientId && !row.archivedAt) ?? null : null;
}

export type ReminderCandidate = { event: AgendaEvent; client: Client; phone: string };

/** Rendez-vous de demain avec un client joignable par SMS, pas encore rappelé. */
export function appointmentReminders(events: readonly AgendaEvent[], projects: readonly Project[], clients: readonly Client[], equipment: readonly InstalledEquipment[],
  services: readonly EquipmentService[], messages: readonly SmsMessage[], today: string): ReminderCandidate[] {
  const tomorrow = new Date(day(today) + 86_400_000).toISOString().slice(0, 10);
  const sent = new Set(messages.filter(row => row.purpose === 'appointment_reminder' && row.status === 'sent').map(row => row.relatedId));
  const rows: ReminderCandidate[] = [];
  for (const event of events) {
    if (event.status !== 'scheduled' || event.startDate !== tomorrow || event.allDay || !event.startTime || sent.has(event.id)) continue;
    const client = eventClient(event, projects, clients, equipment, services);
    const phone = client ? normalizedPhone(client.phone ?? '') : null;
    if (client && phone) rows.push({ event, client, phone });
  }
  return rows.sort((left, right) => (left.event.startTime ?? '').localeCompare(right.event.startTime ?? ''));
}

const REMINDER: Record<string, string> = {
  fr: 'Bonjour, nous vous rappelons notre rendez-vous de demain {date} à {time}. {company}{phone}',
  de: 'Guten Tag, wir erinnern Sie an unseren Termin morgen, {date}, um {time}. {company}{phone}',
  it: 'Buongiorno, le ricordiamo il nostro appuntamento di domani {date} alle {time}. {company}{phone}',
  en: 'Hello, a reminder of our appointment tomorrow, {date} at {time}. {company}{phone}',
};
const REVIEW: Record<string, string> = {
  fr: 'Bonjour, merci pour votre confiance. Votre avis nous aide beaucoup : {url} {company}',
  de: 'Guten Tag, danke für Ihr Vertrauen. Ihre Bewertung hilft uns sehr: {url} {company}',
  it: 'Buongiorno, grazie per la fiducia. La sua opinione ci aiuta molto: {url} {company}',
  en: 'Hello, thank you for your trust. Your review helps us a lot: {url} {company}',
};
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');

/** Texte du rappel ; le numéro de l'entreprise permet de prévenir en cas d'empêchement. */
export function reminderSms(language: string, date: string, time: string, company: string, phone: string) {
  return fill(REMINDER[language] ?? REMINDER.fr, { date, time, company, phone: phone ? ` ${phone}` : '' }).trim();
}

export function reviewSms(language: string, url: string, company: string) {
  return fill(REVIEW[language] ?? REVIEW.fr, { url, company }).trim();
}

const REVIEW_MAIL: Record<string, [string, string]> = {
  fr: ['Votre avis compte pour nous', 'Bonjour {name},\n\nMerci pour votre confiance. Si vous êtes satisfait de notre travail, un avis de quelques mots nous aiderait beaucoup :\n{url}\n\nAvec nos meilleures salutations,\n{company}'],
  de: ['Ihre Meinung zählt', 'Guten Tag {name}\n\nDanke für Ihr Vertrauen. Wenn Sie mit unserer Arbeit zufrieden sind, hilft uns eine kurze Bewertung sehr:\n{url}\n\nFreundliche Grüsse\n{company}'],
  it: ['La sua opinione conta', 'Buongiorno {name},\n\nGrazie per la fiducia. Se è soddisfatto del nostro lavoro, una breve recensione ci aiuterebbe molto:\n{url}\n\nCordiali saluti,\n{company}'],
  en: ['Your opinion matters to us', 'Hello {name},\n\nThank you for your trust. If you are happy with our work, a short review would help us a lot:\n{url}\n\nKind regards,\n{company}'],
};

export function reviewMailto(language: string, email: string, name: string, url: string, company: string) {
  const [subject, body] = REVIEW_MAIL[language] ?? REVIEW_MAIL.fr;
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(fill(body, { name, url, company }))}`;
}
