import { describe, expect, it } from 'vitest';
import { invoiceIssuePreflight, invoiceIssueProblem } from './invoiceIssueHelp';
import { initialOnboardingSettings } from './onboardingDraft';
import type { Invoice } from './types';

const invoice: Invoice = { id: 'invoice', number: '', clientId: 'client', projectId: null, quoteId: null, originalInvoiceId: null, title: 'Mandat', type: 'standard', issueDate: '2026-09-01', dueDate: '2026-10-01', serviceDateFrom: '2026-08-31', serviceDateTo: '', currency: 'CHF', status: 'draft', lines: [{ id: 'line', description: 'Prestation', catalogItemId: null, quantity: 1, unit: 'forfait', unitPriceCents: 10000, discountBp: 0, vatRateBp: 810 }], notes: '', terms: '', depositPercentageBp: null, depositBasisLines: null, createdAt: '2026-09-01T12:00:00Z' };
const workspace = { invoices: [invoice], settings: { ...initialOnboardingSettings, billing: { ...initialOnboardingSettings.billing, iban: 'CH9300762011623852957' } } };

describe('préparer une émission sans changer les données', () => {
  it('accepte le brouillon prêt et ne change ni lignes ni montants', () => {
    const before = JSON.stringify(workspace);
    expect(invoiceIssuePreflight(invoice, workspace)).toBeNull();
    expect(JSON.stringify(workspace)).toBe(before);
  });
  it.each(['issued', 'paid', 'cancelled'] as const)('empêche une émission depuis l’état %s', status => {
    expect(invoiceIssuePreflight({ ...invoice, status }, workspace)?.target).toBe('invoices');
  });
  it('dirige les dates impossibles ou manquantes vers la bonne étape', () => {
    for (const patch of [{ serviceDateFrom: '' }, { issueDate: '2026-02-30' }, { dueDate: '2026-08-30' }, { serviceDateTo: '2026-08-01' }]) expect(invoiceIssuePreflight({ ...invoice, ...patch }, workspace)?.target).toBe('dates');
    expect(invoiceIssuePreflight({ ...invoice, lines: [] }, workspace)?.target).toBe('document');
  });
  it('demande l’IBAN pour une facture, mais ne l’impose pas à un avoir', () => {
    const withoutBank = { ...workspace, settings: { ...workspace.settings, billing: { ...workspace.settings.billing, iban: '' } } };
    expect(invoiceIssuePreflight(invoice, withoutBank)?.target).toBe('billing');
    expect(invoiceIssuePreflight({ ...invoice, type: 'credit_note', dueDate: '' }, withoutBank)).toBeNull();
  });
  it('garde l’ordre acompte puis solde sans confondre émission et paiement', () => {
    const balance = { ...invoice, id: 'balance', billingPair: { depositInvoiceId: invoice.id, balanceInvoiceId: 'balance' } };
    expect(invoiceIssuePreflight(balance, workspace)?.target).toBe('folder');
    expect(invoiceIssuePreflight(balance, { ...workspace, invoices: [{ ...invoice, number: 'F-1', status: 'issued' }] })).toBeNull();
    expect(invoiceIssuePreflight(balance, { ...workspace, invoices: [{ ...invoice, number: 'F-1', status: 'cancelled' }] })?.target).toBe('folder');
  });
  it.each([
    ['service_date_from est obligatoire avant émission.', 'dates'],
    ['La période de facturation est fermée. Vérifiez la date d’émission.', 'periods'],
    ['IBAN invalide.', 'billing'],
    ['Émettez d’abord la facture d’acompte liée avant d’émettre le solde.', 'folder'],
    ['Émettez d’abord l’avoir correctif préparé avec cette facture de remplacement.', 'invoices'],
    ['Une liaison de compte comptable manque.', 'accounts'],
    ['Une interruption locale est survenue.', 'document'],
  ])('explique le refus natif et indique une correction : %s', (message, target) => {
    expect(invoiceIssueProblem(message).target).toBe(target);
  });
});
