import { describe, expect, it } from 'vitest';
import { createUsAutomationGrant, parseUsAutomationBudgetPolicy, UsAutomationPolicyError } from './us-automation-policy';
import { usWorkspaceAutomationAuthority, type UsAuthorityRecord, type UsMembership, type UsSaasPolicy, type UsWorkspaceAutomationAuthority } from './saas-authority';
import type { WorkspaceCreationIntent } from './workspace-creation';
import type { SaasSubscriptionOffer } from './subscriptions';
import { validateCompanyConfiguration } from './country-config';

const org='33333333-3333-4333-8333-333333333333', user='11111111-1111-4111-8111-111111111111', creation='44444444-4444-4444-8444-444444444444', request='22222222-2222-4222-8222-222222222222';
const seconds=(value:string)=>Date.parse(value)/1000;
const initial=seconds('2024-02-15T15:10:00Z');
// Entirely fictitious server-approved offer/evidence; no payment/provider call.
function fixture(now=initial) {
  const offer:SaasSubscriptionOffer={kind:'saas_subscription',catalogVersion:'fixture_us_1',country:'US',currency:'USD',module:'complet',plan:'fixture_plan',priceId:'price_fixture_US',productId:'prod_fixture_US',environment:'TEST',unitAmountMinor:'1000',interval:'month',intervalCount:1,taxBehavior:'exclusive'};
  const configuration=validateCompanyConfiguration({schemaVersion:1,organizationId:org,country:'US',currency:'USD',language:'en',timeZone:'America/New_York',address:{country:'US',line1:'10 Example St',city:'New York',subdivision:'NY',postalCode:'10001'},accountingBasis:'accrual',invoiceNumberPrefix:'INV',taxConfiguration:{status:'unconfigured'}});
  const timestamp=new Date(now*1000).toISOString();
  const intent:WorkspaceCreationIntent={creationId:creation,organizationId:org,actorUserId:user,requestId:request,confirmationVersion:1,companyName:'Fictitious company',fingerprint:'a'.repeat(64),configuration,state:'ready',ownSubscriptionId:'sub_fixture_US',createdAt:timestamp,updatedAt:timestamp,receipt:{creationId:creation,organizationId:org,actorUserId:user,requestId:request,configurationFingerprint:'a'.repeat(64),configuration,revision:1,updatedBy:user,updatedAt:timestamp,replayed:false}};
  const record:UsAuthorityRecord={organizationId:org,creationId:creation,ownerUserId:user,seatLimit:3,revision:1,updatedAt:now,revokedAt:null,authority:{kind:'saas_subscription_authority',organizationId:org,subscriptionId:'sub_fixture_US',offer,status:'active',evidence:{kind:'verified_payment',referenceId:'in_fixture_US',organizationId:org,subscriptionId:'sub_fixture_US',environment:'TEST',catalogVersion:offer.catalogVersion,priceId:offer.priceId,currency:'USD',startsAt:Math.max(0,now-60),endsAt:now+3600,revoked:false}}};
  const member:UsMembership={membershipId:'membership_fixture',organizationId:org,userId:user,role:'owner',joinedAt:now,revokedAt:null};
  const saas:UsSaasPolicy={catalog:[{offer,seatLimit:3}],environment:'TEST',now};
  return {offer,intent,record,member,saas,provenance:()=>usWorkspaceAutomationAuthority(intent,record,member,saas)};
}
function configured() { return {schemaVersion:1,cadence:'utc_calendar_month',budgetPolicyVersion:'fixture-budget-v1',processingPolicyVersion:'fixture-processing-v1',entries:[{catalogVersion:'fixture_us_1',priceId:'price_fixture_US',limit:50}]}; }
function grant(now=initial) { return createUsAutomationGrant(fixture(now).provenance(),parseUsAutomationBudgetPolicy(configured())); }
function invalid(input:unknown) { expect(()=>parseUsAutomationBudgetPolicy(input)).toThrowError(UsAutomationPolicyError); expect(()=>parseUsAutomationBudgetPolicy(input)).toThrow('invalid_automation_policy'); }

describe('explicit US supplier-analysis budget policy',()=>{
  it('parses only the explicit detached policy and has no settings, provider, money or implicit grant',()=>{
    const input=configured(),policy=parseUsAutomationBudgetPolicy(JSON.stringify(input)); expect(policy).toEqual(input);
    input.entries[0].limit=999; expect(policy.entries[0].limit).toBe(50); expect(Object.isFrozen(policy)).toBe(true); expect(Object.isFrozen(policy.entries)).toBe(true); expect(Object.isFrozen(policy.entries[0])).toBe(true);
    expect(Object.keys(grant()).sort()).toEqual(['schemaVersion','organizationId','environment','bucket','periodId','periodStart','periodEnd','limit','subscriptionId','authorityReference','catalogVersion','priceId','budgetPolicyVersion','processingPolicyVersion','checkedAt'].sort());
  });
  it.each([undefined,null,false,1,[],{},'', '{', '[]'])('does not default missing/malformed policy %j',invalid);
  it('keeps an explicitly empty policy closed rather than assigning a quota',()=>{
    const policy=parseUsAutomationBudgetPolicy({...configured(),entries:[]}); expect(()=>createUsAutomationGrant(fixture().provenance(),policy)).toThrow('automation_budget_unavailable');
  });
  it.each([{schemaVersion:2},{cadence:'billing_month'},{cadence:'Europe/Zurich'},{budgetPolicyVersion:''},{processingPolicyVersion:'bad\nversion'},{entries:null},{environment:'TEST'},{provider:'typesafe'},{consent:true},{priceUsd:'15.00'}])('rejects policy contract change %j',change=>invalid({...configured(),...change}));
  it.each([0,-1,1.5,NaN,Infinity,1_000_001,'50',null])('rejects non-approved quota %j',limit=>invalid({...configured(),entries:[{...configured().entries[0],limit}]}));
  it.each([1,1_000_000])('accepts exact integer policy boundary %s',limit=>expect(parseUsAutomationBudgetPolicy({...configured(),entries:[{...configured().entries[0],limit}]}).entries[0].limit).toBe(limit));
  it.each([{catalogVersion:''},{priceId:'price_unsafe\n'},{priceId:'prod_wrong'},{priceId:'price_'},{secret:'private'},{limit:undefined}])('rejects malformed/extra entry %j',change=>invalid({...configured(),entries:[{...configured().entries[0],...change}]}));
  it('rejects duplicate offer scopes even when quotas agree, and excessive entries',()=>{
    invalid({...configured(),entries:[configured().entries[0],{...configured().entries[0]}]}); invalid({...configured(),entries:Array.from({length:101},(_,n)=>({...configured().entries[0],priceId:`price_${n}`}))});
  });
  it('rejects accessor, prototype, symbol, hidden data and malformed UTF16 without invoking code',()=>{
    let calls=0; const accessor={...configured()}; Object.defineProperty(accessor,'entries',{get(){calls++;return [];},enumerable:true}); invalid(accessor); expect(calls).toBe(0);
    invalid(Object.assign(Object.create({provider:'private'}) as object,configured()));
    const symbol={...configured(),[Symbol('hidden')]:'private'}; invalid(symbol);
    const hidden={...configured()}; Object.defineProperty(hidden,'private',{value:'hidden'}); invalid(hidden);
    for(const budgetPolicyVersion of ['\ud800','\udc00','bad\u0000version'])invalid({...configured(),budgetPolicyVersion});
    invalid(' '.repeat(65_537));
  });
  it('requires both exact catalogue and price, without mutating the approved policy',()=>{
    for(const change of [{catalogVersion:'other'},{priceId:'price_other'}])expect(()=>createUsAutomationGrant(fixture().provenance(),parseUsAutomationBudgetPolicy({...configured(),entries:[{...configured().entries[0],...change}]}))).toThrow('automation_budget_unavailable');
  });
  it('rejects a copied or fabricated provenance rather than granting from JSON',()=>{
    const value=fixture().provenance(); expect(()=>createUsAutomationGrant({...value},parseUsAutomationBudgetPolicy(configured()))).toThrow('invalid_authority');
    expect(()=>createUsAutomationGrant(JSON.parse(JSON.stringify(value)) as UsWorkspaceAutomationAuthority,parseUsAutomationBudgetPolicy(configured()))).toThrow('invalid_authority');
  });
});

describe('UTC calendar consumption scope independent of commercial changes',()=>{
  it.each([
    ['2024-02-01T00:00:00Z','2024-02','2024-02-01T00:00:00Z','2024-03-01T00:00:00Z'],
    ['2024-02-29T23:59:59Z','2024-02','2024-02-01T00:00:00Z','2024-03-01T00:00:00Z'],
    ['2023-02-28T23:59:59Z','2023-02','2023-02-01T00:00:00Z','2023-03-01T00:00:00Z'],
    ['2024-03-01T00:00:00Z','2024-03','2024-03-01T00:00:00Z','2024-04-01T00:00:00Z'],
    ['2024-12-31T23:59:59Z','2024-12','2024-12-01T00:00:00Z','2025-01-01T00:00:00Z'],
    ['2025-01-01T00:00:00Z','2025-01','2025-01-01T00:00:00Z','2025-02-01T00:00:00Z'],
    ['1970-01-01T00:00:00Z','1970-01','1970-01-01T00:00:00Z','1970-02-01T00:00:00Z'],
  ])('uses exact half-open UTC month at %s',(timestamp,id,start,end)=>expect(grant(seconds(timestamp))).toMatchObject({periodId:id,periodStart:seconds(start),periodEnd:seconds(end),checkedAt:seconds(timestamp)}));
  it('does not reset the org/env/bucket/month key after an approved price, plan, subscription or proof upgrade',()=>{
    const a=grant(),f=fixture(); const upgraded={...f.offer,plan:'fixture_upgrade',priceId:'price_upgrade',catalogVersion:'fixture_us_2'};
    f.record={...f.record,authority:{...f.record.authority,subscriptionId:'sub_upgrade',offer:upgraded,evidence:{...f.record.authority.evidence!,subscriptionId:'sub_upgrade',referenceId:'in_upgrade',catalogVersion:upgraded.catalogVersion,priceId:upgraded.priceId}}}; f.intent={...f.intent,ownSubscriptionId:'sub_upgrade'}; f.saas={...f.saas,catalog:[{offer:upgraded,seatLimit:3}]};
    const b=createUsAutomationGrant(usWorkspaceAutomationAuthority(f.intent,f.record,f.member,f.saas),parseUsAutomationBudgetPolicy({...configured(),budgetPolicyVersion:'fixture-budget-v2',entries:[{catalogVersion:upgraded.catalogVersion,priceId:upgraded.priceId,limit:100}]}));
    const usageKey=(value:ReturnType<typeof grant>)=>[value.organizationId,value.environment,value.bucket,value.periodId,value.periodStart,value.periodEnd];
    expect(usageKey(b)).toEqual(usageKey(a)); expect(b.limit).toBe(100); expect(b.subscriptionId).not.toBe(a.subscriptionId); expect(b.authorityReference).not.toBe(a.authorityReference);
  });
  it('isolates environments while keeping calendar bounds stable',()=>{
    const f=fixture(),offer={...f.offer,environment:'PRODUCTION' as const};
    const record={...f.record,authority:{...f.record.authority,offer,evidence:{...f.record.authority.evidence!,environment:'PRODUCTION' as const}}};
    const value=createUsAutomationGrant(usWorkspaceAutomationAuthority(f.intent,record,f.member,{...f.saas,environment:'PRODUCTION',catalog:[{offer,seatLimit:3}]}),parseUsAutomationBudgetPolicy(configured()));
    expect(value).toMatchObject({environment:'PRODUCTION',periodId:grant().periodId,periodStart:grant().periodStart,periodEnd:grant().periodEnd});
  });
});

describe('current approved US Automation authority remains mandatory',()=>{
  it.each(['owner','admin','accountant'] as const)('allows active financial role %s without returning private authority JSON',role=>{
    const f=fixture(),value=usWorkspaceAutomationAuthority(f.intent,f.record,{...f.member,role},f.saas); expect(value.role).toBe(role); expect(Object.isFrozen(value)).toBe(true); expect(Object.keys(value)).not.toContain('evidence');
  });
  it.each(['member','read_only'] as const)('denies nonfinancial role %s',role=>{const f=fixture();expect(()=>usWorkspaceAutomationAuthority(f.intent,f.record,{...f.member,role},f.saas)).toThrow('forbidden');});
  it.each(['gestion','support'] as const)('does not infer Automation from a paid %s offer',module=>{const f=fixture(),offer={...f.offer,module};expect(()=>usWorkspaceAutomationAuthority(f.intent,{...f.record,authority:{...f.record.authority,offer}},f.member,{...f.saas,catalog:[{offer,seatLimit:3}]})).toThrow('subscription_required');});
  it('does not infer a Gestion right from a standalone Automation authority',()=>{
    const f=fixture(),offer={...f.offer,module:'automation' as const}; expect(()=>usWorkspaceAutomationAuthority(f.intent,{...f.record,authority:{...f.record.authority,offer}},f.member,{...f.saas,catalog:[{offer,seatLimit:3}]})).toThrow('subscription_required');
  });
  it('does not admit an unimplemented trial through the new budget provenance',()=>{
    const f=fixture(); expect(()=>usWorkspaceAutomationAuthority(f.intent,{...f.record,authority:{...f.record.authority,status:'trialing',evidence:{...f.record.authority.evidence!,kind:'authorized_trial'}}},f.member,f.saas)).toThrow('subscription_required');
  });
  it.each(['tenant','member','ready','receipt','environment','catalogue','revoked','expired','future'] as const)('denies invalid current authority: %s',change=>{
    const f=fixture();
    if(change==='tenant')f.member={...f.member,organizationId:'other'};
    if(change==='member')f.member={...f.member,revokedAt:initial};
    if(change==='ready')f.intent={...f.intent,state:'postgres_confirmed'};
    if(change==='receipt')f.intent={...f.intent,receipt:null};
    if(change==='environment')f.saas={...f.saas,environment:'PRODUCTION'};
    if(change==='catalogue')f.saas={...f.saas,catalog:[]};
    if(change==='revoked')f.record={...f.record,revokedAt:initial};
    if(change==='expired')f.saas={...f.saas,now:initial+3600};
    if(change==='future')f.record={...f.record,authority:{...f.record.authority,evidence:{...f.record.authority.evidence!,startsAt:initial+1}}};
    expect(()=>usWorkspaceAutomationAuthority(f.intent,f.record,f.member,f.saas)).toThrow();
  });
  it('captures provenance deeply without invoking accessors',()=>{
    const f=fixture(); let calls=0; Object.defineProperty(f.record,'authority',{get(){calls++;throw new Error('private');},enumerable:true}); expect(()=>usWorkspaceAutomationAuthority(f.intent,f.record,f.member,f.saas)).toThrow('invalid_authority'); expect(calls).toBe(0);
  });
});
