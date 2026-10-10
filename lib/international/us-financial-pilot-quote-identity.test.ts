import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerClient } from '../supabase-server';
import { ErpError } from './erp-contract';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { readUsFinancialPilotQuoteIdentity, readUsFinancialPilotQuoteSeller, validateUsFinancialPilotQuoteIdentity, type UsFinancialPilotQuoteIdentityDependencies } from './us-financial-pilot-quote-identity';
import type { WorkspaceCountryState } from './workspace-service';
import type { UsSellerProfileState } from './seller-profile';

async function fixture(){
  const f=await financialKernelFixture(),country={status:'configured' as const,organizationId:f.actor.organizationId,revision:2,configuration:f.configuration,updatedBy:f.actor.userId,updatedAt:f.actor.timestamp},seller={status:'configured' as const,organizationId:f.actor.organizationId,revision:7,profile:{displayName:'Current synthetic seller',contactEmail:'current@example.test'},updatedBy:f.actor.userId,updatedAt:f.actor.timestamp};
  const deps:{-readonly[K in keyof UsFinancialPilotQuoteIdentityDependencies]:UsFinancialPilotQuoteIdentityDependencies[K]}={country:vi.fn(async()=>country),seller:vi.fn(async()=>seller)},admit=vi.fn(async()=>f.actor);
  const read=()=>readUsFinancialPilotQuoteIdentity(deps,f.actor,admit);
  return{...f,country,seller,deps,admit,read};
}
describe('private quote identity — bounded current C/S observations and full admission',()=>{
  it('reads C1 → S → C2 with admission around every wait, keeping C/S distinct',async()=>{
    const t=await fixture(),order:string[]=[];t.deps.country=async()=>{order.push('country');return t.country;};t.deps.seller=async()=>{order.push('seller');return t.seller;};
    const identity=await readUsFinancialPilotQuoteIdentity(t.deps,t.actor,async()=>{order.push('admission');return t.actor;});
    expect(order).toEqual(['admission','country','admission','admission','seller','admission','admission','country','admission']);
    expect(identity).toEqual({organizationId:t.actor.organizationId,countryRevision:2,configuration:t.configuration,sellerRevision:7,seller:t.seller.profile});expect(Object.isFrozen(identity)).toBe(true);expect(Object.isFrozen(identity.configuration.address)).toBe(true);
  });
  it.each(['revision','configuration'] as const)('rejects changed C %s rather than retrying or accepting equal values at a newer version',async reason=>{
    const t=await fixture();let calls=0;t.deps.country=async()=>++calls===1?t.country:{...t.country,...(reason==='revision'?{revision:3}:{configuration:{...t.configuration,timeZone:'America/Chicago'}})};
    await expect(t.read()).rejects.toMatchObject({code:'financial_pilot_quote_identity_changed',status:409});expect(calls).toBe(2);
  });
  it('captures callbacks and actor before a private callback mutates its caller-owned arguments',async()=>{
    const t=await fixture(),actor={...t.actor},country={...t.country,configuration:JSON.parse(JSON.stringify(t.configuration)) as typeof t.configuration};let calls=0;
    const originalSeller=vi.fn(async()=>t.seller),originalCountry=vi.fn(async()=>{calls++;if(calls===1){t.deps.seller=async()=>{throw Error('replacement');};actor.userId='changed';}return country;});t.deps.country=originalCountry;t.deps.seller=originalSeller;
    const identity=await readUsFinancialPilotQuoteIdentity(t.deps,actor,t.admit);Reflect.set(country.configuration.address,'line1','mutated after return');
    expect(identity.configuration.address.line1).toBe(t.configuration.address.line1);expect(originalSeller).toHaveBeenCalledWith(t.actor);expect(originalCountry).toHaveBeenCalledTimes(2);
  });
  it('owns each returned state before admission awaits can mutate it',async()=>{
    const t=await fixture(),c=JSON.parse(JSON.stringify(t.country)) as typeof t.country,s=JSON.parse(JSON.stringify(t.seller)) as typeof t.seller;let count=0;
    t.deps.country=async()=>c;t.deps.seller=async()=>s;
    const identity=await readUsFinancialPilotQuoteIdentity(t.deps,t.actor,async()=>{if(++count===5)s.profile.displayName='later mutation';return t.actor;});
    expect(identity.seller.displayName).toBe('Current synthetic seller');
  });
  it('returns a bounded missing-seller conflict with no country/seller fallback',async()=>{
    const t=await fixture();t.deps.seller=async()=>({status:'unconfigured',organizationId:t.actor.organizationId,revision:0});
    await expect(t.read()).rejects.toMatchObject({code:'financial_pilot_seller_required',status:409});expect(t.deps.country).toHaveBeenCalledTimes(1);
  });
  it.each(['extra','tenant','max','zero','unconfigured','CH','timestamp','configuration'] as const)('closes malformed country %s as private unavailable',async reason=>{
    const t=await fixture();let c:unknown=t.country;
    if(reason==='extra')c={...t.country,secret:'private'};if(reason==='tenant')c={...t.country,organizationId:'other'};if(reason==='max')c={...t.country,revision:Number.MAX_SAFE_INTEGER};if(reason==='zero')c={...t.country,revision:0};if(reason==='unconfigured')c={status:'unconfigured',organizationId:t.actor.organizationId,revision:0};if(reason==='CH')c={...t.country,configuration:{...t.configuration,country:'CH',currency:'CHF'}};if(reason==='timestamp')c={...t.country,updatedAt:'not an instant'};if(reason==='configuration')c={...t.country,configuration:{...t.configuration,extra:'secret'}};
    t.deps.country=async()=>c as WorkspaceCountryState;await expect(t.read()).rejects.toMatchObject({code:'service_unavailable',status:503});expect(t.deps.seller).not.toHaveBeenCalled();
  });
  it.each(['tenant','max','extra','profile','timestamp'] as const)('closes malformed seller %s without returning partial identity',async reason=>{
    const t=await fixture();let s:unknown=t.seller;
    if(reason==='tenant')s={...t.seller,organizationId:'other'};if(reason==='max')s={...t.seller,revision:Number.MAX_SAFE_INTEGER};if(reason==='extra')s={...t.seller,secret:'private'};if(reason==='profile')s={...t.seller,profile:{...t.seller.profile,country:'CH'}};if(reason==='timestamp')s={...t.seller,updatedAt:'not an instant'};
    t.deps.seller=async()=>s as UsSellerProfileState;await expect(t.read()).rejects.toMatchObject({code:'service_unavailable',status:503});
  });
  it.each(['country','seller'] as const)('renews admission on rejected %s before allowing a bounded failure',async stage=>{
    const t=await fixture();let rejected=false;t.deps[stage]=async()=>{rejected=true;throw Error('PRIVATE upstream failure');};
    await expect(readUsFinancialPilotQuoteIdentity(t.deps,t.actor,async()=>{if(rejected)throw new ErpError('session_changed',401);return t.actor;})).rejects.toMatchObject({code:'session_changed',status:401});
  });
  it.each(['tenant','user','role','entitlement'] as const)('refuses authority %s change after successful private read',async reason=>{
    const t=await fixture();let read=false;t.deps.country=async()=>{read=true;return t.country;};
    await expect(readUsFinancialPilotQuoteIdentity(t.deps,t.actor,async()=>!read?t.actor:{...t.actor,...(reason==='tenant'?{organizationId:'other'}:reason==='user'?{userId:'other'}:reason==='role'?{role:'admin' as const}:{managementEntitled:false})})).rejects.toBeInstanceOf(Error);
    expect(t.deps.seller).not.toHaveBeenCalled();
  });
  it('does not invoke privileged state or dependency getters',async()=>{
    const t=await fixture(),get=vi.fn(()=>t.country);t.deps.country=async()=>Object.defineProperty({...t.country},'configuration',{enumerable:true,get}) as never;
    await expect(t.read()).rejects.toMatchObject({status:503});expect(get).not.toHaveBeenCalled();
    const deps=Object.defineProperty({seller:t.deps.seller},'country',{enumerable:true,get}) as never;
    await expect(readUsFinancialPilotQuoteIdentity(deps,t.actor,t.admit)).rejects.toMatchObject({status:503});expect(get).not.toHaveBeenCalled();
  });
  it('validates and detaches the private identity synchronously without exposing state audit fields',async()=>{
    const t=await fixture(),raw={organizationId:t.actor.organizationId,countryRevision:2,configuration:JSON.parse(JSON.stringify(t.configuration)) as typeof t.configuration,sellerRevision:7,seller:{...t.seller.profile}},value=validateUsFinancialPilotQuoteIdentity(raw,t.actor.organizationId);
    raw.seller.displayName='changed';Reflect.set(raw.configuration.address,'line1','changed');expect(value.seller.displayName).toBe(t.seller.profile.displayName);expect(Object.keys(value)).toEqual(['organizationId','countryRevision','configuration','sellerRevision','seller']);
    for(const bad of [{...raw,actor:t.actor},{...raw,sellerRevision:0},{...raw,organizationId:'other'},{...raw,configuration:{...raw.configuration,accountingBasis:'cash'}}])expect(()=>validateUsFinancialPilotQuoteIdentity(bad,t.actor.organizationId)).toThrow();
  });
});

describe('private quote seller — exact versioned head without the legacy RPC',()=>{
  async function head(){const t=await fixture();return{...t,row:{organization_id:t.actor.organizationId,revision:7,profile:{...t.seller.profile},updated_by:t.actor.userId,updated_at:'2026-10-10T10:15:30.123456Z'}};}
  function storeRows(rows:unknown){const select=vi.fn(async()=>rows);return{select,store:{select:select as SupabaseServerClient['select']}};}
  it('uses the real client prototype method with one exact tenant select and validates PostgreSQL microseconds',async()=>{
    const t=await head(),calls:string[]=[],store=new SupabaseServerClient({url:'https://supabase.synthetic.test',secretKey:'sb_secret_0000000000000000000000000000000000000000'},async input=>{calls.push(typeof input==='string'?input:input instanceof URL?input.href:input.url);return Response.json([t.row]);});
    const state=await readUsFinancialPilotQuoteSeller(store,t.actor),url=new URL(calls[0]);
    expect(url.pathname).toBe('/rest/v1/zentra_us_seller_profiles');expect([...url.searchParams]).toEqual([['select','organization_id,revision,profile,updated_by,updated_at'],['organization_id','eq.'+t.actor.organizationId],['limit','1']]);expect(calls).toHaveLength(1);
    expect(state).toEqual({...t.seller,updatedAt:t.row.updated_at});expect(Object.isFrozen(state)).toBe(true);if(state.status!=='configured')throw Error('Expected configured seller');expect(Object.isFrozen(state.profile)).toBe(true);
  });
  it('returns only the explicit empty state for an absent head',async()=>{
    const t=await head(),s=storeRows([]);expect(await readUsFinancialPilotQuoteSeller(s.store,t.actor)).toEqual({status:'unconfigured',organizationId:t.actor.organizationId,revision:0});expect(s.select).toHaveBeenCalledWith('zentra_us_seller_profiles',{select:'organization_id,revision,profile,updated_by,updated_at',organization_id:'eq.'+t.actor.organizationId,limit:1});
  });
  it.each(['not-array','two-rows','extra','missing','foreign','zero','string-revision','max','profile','audit','timestamp','getter'] as const)('fails closed for malformed private head %s',async reason=>{
    const t=await head(),get=vi.fn(()=>t.row.profile);let rows:unknown=[t.row];const row:Record<string,unknown>={...t.row};
    if(reason==='not-array')rows={row};else if(reason==='two-rows')rows=[row,row];else{
      if(reason==='extra')row.schema_version=1;if(reason==='missing')delete row.updated_by;if(reason==='foreign')row.organization_id='other';if(reason==='zero')row.revision=0;if(reason==='string-revision')row.revision='7';if(reason==='max')row.revision=Number.MAX_SAFE_INTEGER;if(reason==='profile')row.profile={...t.row.profile,privateTaxFacts:'secret'};if(reason==='audit')row.updated_by=null;if(reason==='timestamp')row.updated_at='not an instant';if(reason==='getter')Object.defineProperty(row,'profile',{enumerable:true,get});rows=[row];
    }
    const s=storeRows(rows);await expect(readUsFinancialPilotQuoteSeller(s.store,t.actor)).rejects.toMatchObject({code:'service_unavailable',status:503});expect(get).not.toHaveBeenCalled();
  });
  it('captures the actor and method before select waits, then owns the returned profile',async()=>{
    const t=await head(),supplied={...t.actor};let release!:(rows:unknown[])=>void;const original=vi.fn(()=>new Promise<unknown[]>(resolve=>{release=resolve;})),replacement=vi.fn(async()=>{throw Error('Replacement must not run');}),store={select:original as SupabaseServerClient['select']};
    const pending=readUsFinancialPilotQuoteSeller(store,supplied);supplied.organizationId='other';store.select=replacement as SupabaseServerClient['select'];release([t.row]);const state=await pending;t.row.profile.displayName='mutated after return';
    expect(original).toHaveBeenCalledWith('zentra_us_seller_profiles',expect.objectContaining({organization_id:'eq.'+t.actor.organizationId}));expect(replacement).not.toHaveBeenCalled();expect(state.status==='configured'&&state.profile.displayName).toBe(t.seller.profile.displayName);
  });
  it('does not invoke a select getter, and bounds an upstream failure without leaking it',async()=>{
    const t=await head(),get=vi.fn(()=>async()=>[t.row]),store=Object.defineProperty({},'select',{get}) as Pick<SupabaseServerClient,'select'>;
    await expect(readUsFinancialPilotQuoteSeller(store,t.actor)).rejects.toMatchObject({code:'service_unavailable',status:503});expect(get).not.toHaveBeenCalled();
    const failure={select:async()=>{throw Error('PRIVATE seller transport detail');}};await expect(readUsFinancialPilotQuoteSeller(failure,t.actor)).rejects.toMatchObject({code:'service_unavailable',message:'service_unavailable',status:503});
  });
});
