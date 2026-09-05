import { describe, expect, it } from 'vitest';
import { matchesSalesDocumentSearch, matchesSalesDocumentStatus } from './salesDocumentList';
import { salesTotalsByCurrency, formatSalesTotals } from './salesFinancials';
import { formatMoney, projectFinancials } from './utils';
import type { Invoice, Payment, Project } from './types';

const invoice = { id: 'invoice', number: 'F-2026-001', title: 'Étude du bureau', currency: 'EUR', type: 'standard', status: 'issued', dueDate: '2026-08-31', qrBill: { input: { reference: 'RF18539007547034' } }, lines: [{ id: 'line', quantity: 1, description: 'Étude', unit: 'heure', unitPriceCents: 10000, vatRateBp: 0 }] } as Invoice;
const paid = [{ invoiceId: 'invoice', amountCents: 2500 }] as Payment[];

describe('navigation des ventes', () => {
  it('retrouve une référence copiée avec espaces, espaces insécables et minuscules', () => {
    expect(matchesSalesDocumentSearch(invoice, 'Entreprise Exemple SA', 'rf18\u00a05390 0754 7034')).toBe(true);
    expect(matchesSalesDocumentSearch(invoice, 'Entreprise Exemple SA', 'Entreprise Exemple')).toBe(true);
    expect(matchesSalesDocumentSearch(invoice, '', 'etude   du bureau')).toBe(true);
    expect(matchesSalesDocumentSearch(invoice, '', 'RF18539000000000')).toBe(false);
  });
  it('calcule les impayés depuis le solde après paiements et avoirs, sans inclure les brouillons', () => {
    expect(matchesSalesDocumentStatus(invoice, 'overdue', [invoice], paid, '2026-09-05')).toBe(true);
    expect(matchesSalesDocumentStatus(invoice, 'overdue', [invoice], paid, '2026-08-31')).toBe(false);
    expect(matchesSalesDocumentStatus({ ...invoice, status: 'draft' }, 'open', [invoice], [], '2026-09-05')).toBe(false);
    const credit = { ...invoice, id: 'credit', type: 'credit_note', originalInvoiceId: invoice.id, lines: [{ ...invoice.lines[0], unitPriceCents: -7500 }] } as Invoice;
    expect(matchesSalesDocumentStatus(invoice, 'open', [invoice, credit], paid, '2026-09-05')).toBe(false);
    expect(matchesSalesDocumentStatus(credit, 'open', [invoice, credit], [], '2026-09-05')).toBe(false);
  });
  it('sépare les devises et calcule le solde par facture après les avoirs', () => {
    const chf = { ...invoice, id: 'chf', currency: 'CHF' };
    const totals = salesTotalsByCurrency([invoice, chf, { ...chf, id: 'draft', status: 'draft' }], paid);
    expect(totals).toEqual([{ currency: 'CHF', invoicedCents: 10000, paidCents: 0, openCents: 10000 }, { currency: 'EUR', invoicedCents: 10000, paidCents: 2500, openCents: 7500 }]);
    expect(formatSalesTotals(totals, 'openCents')).toContain(formatMoney(7500, 'EUR'));
    expect(formatMoney(10000, 'EUR')).not.toContain('CHF');
  });
  it('ne présente pas une marge CHF à partir de recettes EUR sans conversion', () => {
    const project = { id: 'project' } as Project;
    const result = projectFinancials(project, [{ ...invoice, projectId: project.id }], [], [], []);
    expect(result.margin).toBeNull();
    expect(result.invoicedNetLabel).toBe(formatMoney(10000, 'EUR'));
    expect(result.requiresCurrencyConversion).toBe(true);
  });
});
