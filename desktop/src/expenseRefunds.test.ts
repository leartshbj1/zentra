import { describe, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';
import { expenseRefundTotals } from './expenseRefunds';
import { projectFinancials } from './utils';
import { purchaseSummary } from './purchases';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';
import type { Expense, ExpenseRefund, ExpenseRefundInput, Project } from './types';

const project: Project = { id: 'project', clientId: 'client', name: 'Projet', address: '', status: 'in_progress', plannedStart: '', plannedEnd: '', actualStart: '', actualEnd: '', budgetCents: 0, plannedMinutes: 0, notes: '' };
const refund: ExpenseRefund = { id: 'refund', expenseId: 'expense', eventType: 'refund', reversesId: null, creditDate: '2026-04-20', paymentDate: '2026-07-05', reference: 'AV-001', reason: 'Retour de marchandises', netCents: 5000, vatCents: 405, totalCents: 5405, costCents: 5405, treatment: 'non_deductible', creditJournalId: 'credit-journal', paymentJournalId: 'payment-journal', createdAt: '2026-07-05' };
const expense: Expense = { id: 'expense', projectId: project.id, date: '2026-02-10', supplier: 'Fournisseur', category: 'Marchandises', reference: 'EXP-001', netCents: 10000, vatCents: 810, totalCents: 10810, paymentStatus: 'paid', paidAt: '2026-02-10', reimbursable: false, note: '', costCents: 10810, costReviewRequired: false, refunds: [refund] };
const input: ExpenseRefundInput = { requestId: 'request', expenseId: expense.id, creditDate: refund.creditDate, paymentDate: refund.paymentDate, reference: refund.reference, reason: refund.reason, netCents: refund.netCents, vatCents: refund.vatCents, reversesId: null };

describe('remboursements de dépenses', () => {
  it('réduit le coût du projet et le payé net sans modifier le montant de la pièce', () => {
    expect(expenseRefundTotals(expense)).toEqual({ netCents: 5000, vatCents: 405, totalCents: 5405, costCents: 5405 });
    expect(projectFinancials(project, [], [], [], [expense])).toMatchObject({ expenseRefundCost: 5405, expenseNet: 5405, nonDeductibleVatCost: 405, margin: -5405 });
    expect(purchaseSummary([expense], '2026-09-05').paidCents).toBe(5405);
    expect(expense.totalCents).toBe(10810);
  });
  it('une correction rétablit les montants et reste dans l’historique', () => {
    const corrected = { ...expense, refunds: [refund, { ...refund, id: 'reverse', eventType: 'reverse' as const, reversesId: refund.id }] };
    expect(expenseRefundTotals(corrected).totalCents).toBe(0);
    expect(projectFinancials(project, [], [], [], [corrected])).toMatchObject({ expenseNet: 10810, expenseRefundCost: 0, margin: -10810 });
    expect(purchaseSummary([corrected], '2026-09-05').paidCents).toBe(10810);
    expect(corrected.refunds).toHaveLength(2);
  });
  it('le contrat IPC conserve les deux dates, les centimes et la tentative', async () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => command === 'get_app_state' ? { onboarding_completed: false } : {});
    await desktopApi.recordExpenseRefund(input);
    expect(invokeMock).toHaveBeenCalledWith('record_expense_refund', { input: { request_id: 'request', expense_id: 'expense', credit_date: '2026-04-20', payment_date: '2026-07-05', reference: 'AV-001', reason: 'Retour de marchandises', net_cents: 5000, vat_cents: 405, reverses_id: null } });
  });
  it('distingue une lecture interrompue d’une écriture refusée', async () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => { if (command === 'get_app_state') throw new Error('Lecture interrompue'); return {}; });
    await expect(desktopApi.recordExpenseRefund(input)).rejects.toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    invokeMock.mockReset();
    const denied = new Error('Période fermée');
    invokeMock.mockRejectedValue(denied);
    await expect(desktopApi.recordExpenseRefund(input)).rejects.toBe(denied);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
