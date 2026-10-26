import type { DocumentLine } from './types';
import type { PosLineInput, PosPaymentMethod, PosTicket, PosTicketLine } from './openApi';

/**
 * Caisse : affichage du panier et préparation de la clôture. Le montant
 * enregistré est toujours celui calculé par le natif ; ce calcul-ci suit la
 * même règle (celle des lignes de facture) pour afficher le bon total avant.
 */

/** Points de base arrondis au centime, demi-centime vers le haut (montants positifs). */
export function roundBasisPoints(value: number, basisPoints: number): number {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(value) * basisPoints + 5_000) / 10_000);
}

export function lineAmounts(line: Pick<PosLineInput, 'quantityMilli' | 'unitPriceCents' | 'discountBp' | 'vatBp'>) {
  const base = Math.round((line.quantityMilli / 1000) * line.unitPriceCents);
  const net = base - roundBasisPoints(base, line.discountBp);
  const vat = roundBasisPoints(net, line.vatBp);
  return { netCents: net, vatCents: vat, totalCents: net + vat };
}

export function cartTotals(lines: readonly PosLineInput[]) {
  return lines.reduce((totals, line) => {
    const amounts = lineAmounts(line);
    return { netCents: totals.netCents + amounts.netCents, vatCents: totals.vatCents + amounts.vatCents, totalCents: totals.totalCents + amounts.totalCents };
  }, { netCents: 0, vatCents: 0, totalCents: 0 });
}

/** « 12.50 », « 12,5 » ou « 12 » en centimes ; null si illisible. */
export function centsFromText(value: string): number | null {
  const match = /^\s*(\d{1,9})(?:[.,](\d{1,2}))?\s*$/.exec(value.replace(/['’\s]/g, ''));
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : null;
}

/** Billets suisses utiles pour proposer « montant reçu » en un clic. */
export function cashSuggestions(totalCents: number): number[] {
  const notes = [1_000, 2_000, 5_000, 10_000, 20_000];
  const rounded = Math.ceil(totalCents / 500) * 500;
  return [...new Set([totalCents, rounded, ...notes.filter((note) => note > totalCents)])].filter((value) => value >= totalCents).slice(0, 4);
}

/** Ventes du jour qui restent après les annulations. */
export function keptSales(tickets: readonly PosTicket[]): PosTicket[] {
  const voided = new Set(tickets.filter((ticket) => ticket.kind === 'void').map((ticket) => ticket.voidsTicketId));
  return tickets.filter((ticket) => ticket.kind === 'sale' && !voided.has(ticket.id));
}

/**
 * Lignes de la facture « Ventes au comptoir » : une ligne par ligne de ticket,
 * sans lien vers l'article (le stock est déjà sorti au ticket). La facture
 * retrouve donc exactement le total des tickets.
 */
export function closingInvoiceLines(tickets: readonly PosTicket[], lines: readonly PosTicketLine[], newId: () => string): DocumentLine[] {
  const kept = keptSales(tickets);
  const numbers = new Map(kept.map((ticket) => [ticket.id, ticket.number]));
  return lines
    .filter((line) => numbers.has(line.ticketId))
    .map((line) => ({
      id: newId(), catalogItemId: null, description: `${numbers.get(line.ticketId)} · ${line.description}`,
      quantity: line.quantityMilli / 1000, unit: line.unit, unitPriceCents: line.unitPriceCents, discountBp: line.discountBp, vatRateBp: line.vatBp,
    }));
}

export const CLOSING_METHOD_LABEL: Record<PosPaymentMethod, string> = {
  cash: 'Espèces',
  payrexx: 'TWINT / carte (Payrexx)',
  terminal: 'Carte (terminal)',
};

/** Paiements de la facture de clôture, par moyen de paiement. */
export function closingPayments(totals: Readonly<{ cashCents: number; payrexxCents: number; terminalCents: number }>) {
  return ([['cash', totals.cashCents], ['payrexx', totals.payrexxCents], ['terminal', totals.terminalCents]] as const)
    .filter(([, amount]) => amount > 0)
    .map(([method, amountCents]) => ({ method, label: CLOSING_METHOD_LABEL[method], amountCents }));
}

export const closingMarker = (date: string) => `pos-closing:${date}`;

const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/** Ticket imprimable en 80 mm (impression du navigateur, sans pilote). */
export function receiptHtml(input: Readonly<{
  company: string; address: string; vatNumber: string; ticket: PosTicket; lines: readonly PosTicketLine[];
  money: (cents: number) => string; labels: Readonly<Record<string, string>>;
}>): string {
  const { ticket, money, labels } = input;
  const vatRates = new Map<number, number>();
  for (const line of input.lines) vatRates.set(line.vatBp, (vatRates.get(line.vatBp) ?? 0) + line.vatCents);
  const rows = input.lines.map((line) => `<tr><td>${escape(line.description)}<br><small>${line.quantityMilli / 1000} × ${money(line.unitPriceCents)}</small></td><td class="r">${money(line.totalCents)}</td></tr>`).join('');
  const vat = [...vatRates].filter(([rate]) => rate > 0).map(([rate, cents]) => `<tr><td>${escape(labels.vat)} ${(rate / 100).toFixed(1)} %</td><td class="r">${money(cents)}</td></tr>`).join('');
  const cash = ticket.method === 'cash' && ticket.receivedCents !== null
    ? `<tr><td>${escape(labels.received)}</td><td class="r">${money(ticket.receivedCents)}</td></tr><tr><td>${escape(labels.change)}</td><td class="r">${money(ticket.changeCents ?? 0)}</td></tr>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(ticket.number)}</title><style>
@page{size:80mm auto;margin:4mm}body{font:12px/1.35 system-ui,sans-serif;color:#000;margin:0;width:72mm}
h1{font-size:14px;margin:0 0 2px}p{margin:0 0 6px}table{width:100%;border-collapse:collapse}td{padding:2px 0;vertical-align:top}
.r{text-align:right;white-space:nowrap}.t td{border-top:1px solid #000;font-weight:700;padding-top:4px}small{color:#333}
</style></head><body><h1>${escape(input.company)}</h1><p>${escape(input.address)}${input.vatNumber ? `<br>${escape(input.vatNumber)}` : ''}</p>
<p>${escape(ticket.number)} · ${escape(ticket.date)}</p><table>${rows}<tr class="t"><td>${escape(labels.total)}</td><td class="r">${money(ticket.totalCents)}</td></tr>${vat}${cash}
<tr><td>${escape(labels.method)}</td><td class="r">${escape(labels[ticket.method] ?? ticket.method)}</td></tr></table><p>${escape(labels.thanks)}</p></body></html>`;
}
