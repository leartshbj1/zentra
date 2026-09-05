import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const invokeMock=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:invokeMock}));
import { desktopApi } from './bridge';
import { bankMovementFromRaw } from './bank';
import { bankRefundExpenseChoices } from './BankRefundCreate';
import { BankRefundPicker } from './BankRefunds';
import type { Expense, ExpenseRefundInput } from './types';
afterEach(()=>{invokeMock.mockReset();vi.unstubAllGlobals();});
const input:ExpenseRefundInput={requestId:'request',expenseId:'purchase',creditDate:'2026-08-21',paymentDate:'2026-08-31',reference:'AV-54',reason:'Retour matériel',netCents:5000,vatCents:405,reversesId:null};
const movement=bankMovementFromRaw({id:'credit',credit_debit:'CRDT',amount_cents:5405,booking_date:'2026-08-31',refund_suggestion:{can_create:true,candidates:[]}});
describe('création du remboursement depuis la banque',()=>{
  it('attend la permission métier du serveur et reste désactivé en lecture seule',()=>{
    const html=renderToStaticMarkup(<BankRefundPicker movement={movement} disabled onCreate={vi.fn()} onConfirm={vi.fn()}/>);
    expect(html).toMatch(/disabled=""[^>]*>Créer le remboursement reçu/);
    const blocked=renderToStaticMarkup(<BankRefundPicker movement={bankMovementFromRaw({})} disabled={false} onCreate={vi.fn()} onConfirm={vi.fn()}/>);
    expect(blocked).not.toContain('Créer le remboursement reçu');
  });
  it('explique les achats bloqués et tient compte du solde après remboursement',()=>{
    const base:Expense={id:'paid',reference:'RECU',date:'2026-08-20',paidAt:'2026-08-20',paymentStatus:'paid',totalCents:10810,netCents:10000,vatCents:810,costReviewRequired:false,refunds:[],projectId:null,supplier:'Fournisseur',category:'Marchandises',note:''};
    const choices=bankRefundExpenseChoices([base,{...base,id:'future',paidAt:'2026-09-01'},{...base,id:'unknown',paidAt:null},{...base,id:'pending',paymentStatus:'pending'},{...base,id:'review',costReviewRequired:true},{...base,id:'refunded',refunds:[{...input,id:'refund',eventType:'refund',totalCents:6000,costCents:5550,netCents:5550,vatCents:450,treatment:'input_materials',creditJournalId:'credit',paymentJournalId:'payment',createdAt:'2026-08-31'} as NonNullable<Expense['refunds']>[number]]}],movement);
    expect(choices).toHaveLength(5);
    expect(choices.find(x=>x.expense.id==='paid')?.reason).toBe('');
    expect(choices.filter(x=>x.reason)).toHaveLength(4);
    expect(choices.find(x=>x.expense.id==='refunded')?.remaining).toBe(4810);
  });
  it('transmet la pièce et les données dans une seule commande puis laisse la banque gérer les lectures',async()=>{
    vi.stubGlobal('FileReader',class{result='';onload=()=>{};async readAsDataURL(blob:Blob){this.result='data:application/pdf;base64,'+Buffer.from(await blob.arrayBuffer()).toString('base64');this.onload();}});
    invokeMock.mockResolvedValue({});
    await desktopApi.createBankExpenseRefund('credit',{...input,receipt:new File(['%PDF-avoir'],'avoir.pdf')});
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('create_bank_expense_refund',{movementId:'credit',input:{request_id:'request',expense_id:'purchase',credit_date:'2026-08-21',payment_date:'2026-08-31',reference:'AV-54',reason:'Retour matériel',net_cents:5000,vat_cents:405,reverses_id:null},attachment:{original_name:'avoir.pdf',content_base64:Buffer.from('%PDF-avoir').toString('base64')}});
  });
  it('ne transforme pas un refus natif en une création réussie',async()=>{
    const error=new Error('Période fermée'); invokeMock.mockRejectedValue(error);
    await expect(desktopApi.createBankExpenseRefund('credit',input)).rejects.toBe(error);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
