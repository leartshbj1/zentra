import type { Invoice, Payment, Quote } from './types';
import { documentTotals, invoiceCredited, invoiceOpenBalance, invoicePaid } from './utils';
import { invoiceDatesError } from './salesFormValidation';

export function quoteFolderProgress(quote: Quote, invoices: Invoice[], payments: Payment[]) {
  const linked = invoices.filter(invoice => invoice.quoteId === quote.id);
  const issued = linked.filter(invoice => invoice.type !== 'credit_note' && !['draft', 'cancelled'].includes(invoice.status));
  const drafts = linked.filter(invoice => invoice.type !== 'credit_note' && invoice.status === 'draft');
  return {
    invoices: [...linked].sort((a, b) => (a.type === 'deposit' ? 0 : 1) - (b.type === 'deposit' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)),
    quoteCents: documentTotals(quote.lines).totalCents,
    receivedCents: issued.reduce((sum, invoice) => sum + invoicePaid(invoice.id, payments), 0),
    openCents: issued.reduce((sum, invoice) => sum + invoiceOpenBalance(invoice, invoices, payments), 0),
    creditedCents: issued.reduce((sum, invoice) => sum + invoiceCredited(invoice.id, invoices), 0),
    draftCents: drafts.reduce((sum, invoice) => sum + documentTotals(invoice.lines).totalCents, 0),
    draftCount: drafts.length,
    sameCurrency: linked.every(invoice => invoice.currency === quote.currency),
  };
}

export function quoteFolderInvoiceStep(invoice: Invoice, invoices: Invoice[], payments: Payment[]): { kind: 'prepare' | 'deposit-first' | 'issue' | 'pay' | 'settled' | 'cancelled' | 'credit'; message: string } {
  if (invoice.status === 'cancelled') return { kind: 'cancelled', message: 'Facture annulée, conservée dans l’historique.' };
  if (invoice.type === 'credit_note') return { kind: 'credit', message: 'Consultez cet avoir pour suivre son utilisation ou son remboursement.' };
  if (invoice.status === 'draft') {
    if (invoiceDatesError(invoice)) return { kind: 'prepare', message: 'Ouvrez ce brouillon pour compléter ses dates avant l’émission.' };
    if (invoice.billingPair?.balanceInvoiceId === invoice.id) {
      const deposit = invoices.find(item => item.id === invoice.billingPair?.depositInvoiceId);
      if (!deposit?.number || ['draft', 'cancelled'].includes(deposit.status)) return { kind: 'deposit-first', message: 'Émettez d’abord la facture d’acompte. Le solde pourra ensuite recevoir son propre numéro.' };
    }
    return { kind: 'issue', message: 'Les dates sont renseignées. Vérifiez le document, puis émettez-le pour lui attribuer son numéro.' };
  }
  return invoiceOpenBalance(invoice, invoices, payments) > 0
    ? { kind: 'pay', message: 'Enregistrez un paiement uniquement lorsque vous avez reçu l’argent.' }
    : { kind: 'settled', message: 'Aucun montant ne reste à encaisser sur cette facture.' };
}
