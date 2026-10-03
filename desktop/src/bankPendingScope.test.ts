import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const invokeMock=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:invokeMock}));
import {desktopApi} from './bridge';
import {runBankCustomerRequest,sameBankCustomerOrigin} from './bankCustomerRefundRequests';
const origin={companyId:'company-A',organizationId:'organization-A',memberId:'member-A'};
describe('pending bank customer scope admission',()=>{
 beforeEach(()=>{invokeMock.mockReset();invokeMock.mockResolvedValue({});});
 afterEach(()=>vi.unstubAllGlobals());
 const operations=[
  {name:'match',command:'match_bank_customer_credit_refund',input:{request_id:'same-request',movement_id:'same-movement',refund_id:'same-refund',date_difference_reason:'Date vérifiée'},run:(scope?:string)=>desktopApi.matchBankCustomerCreditRefund('same-request','same-movement','same-refund','Date vérifiée',scope)},
  {name:'unlink',command:'unmatch_bank_customer_credit_refund',input:{request_id:'same-request',match_id:'same-match',reason:'Autre association'},run:(scope?:string)=>desktopApi.unmatchBankCustomerCreditRefund('same-request','same-match','Autre association',scope)},
 ];
 for(const operation of operations){
  it(operation.name+' keeps the None payload and void result exactly',async()=>{expect(await operation.run()).toBeUndefined();expect(invokeMock).toHaveBeenCalledExactlyOnceWith(operation.command,{input:operation.input});});
  it(operation.name+' sends only a top-level origin with the same immutable input',async()=>{expect(await operation.run('company-A')).toBeUndefined();expect(invokeMock).toHaveBeenCalledExactlyOnceWith(operation.command,{expectedWorkspaceScope:'company-A',input:operation.input});});
  it(operation.name+' keeps the original rejection and never reads/replays',async()=>{const original=new Error('Synthetic original refusal');invokeMock.mockRejectedValue(original);await expect(operation.run('company-A')).rejects.toBe(original);expect(invokeMock).toHaveBeenCalledTimes(1);});
 }
 const request={kind:'match' as const,requestId:'same-request',movementId:'same-movement',refundId:'same-refund',description:'Private synthetic description',amountCents:1000,currency:'CHF',date:'2026-09-05'};
 it('rejects an ownerless retained request before IndexedDB or native admission',async()=>{const open=vi.fn(()=>{throw new Error('Storage must not be touched');});vi.stubGlobal('indexedDB',{open});await expect(runBankCustomerRequest(request,'company-A')).rejects.toThrow(/identité.*vérifiée/i);expect(open).not.toHaveBeenCalled();expect(invokeMock).not.toHaveBeenCalled();});
 it('rejects a supplied scope that differs from the retained origin before storage',async()=>{const open=vi.fn(()=>{throw new Error('Storage must not be touched');});vi.stubGlobal('indexedDB',{open});await expect(runBankCustomerRequest(request,'company-C',undefined,origin)).rejects.toThrow(/entreprise ouverte a changé/);expect(open).not.toHaveBeenCalled();expect(invokeMock).not.toHaveBeenCalled();});
 it('keeps cancellation before retention and financial admission',async()=>{const controller=new AbortController();controller.abort();const open=vi.fn();vi.stubGlobal('indexedDB',{open});await expect(runBankCustomerRequest(request,'company-A',controller.signal,origin)).rejects.toMatchObject({name:'AbortError'});expect(open).not.toHaveBeenCalled();expect(invokeMock).not.toHaveBeenCalled();});
 it('separates organization/member/physical company despite identical movement identifiers',()=>{expect(sameBankCustomerOrigin(origin,{...origin})).toBe(true);expect(sameBankCustomerOrigin(origin,{...origin,companyId:'company-C'})).toBe(false);expect(sameBankCustomerOrigin(origin,{...origin,organizationId:'organization-C'})).toBe(false);expect(sameBankCustomerOrigin(origin,{...origin,memberId:'member-C'})).toBe(false);expect(sameBankCustomerOrigin(null,origin)).toBe(false);});
});
