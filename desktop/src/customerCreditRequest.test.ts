import {afterEach,describe,expect,it,vi} from 'vitest';
import {clearCustomerCreditRequest,readCustomerCreditRequest,saveCustomerCreditRequest} from './customerCreditRequest';
afterEach(()=>vi.unstubAllGlobals());
function storage(){const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)});return values;}
const request={input:{requestId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',creditNoteId:'credit-1',eventType:'refund' as const,invoiceId:null,bankAccountId:'bank',date:'2026-04-01',amountCents:2703,reference:'BANK-1',reason:'Retour de marchandises'}};
describe('pending customer credit operations',()=>{
  it('retains exact cents and request identity across closing the dossier, then clears after success',()=>{
    storage();saveCustomerCreditRequest(request);expect(readCustomerCreditRequest('credit-1')).toEqual(request);expect(readCustomerCreditRequest('another-credit')).toBeUndefined();clearCustomerCreditRequest('credit-1');expect(readCustomerCreditRequest('credit-1')).toBeUndefined();
  });
  it('does not turn invalid stored data into a financial command',()=>{
    const values=storage();const key='zentra.customer-credit-request.v1.credit-1';
    for(const value of ['{',JSON.stringify({...request,input:{...request.input,creditNoteId:'another-credit'}}),JSON.stringify({...request,input:{...request.input,amountCents:1.01}})]){values.set(key,value);expect(readCustomerCreditRequest('credit-1')).toBeUndefined();}
  });
  it('keeps consultation available when browser storage is unavailable and refuses an unsafe save',()=>{
    vi.stubGlobal('localStorage',{getItem(){throw new Error('storage unavailable')},setItem(){throw new Error('storage unavailable')},removeItem(){throw new Error('storage unavailable')}});
    expect(readCustomerCreditRequest('credit-1')).toBeUndefined();expect(()=>saveCustomerCreditRequest(request)).toThrow('storage unavailable');expect(()=>clearCustomerCreditRequest('credit-1')).not.toThrow();
  });
});
