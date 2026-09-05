import { desktopApi } from '../src/bridge';
import type { BankExpenseDraft } from '../src/BankExpenseForm';
import type { Workspace } from '../src/types';
import { installBankExpenseFixture } from './bank-expense-fixture';

/** UI state machine; native tests verify SQLite, receipt bytes and VAT separately. */
export function installBankCreateFixture(getWorkspace: () => Workspace) {
  installBankExpenseFixture(getWorkspace);
  const read = desktopApi.getBankWorkspace;
  let saved: BankExpenseDraft | null = null;
  let attempts = 0;
  desktopApi.getBankWorkspace = async () => {
    const bank = await read();
    bank.movements = bank.movements.slice(0, 1);
    const movement = bank.movements[0];
    movement.counterpartyName = 'Matériaux du Léman';
    movement.expenseSuggestion = { reason: 'Vérifiez le justificatif avant de créer une dépense.', canCreate: !saved, candidates: [] };
    if (saved) movement.expenseReconciliation = {id:'new-link',expenseId:saved.requestId,journalEntryId:'new-journal',confirmedAt:'2026-09-05T11:00:00Z'};
    return bank;
  };
  desktopApi.createBankExpense = async (draft) => {
    attempts++;
    sessionStorage.setItem('qa-create-attempts',String(attempts));
    const ids = JSON.parse(sessionStorage.getItem('qa-create-ids') || '[]') as string[];
    sessionStorage.setItem('qa-create-ids',JSON.stringify([...ids,draft.requestId]));
    if (sessionStorage.getItem('qa-create-reject') === '1') throw new Error('Le compte bancaire est dissocié. Associez-le avant de réessayer.');
    if (!saved) {
      saved = draft;
      getWorkspace().expenses.push({id:draft.requestId,projectId:draft.projectId,date:draft.date,supplier:draft.supplier,reference:draft.reference,category:draft.category,netCents:10810-draft.vatCents,vatCents:draft.vatCents,totalCents:10810,paymentStatus:'paid',paidAt:'2026-08-31',note:draft.note});
      sessionStorage.setItem('qa-create-postings','1');
      sessionStorage.setItem('qa-create-receipt',draft.receipt.name);
    }
    if (sessionStorage.getItem('qa-create-lost-response') === '1') throw new Error('Réponse interrompue. Réessayez avec les mêmes données.');
    if (sessionStorage.getItem('qa-create-refresh-fail') === '1') sessionStorage.setItem('qa-bank-refresh-fail','1');
  };
}
