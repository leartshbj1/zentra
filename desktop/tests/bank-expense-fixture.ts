import { desktopApi } from '../src/bridge';
import { bankWorkspaceFromRaw } from '../src/bank';
import type { Workspace } from '../src/types';

/** Bank/expense UI only. Real payment, VAT and transaction assertions run in Rust. */
export function installBankExpenseFixture(getWorkspace: () => Workspace) {
  const workspace = getWorkspace();
  workspace.expenses = Array.from({ length: 30 }, (_, index) => ({ id: `expense-${index}`, projectId: null, date: '2026-08-20', dueDate: '2026-08-31', supplier: index === 0 ? 'Électricité du Léman' : `Fournisseur ${index}`, category: 'Marchandises', reference: index === 0 ? 'RECU-2026-MATERIEL-ELECTRIQUE-POUR-LE-PROJET' : `RECU-${index}`, netCents: 10000, vatCents: 810, totalCents: 10810, paymentStatus: index === 1 ? 'paid' : 'pending', paidAt: index === 1 ? '2026-08-30' : null, note: '' }));
  const account='CH9300762011623852957';
  const movements: Array<Record<string, unknown>> = ['pending-expense','paid-expense'].map((id) => ({ id, account_id: account, account_currency: 'CHF', amount_cents: 10810, currency: 'CHF', credit_debit: 'DBIT', status: 'BOOK', reversal: false, booking_date: '2026-08-31', value_date: '2026-08-31', created_at: '2026-08-31T10:00:00Z', counterparty_name: id === 'pending-expense' ? 'Dépense en attente' : 'Dépense déjà payée', strong_key: id, suggestion: { entity_type: 'supplier_invoice', kind: 'none', confirmable: false, requires_confirmation: true, candidates: [], reason: 'Aucune facture fournisseur correspondante.' } }));
  let expenseWrites=0;
  desktopApi.getBankWorkspace=async()=>{
    if(sessionStorage.getItem('qa-bank-refresh-fail')==='1') throw new Error('Lecture bancaire temporairement indisponible.');
    for(const movement of movements) movement.expense_suggestion={ reason: 'Vérifiez la pièce et le montant avant de confirmer.', candidates: movement.expense_reconciliation ? [] : getWorkspace().expenses.filter((expense)=>!movements.some((row)=> (row.expense_reconciliation as { expense_id: string } | undefined)?.expense_id===expense.id)).map((expense)=>({ expense_id:expense.id,supplier:expense.supplier,reference:expense.reference,category:expense.category,date:expense.date,payment_status:expense.paymentStatus,paid_at:expense.paidAt,requires_date_reason:expense.paymentStatus==='paid' && expense.paidAt!=='2026-08-31',total_cents:expense.totalCents,confirmable:expense.id!=='expense-29',reason:expense.id==='expense-29'?'La date comptabilisée ne correspond pas au relevé.':expense.paymentStatus==='paid'?'Paiement déjà comptabilisé : aucune nouvelle écriture.':'Le relevé réglera cette dépense à la date bancaire.' })) };
    return bankWorkspaceFromRaw({ summary: { movement_count:2, import_count:1, unreconciled_supplier_count:movements.filter((row)=>!row.expense_reconciliation).length, booked_debit_count:2 }, accounts:[{account_id:account,currency:'CHF',linked:true,link_source:'explicit',movement_count:2}], imports:[{id:'import',source_name:'releve-depenses.xml',message_type:'camt.053',entry_count:2,imported_count:2,created_at:'2026-09-05T08:00:00Z'}],movements,reconciliations:[],supplier_reconciliations:[]});
  };
  desktopApi.confirmExpenseBankReconciliation=async(movementId,expenseId,dateDifferenceReason)=>{
    sessionStorage.setItem('qa-expense-attempts',String(Number(sessionStorage.getItem('qa-expense-attempts')||0)+1));
    if(sessionStorage.getItem('qa-bank-reject')==='1') throw new Error('Le compte bancaire a été dissocié. Vérifiez son association avant de confirmer.');
    const movement=movements.find((row)=>row.id===movementId)!;
    const expense=getWorkspace().expenses.find((row)=>row.id===expenseId)!;
    if(!movement.expense_reconciliation){
      if(expense.paymentStatus==='pending') { expenseWrites++; expense.paymentStatus='paid';expense.paidAt='2026-08-31'; }
      movement.expense_reconciliation={id:`rec-${movementId}`,expense_id:expenseId,journal_entry_id:`journal-${expenseId}`,date_difference_reason:dateDifferenceReason,confirmed_at:'2026-09-05T10:00:00Z'};
      sessionStorage.setItem('qa-expense-postings',String(expenseWrites));
      sessionStorage.setItem('qa-expense-confirmed',JSON.stringify({movementId,expenseId,paidAt:expense.paidAt}));
    }
    if(sessionStorage.getItem('qa-bank-fail-after-save')==='1') sessionStorage.setItem('qa-bank-refresh-fail','1');
  };
}
