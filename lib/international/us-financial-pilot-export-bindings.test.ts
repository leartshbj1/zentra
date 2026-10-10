import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { UsAuthorityError } from './saas-authority';
import type { FinancialAuthority } from './accounting/ledger';
import type { UsFinancialPilotScope } from './us-financial-pilot-store';

const f=vi.hoisted(()=>({env:{} as Record<string,string|undefined>,user:vi.fn(),access:vi.fn(),scope:vi.fn(),create:vi.fn(),country:vi.fn(),rate:vi.fn(),fonts:vi.fn(),invoice:vi.fn(),report:vi.fn(),factory:vi.fn(),rpc:vi.fn()}));
vi.mock('cloudflare:workers',()=>({env:f.env}));
vi.mock('../../app/zentra-auth',()=>({getZentraUser:f.user}));
vi.mock('./saas-authority-d1',()=>({requireUsWorkspaceAccess:f.access}));
vi.mock('../supabase-server-runtime',()=>({supabaseServerClient:()=>({rpc:f.rpc})}));
vi.mock('./us-financial-pilot-store',()=>({readUsFinancialPilotScope:f.scope,createSupabaseUsFinancialPilotStore:f.create,readUsFinancialPilotPromotionStatus:vi.fn()}));
vi.mock('./workspace-service',()=>({getWorkspaceCountry:f.country}));
vi.mock('../account',()=>({enforceAccountRateLimit:f.rate}));
vi.mock('./export-fonts',()=>({getUsExportFonts:f.fonts}));
vi.mock('./us-financial-pilot-export-server',()=>({createUsFinancialPilotExportHandlers:(...args:unknown[])=>{f.factory(...args);return{INVOICE:f.invoice,REPORT:f.report};}}));
import { usFinancialPilotExportDependencies as deps } from './us-financial-pilot-export-bindings';
import { GET as invoiceRoute } from '../../app/api/international/workspaces/[organizationId]/financial-pilot/exports/invoices/[invoiceId]/route';
import { GET as reportRoute } from '../../app/api/international/workspaces/[organizationId]/financial-pilot/exports/reports/[kind]/route';

const org='10000000-0000-4000-8000-000000000001',userId='20000000-0000-4000-8000-000000000001';
const required=['INTERNATIONAL_CORE_ENABLED','INTERNATIONAL_US_ERP_ENABLED','INTERNATIONAL_US_FINANCIAL_V5_INSTALLED','INTERNATIONAL_US_FINANCIAL_PILOT_ENABLED'] as const;
function enable(){for(const name of required)f.env[name]='true';f.env.INTERNATIONAL_US_BILLING_ENVIRONMENT='TEST';}
function request(headers:Record<string,string>={}){return new Request('https://zentra.test/export',{headers});}
beforeEach(()=>{vi.clearAllMocks();for(const name of Object.keys(f.env))delete f.env[name];f.user.mockResolvedValue({userId,email:'synthetic-export@example.test'});f.access.mockResolvedValue({organizationId:org,userId,role:'owner'});});

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
});
