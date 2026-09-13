import {afterEach,describe,expect,it,vi} from 'vitest';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke}));
import {desktopApi} from './bridge';
import {initialOnboardingSettings} from './onboardingDraft';
import {supplierRefundAvailable,supplierRefundProblem,supplierRefundNativeProblem,supplierRefundWasRecorded,runSupplierRefundMutation,SupplierRefundOutcomeUnknownError,SupplierRefundRefreshError,type SupplierRefundIntent} from './supplierRefundWorkflow';
import type {SupplierCreditNote,SupplierCreditRefund,Workspace} from './types';
const refund={id:'refund',requestId:'request',supplierCreditNoteId:'credit',eventType:'refund',amountCents:1025,date:'2026-05-15',reference:'Virement',reason:'Retour',bankAccountId:'bank',payableAccountId:'payable',journalEntryId:'journal'} as SupplierCreditRefund;
const credit={id:'credit',status:'validated',currency:'CHF',totalCents:5405,allocatedCents:1000,refundedCents:1025,documentDate:'2026-05-01',refunds:[refund]} as SupplierCreditNote;
const data=()=>({onboardingCompleted:true,settings:initialOnboardingSettings,supplierCreditNotes:[credit],accounts:[{id:'bank',active:true,accountType:'asset'}],accountingSettings:{enabled:true,bankAccountId:'bank'}}) as Workspace;
const draft={amount:'10,25',date:'2026-05-16',reference:'Virement',reason:'Retour'};
const intent:SupplierRefundIntent={kind:'refund',requestId:'request',creditId:'credit',amountCents:1025,date:'2026-05-15',reference:'Virement',reason:'Retour'};
afterEach(()=>invoke.mockReset());
describe('remboursement fournisseur guidé',()=>{
  it('déduit les utilisations et remboursements sans inventer un solde absent',()=>{
    expect(supplierRefundAvailable(credit)).toBe(3380);expect(supplierRefundAvailable({...credit,refundedCents:NaN})).toBeNull();expect(supplierRefundAvailable({...credit,allocatedCents:6000})).toBeNull();
  });
  it.each(['','0','-10','10.251','1e2','90000000000000.01'])('explique le montant invalide sans le modifier : %s',amount=>expect(supplierRefundProblem(credit,undefined,false,{...draft,amount},data(),'2026-06-01')?.field).toBe('amount'));
  it('localise les dates, références et motifs manquants ou trop longs',()=>{
    expect(supplierRefundProblem(credit,undefined,false,draft,data(),'2026-06-01')).toBeNull();
    for(const date of ['','2026-02-30','2026-04-30','2026-06-02'])expect(supplierRefundProblem(credit,undefined,false,{...draft,date},data(),'2026-06-01')?.field).toBe('date');
    for(const reference of ['','x'.repeat(256),'a\0b'])expect(supplierRefundProblem(credit,undefined,false,{...draft,reference},data(),'2026-06-01')?.field).toBe('reference');
    for(const reason of ['','abcd','x'.repeat(1001)])expect(supplierRefundProblem(credit,undefined,false,{...draft,reason},data(),'2026-06-01')?.field).toBe('reason');
  });
  it('dirige vers les comptes et empêche de corriger deux fois le même remboursement',()=>{
    expect(supplierRefundProblem(credit,undefined,false,draft,{...data(),accounts:[]},'2026-06-01')?.destination).toBe('accounts');
    expect(supplierRefundProblem(credit,refund,true,{...draft,amount:'invalid',reference:''},data(),'2026-06-01')).toBeNull();
    const corrected={...credit,refunds:[refund,{...refund,id:'reverse',eventType:'reverse' as const,reversesId:'refund'}]};
    expect(supplierRefundProblem(corrected,refund,true,draft,data(),'2026-06-01')?.field).toBe('record');
    expect(supplierRefundNativeProblem('Dissociez d’abord le remboursement du relevé dans Banque.').destination).toBe('bank');
    expect(supplierRefundNativeProblem('La période est fermée').destination).toBe('periods');
  });
  it('exige la même demande, le contenu et le lien comptable après une interruption',()=>{
    expect(supplierRefundWasRecorded(data(),intent)).toBe(true);expect(supplierRefundWasRecorded(data(),{...intent,amountCents:1000})).toBe(false);
    expect(supplierRefundWasRecorded(data(),{...intent,requestId:'autre'})).toBe(false);
    expect(supplierRefundWasRecorded({...data(),supplierCreditNotes:[{...credit,refunds:[{...refund,journalEntryId:''}]}]},intent)).toBe(false);
    const corrected={...refund,id:'reverse',requestId:'reversal',eventType:'reverse' as const,reversesId:'refund',date:'2026-05-16',reason:'Erreur'};
    const workspace={...data(),supplierCreditNotes:[{...credit,refunds:[refund,corrected]}]};
    expect(supplierRefundWasRecorded(workspace,intent)).toBe(true);
    expect(supplierRefundWasRecorded(workspace,{kind:'reverse',requestId:'reversal',refundId:'refund',date:'2026-05-16',reason:' Erreur '})).toBe(true);
  });
  it('une relecture absente reste à reprendre et ne réémet aucune écriture',async()=>{
    const write=vi.fn(async()=>({}));const failure=await runSupplierRefundMutation(intent,write,async()=>({...data(),supplierCreditNotes:[]})).catch(e=>e);
    expect(failure).toBeInstanceOf(SupplierRefundRefreshError);expect(()=>failure.validateRead(data())).not.toThrow();expect(()=>failure.validateRead({...data(),onboardingCompleted:false})).toThrow();expect(write).toHaveBeenCalledTimes(1);
    const lost=await runSupplierRefundMutation(intent,async()=>{throw Error('Lost');},async()=>data()).catch(e=>e);expect(lost).toBeInstanceOf(SupplierRefundOutcomeUnknownError);expect(lost.wasRecorded(data())).toBe(true);
  });
  it('transmet la vérification hors du contenu idempotent',async()=>{
    invoke.mockRejectedValue(Error('Refus'));
    const expectedReview={availableCents:3380,bankAccountId:'bank'};
    const input={requestId:'request',supplierCreditNoteId:'credit',date:'2026-05-15',amountCents:1025,reference:' Virement ',reason:' Retour ',expectedReview};
    expect(await desktopApi.recordSupplierCreditRefund(input).catch(e=>e)).toBeInstanceOf(SupplierRefundOutcomeUnknownError);
    expect(invoke.mock.calls[0]).toEqual(['record_supplier_credit_refund',{input:{request_id:'request',supplier_credit_note_id:'credit',date:'2026-05-15',amount_cents:1025,reference:'Virement',reason:'Retour'},expectedReview}]);
  });
});
