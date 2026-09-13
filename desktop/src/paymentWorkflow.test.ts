import {describe,expect,it,vi} from 'vitest';
import {paymentProblem,paymentNativeProblem,paymentWasRecorded,runPaymentMutation,PaymentOutcomeUnknownError,PaymentRefreshError,type PaymentIntent} from './paymentWorkflow';
import {initialOnboardingSettings} from './onboardingDraft';
import type {Invoice,Workspace} from './types';
const invoice={id:'invoice',type:'final',status:'issued',number:'F-1',issueDate:'2026-05-01',currency:'CHF',lines:[{quantity:1,unitPriceCents:10000,vatRateBp:0,discountBp:0}],creditedCents:0} as unknown as Invoice;
const draft={amount:'10,25',date:'2026-05-02',method:'Virement',reference:'Relevé',notes:'Partiel'};
const data=()=>({onboardingCompleted:true,settings:initialOnboardingSettings,invoices:[invoice],payments:[],accounts:[{id:'bank',accountType:'asset',active:true}],accountingSettings:{enabled:true,bankAccountId:'bank'}} as unknown as Workspace);
const intent:PaymentIntent={...draft,invoiceId:'invoice',requestId:'request',amountCents:1025};
describe('paiement client guidé',()=>{
  it('explique le montant, la date et le moyen de paiement au bon champ',()=>{
    expect(paymentProblem(invoice,data(),draft,'2026-06-01')).toBeNull();
    for(const amount of ['','-1','0','10.251','1e2','100.01','90000000000000.01'])expect(paymentProblem(invoice,data(),{...draft,amount},'2026-06-01')?.field).toBe('amount');
    for(const date of ['','2026-02-30','2026-04-30','2026-06-02'])expect(paymentProblem(invoice,data(),{...draft,date},'2026-06-01')?.field).toBe('date');
    expect(paymentProblem(invoice,data(),{...draft,method:''},'2026-06-01')?.field).toBe('method');
    expect(paymentProblem(invoice,data(),{...draft,notes:'x'.repeat(5001)},'2026-06-01')?.field).toBe('notes');
    expect(paymentProblem(invoice,data(),{...draft,reference:'a\0b'},'2026-06-01')?.field).toBe('reference');
  });
  it('relit les paiements et avoirs actuels, la chronologie et le compte',()=>{
    expect(paymentProblem(undefined,data(),draft,'2026-06-01')?.field).toBe('record');
    expect(paymentProblem({...invoice,status:'cancelled'},data(),draft,'2026-06-01')?.field).toBe('record');
    const workspace=data();workspace.payments=[{id:'prior',invoiceId:'invoice',amountCents:9500,date:'2026-05-01',method:'Virement',reference:''}];
    expect(paymentProblem(invoice,workspace,draft,'2026-06-01')?.field).toBe('amount');
    workspace.payments=[];workspace.invoices.push({...invoice,id:'credit',type:'credit_note',creditSettlements:[{invoiceId:'invoice',date:'2026-05-03'} as never]});
    expect(paymentProblem(invoice,workspace,draft,'2026-06-01')?.field).toBe('date');
    expect(paymentProblem(invoice,{...data(),accounts:[]},draft,'2026-06-01')?.accounting).toBe(true);
    expect(paymentNativeProblem('Le compte a changé depuis votre vérification').accounting).toBeUndefined();
    expect(paymentNativeProblem('La période est fermée').accounting).toBe(true);
  });
  it('une réponse perdue exige le même paiement et son lien comptable',()=>{
    const workspace=data();workspace.payments=[{id:'request',invoiceId:'invoice',date:draft.date,amountCents:1025,method:draft.method,reference:draft.reference,notes:draft.notes,journalEntryId:'journal',journalEntrySemanticallyValid:true}];
    expect(paymentWasRecorded(workspace,intent)).toBe(true);
    for(const patch of [{requestId:'other'},{amountCents:1026},{notes:'Autre note'},{date:'2026-05-03'}])expect(paymentWasRecorded(workspace,{...intent,...patch})).toBe(false);
    workspace.payments[0].journalEntrySemanticallyValid=undefined;expect(paymentWasRecorded(workspace,intent)).toBe(false);
    workspace.payments[0].journalEntrySemanticallyValid=false;expect(paymentWasRecorded(workspace,intent)).toBe(false);
    workspace.payments[0].journalEntrySemanticallyValid=true;workspace.payments[0].journalEntryId=null;expect(paymentWasRecorded(workspace,intent)).toBe(false);
    expect(()=>paymentWasRecorded({...workspace,onboardingCompleted:false},intent)).toThrow();
  });
  it('les reprises relisent sans répéter une écriture',async()=>{
    const write=vi.fn(async()=>({}));
    const result=await runPaymentMutation(intent,write,async()=>data()).catch(e=>e);
    expect(result).toBeInstanceOf(PaymentRefreshError);expect(()=>result.validateRead(data())).toThrow();expect(write).toHaveBeenCalledTimes(1);
    const cause=Error('Réponse perdue');const lost=await runPaymentMutation(intent,async()=>{throw cause;},async()=>data()).catch(e=>e);
    expect(lost).toBeInstanceOf(PaymentOutcomeUnknownError);expect(lost.mutationCause).toBe(cause);expect(lost.wasRecorded(data())).toBe(false);
  });
});
