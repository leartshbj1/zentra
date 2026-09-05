import { desktopApi } from '../src/bridge';
import type { BankMovement, Workspace } from '../src/types';
import { installBankExpenseFixture } from './bank-expense-fixture';

/** UI transition fixture; real journal and VAT invariance is checked in native tests. */
export function installBankUnlinkFixture(getWorkspace: () => Workspace) {
  installBankExpenseFixture(getWorkspace);
  const read = desktopApi.getBankWorkspace;
  const expense = getWorkspace().expenses[0];
  expense.paymentStatus='paid'; expense.paidAt='2026-08-31';
  const active: Record<string, NonNullable<BankMovement['expenseReconciliation']> | null> = {
    'pending-expense': {id:'first-link',expenseId:expense.id,journalEntryId:'journal-original',confirmedAt:'2026-08-31T10:00:00Z'},
    'paid-expense': {id:'other-link',expenseId:'expense-1',journalEntryId:'journal-other',confirmedAt:'2026-08-31T10:00:00Z',dateDifferenceReason:'Ordre de paiement enregistré la veille.'},
  };
  const history: NonNullable<BankMovement['expenseHistory']> = Array.from({length:5},(_,i)=>({id:`history-${i}`,expenseId:expense.id,reference:`ANCIENNE-${i}`,supplier:expense.supplier,amountCents:10810,confirmedAt:'2026-08-31T10:00:00Z',unlinkedAt:'2026-09-04T10:00:00Z',reason:`Correction antérieure documentée ${i}`}));
  const requests = new Map<string,{id:string;reason:string}>();
  desktopApi.getBankWorkspace = async () => {
    const bank = await read();
    if(sessionStorage.getItem('qa-unlink-external-correction')==='1' && active['pending-expense']) {
      const previous=active['pending-expense'];
      history.unshift({id:previous.id,expenseId:expense.id,reference:expense.reference,supplier:expense.supplier,amountCents:10810,confirmedAt:previous.confirmedAt,unlinkedAt:'2026-09-05T11:45:00Z',reason:'Association corrigée pendant l’interruption de lecture.'});
      active['pending-expense']=null; sessionStorage.removeItem('qa-unlink-external-correction');
    }
    for (const movement of bank.movements) {
      movement.expenseReconciliation=active[movement.id];
      if(movement.id==='pending-expense') {
        movement.expenseHistory=history;
        movement.expenseSuggestion={reason:'Choisissez la pièce correspondant réellement à ce débit.',canCreate:false,candidates:active[movement.id]?[]:[{expenseId:expense.id,supplier:expense.supplier,reference:expense.reference,category:expense.category,date:expense.date,paidAt:expense.paidAt || '',requiresDateReason:false,paymentStatus:'paid',totalCents:10810,confirmable:true,reason:'Paiement conservé : aucune nouvelle écriture.'}]};
      }
    }
    return bank;
  };
  desktopApi.unreconcileBankExpense=async(requestId,id,reason)=>{
    sessionStorage.setItem('qa-unlink-attempts',String(Number(sessionStorage.getItem('qa-unlink-attempts')||0)+1));
    const ids=JSON.parse(sessionStorage.getItem('qa-unlink-ids')||'[]') as string[];
    sessionStorage.setItem('qa-unlink-ids',JSON.stringify([...ids,requestId]));
    if(sessionStorage.getItem('qa-unlink-reject')==='1')throw new Error('Les données du rapprochement ont changé. Vérifiez la pièce avant de réessayer.');
    if(!requests.has(requestId)) {
      const link=active['pending-expense'];
      if(!link || link.id!==id)throw new Error('Cette association n’est plus active.');
      requests.set(requestId,{id,reason});active['pending-expense']=null;
      history.unshift({id,expenseId:expense.id,reference:expense.reference,supplier:expense.supplier,amountCents:10810,confirmedAt:link.confirmedAt,unlinkedAt:'2026-09-05T11:00:00Z',reason});
      sessionStorage.setItem('qa-unlink-writes','1');
    }
    if(sessionStorage.getItem('qa-unlink-lost-response')==='1')throw new Error('Réponse interrompue. Réessayez avec le même motif.');
    if(sessionStorage.getItem('qa-unlink-refresh-fail')==='1')sessionStorage.setItem('qa-bank-refresh-fail','1');
  };
  desktopApi.confirmExpenseBankReconciliation=async(movementId,expenseId,reason,requestId)=>{
    const ids=JSON.parse(sessionStorage.getItem('qa-unlink-confirm-ids')||'[]') as string[];
    sessionStorage.setItem('qa-unlink-confirm-ids',JSON.stringify([...ids,requestId]));
    active[movementId]={id:requestId || 'new-link',expenseId,journalEntryId:'journal-original',confirmedAt:'2026-09-05T11:30:00Z',dateDifferenceReason:reason};
    sessionStorage.setItem('qa-unlink-rematched','1');
    if(sessionStorage.getItem('qa-unlink-rematch-read-fail')==='1')sessionStorage.setItem('qa-bank-refresh-fail','1');
  };
}
