import { describe, expect, it } from 'vitest';
import type { Invoice, Payment, Quote } from './types';
import { quoteFolderInvoiceStep, quoteFolderProgress } from './quoteFolderProgress';

const line = (amount: number) => ({ id: 'line', description: 'Mandat', catalogItemId: null, quantity: 1, unit: 'forfait', unitPriceCents: amount, discountBp: 0, vatRateBp: 0 });
const quote = { id: 'quote', currency: 'CHF', lines: [line(100000)] } as Quote;
function invoice(id: string, amount: number, patch: Partial<Invoice> = {}): Invoice {
  return { id, quoteId: quote.id, type: 'standard', status: 'issued', currency: 'CHF', number: id, createdAt: '2026-09-01', issueDate: '2026-09-01', dueDate: '2026-10-01', serviceDateFrom: '2026-09-01', serviceDateTo: '', lines: [line(amount)], ...patch } as Invoice;
}
const payment = (invoiceId: string, amountCents: number) => ({ invoiceId, amountCents }) as Payment;
describe('progression du dossier devis et factures', () => {
  it('sépare les brouillons des factures émises et applique les paiements seulement une fois', () => {
    const deposit = invoice('deposit', 30000, { type: 'deposit' });
    const balance = invoice('balance', 70000, { status: 'draft', number: '' });
    const data = quoteFolderProgress(quote, [balance, deposit], [payment('deposit', 10000)]);
    expect(data.invoices.map(item => item.id)).toEqual(['deposit', 'balance']);
    expect(data.quoteCents).toBe(100000);
    expect(data.receivedCents).toBe(10000);
    expect(data.openCents).toBe(20000);
    expect(data.draftCents).toBe(70000);
    expect(data.draftCount).toBe(1);
    expect(quoteFolderProgress(quote, [{ ...balance, status: 'issued' }, deposit], [payment('deposit', 30000)]).openCents).toBe(70000);
  });
  it('utilise les avoirs réellement affectés, y compris ceux provenant d’un autre dossier', () => {
    const target = invoice('target', 100000, { creditedCents: 25000 });
    const unusedCredit = invoice('credit', -20000, { type: 'credit_note' });
    const outside = invoice('outside', 99900, { quoteId: 'other' });
    const cancelled = invoice('cancelled', 99900, { status: 'cancelled' });
    const progress = quoteFolderProgress(quote, [target, unusedCredit, outside, cancelled], [payment('target', 10000), payment('outside', 99900)]);
    expect(progress.openCents).toBe(65000);
    expect(progress.creditedCents).toBe(25000);
    expect(progress.receivedCents).toBe(10000);
    expect(progress.draftCount).toBe(0);
  });
  it('préserve le calcul historique d’un avoir et ne cumule pas silencieusement des devises', () => {
    const target = invoice('target', 100000);
    const credit = invoice('credit', -20000, { type: 'credit_note', originalInvoiceId: target.id });
    expect(quoteFolderProgress(quote, [target, credit], []).openCents).toBe(80000);
    expect(quoteFolderProgress(quote, [target, invoice('eur', 100, { currency: 'EUR' })], []).sameCurrency).toBe(false);
  });
  it('guide les dates, l’émission de l’acompte, puis le paiement sans confondre les deux', () => {
    const pair = { depositInvoiceId: 'deposit', balanceInvoiceId: 'balance' };
    const deposit = invoice('deposit', 30000, { type: 'deposit', status: 'draft', number: '', billingPair: pair });
    const balance = invoice('balance', 70000, { type: 'final', status: 'draft', number: '', billingPair: pair });
    expect(quoteFolderInvoiceStep({ ...deposit, serviceDateFrom: '' }, [deposit, balance], []).kind).toBe('prepare');
    expect(quoteFolderInvoiceStep(deposit, [deposit, balance], []).kind).toBe('issue');
    expect(quoteFolderInvoiceStep(balance, [deposit, balance], []).kind).toBe('deposit-first');
    const issued = { ...deposit, status: 'issued' as const, number: 'F-1' };
    expect(quoteFolderInvoiceStep(balance, [issued, balance], []).kind).toBe('issue');
    expect(quoteFolderInvoiceStep(issued, [issued, balance], []).kind).toBe('pay');
    expect(quoteFolderInvoiceStep(issued, [issued, balance], [payment('deposit', 30000)]).kind).toBe('settled');
    expect(quoteFolderInvoiceStep(invoice('zero', 0), [], []).kind).toBe('settled');
    expect(quoteFolderInvoiceStep(invoice('cancelled', 900, { status: 'cancelled' }), [], []).kind).toBe('cancelled');
  });
});
