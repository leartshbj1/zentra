import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRole } from '../account-security';
import { AccountPublicError } from '../account-security';
import type { FinancialAuthority } from './accounting/ledger';
import { ErpError } from './erp-contract';
import { UsAuthorityError } from './saas-authority';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import type { UsFinancialPilotScope } from './us-financial-pilot-store';

const f=vi.hoisted(()=>({env:{} as Record<string,string|undefined>,user:vi.fn(),access:vi.fn(),probe:vi.fn(),scope:vi.fn(),create:vi.fn(),configuration:vi.fn(),rate:vi.fn(),rpc:vi.fn(),select:vi.fn()}));
vi.mock('cloudflare:workers',()=>({env:f.env}));
vi.mock('../../app/zentra-auth',()=>({getZentraUser:f.user}));
vi.mock('./saas-authority-d1',()=>({requireUsWorkspaceAccess:f.access}));
vi.mock('../supabase-server-runtime',()=>({supabaseServerClient:()=>({rpc:f.rpc,select:f.select})}));
vi.mock('./us-financial-pilot-store',()=>({readUsFinancialPilotPromotionStatus:f.probe,readUsFinancialPilotScope:f.scope,createSupabaseUsFinancialPilotStore:f.create}));
vi.mock('./workspace-service',()=>({getWorkspaceCountry:f.configuration}));
vi.mock('../account',()=>({enforceAccountRateLimit:f.rate}));
import { usFinancialPilotDependencies as binding, usFinancialPilotEnabled, usFinancialPilotFlagConfiguration, usFinancialPilotPageMode } from './us-financial-pilot-bindings';

const organizationId='10000000-0000-4000-8000-000000000001',userId='20000000-0000-4000-8000-000000000001';
const core=['INTERNATIONAL_CORE_ENABLED','INTERNATIONAL_US_ERP_ENABLED','INTERNATIONAL_US_FINANCIAL_V5_INSTALLED'] as const;
const pilot='INTERNATIONAL_US_FINANCIAL_PILOT_ENABLED',environment='INTERNATIONAL_US_BILLING_ENVIRONMENT';
let privateScope:UsFinancialPilotScope;
function installed(enabled=true){for(const key of core)f.env[key]='true';f.env[pilot]=enabled?'true':'false';f.env[environment]='TEST';}
function request(headers:Record<string,string>={}){return new Request('https://zentra.test/private',{headers});}
function role(value:AccountRole){f.access.mockResolvedValue({organizationId,userId,role:value});}
beforeEach(async()=>{
  vi.resetAllMocks();for(const key of Object.keys(f.env))delete f.env[key];
  const synthetic=await financialKernelFixture();
  privateScope={scope:{organizationId,actor:{...synthetic.actor,organizationId,userId},policy:synthetic.policy,grantVersion:4},optInVersion:7};
  f.user.mockResolvedValue({userId,email:'synthetic-pilot@example.test',displayName:'Synthetic pilot owner'});role('owner');f.probe.mockResolvedValue(false);
  f.scope.mockImplementation(async(_client:unknown,actor:FinancialAuthority)=>({...privateScope,scope:{...privateScope.scope,actor}}));
});
afterEach(()=>vi.restoreAllMocks());

describe('financial pilot real rollout and page selection — synthetic Auth/D1/PG ports',()=>{
  it('defaults to legacy without querying Auth, D1 or a missing V5 schema',async()=>{
    expect(usFinancialPilotFlagConfiguration({})).toEqual({installed:false,enabled:false});expect(await usFinancialPilotEnabled()).toBe(false);
    expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('legacy');expect(f.user).not.toHaveBeenCalled();expect(f.access).not.toHaveBeenCalled();expect(f.probe).not.toHaveBeenCalled();
  });
  it.each([undefined,'false','TRUE','1','true '])('requires the exact independent installation marker %j before probing a V5 schema',async value=>{
    installed();f.env[core[2]]=value;expect(await usFinancialPilotEnabled()).toBe(false);expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('legacy');expect(f.probe).not.toHaveBeenCalled();
  });
  it.each(core.slice(0,2).flatMap(flag=>[undefined,'false','TRUE','1','true '].map(value=>({flag,value}))))('retains promotion discovery when installed but $flag is $value',async({flag,value})=>{
    installed();f.env[flag]=value;f.probe.mockResolvedValue(true);
    expect(usFinancialPilotFlagConfiguration(f.env)).toEqual({installed:true,enabled:false});expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('unavailable');expect(f.probe).toHaveBeenCalledTimes(1);expect(f.scope).not.toHaveBeenCalled();
  });
  it.each(core.slice(0,2).flatMap(flag=>[undefined,'false','TRUE'].map(value=>({flag,value}))))('keeps nonpromoted spaces legacy when installed but $flag is $value',async({flag,value})=>{
    installed();f.env[flag]=value;expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('legacy');expect(f.probe).toHaveBeenCalledTimes(1);expect(f.scope).not.toHaveBeenCalled();
  });
  it.each(['false','TRUE','1','true ',undefined])('requires exact pilot flag %j, but still probes installed promoted workspaces',async value=>{
    installed();f.env[pilot]=value;f.probe.mockResolvedValue(true);expect(await usFinancialPilotEnabled()).toBe(false);
    expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('unavailable');expect(f.probe).toHaveBeenCalledTimes(1);expect(f.scope).not.toHaveBeenCalled();
  });
  it.each(['LIVE','test',undefined])('does not open a promoted pilot in billing environment %j',async value=>{
    installed();f.env[environment]=value;f.probe.mockResolvedValue(true);expect(await usFinancialPilotEnabled()).toBe(false);expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('unavailable');expect(f.scope).not.toHaveBeenCalled();
  });
  it.each(['owner','admin','accountant','member','read_only'] as const)('preserves unpromoted %s ERP4 membership without requiring a financial grant',async currentRole=>{
    installed(false);role(currentRole);expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('legacy');expect(f.access).toHaveBeenCalledWith(organizationId,userId);expect(f.scope).not.toHaveBeenCalled();
    expect(f.user).toHaveBeenCalledWith({offerAccess:false});expect(f.probe).toHaveBeenCalledWith(expect.objectContaining({rpc:f.rpc,select:f.select}),organizationId);
  });
  it.each(['owner','admin','accountant'] as const)('selects a promoted %s pilot only after fresh membership and pinned scope revalidation',async currentRole=>{
    installed();role(currentRole);f.probe.mockResolvedValue(true);expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('pilot');expect(f.scope).toHaveBeenCalledTimes(2);
    const initial=f.scope.mock.calls[0][1] as FinancialAuthority;expect(initial).toMatchObject({organizationId,userId,role:currentRole,managementEntitled:true});
    expect(f.scope.mock.calls[1][2]).toMatchObject({scope:{organizationId,grantVersion:4,actor:initial},optInVersion:7});expect(f.access.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
  it.each(['member','read_only'] as const)('closes promoted %s without exposing a frozen ERP4 baseline or asking for a private financial scope',async currentRole=>{
    installed();role(currentRole);f.probe.mockResolvedValue(true);expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('unavailable');expect(f.probe).toHaveBeenCalledTimes(1);expect(f.scope).not.toHaveBeenCalled();
  });
  it.each([401,402,403,404,409,503])('never converts rejected promoted scope status %s into legacy',async status=>{
    installed();f.probe.mockResolvedValue(true);f.scope.mockRejectedValue(new ErpError('synthetic_private_denial',status));expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('unavailable');
  });
  it('fails closed on a promotion probe outage, rather than treating it as unpromoted',async()=>{
    installed();f.probe.mockRejectedValue(new ErpError('financial_service_unavailable',503));expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('unavailable');expect(f.scope).not.toHaveBeenCalled();
  });
  it.each(['probe','scope'] as const)('withholds a previous account after session change during %s',async wait=>{
    installed();f.probe.mockResolvedValue(true);
    if(wait==='probe')f.probe.mockImplementation(async()=>{f.user.mockResolvedValue({userId:'another-account'});return true;});
    else f.scope.mockImplementation(async(_client:unknown,actor:FinancialAuthority)=>{f.user.mockResolvedValue(null);return{...privateScope,scope:{...privateScope.scope,actor}};});
    expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('unavailable');
  });
  it.each(['probe','scope'] as const)('withholds a changed membership role after %s',async wait=>{
    installed();f.probe.mockResolvedValue(true);
    if(wait==='probe')f.probe.mockImplementation(async()=>{role('accountant');return true;});
    else f.scope.mockImplementation(async(_client:unknown,actor:FinancialAuthority)=>{role('read_only');return{...privateScope,scope:{...privateScope.scope,actor}};});
    expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('unavailable');
  });
  it.each([402,403,503])('closes on effective membership denial %s before the promotion probe',async status=>{
    installed();f.access.mockRejectedValue(new UsAuthorityError(status===402?'subscription_required':status===403?'forbidden':'service_unavailable',status));expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('unavailable');expect(f.probe).not.toHaveBeenCalled();
  });
  it.each(['tenant','user'])('rejects a D1 %s mismatch before the private marker probe',async field=>{
    installed();f.access.mockResolvedValue({organizationId:field==='tenant'?'other-organization':organizationId,userId:field==='user'?'another-user':userId,role:'owner'});
    expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('unavailable');expect(f.probe).not.toHaveBeenCalled();
  });
  it('rejects a mismatched expected account before querying private promotion metadata',async()=>{
    installed();expect(await usFinancialPilotPageMode(organizationId,'previous-account')).toBe('unavailable');expect(f.probe).not.toHaveBeenCalled();
  });
  it.each(['installation','pilot','environment'] as const)('rechecks %s after awaiting the private scope',async changed=>{
    installed();f.probe.mockResolvedValue(true);f.scope.mockImplementation(async(_client:unknown,actor:FinancialAuthority)=>{
      f.env[changed==='installation'?core[2]:changed==='pilot'?pilot:environment]=changed==='environment'?'LIVE':'false';return{...privateScope,scope:{...privateScope.scope,actor}};
    });
    expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('unavailable');expect(f.scope).toHaveBeenCalledTimes(1);
  });
  it('does not reinterpret installation loss during an unpromoted probe as safe legacy access',async()=>{
    installed();f.probe.mockImplementation(async()=>{f.env[core[2]]='false';return false;});expect(await usFinancialPilotPageMode(organizationId,userId)).toBe('unavailable');
  });
});

describe('real financial pilot HTTP dependency authority remains financial-only',()=>{
  it.each(['member','read_only'] as const)('rejects %s from HTTP authority even though unpromoted page membership is supported',async currentRole=>{
    role(currentRole);await expect(binding.authority(request(),organizationId)).rejects.toMatchObject({code:'financial_permission_required',status:403});expect(f.probe).not.toHaveBeenCalled();
  });
  it('rejects native authorization before Auth and uses read-only browser Auth without offered rights or token refresh',async()=>{
    await expect(binding.authority(request({Authorization:'Bearer synthetic-never-valid'}),organizationId)).rejects.toMatchObject({status:403});expect(f.user).not.toHaveBeenCalled();
    expect(await binding.authority(request(),organizationId)).toMatchObject({mode:'browser',actor:{organizationId,userId,role:'owner',managementEntitled:true}});expect(f.user).toHaveBeenCalledWith({offerAccess:false});
    expect(f.user.mock.calls.every(([options])=>Object.keys(options).length===1&&options.offerAccess===false)).toBe(true);
  });
  it('requires a current browser session',async()=>{
    f.user.mockResolvedValue(null);await expect(binding.authority(request(),organizationId)).rejects.toBeInstanceOf(AccountPublicError);expect(f.access).not.toHaveBeenCalled();
  });
});
