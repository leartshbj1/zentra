import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke }));
import { desktopApi } from './bridge';
import { creditAllocationProblem, creditAmount, creditAmountInput, creditBalances, creditAllocationWasRecorded, CreditAllocationOutcomeUnknownError, CreditAllocationRefreshError, eligibleCreditInvoices, runCreditAllocationMutation, type CreditAllocationIntent } from './creditAllocationWorkflow';
import { initialOnboardingSettings } from './onboardingDraft';
import type { SupplierCreditNote, SupplierInvoice, Workspace } from './types';
const credit = { id:'credit', supplierId:'supplier', currency:'CHF', status:'validated', documentDate:'2026-05-01', totalCents:5405, allocatedCents:1000, refundedCents:500, allocations:[] } as unknown as SupplierCreditNote;
const invoice = { id:'invoice', supplierId:'supplier', currency:'CHF', documentStatus:'validated', documentDate:'2026-05-02', balanceCents:2000 } as SupplierInvoice;
const draft = { amount:'10,25', date:'2026-05-03', reason:'Erreur', reverse:false };
const intent: CreditAllocationIntent = {kind:'apply',requestId:'request',creditId:'credit',invoiceId:'invoice',amountCents:1025,date:'2026-05-03'};
const data = () => ({onboardingCompleted:true,settings:initialOnboardingSettings,supplierInvoices:[invoice],supplierCreditNotes:[{...credit,allocations:[{id:'apply',eventType:'apply',requestId:'request',supplierCreditNoteId:'credit',supplierInvoiceId:'invoice',amountCents:1025,effectiveDate:'2026-05-03',reason:''}]}]}) as Workspace;
afterEach(() => invoke.mockReset());
describe('utilisation guidée des avoirs', () => {
  it.each(['','-1','0','1.001','2e2','1,2.3','NaN','90071992547409.92'])('refuse la saisie sans arrondir : %s', value => expect(creditAmount(value)).toBeNull());
  it('conserve chaque centime même aux limites exactes et accepte la virgule', () => {
    expect(creditAmount('10,25')).toBe(1025); expect(creditAmount('1.1')).toBe(110);
    expect(creditAmount('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
    expect(creditAmountInput(Number.MAX_SAFE_INTEGER)).toBe('90071992547409.91');
    expect(creditAmountInput(NaN)).toBe('');
  });
  it('utilise les remboursements et refuse les soldes illisibles', () => {
    expect(creditBalances(credit, invoice)).toEqual({creditAvailableCents:3905,invoiceBalanceCents:2000});
    expect(creditBalances({...credit,refundedCents:NaN},invoice)).toBeNull();
    expect(creditBalances({...credit,refundedCents:6000},invoice)).toBeNull();
  });
  it('propose uniquement les factures du même fournisseur et de la même monnaie, récentes d’abord', () => {
    expect(eligibleCreditInvoices(credit,[invoice,{...invoice,id:'new',documentDate:'2026-06-01'},{...invoice,id:'paid',balanceCents:0},{...invoice,id:'draft',documentStatus:'draft'},{...invoice,id:'eur',currency:'EUR' as 'CHF'},{...invoice,id:'other',supplierId:'other'}]).map(row=>row.id)).toEqual(['new','invoice']);
  });
  it('localise les dépassements, dates et documents invalides sans modifier la saisie', () => {
    expect(creditAllocationProblem(credit,invoice,undefined,draft,'2026-06-01')).toBeNull();
    for (const amount of ['','20.001','20.01','40']) expect(creditAllocationProblem(credit,invoice,undefined,{...draft,amount},'2026-06-01')?.field).toBe('amount');
    for (const date of ['','2026-02-30','2026-05-01','2026-06-02']) expect(creditAllocationProblem(credit,invoice,undefined,{...draft,date},'2026-06-01')?.field).toBe('date');
    expect(creditAllocationProblem(undefined,invoice,undefined,draft,'2026-06-01')?.field).toBe('record');
    expect(creditAllocationProblem(credit,{...invoice,supplierId:'other'},undefined,draft,'2026-06-01')?.field).toBe('invoice');
  });
  it('permet un motif bref et refuse une annulation répétée ou trop ancienne', () => {
    const source=data().supplierCreditNotes[0], allocation=source.allocations[0];
    expect(creditAllocationProblem(source,invoice,allocation,{...draft,reverse:true},'2026-06-01')).toBeNull();
    expect(creditAllocationProblem(source,invoice,allocation,{...draft,reverse:true,reason:''},'2026-06-01')?.field).toBe('reason');
    expect(creditAllocationProblem(source,invoice,allocation,{...draft,reverse:true,reason:'x'.repeat(501)},'2026-06-01')?.field).toBe('reason');
    expect(creditAllocationProblem({...source,allocations:[...source.allocations,{...allocation,id:'reverse',eventType:'reverse',reversesAllocationId:'apply'}]},invoice,allocation,{...draft,reverse:true},'2026-06-01')?.field).toBe('record');
  });
  it('exige la preuve de la même demande même après annulation ou changement de solde', () => {
    expect(creditAllocationWasRecorded(data(),intent)).toBe(true);
    expect(creditAllocationWasRecorded(data(),{...intent,requestId:'other'})).toBe(false);
    expect(creditAllocationWasRecorded(data(),{...intent,amountCents:1024})).toBe(false);
    expect(creditAllocationWasRecorded({...data(),supplierInvoices:[]},intent)).toBe(false);
    const workspace=data();workspace.supplierInvoices[0]={...invoice,balanceCents:0};
    const allocation={...workspace.supplierCreditNotes[0].allocations[0],id:'reverse',eventType:'reverse' as const,reversesAllocationId:'apply',requestId:'reversal',reason:'Erreur'};
    workspace.supplierCreditNotes[0].allocations.push(allocation);
    expect(creditAllocationWasRecorded(workspace,intent)).toBe(true);
    expect(creditAllocationWasRecorded(workspace,{kind:'reverse',requestId:'reversal',allocationId:'apply',date:'2026-05-03',reason:' Erreur '})).toBe(true);
    expect(()=>creditAllocationWasRecorded({...workspace,onboardingCompleted:false},intent)).toThrow();
  });
  it('une reprise ne réémet pas l’écriture et une ligne manquante ne confirme pas la lecture', async () => {
    const write=vi.fn(async()=>({}));const load=vi.fn(async()=>({...data(),supplierCreditNotes:[]}));
    const failure=await runCreditAllocationMutation(intent,write,load).catch(e=>e);
    expect(failure).toBeInstanceOf(CreditAllocationRefreshError);expect(()=>failure.validateRead(data())).not.toThrow();
    expect(()=>failure.validateRead({...data(),supplierCreditNotes:[]})).toThrow();expect(write).toHaveBeenCalledTimes(1);
    const lost=await runCreditAllocationMutation(intent,async()=>{throw Error('Lost');},load).catch(e=>e);
    expect(lost).toBeInstanceOf(CreditAllocationOutcomeUnknownError);expect(lost.wasRecorded(data())).toBe(true);
  });
  it('transmet les soldes attendus hors du contenu historique de la demande', async () => {
    invoke.mockRejectedValue(Error('Refus'));
    const balances={creditAvailableCents:3905,invoiceBalanceCents:2000};
    const apply=await desktopApi.applySupplierCredit('request','credit','invoice',1025,'2026-05-03',balances).catch(e=>e);
    expect(apply).toBeInstanceOf(CreditAllocationOutcomeUnknownError);
    expect(invoke.mock.calls[0]).toEqual(['apply_supplier_credit',{input:{request_id:'request',supplier_credit_note_id:'credit',supplier_invoice_id:'invoice',amount_cents:1025,effective_date:'2026-05-03'},expectedBalances:balances}]);
    await desktopApi.reverseSupplierCreditAllocation('reversal','apply',' Erreur ','2026-05-03',balances).catch(()=>{});
    expect(invoke.mock.calls[1][1]).toEqual({input:{request_id:'reversal',supplier_credit_allocation_id:'apply',reason:'Erreur',effective_date:'2026-05-03'},expectedBalances:balances});
  });
});
