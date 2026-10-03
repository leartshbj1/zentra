import {afterEach,describe,expect,it,vi} from 'vitest';
const invokeMock=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({Channel:class {},invoke:invokeMock}));
import {desktopApi} from './bridge';
import {WorkspaceRefreshAfterMutationError} from './workspaceMutation';
import type {CustomerCreditRecoveryInput} from './customerCreditRecoveryState';
const scope='synthetic-scope-a';
const input:CustomerCreditRecoveryInput={requestId:'12211111-1111-4111-8111-111111111111',originalInvoiceId:'11111111-1111-4111-8111-111111111111',sourceToken:'a'.repeat(64),reference:'Accord client',reason:'Déduction confirmée',noPriorRefund:true,confirmVatReconciliation:true,credits:[{creditNoteId:'22222222-2222-4222-8222-222222222222',appliedCents:2703,applicationDate:'2026-03-15'}]};
const nativeInput={request_id:input.requestId,original_invoice_id:input.originalInvoiceId,source_token:input.sourceToken,reference:input.reference,reason:input.reason,no_prior_refund:true,confirm_vat_reconciliation:true,credits:[{credit_note_id:input.credits[0].creditNoteId,applied_cents:2703,application_date:'2026-03-15'}]};
const commands=['get_customer_credit_recovery','preview_customer_credit_recovery','adopt_customer_credit_recovery'] as const;
function call(command:typeof commands[number],expectedWorkspaceScope?:string){
  if(command==='get_customer_credit_recovery')return desktopApi.getCustomerCreditRecovery(input.originalInvoiceId,expectedWorkspaceScope);
  if(command==='preview_customer_credit_recovery')return desktopApi.previewCustomerCreditRecovery(input,expectedWorkspaceScope);
  return desktopApi.adoptCustomerCreditRecovery(input,expectedWorkspaceScope);
}
function args(command:typeof commands[number]){return command==='get_customer_credit_recovery'?{originalInvoiceId:input.originalInvoiceId}:{input:nativeInput};}
function answer(command:string){
  if(command==='get_app_state')return {onboarding_completed:true};
  if(command==='get_workspace')return {work_notes_scope:scope};
  return {source_token:input.sourceToken,original_invoice_id:input.originalInvoiceId,number:'FAC-1',currency:'CHF',invoice_total_cents:8107,invoice_remaining_cents:8107,paid_cents:0,blocker:null,credits:[]};
}
afterEach(()=>invokeMock.mockReset());
describe('customer recovery SDK top-level workspace scope and post-ACK reads',()=>{
  for(const command of commands){
    it(command+' transmits the explicit origin without changing native input or arity',async()=>{
      invokeMock.mockImplementation(async(command:string)=>answer(command));const before=structuredClone(input);
      await call(command,scope);
      expect(invokeMock.mock.calls[0]).toEqual([command,{...args(command),expectedWorkspaceScope:scope}]);
      expect(input).toEqual(before);
      if(command==='adopt_customer_credit_recovery')expect(invokeMock.mock.calls.map(x=>x[0])).toEqual([command,'get_app_state','get_workspace']);
      else expect(invokeMock).toHaveBeenCalledTimes(1);
    });
    it(command+' keeps the None legacy SDK contract without an undefined property',async()=>{
      invokeMock.mockImplementation(async(command:string)=>answer(command));await call(command);
      expect(invokeMock.mock.calls[0]).toEqual([command,args(command)]);
      expect(Object.hasOwn(invokeMock.mock.calls[0][1],'expectedWorkspaceScope')).toBe(false);
    });
    it(command+' preserves a refused native command and starts no workspace read',async()=>{
      const refusal=new Error('Synthetic native refusal');invokeMock.mockRejectedValue(refusal);
      await expect(call(command,scope)).rejects.toBe(refusal);
      expect(invokeMock.mock.calls).toEqual([[command,{...args(command),expectedWorkspaceScope:scope}]]);
    });
  }
  it('keeps one confirmed adopt when the subsequent read refuses, preserving its cause',async()=>{
    const refusal=new Error('Synthetic GET refusal');
    invokeMock.mockImplementation(async(command:string)=>{if(command==='get_workspace')throw refusal;return answer(command);});
    const error=await desktopApi.adoptCustomerCreditRecovery(input,scope).catch(reason=>reason);
    expect(error).toBeInstanceOf(WorkspaceRefreshAfterMutationError);expect(error.refreshCause).toBe(refusal);
    expect(invokeMock.mock.calls.map(x=>x[0])).toEqual(['adopt_customer_credit_recovery','get_app_state','get_workspace']);
    expect(invokeMock.mock.calls[0]).toEqual(['adopt_customer_credit_recovery',{input:nativeInput,expectedWorkspaceScope:scope}]);
  });
  it('refuses a foreign post-ACK workspace and never resubmits the confirmed request',async()=>{
    invokeMock.mockImplementation(async(command:string)=>command==='get_workspace'?{work_notes_scope:'synthetic-scope-c'}:answer(command));
    const error=await desktopApi.adoptCustomerCreditRecovery(input,scope).catch(reason=>reason);
    expect(error).toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect(error.refreshCause).toBeInstanceOf(Error);
    expect(error.refreshCause.message).toBe('L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.');
    expect(invokeMock.mock.calls.map(x=>x[0])).toEqual(['adopt_customer_credit_recovery','get_app_state','get_workspace']);
    expect(input.requestId).toBe('12211111-1111-4111-8111-111111111111');
  });
});
