import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const transport=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:transport.invoke}));
import {desktopApi} from './bridge';
import {CustomerSettlementOutcomeUnknownError,CustomerSettlementRefreshError} from './customerSettlementWorkflow';
import {WorkspaceRefreshAfterMutationError} from './workspaceMutation';

// Real bridge/diagnostics/fileBase64/receipt verification. The native transport
// and FileReader timing are synthetic; native scope enforcement is not executed.
const scope='synthetic-company-a',reason=new Error('Synthetic native refusal');
const input={requestId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',creditNoteId:'credit',eventType:'refund' as const,invoiceId:null,bankAccountId:'bank',date:'2026-04-01',amountCents:2703,reference:' BANK-1 ',reason:' Retour de marchandises ',expectedReview:{creditAvailableCents:5405,invoiceBalanceCents:null,bankAccountId:'bank',accountingEnabled:true}};
const expense={requestId:input.requestId,expenseId:'expense',creditDate:'2026-04-01',paymentDate:'2026-04-02',reference:'BANK-1',reason:'Retour de marchandises',netCents:2500,vatCents:203,reversesId:null};
const originEvent={id:'settlement-original',request_id:'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',credit_note_id:'credit',invoice_id:null,event_type:'refund',date:'2026-03-31',amount_cents:2703,bank_account_id:'bank',reference:'BANK-1',reason:'Retour initial',journal_entry_id:'journal-original',journal_valid:true};
const event={...originEvent,id:'settlement-current',request_id:input.requestId,date:input.date,reason:input.reason.trim(),journal_entry_id:'journal-current'};
const raw=(workspaceScope:string,events:typeof event[]=[])=>({schema_version:43,work_notes_scope:workspaceScope,settings:{company_name:'Synthetic company'},invoices:[{id:'credit',type:'avoir',status:'emise',currency:'CHF'}],customer_credit_settlements:events});
const nativeRecord={request_id:input.requestId,credit_note_id:'credit',event_type:'refund',invoice_id:null,date:input.date,amount_cents:2703,bank_account_id:'bank',reference:'BANK-1',reason:'Retour de marchandises'};
const calls=(command:string)=>transport.invoke.mock.calls.filter(([name])=>name===command);
beforeEach(()=>{transport.invoke.mockReset();});afterEach(()=>vi.unstubAllGlobals());
function readAfterAck(workspaceScope=scope,events=[event]){transport.invoke.mockImplementation(async command=>command==='get_app_state'?{onboarding_completed:true}:command==='get_workspace'?raw(workspaceScope,events):{});}

describe('payment form scope through the real native bridge',()=>{
 it.each([scope,undefined])('preserves customer request/review and legacy omitted scope, scope=%s',async expected=>{
  transport.invoke.mockRejectedValue(reason);const failure=await desktopApi.recordCustomerCreditSettlement(input,expected).catch(cause=>cause);expect(failure).toBeInstanceOf(CustomerSettlementOutcomeUnknownError);expect(failure.mutationCause).toBe(reason);expect(failure.intent.input).toBe(input);expect(transport.invoke).toHaveBeenCalledExactlyOnceWith('record_customer_credit_settlement',{...(expected===undefined?{}:{expectedWorkspaceScope:expected}),input:nativeRecord,expectedReview:input.expectedReview});
 });
 it.each([scope,undefined])('preserves reversal identity, review and omitted scope, scope=%s',async expected=>{
  const pending={input,reverseId:'settlement-original'};transport.invoke.mockRejectedValue(reason);const failure=await desktopApi.reverseCustomerCreditSettlement({requestId:input.requestId,settlementId:pending.reverseId,date:input.date,reason:input.reason,context:pending},expected).catch(cause=>cause);expect(failure).toBeInstanceOf(CustomerSettlementOutcomeUnknownError);expect(failure.mutationCause).toBe(reason);expect(transport.invoke).toHaveBeenCalledExactlyOnceWith('reverse_customer_credit_settlement',{...(expected===undefined?{}:{expectedWorkspaceScope:expected}),input:{request_id:input.requestId,settlement_id:pending.reverseId,date:input.date,reason:input.reason.trim()},expectedReview:input.expectedReview});
 });
 it.each([scope,undefined])('preserves expense cents and original rejection without extra refresh or retry, scope=%s',async expected=>{
  transport.invoke.mockRejectedValue(reason);await expect(desktopApi.recordExpenseRefund(expense,expected)).rejects.toBe(reason);expect(transport.invoke).toHaveBeenCalledExactlyOnceWith('record_expense_refund',{...(expected===undefined?{}:{expectedWorkspaceScope:expected}),input:{request_id:expense.requestId,expense_id:'expense',credit_date:expense.creditDate,payment_date:expense.paymentDate,reference:expense.reference,reason:expense.reason,net_cents:2500,vat_cents:203,reverses_id:null}});
 });
 it('rejects changed reversal context before any transport call',async()=>{
  await expect(desktopApi.reverseCustomerCreditSettlement({requestId:input.requestId,settlementId:'other',date:input.date,reason:input.reason,context:{input,reverseId:'settlement-original'}},scope)).rejects.toThrow('ne correspond plus');expect(transport.invoke).not.toHaveBeenCalled();
 });
 it('keeps a same-scope customer acknowledgement and exact cents with only one subsequent workspace read',async()=>{
  readAfterAck();const workspace=await desktopApi.recordCustomerCreditSettlement(input,scope);expect(workspace.workNotesScope).toBe(scope);expect(workspace.invoices[0].creditSettlements?.[0].amountCents).toBe(2703);expect(calls('record_customer_credit_settlement')).toHaveLength(1);expect(calls('get_app_state')).toHaveLength(1);expect(calls('get_workspace')).toHaveLength(1);
 });
 it('does not replace a customer acknowledgement with another company workspace or retry its write',async()=>{
  readAfterAck('synthetic-company-c');const failure=await desktopApi.recordCustomerCreditSettlement(input,scope).catch(cause=>cause);expect(failure).toBeInstanceOf(CustomerSettlementRefreshError);expect(failure.refreshCause.message).toContain('entreprise ouverte a changé');expect(calls('record_customer_credit_settlement')).toHaveLength(1);expect(calls('get_workspace')).toHaveLength(1);
 });
 it('does not replace an expense acknowledgement with another company workspace',async()=>{
  readAfterAck('synthetic-company-c');const failure=await desktopApi.recordExpenseRefund(expense,scope).catch(cause=>cause);expect(failure).toBeInstanceOf(WorkspaceRefreshAfterMutationError);expect(failure.refreshCause.message).toContain('entreprise ouverte a changé');expect(calls('record_expense_refund')).toHaveLength(1);expect(calls('get_workspace')).toHaveLength(1);
 });
 it('refuses an already aborted receipt before creating its FileReader or invoking the native command',async()=>{
  const reader=vi.fn();vi.stubGlobal('FileReader',reader);const controller=new AbortController();controller.abort();await expect(desktopApi.recordExpenseRefund({...expense,receipt:new File(['synthetic'],'receipt.pdf',{type:'application/pdf'})},scope,controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(reader).not.toHaveBeenCalled();expect(transport.invoke).not.toHaveBeenCalled();
 });
 it('aborts a held real fileBase64 read without admitting its refund even if the old reader later finishes',async()=>{
  let reader!:any;vi.stubGlobal('FileReader',class{result:string|null=null;onload:(()=>void)|null=null;onerror:(()=>void)|null=null;onabort:(()=>void)|null=null;constructor(){reader=this;}readAsDataURL(){}abort(){this.onabort?.();}});const controller=new AbortController();const pending=desktopApi.recordExpenseRefund({...expense,receipt:new File(['synthetic'],'receipt.pdf',{type:'application/pdf'})},scope,controller.signal);const rejection=expect(pending).rejects.toMatchObject({name:'AbortError'});controller.abort();reader.result='data:application/pdf;base64,U1lOVEhFVElD';reader.onload?.();await rejection;expect(transport.invoke).not.toHaveBeenCalled();
 });
 it('checks abortion again after a completed FileReader before admitting a native write',async()=>{
  const controller=new AbortController();vi.stubGlobal('FileReader',class{result='data:application/pdf;base64,U1lOVEhFVElD';onload:(()=>void)|null=null;readAsDataURL(){this.onload?.();controller.abort();}abort(){}});await expect(desktopApi.recordExpenseRefund({...expense,receipt:new File(['synthetic'],'receipt.pdf',{type:'application/pdf'})},scope,controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(transport.invoke).not.toHaveBeenCalled();
 });
});
