import type { AutopilotSender } from './autopilotReview';
import type { Client, Invoice, Payment, Quote, Supplier, SupplierInvoice } from './types';
import { invoiceOpenBalance } from './utils';

/**
 * What a client or supplier mail means, read by the server (30 days, at most 50).
 * Amounts and numbers are copied from the mail. Nothing runs from a signal:
 * the app finds the local object and proposes one action that a person clicks.
 */
export type MailSignalKind = 'quote_accepted' | 'quote_declined' | 'supplier_document' | 'supplier_order' | 'payment_announced' | 'payment_promised' | 'contact_update' | 'follow_up';
export type MailSignal = Readonly<{
  kind: MailSignalKind; sourceId: string; receivedAt: number; subject: string; evidence: string;
  quoteReference: string | null; invoiceReference: string | null; amountCents: number | null; currency: 'CHF' | 'EUR' | null;
  documentType: 'supplier_invoice' | 'payment_reminder' | 'credit_note' | 'receipt' | null;
  sender: AutopilotSender | null; requiresHumanValidation: true;
}>;
const KINDS: readonly MailSignalKind[] = ['quote_accepted', 'quote_declined', 'supplier_document', 'supplier_order', 'payment_announced', 'payment_promised', 'contact_update', 'follow_up'];
const DOCUMENTS = ['supplier_invoice', 'payment_reminder', 'credit_note', 'receipt'];
const short = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && [...value].length <= max;

/** One signal as read from the native side; null when it cannot be used (the others stay). */
export function mailSignalFrom(raw: Record<string, unknown>, sender: AutopilotSender | null): MailSignal | null {
  const nullable = (value: unknown, max: number) => value === null || short(value, max);
  if (!KINDS.includes(raw.kind as MailSignalKind) || typeof raw.sourceId !== 'string' || !raw.sourceId
    || typeof raw.receivedAt !== 'number' || !Number.isSafeInteger(raw.receivedAt) || raw.receivedAt < 1
    || typeof raw.subject !== 'string' || [...raw.subject].length > 300 || !short(raw.evidence, 1000)
    || !nullable(raw.quoteReference, 64) || !nullable(raw.invoiceReference, 64)
    || raw.amountCents !== null && (typeof raw.amountCents !== 'number' || !Number.isSafeInteger(raw.amountCents) || raw.amountCents < 0)
    || raw.currency !== null && raw.currency !== 'CHF' && raw.currency !== 'EUR'
    || raw.documentType !== null && !DOCUMENTS.includes(raw.documentType as string)
    || raw.requiresHumanValidation !== true) return null;
  return Object.freeze({ kind: raw.kind as MailSignalKind, sourceId: raw.sourceId, receivedAt: raw.receivedAt, subject: raw.subject,
    evidence: raw.evidence as string, quoteReference: raw.quoteReference as string | null, invoiceReference: raw.invoiceReference as string | null,
    amountCents: raw.amountCents as number | null, currency: raw.currency as MailSignal['currency'],
    documentType: raw.documentType as MailSignal['documentType'], sender, requiresHumanValidation: true });
}

const reference = (value: string) => value.toLocaleLowerCase('fr-CH').replace(/\s+/g, '');
const lower = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();
/** Clients the mail comes from: same address first, else same company. */
function senderClients(sender: AutopilotSender | null, clients: readonly Client[]): Client[] {
  const active = clients.filter(client => !client.archivedAt);
  const email = lower(sender?.email);
  const byEmail = email ? active.filter(client => lower(client.email) === email) : [];
  if (byEmail.length) return byEmail;
  const company = lower(sender?.company);
  return company ? active.filter(client => lower(client.company) === company || lower(client.name) === company) : [];
}

/** What the app proposes for one signal, with the object it found. */
export type SignalProposal =
  | Readonly<{ action: 'record_payment'; invoice: Invoice; amountCents: number }>
  | Readonly<{ action: 'choose_invoice'; candidates: readonly Invoice[] }>
  | Readonly<{ action: 'decline_quote'; quote: Quote }>
  | Readonly<{ action: 'open_purchase'; supplier: Supplier | null; supplierInvoice: SupplierInvoice | null }>
  | Readonly<{ action: 'follow_up'; client: Client | null }>
  | Readonly<{ action: 'none' }>;

export function proposeForSignal(signal: MailSignal, data: Readonly<{ invoices: Invoice[]; payments: Payment[]; quotes: readonly Quote[];
  clients: readonly Client[]; suppliers: readonly Supplier[]; supplierInvoices: readonly SupplierInvoice[] }>): SignalProposal {
  if (signal.kind === 'payment_announced') {
    const open = data.invoices.filter(invoice => invoice.number && invoice.type !== 'credit_note'
      && invoice.status !== 'draft' && invoice.status !== 'cancelled' && invoice.status !== 'paid' && invoiceOpenBalance(invoice, data.invoices, data.payments) > 0);
    if (signal.invoiceReference) {
      const wanted = reference(signal.invoiceReference);
      const numbered = open.filter(invoice => reference(invoice.number) === wanted);
      if (numbered.length === 1) return { action: 'record_payment', invoice: numbered[0],
        amountCents: signal.amountCents ?? invoiceOpenBalance(numbered[0], data.invoices, data.payments) };
    }
    const owners = new Set(senderClients(signal.sender, data.clients).map(client => client.id));
    const theirs = open.filter(invoice => owners.has(invoice.clientId));
    const exact = signal.amountCents === null ? [] : theirs.filter(invoice => invoiceOpenBalance(invoice, data.invoices, data.payments) === signal.amountCents);
    if (exact.length === 1) return { action: 'record_payment', invoice: exact[0], amountCents: signal.amountCents! };
    return theirs.length ? { action: 'choose_invoice', candidates: theirs } : { action: 'none' };
  }
  if (signal.kind === 'quote_declined') {
    const live = data.quotes.filter(quote => quote.status === 'issued');
    if (signal.quoteReference) {
      const wanted = reference(signal.quoteReference);
      const numbered = live.filter(quote => quote.number && reference(quote.number) === wanted);
      if (numbered.length === 1) return { action: 'decline_quote', quote: numbered[0] };
    }
    const owners = new Set(senderClients(signal.sender, data.clients).map(client => client.id));
    const latest = live.filter(quote => owners.has(quote.clientId)).sort((a, b) => (b.issueDate + b.createdAt).localeCompare(a.issueDate + a.createdAt))[0];
    return latest ? { action: 'decline_quote', quote: latest } : { action: 'none' };
  }
  if (signal.kind === 'supplier_document') {
    const email = lower(signal.sender?.email), company = lower(signal.sender?.company);
    const active = data.suppliers.filter(supplier => !supplier.archivedAt);
    const supplier = (email ? active.find(row => lower(row.email) === email) : undefined)
      ?? (company ? active.find(row => lower(row.name) === company) : undefined) ?? null;
    const wanted = signal.invoiceReference ? reference(signal.invoiceReference) : '';
    const supplierInvoice = signal.documentType === 'payment_reminder' && wanted
      ? data.supplierInvoices.find(row => reference(row.reference) === wanted && (!supplier || row.supplierId === supplier.id)) ?? null : null;
    return { action: 'open_purchase', supplier, supplierInvoice };
  }
  if (signal.kind === 'follow_up') return { action: 'follow_up', client: senderClients(signal.sender, data.clients)[0] ?? null };
  return { action: 'none' };
}

/** Signals handled or ignored on this device, so they do not come back. */
type Store = Record<string, Record<string, 'done' | 'ignored'>>;
const KEY = 'zentra.autopilot.signals.v1';
const MAX = 300;
function read(): Store {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Store : {};
  } catch { return {}; }
}
export function signalDecisions(organizationId: string): Readonly<Record<string, 'done' | 'ignored'>> {
  return Object.fromEntries(Object.entries(read()[organizationId] ?? {}).filter(([, state]) => state === 'done' || state === 'ignored'));
}
export function saveSignalDecision(organizationId: string, sourceId: string, state: 'done' | 'ignored') {
  const store = read(), company = { ...(store[organizationId] ?? {}), [sourceId]: state };
  const ids = Object.keys(company);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX))) delete company[old];
  store[organizationId] = company;
  try { window.localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* best effort */ }
}
