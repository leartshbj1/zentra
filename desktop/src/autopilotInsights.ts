import type { Client, Invoice, Payment, Quote, SupplierInvoice } from './types';
import { documentTotals, invoiceOpenBalance } from './utils';

/**
 * The owner's figures, computed by the app (never by a model): the monthly
 * summary in plain words and the answers to a few everyday questions. Read-only.
 */
export type InsightData = Readonly<{ invoices: Invoice[]; payments: Payment[]; quotes: readonly Quote[]; clients: readonly Client[]; supplierInvoices: readonly SupplierInvoice[] }>;

const issued = (invoice: Invoice) => invoice.type !== 'credit_note' && invoice.status !== 'draft' && invoice.status !== 'cancelled';
const net = (invoice: Invoice) => documentTotals(invoice.lines).netCents;
const clientName = (clients: readonly Client[], id: string) => { const client = clients.find(row => row.id === id); return client?.company || client?.name || '—'; };
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86_400_000);

/** Who owes how much, invoices due for more than `days` days, largest first. */
export function owedOver(data: InsightData, today: string, days: number) {
  const byClient = new Map<string, number>();
  for (const invoice of data.invoices) {
    if (!issued(invoice) || !invoice.dueDate || daysBetween(invoice.dueDate, today) <= days) continue;
    const open = invoiceOpenBalance(invoice, data.invoices, data.payments);
    if (open > 0) byClient.set(invoice.clientId, (byClient.get(invoice.clientId) ?? 0) + open);
  }
  return [...byClient].map(([clientId, cents]) => ({ client: clientName(data.clients, clientId), cents })).sort((a, b) => b.cents - a.cents);
}

/** One month's figures (`month` = YYYY-MM). */
export function monthFigures(data: InsightData, month: string, today: string) {
  const inMonth = (iso: string | undefined | null) => !!iso && iso.slice(0, 7) === month;
  const invoiced = data.invoices.filter(invoice => issued(invoice) && inMonth(invoice.issueDate));
  const credits = data.invoices.filter(invoice => invoice.type === 'credit_note' && invoice.status !== 'draft' && invoice.status !== 'cancelled' && inMonth(invoice.issueDate));
  const accepted = data.quotes.filter(quote => quote.status === 'accepted' && inMonth(quote.issueDate));
  const byClient = new Map<string, number>();
  for (const invoice of invoiced) byClient.set(invoice.clientId, (byClient.get(invoice.clientId) ?? 0) + net(invoice));
  const top = [...byClient].sort((a, b) => b[1] - a[1])[0];
  return {
    invoicedCents: invoiced.reduce((sum, invoice) => sum + net(invoice), 0) - credits.reduce((sum, invoice) => sum + net(invoice), 0),
    invoiceCount: invoiced.length,
    collectedCents: data.payments.filter(payment => inMonth(payment.date)).reduce((sum, payment) => sum + payment.amountCents, 0),
    purchasesCents: data.supplierInvoices.filter(row => row.documentStatus === 'validated' && inMonth(row.documentDate)).reduce((sum, row) => sum + row.netCents, 0),
    acceptedQuotes: accepted.length,
    acceptedCents: accepted.reduce((sum, quote) => sum + documentTotals(quote.lines).netCents, 0),
    overdue: owedOver(data, today, 0),
    topClient: top ? { client: clientName(data.clients, top[0]), cents: top[1] } : null,
  };
}

export type MonthFigures = ReturnType<typeof monthFigures>;

const SUMMARY = {
  fr: { title: 'Résumé de {month}', invoiced: 'Vous avez facturé {amount} hors TVA ({n} factures).', collected: 'Vous avez encaissé {amount}.', purchases: 'Les achats validés font {amount} hors TVA.', margin: 'Il reste {amount} une fois les achats déduits.', quotes: '{n} devis acceptés pour {amount}.', top: 'Votre premier client du mois : {client} ({amount}).', overdue: '{n} clients ont des factures échues, pour {amount} au total. Le plus gros montant : {client} ({top}).', overdueOne: 'Un client a des factures échues : {client}, {top}.', none: 'Aucune facture échue.' },
  de: { title: 'Zusammenfassung {month}', invoiced: 'Sie haben {amount} ohne MWST fakturiert ({n} Rechnungen).', collected: 'Sie haben {amount} eingenommen.', purchases: 'Die bestätigten Einkäufe betragen {amount} ohne MWST.', margin: 'Nach Abzug der Einkäufe bleiben {amount}.', quotes: '{n} Offerten angenommen für {amount}.', top: 'Ihr grösster Kunde des Monats: {client} ({amount}).', overdue: '{n} Kunden haben fällige Rechnungen, insgesamt {amount}. Grösster Betrag: {client} ({top}).', overdueOne: 'Ein Kunde hat fällige Rechnungen: {client}, {top}.', none: 'Keine fälligen Rechnungen.' },
  it: { title: 'Riepilogo di {month}', invoiced: 'Hai fatturato {amount} IVA esclusa ({n} fatture).', collected: 'Hai incassato {amount}.', purchases: 'Gli acquisti confermati ammontano a {amount} IVA esclusa.', margin: 'Dedotti gli acquisti restano {amount}.', quotes: '{n} preventivi accettati per {amount}.', top: 'Il tuo primo cliente del mese: {client} ({amount}).', overdue: '{n} clienti hanno fatture scadute, per {amount} in totale. Importo maggiore: {client} ({top}).', overdueOne: 'Un cliente ha fatture scadute: {client}, {top}.', none: 'Nessuna fattura scaduta.' },
  en: { title: '{month} summary', invoiced: 'You invoiced {amount} excluding VAT ({n} invoices).', collected: 'You collected {amount}.', purchases: 'Validated purchases come to {amount} excluding VAT.', margin: '{amount} remains once purchases are deducted.', quotes: '{n} quotes accepted for {amount}.', top: 'Your largest client this month: {client} ({amount}).', overdue: '{n} clients have overdue invoices, {amount} in total. Largest: {client} ({top}).', overdueOne: 'One client has overdue invoices: {client}, {top}.', none: 'No overdue invoices.' },
};

/** The summary in plain words, written only from the figures above; the person edits it as a note. */
export function monthSummaryText(figures: MonthFigures, monthLabel: string, language: string, money: (cents: number) => string) {
  const copy = SUMMARY[language as keyof typeof SUMMARY] ?? SUMMARY.fr;
  const fill = (text: string, values: Record<string, string | number>) => Object.entries(values).reduce((s, [k, v]) => s.split('{' + k + '}').join(String(v)), text);
  const overdueTotal = figures.overdue.reduce((sum, row) => sum + row.cents, 0);
  const lines = [
    fill(copy.invoiced, { amount: money(figures.invoicedCents), n: figures.invoiceCount }),
    fill(copy.collected, { amount: money(figures.collectedCents) }),
    fill(copy.purchases, { amount: money(figures.purchasesCents) }),
    fill(copy.margin, { amount: money(figures.invoicedCents - figures.purchasesCents) }),
    figures.acceptedQuotes ? fill(copy.quotes, { n: figures.acceptedQuotes, amount: money(figures.acceptedCents) }) : '',
    figures.topClient ? fill(copy.top, { client: figures.topClient.client, amount: money(figures.topClient.cents) }) : '',
    figures.overdue.length === 1 ? fill(copy.overdueOne, { client: figures.overdue[0].client, top: money(figures.overdue[0].cents) })
      : figures.overdue.length ? fill(copy.overdue, { n: figures.overdue.length, amount: money(overdueTotal), client: figures.overdue[0].client, top: money(figures.overdue[0].cents) }) : copy.none,
  ].filter(Boolean);
  return { title: fill(copy.title, { month: monthLabel }), body: lines.join('\n') };
}

/** The previous calendar month (YYYY-MM) of a date. */
export function previousMonth(today: string): string {
  const [year, month] = today.split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

export type InsightQuestion =
  | Readonly<{ kind: 'owed'; days: number }>
  | Readonly<{ kind: 'month'; month: 'current' | 'previous' }>
  | Readonly<{ kind: 'quotes_pending' }>;

/**
 * A typed question translated to one predefined, read-only query, or null.
 * The wording only picks the query; the app computes the answer.
 */
export function readQuestion(text: string): InsightQuestion | null {
  const value = text.toLowerCase().trim();
  const owes = /(?:qui (?:me |nous )?doi(?:t|vent)|impay|en retard|échu|wer schuldet|offene rechnung|überfällig|chi (?:mi |ci )?deve|non pagat|scadut|who owes|unpaid|overdue)/u.test(value);
  if (owes) {
    const days = /(\d{1,3})\s*(?:jours?|j\b|tage?n?|giorni|days?)/u.exec(value);
    return { kind: 'owed', days: days ? Math.min(365, Number(days[1])) : 0 };
  }
  const revenue = /(?:chiffre d['’]affaires|combien (?:j['’]ai|ai-je|avons-nous) (?:factur|gagn|encaiss)|umsatz|fatturato|quanto ho (?:fatturato|incassato)|revenue|turnover|how much did (?:i|we) (?:invoice|earn))/u.test(value)
    || /(?:résumé|bilan|zusammenfassung|riepilogo|summary)\s+(?:du |de |des |vom |del |of )?(?:mois|monat|mese|month)/u.test(value);
  if (revenue) return { kind: 'month', month: /(?:dernier|précédent|passé|letzte[nm]?|vormonat|scorso|precedente|last)/u.test(value) ? 'previous' : 'current' };
  if (/(?:devis (?:en attente|sans réponse|ouverts?)|offene offerten|offerten ohne antwort|preventivi (?:in attesa|aperti)|pending quotes|open quotes)/u.test(value)) return { kind: 'quotes_pending' };
  return null;
}
