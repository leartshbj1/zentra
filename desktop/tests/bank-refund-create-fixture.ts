import { desktopApi } from '../src/bridge';
import { bankWorkspaceFromRaw } from '../src/bank';
import { installBankRefundFixture } from './bank-refund-fixture';
import type { ExpenseRefund, Workspace } from '../src/types';

/** Browser-only error/recovery fixture; native tests validate the real transaction. */
export function installBankRefundCreateFixture(initial: Workspace) {
  installBankRefundFixture(initial);
  initial.expenses.forEach(expense => { expense.refunds = []; });
  initial.expenses.push({ ...initial.expenses[0], id:'blocked-expense', reference:'ANCIEN-PAIEMENT-INCONNU', paidAt:null });
  const persisted = structuredClone(initial);
  let active: Record<string, unknown> | null = null;
  const requests = new Map<string,string>();
  const account='CH9300762011623852957';
  const fail = (name:string) => sessionStorage.getItem('qa-bank-create-refund-'+name)==='1';
  desktopApi.loadWorkspace = async () => { if (fail('read')) throw new Error('Lecture des achats indisponible.'); return structuredClone(persisted); };
  desktopApi.openAttachment = async id => { sessionStorage.setItem('qa-bank-create-refund-opened',id); return id; };
  desktopApi.getBankWorkspace = async () => {
    if (fail('read')) throw new Error('Lecture bancaire indisponible.');
    return bankWorkspaceFromRaw({summary:{movement_count:1,import_count:1,unreconciled_count:active?0:1,booked_credit_count:1}, accounts:[{account_id:account,currency:'CHF',linked:true,link_source:'explicit',movement_count:1}],imports:[{id:'import',source_name:'remboursement-recu.xml',message_type:'camt.053',entry_count:1,imported_count:1,created_at:'2026-09-05T08:00:00Z'}],movements:[{id:'create-refund-credit',account_id:account,account_currency:'CHF',amount_cents:5405,currency:'CHF',credit_debit:'CRDT',status:'BOOK',reversal:false,booking_date:'2026-08-31',value_date:'2026-08-30',created_at:'2026-08-31',strong_key:'create-refund-credit',reference_type:'NON',unstructured:'Remboursement de marchandises',counterparty_name:'Électricité du Léman',refund_match:active,refund_history:[],refund_suggestion:{can_create:!active,reason:'Aucun remboursement déjà saisi.',candidates:[]},suggestion:{kind:'none',candidates:[],confirmable:false,reason:'Aucune facture client correspondante.'}}],reconciliations:[],supplier_reconciliations:[]});
  };
  desktopApi.createBankExpenseRefund = async (movementId,input) => {
    const record={movementId,...input,receipt:input.receipt?{name:input.receipt.name,size:input.receipt.size}:null};
    const signature=JSON.stringify(record);
    sessionStorage.setItem('qa-bank-create-refund-attempts',JSON.stringify([...JSON.parse(sessionStorage.getItem('qa-bank-create-refund-attempts')||'[]'),record]));
    if (fail('deny')) throw new Error('Le compte bancaire a changé. Votre remboursement n’a pas été enregistré.');
    const previous=requests.get(input.requestId);
    if(previous && previous!==signature) throw new Error('Cette demande est déjà enregistrée avec une autre saisie.');
    if(!previous) {
      if(active) throw new Error('Ce crédit est déjà rapproché.');
      const expense=persisted.expenses.find(expense=>expense.id===input.expenseId)!;
      const refund: ExpenseRefund={...input,id:'created-refund',eventType:'refund',reversesId:null,totalCents:input.netCents+input.vatCents,costCents:input.netCents,treatment:'input_materials',creditJournalId:'credit-journal',paymentJournalId:'bank-journal',createdAt:'2026-09-05',bankMatchId:input.requestId};
      expense.refunds=[refund];
      active={id:input.requestId,refund_id:refund.id,expense_id:expense.id,reference:input.reference,supplier:expense.supplier,amount_cents:refund.totalCents,payment_date:input.paymentDate,payment_journal_id:refund.paymentJournalId,confirmed_at:'2026-09-05T12:00:00Z'};
      if(input.receipt) (persisted.attachments ??= []).push({id:'bank-refund-receipt',projectId:expense.projectId,entityType:'expense_refund',entityId:refund.id,originalName:input.receipt.name,mimeType:'application/pdf',sizeBytes:input.receipt.size,sha256:'a'.repeat(64),createdAt:'2026-09-05',updatedAt:'2026-09-05'});
      requests.set(input.requestId,signature); sessionStorage.setItem('qa-bank-create-refund-commits',String(requests.size));
    }
    if(fail('lost')) throw new Error('Réponse interrompue. Réessayez cette même saisie.');
    if(fail('fail-after-save')) sessionStorage.setItem('qa-bank-create-refund-read','1');
  };
}
