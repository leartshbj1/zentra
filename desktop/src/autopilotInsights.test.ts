import { describe, expect, it } from 'vitest';
import { monthFigures, monthSummaryText, owedOver, previousMonth, readQuestion, type InsightData } from './autopilotInsights';
import type { Client, Invoice, Payment, Quote, SupplierInvoice } from './types';

const line = (cents: number) => [{ id: 'l', description: 'x', quantity: 1, unit: 'pce', unitPriceCents: cents, vatRateBp: 0 }];
const invoice = (id: string, clientId: string, cents: number, issueDate: string, dueDate: string, values: Partial<Invoice> = {}) =>
  ({ id, number: 'F-' + id, clientId, type: 'standard', status: 'issued', issueDate, dueDate, currency: 'CHF', lines: line(cents), ...values }) as unknown as Invoice;
const clients = [{ id: 'c1', name: 'Dupont', company: 'Dupont SA' }, { id: 'c2', name: 'Keller', company: '' }] as Client[];
const data = (values: Partial<InsightData> = {}): InsightData => ({ invoices: [], payments: [], quotes: [], clients, supplierInvoices: [], ...values });

describe('owner insights (computed by the app)', () => {
  it('lists who owes for more than N days, largest first, paid invoices excluded', () => {
    const invoices = [invoice('1', 'c1', 100000, '2026-08-01', '2026-08-31'), invoice('2', 'c2', 50000, '2026-09-01', '2026-10-01'),
      invoice('3', 'c2', 20000, '2026-10-10', '2026-10-24'), invoice('4', 'c1', 30000, '2026-08-01', '2026-08-31')];
    const payments = [{ id: 'p', invoiceId: '4', amountCents: 30000, date: '2026-09-02' }] as Payment[];
    expect(owedOver(data({ invoices, payments }), '2026-10-25', 30)).toEqual([{ client: 'Dupont SA', cents: 100000 }]);
    expect(owedOver(data({ invoices, payments }), '2026-10-25', 0)).toEqual([{ client: 'Dupont SA', cents: 100000 }, { client: 'Keller', cents: 70000 }]);
  });

  it('writes the monthly summary only from the computed figures', () => {
    const invoices = [invoice('1', 'c1', 100000, '2026-09-05', '2026-10-05'), invoice('2', 'c2', 40000, '2026-09-20', '2026-12-20'),
      invoice('3', 'c1', 10000, '2026-09-25', '2026-10-25', { type: 'credit_note' })];
    const payments = [{ id: 'p', invoiceId: '1', amountCents: 60000, date: '2026-09-30' }] as Payment[];
    const supplierInvoices = [{ id: 's', documentStatus: 'validated', documentDate: '2026-09-10', netCents: 30000 }] as SupplierInvoice[];
    const quotes = [{ id: 'q', status: 'accepted', issueDate: '2026-09-02', lines: line(80000) }] as unknown as Quote[];
    const figures = monthFigures(data({ invoices, payments, supplierInvoices, quotes }), '2026-09', '2026-10-25');
    expect(figures).toMatchObject({ invoicedCents: 130000, invoiceCount: 2, collectedCents: 60000, purchasesCents: 30000, acceptedQuotes: 1, acceptedCents: 80000,
      topClient: { client: 'Dupont SA', cents: 100000 } });
    const text = monthSummaryText(figures, 'septembre 2026', 'fr', cents => `CHF ${(cents / 100).toFixed(2)}`);
    expect(text.title).toBe('Résumé de septembre 2026');
    expect(text.body).toContain('Vous avez facturé CHF 1300.00 hors TVA (2 factures).');
    expect(text.body).toContain('Il reste CHF 1000.00 une fois les achats déduits.');
    expect(text.body).toContain('Un client a des factures échues : Dupont SA, CHF 400.00.');
  });

  it('turns a question into one predefined query, or nothing', () => {
    expect(readQuestion('Qui me doit plus de 30 jours ?')).toEqual({ kind: 'owed', days: 30 });
    expect(readQuestion('Wer schuldet mir etwas?')).toEqual({ kind: 'owed', days: 0 });
    expect(readQuestion('Quel est mon chiffre d’affaires du mois dernier ?')).toEqual({ kind: 'month', month: 'previous' });
    expect(readQuestion('What is my revenue this month?')).toEqual({ kind: 'month', month: 'current' });
    expect(readQuestion('Devis en attente')).toEqual({ kind: 'quotes_pending' });
    expect(readQuestion('Fais un devis pour Dupont SA : 3 Zentra Pro')).toBeNull();
    expect(previousMonth('2026-01-03')).toBe('2025-12');
  });
});
