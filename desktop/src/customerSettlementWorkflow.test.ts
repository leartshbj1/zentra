import {describe,expect,it,vi} from 'vitest';
import {customerSettlementAvailable,customerSettlementTargets,customerSettlementProblem,customerSettlementWasRecorded,customerSettlementNativeProblem,runCustomerSettlementMutation,requireCustomerSettlementReverseContext,CustomerSettlementOutcomeUnknownError,CustomerSettlementRefreshError,type CustomerSettlementDraft} from './customerSettlementWorkflow';
import type {Invoice,Workspace,CustomerCreditSettlement} from './types';
import type {PendingCustomerCreditRequest} from './customerCreditRequest';
import {initialOnboardingSettings} from './onboardingDraft';
const base={clientId:'client',currency:'CHF',status:'issued',issueDate:'2026-03-01',lines:[{quantity:1,unitPriceCents:10000,vatRateBp:0,discountBp:0}],creditedCents:0,creditSettlements:[]} as unknown as Invoice;
const target={...base,id:'target',type:'standard' as const,number:'FA-1'};
const credit={...base,id:'credit',number:'AV-1',type:'credit_note' as const,customerCredit:{allocatedCents:0,refundedCents:0,remainingCents:5405}};
const data=()=>({onboardingCompleted:true,settings:initialOnboardingSettings,invoices:[structuredClone(target),structuredClone(credit)],payments:[],accounts:[{id:'bank',active:true,accountType:'asset'}],accountingSettings:{enabled:true,bankAccountId:'bank',arAccountId:'ar'}} as unknown as Workspace);
const draft:CustomerSettlementDraft={amount:'10,25',date:'2026-04-01',invoiceId:'target',bankAccountId:'bank',reference:'VIR-1',reason:'Retour'};
const intent:PendingCustomerCreditRequest={input:{requestId:'req',creditNoteId:'credit',eventType:'refund',invoiceId:null,date:draft.date,amountCents:1025,bankAccountId:'bank',reference:draft.reference,reason:draft.reason,expectedReview:{creditAvailableCents:5405,invoiceBalanceCents:null,bankAccountId:'bank',accountingEnabled:true}}};
const refund={id:'event',requestId:'req',creditNoteId:'credit',eventType:'refund',invoiceId:null,date:draft.date,amountCents:1025,bankAccountId:'bank',reference:draft.reference,reason:draft.reason,reversesId:null,journalEntryId:'journal',journalValid:true} as CustomerCreditSettlement;
describe('règlements clients guidés',()=>{
 it('classe les factures récentes du même client et de la même monnaie',()=>{const workspace=data();workspace.invoices.push({...target,id:'recent',issueDate:'2026-04-01'},{...target,id:'other-client',clientId:'another'},{...target,id:'other-currency',currency:'EUR'},{...target,id:'draft',status:'draft'});expect(customerSettlementTargets(credit,workspace).map(row=>row.id)).toEqual(['recent','target']);});
 it('distingue un solde nul d’un solde absent',()=>{expect(customerSettlementAvailable(credit)).toBe(5405);expect(customerSettlementAvailable({...credit,customerCredit:undefined})).toBeNull();expect(customerSettlementAvailable({...credit,customerCredit:{allocatedCents:0,refundedCents:NaN,remainingCents:0}})).toBeNull();});
 it('explique les champs manquants sans arrondir les montants',()=>{
  expect(customerSettlementProblem(credit,undefined,undefined,'apply',draft,data(),'2026-05-01')).toBeNull();
  for(const amount of ['','0','10.251','1e2','54.06','90000000000000.01'])expect(customerSettlementProblem(credit,undefined,undefined,'refund',{...draft,amount},data(),'2026-05-01')?.field).toBe('amount');
  for(const date of ['','2026-02-30','2026-02-28','2026-05-02'])expect(customerSettlementProblem(credit,undefined,undefined,'refund',{...draft,date},data(),'2026-05-01')?.field).toBe('date');
  expect(customerSettlementProblem(credit,undefined,undefined,'apply',{...draft,invoiceId:''},data(),'2026-05-01')?.field).toBe('invoiceId');
  expect(customerSettlementProblem(credit,undefined,undefined,'refund',{...draft,reference:''},data(),'2026-05-01')?.field).toBe('reference');
  expect(customerSettlementProblem(credit,undefined,undefined,'refund',{...draft,reason:'abcd'},data(),'2026-05-01')?.field).toBe('reason');
 });
 it('prend en compte le paiement et la chronologie de la facture cible',()=>{const workspace=data();workspace.payments=[{id:'paid',invoiceId:'target',amountCents:9500,date:'2026-04-02',method:'bank',reference:''}];expect(customerSettlementProblem(credit,undefined,undefined,'apply',draft,workspace,'2026-05-01')?.field).toBe('amount');expect(customerSettlementProblem(credit,undefined,undefined,'apply',{...draft,amount:'5'},workspace,'2026-05-01')?.field).toBe('date');});
 it('conserve le montant initial et refuse les corrections déjà faites ou rapprochées',()=>{
  const current={...credit,creditSettlements:[refund]};expect(customerSettlementProblem(current,refund,refund.id,'refund',{...draft,amount:'invalide',reference:''},data(),'2026-05-01')).toBeNull();
  expect(customerSettlementProblem(current,{...refund,bankMatchId:'match'},refund.id,'refund',draft,data(),'2026-05-01')?.destination).toBe('bank');
  expect(customerSettlementProblem({...current,creditSettlements:[refund,{...refund,id:'reverse',reversesId:refund.id}]},refund,refund.id,'refund',draft,data(),'2026-05-01')?.field).toBe('record');
  expect(customerSettlementProblem(credit,undefined,undefined,'refund',draft,{...data(),accounts:[]},'2026-05-01')?.destination).toBe('accounts');
  expect(customerSettlementNativeProblem('La période est fermée').destination).toBe('periods');
 });
 it('exige le même événement et une preuve comptable valide quand la comptabilité est active',()=>{
  const workspace=data();workspace.invoices[1].creditSettlements=[refund];expect(customerSettlementWasRecorded(workspace,intent)).toBe(true);
  for(const patch of [{requestId:'other'},{amountCents:1026},{reference:'autre'}])expect(customerSettlementWasRecorded(workspace,{input:{...intent.input,...patch}})).toBe(false);
  workspace.invoices[1].creditSettlements=[{...refund,journalEntryId:null,journalValid:false}];expect(customerSettlementWasRecorded(workspace,intent)).toBe(false);
  workspace.accountingSettings!.enabled=false;expect(customerSettlementWasRecorded(workspace,{input:{...intent.input,expectedReview:undefined}})).toBe(true);
  expect(customerSettlementWasRecorded(workspace,intent)).toBe(false);
  expect(()=>customerSettlementWasRecorded({...workspace,invoices:[]},intent)).toThrow();
 });
 it('retrouve une correction par la demande et le règlement d’origine',()=>{const workspace=data();workspace.invoices[1].creditSettlements=[refund,{...refund,id:'reverse',requestId:'reversal',eventType:'reverse_refund',reversesId:refund.id,reason:'Erreur'}];expect(customerSettlementWasRecorded(workspace,{reverseId:refund.id,input:{...intent.input,requestId:'reversal',reason:'Erreur'}})).toBe(true);});
 it('refuse une correction relue avec un montant, une facture ou un compte différent',()=>{
  const workspace=data(),reversal={...refund,id:'reverse',requestId:'reversal',eventType:'reverse_refund' as const,reversesId:refund.id,reason:'Erreur'};
  const pending={reverseId:refund.id,input:{...intent.input,requestId:'reversal',reason:'Erreur'}};
  for(const patch of [{amountCents:1026},{invoiceId:'other'},{bankAccountId:'other'},{reference:'AUTRE'}]){workspace.invoices[1].creditSettlements=[refund,{...reversal,...patch}];expect(customerSettlementWasRecorded(workspace,pending)).toBe(false);}
  workspace.invoices[1].creditSettlements=[reversal];expect(customerSettlementWasRecorded(workspace,pending)).toBe(false);
  workspace.invoices[1].creditSettlements=[{...refund,amountCents:99},reversal];expect(customerSettlementWasRecorded(workspace,pending)).toBe(false);
 });
 it('lie le contexte de reprise aux arguments réellement envoyés pour une correction',()=>{
  const input={requestId:'new',settlementId:refund.id,date:draft.date,reason:'Erreur',context:{reverseId:refund.id,input:{...intent.input,requestId:'new',reason:'Erreur'}}};
  expect(()=>requireCustomerSettlementReverseContext(input)).not.toThrow();
  for(const patch of [{requestId:'autre'},{settlementId:'autre'},{date:'2026-04-02'},{reason:'Autre motif'}])expect(()=>requireCustomerSettlementReverseContext({...input,...patch})).toThrow('correction');
  expect(()=>requireCustomerSettlementReverseContext({...input,context:undefined})).not.toThrow();
 });
 it('une reprise ne réémet pas la commande',async()=>{const write=vi.fn(async()=>({}));const failure=await runCustomerSettlementMutation(intent,write,async()=>data()).catch(e=>e);expect(failure).toBeInstanceOf(CustomerSettlementRefreshError);expect(()=>failure.validateRead(data())).toThrow();expect(write).toHaveBeenCalledTimes(1);const lost=await runCustomerSettlementMutation(intent,async()=>{throw Error('Perdue');},async()=>data()).catch(e=>e);expect(lost).toBeInstanceOf(CustomerSettlementOutcomeUnknownError);expect(lost.wasRecorded(data())).toBe(false);});
});
