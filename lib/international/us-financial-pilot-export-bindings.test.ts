import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { ErpError } from './erp-contract';
import { UsAuthorityError } from './saas-authority';
import type { FinancialAuthority } from './accounting/ledger';
import type { UsFinancialPilotScope } from './us-financial-pilot-store';

const f=vi.hoisted(()=>({env:{} as Record<string,string|undefined>,user:vi.fn(),access:vi.fn(),scope:vi.fn(),create:vi.fn(),sellerCreate:vi.fn(),country:vi.fn(),select:vi.fn(),rate:vi.fn(),fonts:vi.fn(),invoice:vi.fn(),report:vi.fn(),estimate:vi.fn(),factory:vi.fn(),rpc:vi.fn()}));
vi.mock('cloudflare:workers',()=>({env:f.env}));
vi.mock('../../app/zentra-auth',()=>({getZentraUser:f.user}));
vi.mock('./saas-authority-d1',()=>({requireUsWorkspaceAccess:f.access}));
vi.mock('../supabase-server-runtime',()=>({supabaseServerClient:()=>({rpc:f.rpc,select:f.select})}));
vi.mock('./us-financial-pilot-store',async importOriginal=>{const actual=await importOriginal<typeof import('./us-financial-pilot-store')>();return{captureUsFinancialPilotScope:actual.captureUsFinancialPilotScope,readUsFinancialPilotScope:f.scope,createSupabaseUsFinancialPilotStore:f.create,readUsFinancialPilotPromotionStatus:vi.fn()};});
vi.mock('./us-financial-pilot-seller-store',()=>({createSupabaseUsFinancialPilotSellerStore:f.sellerCreate}));
vi.mock('./workspace-service',()=>({getWorkspaceCountry:f.country}));
vi.mock('../account',()=>({enforceAccountRateLimit:f.rate}));
vi.mock('./export-fonts',()=>({getUsExportFonts:f.fonts}));
vi.mock('./us-financial-pilot-export-server',()=>({createUsFinancialPilotExportHandlers:(...args:unknown[])=>{f.factory(...args);return{INVOICE:f.invoice,REPORT:f.report,ESTIMATE:f.estimate};}}));
import { usFinancialPilotExportDependencies as deps } from './us-financial-pilot-export-bindings';
import { GET as invoiceRoute } from '../../app/api/international/workspaces/[organizationId]/financial-pilot/exports/invoices/[invoiceId]/route';
import { GET as reportRoute } from '../../app/api/international/workspaces/[organizationId]/financial-pilot/exports/reports/[kind]/route';
import { GET as estimateRoute } from '../../app/api/international/workspaces/[organizationId]/financial-pilot/exports/estimates/[estimateId]/route';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';

const org='10000000-0000-4000-8000-000000000001',userId='20000000-0000-4000-8000-000000000001';
const required=['INTERNATIONAL_CORE_ENABLED','INTERNATIONAL_US_ERP_ENABLED','INTERNATIONAL_US_FINANCIAL_V5_INSTALLED','INTERNATIONAL_US_FINANCIAL_PILOT_ENABLED'] as const;
function enable(){for(const name of required)f.env[name]='true';f.env.INTERNATIONAL_US_BILLING_ENVIRONMENT='TEST';}
function request(headers:Record<string,string>={}){return new Request('https://zentra.test/export',{headers});}
beforeEach(()=>{vi.clearAllMocks();f.sellerCreate.mockReset();for(const name of Object.keys(f.env))delete f.env[name];f.user.mockResolvedValue({userId,email:'synthetic-export@example.test'});f.access.mockResolvedValue({organizationId:org,userId,role:'owner'});});

describe('financial pilot exports real bindings — synthetic Auth/D1/PG callbacks',()=>{
  it('defaults closed without provisioning any scope or rights',async()=>{expect(await deps.enabled()).toBe(false);expect(f.scope).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();});
  it.each(required)('closes when %s is missing or not exact true',async name=>{enable();f.env[name]='TRUE';expect(await deps.enabled()).toBe(false);delete f.env[name];expect(await deps.enabled()).toBe(false);});
  it.each(['LIVE','test','TEST ',undefined])('rejects billing environment %j',async value=>{enable();f.env.INTERNATIONAL_US_BILLING_ENVIRONMENT=value;expect(await deps.enabled()).toBe(false);});
  it('opens only the existing explicitly installed TEST pilot configuration',async()=>{enable();expect(await deps.enabled()).toBe(true);});
  it('uses current read-only Auth, without refreshSession or offered subscription rights',async()=>{expect(await deps.authority(request(),org)).toMatchObject({mode:'browser',actor:{organizationId:org,userId,role:'owner',managementEntitled:true}});expect(f.user).toHaveBeenCalledWith({offerAccess:false});expect(f.user.mock.calls[0][0]).toEqual({offerAccess:false});expect(f.access).toHaveBeenCalledWith(org,userId);});
  it.each(['owner','admin','accountant'])('admits effective D1 financial role %s',async role=>{f.access.mockResolvedValue({organizationId:org,userId,role});expect((await deps.authority(request(),org)).actor.role).toBe(role);});
  it.each(['member','read_only'])('refuses effective D1 role %s',async role=>{f.access.mockResolvedValue({organizationId:org,userId,role});await expect(deps.authority(request(),org)).rejects.toMatchObject({code:'financial_permission_required',status:403});});
  it('rejects device credentials before touching browser Auth',async()=>{await expect(deps.authority(request({Authorization:'Bearer synthetic'}),org)).rejects.toMatchObject({code:'forbidden',status:403});expect(f.user).not.toHaveBeenCalled();});
  it('requires a live browser session',async()=>{f.user.mockResolvedValue(null);await expect(deps.authority(request(),org)).rejects.toBeInstanceOf(AccountPublicError);expect(f.access).not.toHaveBeenCalled();});
  it.each(['user','organization'])('refuses effective D1 %s mismatch',async field=>{f.access.mockResolvedValue({organizationId:field==='organization'?'another-org':org,userId:field==='user'?'another-user':userId,role:'owner'});await expect(deps.authority(request(),org)).rejects.toMatchObject({code:'tenant_mismatch',status:403});});
  it.each([402,403,503])('preserves effective membership denial %s without a private read',async status=>{f.access.mockRejectedValueOnce(new UsAuthorityError(status===402?'subscription_required':status===403?'forbidden':'service_unavailable',status));await expect(deps.authority(request(),org)).rejects.toMatchObject({status});expect(f.scope).not.toHaveBeenCalled();});
  it('uses the existing admitted country, exact pilot scope and wrapped store callbacks',async()=>{
    const actor=(await deps.authority(request(),org)).actor,configuration={organizationId:org,country:'US'},scope={scope:{organizationId:org,actor},optInVersion:3} as UsFinancialPilotScope,revalidate=vi.fn(async()=>scope),store={synthetic:true};f.country.mockResolvedValue({status:'configured',configuration});f.scope.mockResolvedValue(scope);f.create.mockReturnValue(store);
    expect(await deps.configuration(actor)).toBe(configuration);expect(await deps.scope(actor,scope)).toBe(scope);expect(await deps.store(scope,revalidate)).toBe(store);expect(f.scope).toHaveBeenCalledWith(expect.objectContaining({rpc:f.rpc}),actor,scope);expect(f.create).toHaveBeenCalledWith(expect.objectContaining({rpc:f.rpc}),scope,revalidate);
  });
  it('refuses an unconfigured workspace rather than opening an ERP4 seller reader',async()=>{f.country.mockResolvedValue({status:'required'});await expect(deps.configuration((await deps.authority(request(),org)).actor)).rejects.toMatchObject({code:'financial_configuration_changed',status:409});});
  it('charges only the scoped existing read limiter and uses fixed embedded fonts',async()=>{const actor=(await deps.authority(request(),org)).actor as FinancialAuthority,req=request();await deps.rateLimit(req,actor,'read');expect(f.rate).toHaveBeenCalledWith(req,'international-financial-pilot-read',`${org}:${userId}`,3600);const fonts={regular:new Uint8Array([1]),bold:new Uint8Array([2])};f.fonts.mockResolvedValue(fonts);expect(await deps.fonts()).toBe(fonts);});
  it('passes resolved route path parameters to the new export handlers, without extra authority fields',async()=>{const req=request(),invoice=new Response('invoice'),report=new Response('report');f.invoice.mockResolvedValue(invoice);f.report.mockResolvedValue(report);expect(await invoiceRoute(req,{params:Promise.resolve({organizationId:org,invoiceId:'synthetic-invoice'})})).toBe(invoice);expect(await reportRoute(req,{params:Promise.resolve({organizationId:org,kind:'trial_balance'})})).toBe(report);expect(f.invoice).toHaveBeenCalledWith(req,org,'synthetic-invoice');expect(f.report).toHaveBeenCalledWith(req,org,'trial_balance');});
  it('delegates the exact saved quote route without injecting identity or authority',async()=>{const req=request(),response=new Response('quote');f.estimate.mockResolvedValue(response);expect(await estimateRoute(req,{params:Promise.resolve({organizationId:org,estimateId:'saved quote'})})).toBe(response);expect(f.estimate).toHaveBeenCalledWith(req,org,'saved quote');});
  it('reads current country C1/S/C2 with the supplied full admission and no tax/provider port',async()=>{
    const raw=await financialKernelFixture(),actor={...raw.actor,organizationId:org,userId},config={...raw.configuration,organizationId:org},admit=vi.fn(async()=>actor);
    f.country.mockResolvedValue({status:'configured',organizationId:org,revision:4,configuration:config,updatedBy:userId,updatedAt:actor.timestamp});f.select.mockResolvedValue([{organization_id:org,revision:9,profile:{displayName:'Synthetic current quote seller'},updated_by:userId,updated_at:actor.timestamp}]);
    expect(await deps.quoteIdentity!(actor,admit)).toEqual({organizationId:org,countryRevision:4,configuration:config,sellerRevision:9,seller:{displayName:'Synthetic current quote seller'}});expect(f.country).toHaveBeenCalledTimes(2);expect(f.select).toHaveBeenCalledOnce();expect(admit).toHaveBeenCalledTimes(6);expect(f.select).toHaveBeenCalledWith('zentra_us_seller_profiles',{select:'organization_id,revision,profile,updated_by,updated_at',organization_id:'eq.'+org,limit:1});expect(f.rpc).not.toHaveBeenCalled();
  });
  it('renews full admission after a rejected private seller read',async()=>{
    const raw=await financialKernelFixture(),actor={...raw.actor,organizationId:org,userId};let failed=false;
    f.country.mockResolvedValue({status:'configured',organizationId:org,revision:4,configuration:{...raw.configuration,organizationId:org},updatedBy:userId,updatedAt:actor.timestamp});f.select.mockImplementation(async()=>{failed=true;throw Error('private');});
    await expect(deps.quoteIdentity!(actor,async()=>{if(failed)throw new AccountPublicError('revoked',401);return actor;})).rejects.toMatchObject({status:401});expect(f.country).toHaveBeenCalledOnce();
  });
  it.each(['absent','foreign','malformed'] as const)('does not substitute a seller when the real private select is %s',async kind=>{
    const raw=await financialKernelFixture(),actor={...raw.actor,organizationId:org,userId},admit=vi.fn(async()=>actor);
    f.country.mockResolvedValue({status:'configured',organizationId:org,revision:4,configuration:{...raw.configuration,organizationId:org},updatedBy:userId,updatedAt:actor.timestamp});
    f.select.mockResolvedValue(kind==='absent'?[]:[{organization_id:kind==='foreign'?'other':org,revision:9,profile:{displayName:'Synthetic seller'},updated_by:userId,updated_at:kind==='malformed'?null:actor.timestamp}]);
    await expect(deps.quoteIdentity!(actor,admit)).rejects.toMatchObject({code:kind==='absent'?'financial_pilot_seller_required':'service_unavailable',status:kind==='absent'?409:503});expect(admit).toHaveBeenCalledTimes(4);expect(f.country).toHaveBeenCalledOnce();expect(f.rpc).not.toHaveBeenCalled();
  });
  it('selects the installed effective S reader under renewed full scope while new writes are paused',async()=>{
    enable();f.env.ZENTRA_US_FINANCIAL_SELLER_TEST_INSTALLED='true';
    const raw=await financialKernelFixture(),actor={...raw.actor,organizationId:org,userId},configuration={...raw.configuration,organizationId:org},admit=vi.fn(async()=>actor);
    const scope:UsFinancialPilotScope={scope:{organizationId:org,actor,policy:raw.policy,grantVersion:3},optInVersion:5};
    f.scope.mockResolvedValue(scope);f.country.mockResolvedValue({status:'configured',organizationId:org,revision:4,configuration,updatedBy:userId,updatedAt:actor.timestamp});
    const read=vi.fn(async()=>({head:{consumer:'financial-pilot',schemaVersion:1,organizationId:org,revision:7,bankRevision:2,sellerRevision:10},presentation:{origin:'financial-v5',baseSellerRevision:9,sellerRevision:10,changeCount:1,profile:{displayName:'Synthetic effective S10',contactEmail:'effective@example.test'},updatedBy:userId,updatedAt:actor.timestamp,changeSha256:'a'.repeat(64)}}));
    f.sellerCreate.mockImplementation((_client:unknown,initial:UsFinancialPilotScope,fresh:()=>Promise<UsFinancialPilotScope>)=>({read:async()=>{expect(initial).toEqual(scope);expect(await fresh()).toEqual(scope);return read();}}));
    expect(await deps.quoteIdentity!(actor,admit)).toEqual({organizationId:org,countryRevision:4,configuration,sellerRevision:10,seller:{displayName:'Synthetic effective S10',contactEmail:'effective@example.test'}});
    expect(read).toHaveBeenCalledOnce();expect(f.sellerCreate).toHaveBeenCalledWith(expect.objectContaining({rpc:f.rpc}),scope,expect.any(Function));expect(f.scope).toHaveBeenNthCalledWith(1,expect.objectContaining({rpc:f.rpc}),actor,undefined);expect(f.scope).toHaveBeenNthCalledWith(2,expect.objectContaining({rpc:f.rpc}),actor,scope);expect(admit).toHaveBeenCalledTimes(8);expect(f.select).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();
  });
  it.each(['missing-helper','malformed-scope','base-paused'] as const)('never falls back to legacy S0 when installed reader is %s',async kind=>{
    enable();f.env.ZENTRA_US_FINANCIAL_SELLER_TEST_INSTALLED='true';const raw=await financialKernelFixture(),actor={...raw.actor,organizationId:org,userId},admit=vi.fn(async()=>actor);
    const scope:UsFinancialPilotScope={scope:{organizationId:org,actor,policy:raw.policy,grantVersion:3},optInVersion:5};f.scope.mockResolvedValue(kind==='malformed-scope'?{}:scope);
    f.country.mockResolvedValue({status:'configured',organizationId:org,revision:4,configuration:{...raw.configuration,organizationId:org},updatedBy:userId,updatedAt:actor.timestamp});f.sellerCreate.mockReturnValue({read:async()=>{throw new ErpError('financial_service_unavailable',503);}});
    if(kind==='base-paused')delete f.env.INTERNATIONAL_US_FINANCIAL_PILOT_ENABLED;
    await expect(deps.quoteIdentity!(actor,admit)).rejects.toMatchObject({code:'service_unavailable',status:503});expect(f.select).not.toHaveBeenCalled();expect(f.country).toHaveBeenCalledOnce();if(kind!=='missing-helper')expect(f.sellerCreate).not.toHaveBeenCalled();
  });
  it('renews outer admission after an installed source rejection and masks it with current revocation',async()=>{
    enable();f.env.ZENTRA_US_FINANCIAL_SELLER_TEST_INSTALLED='true';const raw=await financialKernelFixture(),actor={...raw.actor,organizationId:org,userId};let revoked=false;
    f.scope.mockResolvedValue({scope:{organizationId:org,actor,policy:raw.policy,grantVersion:1},optInVersion:1});f.country.mockResolvedValue({status:'configured',organizationId:org,revision:4,configuration:{...raw.configuration,organizationId:org},updatedBy:userId,updatedAt:actor.timestamp});
    f.sellerCreate.mockReturnValue({read:async()=>{revoked=true;throw new Error('PRIVATE SOURCE');}});
    await expect(deps.quoteIdentity!(actor,async()=>{if(revoked)throw new AccountPublicError('PRIVATE DENIAL',401);return actor;})).rejects.toMatchObject({status:401});expect(f.select).not.toHaveBeenCalled();expect(f.country).toHaveBeenCalledOnce();
  });
  it('preserves the explicit installed missing-seller refusal without substituting a profile',async()=>{
    enable();f.env.ZENTRA_US_FINANCIAL_SELLER_TEST_INSTALLED='true';const raw=await financialKernelFixture(),actor={...raw.actor,organizationId:org,userId},admit=vi.fn(async()=>actor);
    f.scope.mockResolvedValue({scope:{organizationId:org,actor,policy:raw.policy,grantVersion:1},optInVersion:1});f.country.mockResolvedValue({status:'configured',organizationId:org,revision:4,configuration:{...raw.configuration,organizationId:org},updatedBy:userId,updatedAt:actor.timestamp});f.sellerCreate.mockReturnValue({read:async()=>{throw new ErpError('financial_pilot_seller_required',409);}});
    await expect(deps.quoteIdentity!(actor,admit)).rejects.toMatchObject({code:'financial_pilot_seller_required',status:409});expect(admit).toHaveBeenCalledTimes(4);expect(f.select).not.toHaveBeenCalled();expect(f.country).toHaveBeenCalledOnce();
  });
});
