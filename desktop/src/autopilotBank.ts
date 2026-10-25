import { linksWithBankFee } from './bank';
import type { MailSignal } from './autopilotSignals';
import type { BankMovement, BankWorkspace, Client, Invoice } from './types';

/**
 * Bank movements Autopilote proposes to confirm, the surest first. Each one uses
 * the native suggestion as is: nothing is confirmed without a click.
 */
export type BankProposal = Readonly<{
  movement: BankMovement;
  action: 'confirm_invoice' | 'confirm_supplier' | 'confirm_expense' | 'link_with_fee' | 'create_expense' | 'choose';
  invoiceId?: string; invoiceNumber?: string; supplierInvoiceId?: string; expenseId?: string; label?: string;
  /** link_with_fee: the payment already recorded, its amount and the bank fee to book. */
  paymentId?: string; recordedCents?: number; feeCents?: number;
  /** A client mail that had announced or promised this payment. */
  announcedBy: MailSignal | null;
}>;
const reference = (value: string) => value.toLocaleLowerCase('fr-CH').replace(/\s+/g, '');
const lower = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();
const open = (movement: BankMovement) => !movement.reversal && !movement.reconciliation && !movement.supplierReconciliation
  && !movement.expenseReconciliation && !movement.refundMatch;
const rank = { confirm_invoice: 0, confirm_supplier: 1, confirm_expense: 2, link_with_fee: 3, choose: 4, create_expense: 5 } as const;

export function bankProposals(bank: BankWorkspace | null, signals: readonly MailSignal[], invoices: readonly Invoice[], clients: readonly Client[]): BankProposal[] {
  if (!bank) return [];
  const announced = (movement: BankMovement, invoiceNumber?: string) => {
    if (movement.creditDebit !== 'CRDT') return null;
    const amount = Math.abs(movement.amountCents);
    return signals.find(signal => (signal.kind === 'payment_announced' || signal.kind === 'payment_promised') && (
      invoiceNumber && signal.invoiceReference ? reference(signal.invoiceReference) === reference(invoiceNumber)
        : signal.amountCents === amount && (!invoiceNumber || clientOf(invoiceNumber) === lower(signal.sender?.email)))) ?? null;
  };
  const clientOf = (invoiceNumber: string) => {
    const invoice = invoices.find(row => row.number === invoiceNumber);
    return lower(clients.find(client => client.id === invoice?.clientId)?.email);
  };
  const rows: BankProposal[] = [];
  for (const movement of bank.movements.filter(open)) {
    const s = movement.suggestion, supplier = movement.supplierSuggestion, expense = movement.expenseSuggestion;
    // A payment already recorded with a slightly different amount: link it, book the bank fee. Always one click.
    const feeInvoice = movement.creditDebit === 'CRDT' ? s?.candidates.filter(linksWithBankFee) ?? [] : [];
    const feeSupplier = movement.creditDebit === 'DBIT' ? supplier?.candidates.filter(linksWithBankFee) ?? [] : [];
    if (feeInvoice.length === 1)
      rows.push({ movement, action: 'link_with_fee', invoiceId: feeInvoice[0].invoiceId, invoiceNumber: feeInvoice[0].invoiceNumber || undefined,
        paymentId: feeInvoice[0].nearPaymentId, recordedCents: feeInvoice[0].nearPaymentAmountCents, feeCents: feeInvoice[0].feeCents, announcedBy: null });
    else if (feeSupplier.length === 1)
      rows.push({ movement, action: 'link_with_fee', supplierInvoiceId: feeSupplier[0].supplierInvoiceId, label: feeSupplier[0].reference || undefined,
        paymentId: feeSupplier[0].nearPaymentId, recordedCents: feeSupplier[0].nearPaymentAmountCents, feeCents: feeSupplier[0].feeCents, announcedBy: null });
    else if (movement.creditDebit === 'CRDT' && s?.confirmable && s.invoiceId && (s.kind === 'automatic_exact' || s.kind === 'automatic_partial'))
      rows.push({ movement, action: 'confirm_invoice', invoiceId: s.invoiceId, invoiceNumber: s.invoiceNumber ?? undefined, announcedBy: announced(movement, s.invoiceNumber ?? undefined) });
    else if (movement.creditDebit === 'DBIT' && supplier?.confirmable && supplier.supplierInvoiceId && supplier.kind === 'supplier_match')
      rows.push({ movement, action: 'confirm_supplier', supplierInvoiceId: supplier.supplierInvoiceId,
        label: supplier.candidates.find(row => row.supplierInvoiceId === supplier.supplierInvoiceId)?.reference, announcedBy: null });
    else if (movement.creditDebit === 'DBIT' && expense?.candidates.length === 1 && expense.candidates[0].confirmable && !expense.candidates[0].requiresDateReason)
      rows.push({ movement, action: 'confirm_expense', expenseId: expense.candidates[0].expenseId,
        label: [expense.candidates[0].supplier, expense.candidates[0].reference].filter(Boolean).join(' · '), announcedBy: null });
    else if ((s?.candidates.length ?? 0) > 0 || (supplier?.candidates.length ?? 0) > 0 || (expense?.candidates.length ?? 0) > 0)
      rows.push({ movement, action: 'choose', announcedBy: announced(movement) });
    // A payment with no invoice nor expense behind it: create the expense, with its receipt.
    else if (movement.creditDebit === 'DBIT' && expense?.canCreate)
      rows.push({ movement, action: 'create_expense', label: movement.counterpartyName || undefined, announcedBy: null });
  }
  return rows.sort((a, b) => rank[a.action] - rank[b.action] || b.movement.bookingDate.localeCompare(a.movement.bookingDate));
}

/** No statement imported for a week while an account is linked: a single discreet reminder. */
export function statementDue(bank: BankWorkspace | null, today: string) {
  if (!bank || !bank.accounts.some(account => account.linked)) return false;
  const last = bank.imports.map(row => row.createdAt.slice(0, 10)).sort().at(-1);
  return !last || Date.parse(today) - Date.parse(last) > 7 * 86_400_000;
}

/** Whether a bank account is linked to the company. */
export const hasLinkedBank = (bank: BankWorkspace | null) => !!bank?.accounts.some(account => account.linked);
