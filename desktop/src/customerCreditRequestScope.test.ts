import {afterEach,describe,expect,it,vi} from 'vitest';
import {clearCustomerCreditRequest,customerCreditRequestScopeKey,readCustomerCreditRequest,saveCustomerCreditRequest,legacyCustomerCreditReviewRequired,legacyCustomerCreditReviewToken,acknowledgeLegacyCustomerCreditOtherCompany,adoptLegacyCustomerCreditRequest,completeLegacyCustomerCreditRequest} from './customerCreditRequest';

afterEach(()=>vi.unstubAllGlobals());
function storage(){const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)});return values;}
const origin={companyId:'company-a',organizationId:'org-a',memberId:'member-a'};
const request={input:{requestId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',creditNoteId:'shared-credit',eventType:'refund' as const,invoiceId:null,bankAccountId:'bank',date:'2026-04-01',amountCents:2703,reference:'BANK-1',reason:'Retour de marchandises',expectedReview:{creditAvailableCents:5405,invoiceBalanceCents:null,bankAccountId:'bank',accountingEnabled:true}},reverseId:'settlement-original'};

describe('customer credit receipts belong to their verified company and member',()=>{
  it('restores the same exact reviewed request and reversal identity, without creating another UUID',()=>{
    storage();saveCustomerCreditRequest(request,origin);const restored=readCustomerCreditRequest('shared-credit',{...origin});expect(restored).toEqual(request);expect(restored?.input.requestId).toBe(request.input.requestId);clearCustomerCreditRequest('shared-credit',origin);expect(readCustomerCreditRequest('shared-credit',origin)).toBeUndefined();
  });
  it('does not expose the same record UUID in another company, organization, member or record',()=>{
    storage();saveCustomerCreditRequest(request,origin);
    for(const scope of [{...origin,companyId:'company-c'},{...origin,organizationId:'org-c'},{...origin,memberId:'member-b'}])expect(readCustomerCreditRequest('shared-credit',scope)).toBeUndefined();
    expect(readCustomerCreditRequest('different-credit',origin)).toBeUndefined();expect(readCustomerCreditRequest('shared-credit',origin)).toEqual(request);
  });
  it('clears only the completed member receipt and preserves another member and company',()=>{
    const values=storage(),otherMember={...origin,memberId:'member-b'},otherCompany={...origin,companyId:'company-c'};
    const pendingB={...request,input:{...request.input,requestId:'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',reference:'BANK-B'}};
    saveCustomerCreditRequest(request,origin);saveCustomerCreditRequest(pendingB,otherMember);saveCustomerCreditRequest(pendingB,otherCompany);clearCustomerCreditRequest('shared-credit',otherMember);
    expect(values.size).toBe(2);expect(readCustomerCreditRequest('shared-credit',origin)).toEqual(request);expect(readCustomerCreditRequest('shared-credit',otherCompany)).toEqual(pendingB);expect(readCustomerCreditRequest('shared-credit',otherMember)).toBeUndefined();
  });
  it('quarantines an unscoped legacy receipt without deleting it or assigning its origin',()=>{
    const values=storage(),legacyKey='zentra.customer-credit-request.v1.shared-credit';saveCustomerCreditRequest(request);const legacy=values.get(legacyKey);
    expect(readCustomerCreditRequest('shared-credit',origin)).toBeUndefined();expect(readCustomerCreditRequest('shared-credit',null)).toBeUndefined();clearCustomerCreditRequest('shared-credit',origin);clearCustomerCreditRequest('shared-credit',null);expect(values.get(legacyKey)).toBe(legacy);expect(readCustomerCreditRequest('shared-credit')).toEqual(request);
    saveCustomerCreditRequest(request,origin);clearCustomerCreditRequest('shared-credit',origin);expect(values.get(legacyKey)).toBe(legacy);
  });
  it('refuses missing or blank verified identity instead of a global member fallback',()=>{
    const values=storage();saveCustomerCreditRequest(request,origin);
    for(const scope of [null,{companyId:'company-a'},{...origin,memberId:''},{...origin,memberId:' '},{...origin,companyId:' '},{...origin,organizationId:3}] as Parameters<typeof customerCreditRequestScopeKey>[0][]){expect(customerCreditRequestScopeKey(scope)).toBeNull();expect(readCustomerCreditRequest('shared-credit',scope)).toBeUndefined();expect(()=>saveCustomerCreditRequest(request,scope)).toThrow();clearCustomerCreditRequest('shared-credit',scope);}
    expect(values.size).toBe(1);expect(customerCreditRequestScopeKey(undefined)).toBeNull();expect(customerCreditRequestScopeKey({companyId:'local-company',memberId:'local-user'})).toBe(JSON.stringify(['local-company','','local-user']));
  });
  it('rejects tampered envelope version or scope even at the correct storage key',()=>{
    const values=storage();saveCustomerCreditRequest(request,origin);const [key,raw]=[...values][0],envelope=JSON.parse(raw);
    for(const value of [{...envelope,version:1},{...envelope,scope:customerCreditRequestScopeKey({...origin,memberId:'member-b'})},{request},null]){values.set(key,JSON.stringify(value));expect(readCustomerCreditRequest('shared-credit',origin)).toBeUndefined();}
  });
  it('retains the existing request and reviewed balance validators inside the scoped envelope',()=>{
    const values=storage();saveCustomerCreditRequest(request,origin);const [key,raw]=[...values][0],envelope=JSON.parse(raw);
    for(const input of [{...request.input,creditNoteId:'other-credit'},{...request.input,amountCents:1.01},{...request.input,amountCents:Number.MAX_SAFE_INTEGER+1},{...request.input,requestId:'not-a-uuid'},{...request.input,expectedReview:{...request.input.expectedReview,bankAccountId:'other-bank'}}]){values.set(key,JSON.stringify({...envelope,request:{...request,input}}));expect(readCustomerCreditRequest('shared-credit',origin)).toBeUndefined();}
    values.set(key,'{');expect(readCustomerCreditRequest('shared-credit',origin)).toBeUndefined();
  });
  it('does not erase or send a receipt when browser storage is unavailable',()=>{
    vi.stubGlobal('localStorage',{getItem(){throw Error('storage unavailable');},setItem(){throw Error('storage unavailable');},removeItem(){throw Error('storage unavailable');}});
    expect(readCustomerCreditRequest('shared-credit',origin)).toBeUndefined();expect(()=>saveCustomerCreditRequest(request,origin)).toThrow('storage unavailable');expect(()=>clearCustomerCreditRequest('shared-credit',origin)).not.toThrow();
  });
  it('uses structured identity without separator collisions and keeps exact string identifiers',()=>{
    const values=storage(),a={companyId:'company:a',organizationId:'org',memberId:'member'},b={companyId:'company',organizationId:'a:org',memberId:'member'};saveCustomerCreditRequest(request,a);saveCustomerCreditRequest({...request,input:{...request.input,reference:'SECOND'}},b);expect(values.size).toBe(2);expect(readCustomerCreditRequest('shared-credit',a)?.input.reference).toBe('BANK-1');expect(readCustomerCreditRequest('shared-credit',b)?.input.reference).toBe('SECOND');
  });
  it('blocks a fresh request while an unassigned legacy receipt remains unresolved',()=>{
    storage();saveCustomerCreditRequest(request);expect(legacyCustomerCreditReviewRequired('shared-credit',origin)).toBe(true);expect(legacyCustomerCreditReviewRequired('shared-credit',{...origin,companyId:'company-c'})).toBe(true);expect(readCustomerCreditRequest('shared-credit',origin)).toBeUndefined();
  });
  it('adopts only an explicitly selected legacy request without changing its UUID or deleting v1',()=>{
    const values=storage();saveCustomerCreditRequest(request);const token=legacyCustomerCreditReviewToken('shared-credit')!;expect(adoptLegacyCustomerCreditRequest('shared-credit',origin,token)).toEqual(request);expect(readCustomerCreditRequest('shared-credit',origin)).toEqual(request);expect(values.get('zentra.customer-credit-request.v1.shared-credit')).toBe(token);expect(legacyCustomerCreditReviewRequired('shared-credit',origin)).toBe(true);
    completeLegacyCustomerCreditRequest('shared-credit',origin,request);clearCustomerCreditRequest('shared-credit',origin);expect(legacyCustomerCreditReviewRequired('shared-credit',origin)).toBe(false);expect(legacyCustomerCreditReviewRequired('shared-credit',{...origin,memberId:'member-b'})).toBe(true);expect(values.get('zentra.customer-credit-request.v1.shared-credit')).toBe(token);
  });
  it('allows a fresh local request only after an explicit other-company decision, never for another member',()=>{
    const values=storage();saveCustomerCreditRequest(request);const token=legacyCustomerCreditReviewToken('shared-credit')!;acknowledgeLegacyCustomerCreditOtherCompany('shared-credit',origin,token);expect(legacyCustomerCreditReviewRequired('shared-credit',origin)).toBe(false);expect(legacyCustomerCreditReviewRequired('shared-credit',{...origin,memberId:'member-b'})).toBe(true);expect(legacyCustomerCreditReviewRequired('shared-credit',{...origin,companyId:'company-c'})).toBe(true);expect(readCustomerCreditRequest('shared-credit',origin)).toBeUndefined();expect(values.get('zentra.customer-credit-request.v1.shared-credit')).toBe(token);
  });
  it('requires another history read if the legacy receipt changes before assignment or afterwards',()=>{
    storage();saveCustomerCreditRequest(request);const token=legacyCustomerCreditReviewToken('shared-credit')!;acknowledgeLegacyCustomerCreditOtherCompany('shared-credit',origin,token);saveCustomerCreditRequest({...request,input:{...request.input,reference:'CHANGED'}});expect(legacyCustomerCreditReviewRequired('shared-credit',origin)).toBe(true);expect(()=>adoptLegacyCustomerCreditRequest('shared-credit',origin,token)).toThrow('changé');expect(()=>acknowledgeLegacyCustomerCreditOtherCompany('shared-credit',origin,token)).toThrow('changé');expect(readCustomerCreditRequest('shared-credit',origin)).toBeUndefined();
  });
  it('does not treat another completed request as completion of the old unknown result',()=>{
    storage();saveCustomerCreditRequest(request);completeLegacyCustomerCreditRequest('shared-credit',origin,{...request,input:{...request.input,requestId:'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'}});expect(legacyCustomerCreditReviewRequired('shared-credit',origin)).toBe(true);
  });
  it('keeps a malformed or inaccessible legacy receipt blocked instead of guessing an origin or result',()=>{
    const values=storage();values.set('zentra.customer-credit-request.v1.shared-credit','{');expect(legacyCustomerCreditReviewRequired('shared-credit',origin)).toBe(true);expect(()=>adoptLegacyCustomerCreditRequest('shared-credit',origin,'{')).toThrow('ne peut pas être reprise');vi.stubGlobal('localStorage',{getItem(){throw Error('storage unavailable');}});expect(legacyCustomerCreditReviewRequired('shared-credit',origin)).toBe(true);
  });
});
