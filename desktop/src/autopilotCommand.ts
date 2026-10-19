import type { CatalogItem, Client, DocumentLine, Invoice, Supplier } from './types';

/** What the server read in a sentence typed in "Demander à Autopilote". Nothing is created from it. */
export type CommandAction = 'create_quote' | 'create_invoice' | 'send_reminder' | 'record_payment' | 'create_client' | 'create_appointment' | 'create_task' | 'search' | 'unknown';
export type CommandReading = Readonly<{
  action: CommandAction; party: string | null;
  lines: readonly Readonly<{ evidence: string; quantityMilli: number | null; unit: string | null }>[];
  date: string | null; time: string | null; amountCents: number | null; currency: 'CHF' | 'EUR' | null;
  quoteReference: string | null; invoiceReference: string | null; text: string;
}>;
const ACTIONS: readonly CommandAction[] = ['create_quote', 'create_invoice', 'send_reminder', 'record_payment', 'create_client', 'create_appointment', 'create_task', 'search', 'unknown'];
const nullableText = (value: unknown, max: number) => value === null || typeof value === 'string' && value.trim().length > 0 && [...value].length <= max;

/** The reading as returned by the native side; null when it cannot be used. */
export function commandReadingFrom(raw: Record<string, unknown>): CommandReading | null {
  if (!ACTIONS.includes(raw.action as CommandAction) || !nullableText(raw.party, 200) || !Array.isArray(raw.lines) || raw.lines.length > 20
    || !(raw.date === null || typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date))
    || !(raw.time === null || typeof raw.time === 'string' && /^\d{2}:\d{2}$/.test(raw.time))
    || !(raw.amountCents === null || typeof raw.amountCents === 'number' && Number.isSafeInteger(raw.amountCents) && raw.amountCents >= 0)
    || !(raw.currency === null || raw.currency === 'CHF' || raw.currency === 'EUR')
    || !nullableText(raw.quoteReference, 64) || !nullableText(raw.invoiceReference, 64) || typeof raw.text !== 'string') return null;
  const lines: { evidence: string; quantityMilli: number | null; unit: string | null }[] = [];
  for (const line of raw.lines as unknown[]) {
    const row = line as Record<string, unknown>;
    if (!row || typeof row.evidence !== 'string' || !row.evidence.trim() || !(row.quantityMilli === null || typeof row.quantityMilli === 'number' && Number.isSafeInteger(row.quantityMilli) && row.quantityMilli >= 0)
      || !nullableText(row.unit, 32)) return null;
    lines.push({ evidence: row.evidence, quantityMilli: row.quantityMilli as number | null, unit: row.unit as string | null });
  }
  return Object.freeze({ action: raw.action as CommandAction, party: raw.party as string | null, lines, date: raw.date as string | null, time: raw.time as string | null,
    amountCents: raw.amountCents as number | null, currency: raw.currency as CommandReading['currency'], quoteReference: raw.quoteReference as string | null,
    invoiceReference: raw.invoiceReference as string | null, text: raw.text });
}

const lower = (value: string | null | undefined) => (value ?? '').trim().toLocaleLowerCase('fr-CH');
const reference = (value: string) => lower(value).replace(/\s+/g, '');

/** The client or supplier named in the sentence: same name, then company, then start of the name. Never guessed further. */
export function findParty(party: string | null, clients: readonly Client[], suppliers: readonly Supplier[]) {
  const wanted = lower(party);
  if (!wanted) return null;
  const activeClients = clients.filter(row => !row.archivedAt), activeSuppliers = suppliers.filter(row => !row.archivedAt);
  const one = <T,>(rows: T[]) => rows.length === 1 ? rows[0] : null;
  const client = one(activeClients.filter(row => lower(row.name) === wanted)) ?? one(activeClients.filter(row => lower(row.company) === wanted))
    ?? one(activeClients.filter(row => lower(row.name).startsWith(wanted) || lower(row.company).startsWith(wanted)));
  if (client) return { kind: 'client' as const, client };
  const supplier = one(activeSuppliers.filter(row => lower(row.name) === wanted)) ?? one(activeSuppliers.filter(row => lower(row.name).startsWith(wanted)));
  return supplier ? { kind: 'supplier' as const, supplier } : null;
}

const HOUR_UNITS = ['h', 'heure', 'heures', 'hour', 'hours', 'std', 'stunde', 'stunden', 'ora', 'ore'];
/** A catalogue line for each element of the sentence; an element without its article stays as typed text. */
export function commandLines(reading: CommandReading, catalogue: readonly CatalogItem[], newId: () => string): { lines: DocumentLine[]; missing: string[] } {
  const active = catalogue.filter(item => !item.archivedAt);
  const hourly = active.filter(item => HOUR_UNITS.includes(lower(item.unit)));
  const missing: string[] = [];
  const lines = reading.lines.map(line => {
    // The words of the line without the leading quantity ("3 Zentra Pro" → "zentra pro").
    const words = lower(line.evidence).replace(/^\d+([.,]\d+)?\s*(h|x|×)?\s*/, '').replace(/^(de|d’|d'|of|von|di)\s+/, '');
    const found = active.find(item => lower(item.name) === words)
      ?? (active.filter(item => lower(item.name).startsWith(words) || (words && words.startsWith(lower(item.name)))).length === 1
        ? active.find(item => lower(item.name).startsWith(words) || words.startsWith(lower(item.name))) : undefined)
      ?? (line.unit === 'hour' && hourly.length === 1 ? hourly[0] : undefined);
    if (!found) missing.push(line.evidence);
    const quantity = (line.quantityMilli ?? 1000) / 1000;
    return found
      ? { id: newId(), catalogItemId: found.id, description: found.name, quantity, unit: found.unit, unitPriceCents: found.salesPriceCents, discountBp: 0, vatRateBp: found.vatBp }
      : { id: newId(), catalogItemId: null, description: line.evidence, quantity, unit: line.unit === 'hour' ? 'h' : '', unitPriceCents: 0, discountBp: 0, vatRateBp: 0 };
  });
  return { lines, missing };
}

export function findInvoice(invoiceReference: string | null, invoices: readonly Invoice[]) {
  if (!invoiceReference) return null;
  const wanted = reference(invoiceReference);
  return invoices.find(invoice => invoice.number && reference(invoice.number) === wanted) ?? null;
}

/** Where a search goes, from the words of the sentence. */
export function searchView(text: string): 'invoices' | 'quotes' | 'clients' | 'expenses' | 'agenda' | 'catalog' | null {
  const value = lower(text);
  if (/factur|rechnung|fattur|invoice/.test(value)) return 'invoices';
  if (/devis|offert|preventiv|quote/.test(value)) return 'quotes';
  if (/fournisseur|lieferant|fornitor|supplier|achat|einkauf|acquist|purchase/.test(value)) return 'expenses';
  if (/rendez|rdv|termin|appuntament|appointment|agenda|kalender/.test(value)) return 'agenda';
  if (/article|artikel|articol|catalog|stock|lager|scorte/.test(value)) return 'catalog';
  if (/client|kund|client/.test(value)) return 'clients';
  return null;
}

/** The last 20 sentences, kept on this device only. */
const KEY = 'zentra.autopilot.commands.v1';
export function commandHistory(): string[] {
  try { const value = JSON.parse(window.localStorage.getItem(KEY) ?? '[]') as unknown; return Array.isArray(value) ? value.filter((row): row is string => typeof row === 'string').slice(0, 20) : []; }
  catch { return []; }
}
export function rememberCommand(text: string) {
  const next = [text, ...commandHistory().filter(row => row !== text)].slice(0, 20);
  try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* best effort */ }
}
/** What the server understands, shown in the app's language when a sentence was not understood. */
export const COMMAND_EXAMPLES: Readonly<Record<'fr' | 'de' | 'it' | 'en', readonly string[]>> = {
  fr: ['Facture Müller pour 3 h de conseil', 'Fais un devis pour Meier SA : 5 Zentra Gestion Pro', 'Relance la facture F-2026-0012', 'Dupont a payé la facture F-2026-0012, CHF 178.00',
    'Rdv avec Martin demain à 14h30', 'Rappelle-moi de rappeler Dupont lundi', 'Montre les factures impayées'],
  de: ['Rechnung Müller für 3 h Beratung', 'Erstelle eine Offerte für Meier AG: 5 Zentra Gestion Pro', 'Mahne die Rechnung F-2026-0012', 'Dupont hat die Rechnung F-2026-0012 bezahlt, CHF 178.00',
    'Termin mit Keller am Freitag um 9 Uhr', 'Erinnere mich, Dupont am Montag anzurufen', 'Zeige die unbezahlten Rechnungen'],
  it: ['Fattura Müller per 3 h di consulenza', 'Fai un preventivo per Meier SA: 5 Zentra Gestion Pro', 'Sollecita la fattura F-2026-0012', 'Dupont ha pagato la fattura F-2026-0012, CHF 178.00',
    'Appuntamento con Martin domani alle 14:30', 'Ricordami di richiamare Dupont lunedì', 'Mostra le fatture non pagate'],
  en: ['Invoice Müller for 3 h of consulting', 'Make a quote for Meier Ltd: 5 Zentra Gestion Pro', 'Send a reminder for invoice F-2026-0012', 'Dupont paid invoice F-2026-0012, CHF 178.00',
    'Meeting with Martin tomorrow at 2:30 pm', 'Remind me to call Dupont on Monday', 'Show unpaid invoices'],
};
