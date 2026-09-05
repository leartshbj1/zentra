import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';
import { bankMovementFromRaw, canConfirmBankReconciliation, filterBankMovements, initialInvoiceChoice } from './bank';
import { ExpenseRefundHistory } from './ExpenseRefundForm';
import type { Expense, ExpenseRefund } from './types';

const match = { id: 'match', refund_id: 'refund', expense_id: 'expense', reference: 'AV-2026-054', supplier: 'Fournisseur Léman', amount_cents: 5405, payment_date: '2026-08-31', payment_journal_id: 'journal', confirmed_at: '2026-09-05T10:00:00Z', date_difference_reason: 'Décalage bancaire documenté' };
describe('rapprochement des remboursements de dépenses', () => {
  it('conserve la preuve du remboursement et empêche son utilisation comme paiement client', () => {
    const movement = bankMovementFromRaw({ id: 'movement', status: 'BOOK', credit_debit: 'CRDT', amount_cents: 5405, currency: 'CHF', refund_match: match, suggestion: { kind: 'automatic_exact', confirmable: true, invoice_id: 'invoice', candidates: [{ invoice_id: 'invoice', confirmable: true, remaining_cents: 5405 }] } });
    expect(movement.refundMatch).toMatchObject({ id: 'match', refundId: 'refund', paymentJournalId: 'journal', dateDifferenceReason: 'Décalage bancaire documenté' });
    expect(initialInvoiceChoice(movement)).toBe('');
    expect(canConfirmBankReconciliation(movement, 'invoice')).toBe(false);
    expect(filterBankMovements([movement], 'unreconciled')).toEqual([]);
    expect(filterBankMovements([movement], 'reconciled', 'AV2026054')).toEqual([movement]);
  });
  it('retrouve la dissociation par son motif et conserve les dates des choix proposés', () => {
    const movement = bankMovementFromRaw({ id: 'movement', status: 'BOOK', credit_debit: 'CRDT', refund_history: [{ ...match, reason: 'Crédit du mauvais fournisseur', unlinked_at: '2026-09-05T11:00:00Z' }], refund_suggestion: { candidates: [{ refund_id: 'refund', reference: 'AV-2026-054', payment_date: '2026-08-31', total_cents: 5405, requires_date_reason: 1, confirmable: true }] } });
    expect(filterBankMovements([movement], 'unreconciled', 'mauvais fournisseur')).toEqual([movement]);
    expect(movement.refundHistory?.[0]).toMatchObject({ id: 'match', refundId: 'refund', reason: 'Crédit du mauvais fournisseur' });
    expect(movement.refundSuggestion?.candidates[0]).toMatchObject({ paymentDate: '2026-08-31', totalCents: 5405, requiresDateReason: true });
    expect(bankMovementFromRaw({}).refundMatch).toBeNull();
  });
  it('transmet la demande stable et le motif aux commandes natives sans enregistrer de paiement', async () => {
    invokeMock.mockResolvedValue(undefined);
    await desktopApi.matchBankExpenseRefund('request', 'movement', 'refund', 'Décalage bancaire documenté');
    expect(invokeMock).toHaveBeenLastCalledWith('match_bank_expense_refund', { input: { request_id: 'request', movement_id: 'movement', refund_id: 'refund', date_difference_reason: 'Décalage bancaire documenté' } });
    await desktopApi.unmatchBankExpenseRefund('unlink', 'match', 'Mauvaise association');
    expect(invokeMock).toHaveBeenLastCalledWith('unmatch_bank_expense_refund', { input: { request_id: 'unlink', match_id: 'match', reason: 'Mauvaise association' } });
  });
  it('demande la dissociation avant de proposer une correction financière du remboursement', () => {
    const refund: ExpenseRefund = { id: 'refund', expenseId: 'expense', bankMatchId: 'match', reversesId: null, eventType: 'refund', creditDate: '2026-08-21', paymentDate: '2026-08-31', reference: 'AV-054', reason: 'Retour matériel', netCents: 5000, vatCents: 405, totalCents: 5405, costCents: 5000, treatment: 'input_materials', creditJournalId: 'credit', paymentJournalId: 'payment', createdAt: '2026-08-31' };
    const expense = { refunds: [refund] } as Expense;
    const locked = renderToStaticMarkup(<ExpenseRefundHistory expense={expense} disabled={false} onReverse={vi.fn()} />);
    expect(locked).toContain('Dissociez ce remboursement dans Banque');
    expect(locked).not.toContain('Corriger une saisie erronée');
    const unlocked = renderToStaticMarkup(<ExpenseRefundHistory expense={{ ...expense, refunds: [{ ...refund, bankMatchId: null }] }} disabled={false} onReverse={vi.fn()} />);
    expect(unlocked).toContain('Corriger une saisie erronée');
  });
});
