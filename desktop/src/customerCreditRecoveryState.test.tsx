import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
const invokeMock=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({Channel:class {},invoke:invokeMock}));
import { desktopApi } from './bridge';
import { CustomerCreditRecovery } from './CustomerCreditRecovery';
import { clearCreditRecovery,readCreditRecovery,saveCreditRecovery } from './customerCreditRecoveryState';
import type { PendingCreditRecovery } from './customerCreditRecoveryState';
const pending:PendingCreditRecovery={input:{requestId:'12211111-1111-4111-8111-111111111111',originalInvoiceId:'invoice',sourceToken:'a'.repeat(64),reference:'Accord client',reason:'Déduction confirmée',noPriorRefund:true,credits:[{creditNoteId:'credit',appliedCents:2703,applicationDate:'2026-03-15'}]},preview:{originalInvoiceId:'invoice',number:'FAC-1',currency:'CHF',invoiceRemainingCents:8107,credits:[{creditNoteId:'credit',number:'AVO-1',allocatedCents:2703,remainingCents:2702}]}};
function storage(){const map=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>map.set(key,value),removeItem:(key:string)=>map.delete(key)});return map;}
afterEach(()=>{invokeMock.mockReset();vi.unstubAllGlobals();});
describe('reprise documentée des avoirs',()=>{
  it('conserve la protection des pièces originales dans le journal',async()=>{
    invokeMock.mockResolvedValue({entries:[{id:'j1',source_type:'invoice',customer_recovery_protected:1}],lines:[],currency:'CHF'});
    const journal=await desktopApi.getJournal({});expect(journal.entries[0].customerRecoveryProtected).toBe(true);
  });
  it('conserve les corrections reçues et exige leur confirmation pour reprendre une demande',()=>{
    storage();const received={...pending,input:{...pending.input,confirmVatReconciliation:true},preview:{...pending.preview,receivedVat:true,vatAdjustments:[{sourceType:'payment',sourceId:'p1',date:'2026-04-01',reference:'Encaissement',expectedVatCents:224,dueChangeCents:-1}]}};
    saveCreditRecovery(received);expect(readCreditRecovery('invoice')).toEqual(received);
    const html=renderToStaticMarkup(<CustomerCreditRecovery originalInvoiceId="invoice" busy={false} readOnly act={vi.fn()}/>);
    expect(html).toContain('TVA sur encaissements');expect(html).toContain('checked');expect(html).toContain('décompte rectificatif');expect(html).toContain('Encaissement');
    saveCreditRecovery({...received,input:{...received.input,confirmVatReconciliation:false}});expect(readCreditRecovery('invoice')).toBeUndefined();
  });
  it('transmet la confirmation TVA et conserve le détail des écarts signés',async()=>{
    invokeMock.mockResolvedValue({original_invoice_id:'invoice',received_vat:true,vat_adjustments:[{source_type:'payment',source_id:'p1',date:'2026-04-01',reference:'Encaissement',expected_vat_cents:224,due_change_cents:-1}],credits:[]});
    const result=await desktopApi.previewCustomerCreditRecovery({...pending.input,confirmVatReconciliation:true});
    expect(result.receivedVat).toBe(true);expect(result.vatAdjustments?.[0].dueChangeCents).toBe(-1);
    expect(invokeMock.mock.calls[0][1].input.confirm_vat_reconciliation).toBe(true);
  });
  it('permet de consulter les corrections après la reprise du dossier',async()=>{
    invokeMock.mockImplementation(async(command:string)=>command==='get_app_state'?{onboarding_completed:true}:{invoices:[{id:'credit',type:'avoir',original_invoice_id:'invoice'}],customer_credit_recoveries:[{request_json:JSON.stringify({reference:'Accord',reason:'TVA rapprochée',credits:[{credit_note_id:'credit'}]}),result_json:JSON.stringify({received_vat:true,vat_adjustments:[{date:'2026-04-01',reference:'Encaissement',due_change_cents:-1}]})}]});
    const workspace=await desktopApi.loadWorkspace();expect(workspace.invoices[0].creditRecovery?.vatAdjustments).toEqual([{date:'2026-04-01',reference:'Encaissement',dueChangeCents:-1}]);
  });
  it('rattache la preuve aux seuls avoirs concernés et tolère une note illisible',async()=>{
    invokeMock.mockImplementation(async(command:string)=>command==='get_app_state'?{onboarding_completed:true}:{invoices:[{id:'credit',type:'avoir',original_invoice_id:'invoice'},{id:'other',type:'avoir'}],customer_credit_recoveries:[{request_json:'{'},{created_at:'2026-09-06T10:00:00Z',request_json:JSON.stringify({reference:'Accord client',reason:'Déduction confirmée',credits:[{credit_note_id:'credit'}]})}]});
    const workspace=await desktopApi.loadWorkspace();
    expect(workspace.invoices.find(i=>i.id==='credit')?.creditRecovery).toEqual({recordedAt:'2026-09-06T10:00:00Z',reference:'Accord client',reason:'Déduction confirmée'});
    expect(workspace.invoices.find(i=>i.id==='other')?.creditRecovery).toBeUndefined();
  });
  it('conserve le blocage natif, les montants et les dates minimales sans proposer une date devinée',async()=>{
    invokeMock.mockResolvedValue({source_token:'proof',original_invoice_id:'invoice',number:'FAC-1',currency:'CHF',invoice_total_cents:10810,paid_cents:1000,blocker:'TVA à rapprocher',credits:[{id:'credit',number:'AVO-1',total_cents:5405,issue_date:'2026-03-01',earliest_application_date:'2026-03-10'}]});
    const plan=await desktopApi.getCustomerCreditRecovery('invoice');
    expect(plan.blocker).toBe('TVA à rapprocher');expect(plan.credits[0].earliestApplicationDate).toBe('2026-03-10');expect(plan.invoiceTotalCents).toBe(10810);
    expect(invokeMock).toHaveBeenCalledWith('get_customer_credit_recovery',{originalInvoiceId:'invoice'});
  });
  it('transmet les faits et le jeton de source inchangés à la simulation',async()=>{
    invokeMock.mockResolvedValue({original_invoice_id:'invoice',number:'FAC-1',currency:'CHF',invoice_remaining_cents:8107,credits:[{credit_note_id:'credit',number:'AVO-1',allocated_cents:2703,remaining_cents:2702}]});
    expect(await desktopApi.previewCustomerCreditRecovery(pending.input)).toEqual(pending.preview);
    expect(invokeMock).toHaveBeenCalledWith('preview_customer_credit_recovery',{input:{request_id:pending.input.requestId,original_invoice_id:'invoice',source_token:'a'.repeat(64),reference:'Accord client',reason:'Déduction confirmée',no_prior_refund:true,credits:[{credit_note_id:'credit',applied_cents:2703,application_date:'2026-03-15'}]}});
  });
  it('retrouve une demande interrompue après réouverture sans nouvelle identité',()=>{
    storage();saveCreditRecovery(pending);expect(readCreditRecovery('invoice')).toEqual(pending);expect(readCreditRecovery('another')).toBeUndefined();
    const html=renderToStaticMarkup(<CustomerCreditRecovery originalInvoiceId="invoice" busy={false} readOnly act={vi.fn()}/>);
    expect(html).toContain('Vérifier la même reprise');expect(html).toContain('Accord client');expect(html).not.toContain('>Modifier<');expect(html).toContain('disabled');
    clearCreditRecovery('invoice');expect(readCreditRecovery('invoice')).toBeUndefined();
  });
  it('ignore une sauvegarde partielle ou des montants non entiers',()=>{
    const map=storage();saveCreditRecovery(pending);const key=Array.from(map.keys())[0];
    map.set(key,JSON.stringify({...pending,input:{...pending.input,credits:[{...pending.input.credits[0],appliedCents:1.5}]}}));expect(readCreditRecovery('invoice')).toBeUndefined();
    map.set(key,'{');expect(readCreditRecovery('invoice')).toBeUndefined();
  });
});
