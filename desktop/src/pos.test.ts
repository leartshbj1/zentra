import { describe, expect, it } from 'vitest';
import { cartTotals, cashSuggestions, centsFromText, closingInvoiceLines, closingPayments, keptSales, lineAmounts, receiptHtml } from './pos';
import { documentTotals } from './utils';
import type { PosTicket, PosTicketLine } from './openApi';

const ticket = (overrides: Partial<PosTicket>): PosTicket => ({
  id: 't1', number: 'T-2026-00001-ABCD', kind: 'sale', date: '2026-10-25', method: 'cash', currency: 'CHF', subtotalCents: 0, vatCents: 0, totalCents: 0,
  receivedCents: null, changeCents: null, reference: null, voidsTicketId: null, createdAt: '2026-10-25T10:00:00Z', ...overrides,
});
const line = (ticketId: string, quantityMilli: number, unitPriceCents: number, vatBp: number, discountBp = 0): PosTicketLine => {
  const amounts = lineAmounts({ quantityMilli, unitPriceCents, discountBp, vatBp });
  return { id: `${ticketId}-${unitPriceCents}`, ticketId, position: 0, catalogItemId: 'cafe', description: 'Café', quantityMilli, unit: 'pce', unitPriceCents, discountBp, vatBp,
    netCents: amounts.netCents, vatCents: amounts.vatCents, totalCents: amounts.totalCents, stockMoved: true };
};

describe('caisse', () => {
  it('calcule chaque ligne comme le natif et comme une ligne de facture', () => {
    expect(lineAmounts({ quantityMilli: 2000, unitPriceCents: 1850, discountBp: 0, vatBp: 260 })).toEqual({ netCents: 3700, vatCents: 96, totalCents: 3796 });
    expect(lineAmounts({ quantityMilli: 1500, unitPriceCents: 333, discountBp: 1000, vatBp: 810 })).toEqual({ netCents: 450, vatCents: 36, totalCents: 486 });
    const lines = [{ catalogItemId: null, description: 'A', quantityMilli: 1500, unitPriceCents: 333, discountBp: 1000, vatBp: 810, unit: 'pce' }];
    const invoice = documentTotals([{ id: 'x', description: 'A', quantity: 1.5, unit: 'pce', unitPriceCents: 333, discountBp: 1000, vatRateBp: 810 }]);
    expect(cartTotals(lines).totalCents).toBe(invoice.totalCents);
  });

  it('lit un montant saisi et propose des billets ronds', () => {
    expect(centsFromText("1'234.5")).toBe(123_450);
    expect(centsFromText('12,05')).toBe(1205);
    expect(centsFromText('abc')).toBeNull();
    expect(cashSuggestions(3796)).toEqual([3796, 4000, 5000, 10_000]);
  });

  it('prépare une facture de clôture qui retrouve le total des tickets gardés', () => {
    const tickets = [
      ticket({ id: 'a', number: 'T-1', totalCents: 3796 }),
      ticket({ id: 'b', number: 'T-2', method: 'terminal', totalCents: 486 }),
      ticket({ id: 'c', number: 'T-3', totalCents: 1000 }),
      ticket({ id: 'v', number: 'A-3', kind: 'void', voidsTicketId: 'c' }),
    ];
    const lines = [line('a', 2000, 1850, 260), line('b', 1500, 333, 810, 1000), line('c', 1000, 926, 810)];
    expect(keptSales(tickets).map((row) => row.id)).toEqual(['a', 'b']);
    let next = 0;
    const invoiceLines = closingInvoiceLines(tickets, lines, () => `id-${next++}`);
    expect(invoiceLines.map((row) => row.description)).toEqual(['T-1 · Café', 'T-2 · Café']);
    expect(invoiceLines.every((row) => row.catalogItemId === null)).toBe(true);
    expect(documentTotals(invoiceLines).totalCents).toBe(3796 + 486);
  });

  it('répartit les paiements de clôture par moyen, sans ligne vide', () => {
    expect(closingPayments({ cashCents: 3796, payrexxCents: 0, terminalCents: 486 })).toEqual([
      { method: 'cash', label: 'Espèces', amountCents: 3796 },
      { method: 'terminal', label: 'Carte (terminal)', amountCents: 486 },
    ]);
  });

  it('échappe le texte du ticket imprimé', () => {
    const html = receiptHtml({
      company: 'Café <b>', address: 'Rue 1', vatNumber: '', ticket: ticket({ totalCents: 3796, receivedCents: 5000, changeCents: 1204 }),
      lines: [{ ...line('t1', 2000, 1850, 260), description: '<script>' }], money: (cents) => (cents / 100).toFixed(2),
      labels: { total: 'Total', vat: 'TVA', received: 'Reçu', change: 'Rendu', method: 'Paiement', thanks: 'Merci', cash: 'Espèces', payrexx: 'TWINT', terminal: 'Terminal' },
    });
    expect(html).toContain('Café &lt;b&gt;');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('12.04');
    expect(html).toContain('size:80mm auto');
  });
});
