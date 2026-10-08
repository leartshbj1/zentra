import { describe,it,expect,vi,beforeEach } from 'vitest';
import { AccountPublicError } from '../account-security';
import { UsAuthorityError } from './saas-authority';
const f=vi.hoisted(()=>({
  device:vi.fn(),membership:vi.fn(),user:vi.fn(),seats:vi.fn(),select:vi.fn(),rate:vi.fn(),usAccess:vi.fn(),
}));
vi.mock('../account',()=>({requireDeviceSession:f.device,requireBrowserMembership:f.membership,enforceAccountRateLimit:f.rate}));
vi.mock('../../app/zentra-auth',()=>({getZentraUser:f.user}));
vi.mock('../team-seats',()=>({teamSeats:f.seats}));
vi.mock('../supabase-server-runtime',()=>({supabaseServerClient:()=>({select:f.select})}));
vi.mock('./saas-authority-d1',()=>({requireUsWorkspaceAccess:f.usAccess}));
import { erpServerDependencies as binding } from './runtime-bindings';
const org='fictitious-us-binding';
const request=(bearer=false)=>new Request('https://zentraapp.ch/erp',{headers:bearer?{Authorization:'Bearer fictitious-session'}:{}});
beforeEach(()=>{
  vi.clearAllMocks();f.device.mockResolvedValue({organizationId:org,userId:'device-user',role:'accountant'});
  f.user.mockResolvedValue({userId:'browser-user'});f.membership.mockResolvedValue({organizationId:org,role:'member'});
  f.seats.mockResolvedValue({subscriptionActive:true});f.select.mockResolvedValue([]);
  f.usAccess.mockImplementation(async (_org:string,userId:string)=>({organizationId:org,userId,role:userId==='device-user'?'accountant':'member',subscriptionId:'sub_US',seatLimit:3}));
});
describe('actual ERP authority bindings',()=>{
  it('uses the scoped US registry and own USD rights, never the CHF licence/seat path',async()=>{
    const result=await binding.authority(request(),org);expect(result.mode).toBe('browser');expect(result.actor).toMatchObject({organizationId:org,userId:'browser-user',role:'member',managementEntitled:true});expect(f.user).toHaveBeenCalledWith({offerAccess:false});expect(f.usAccess).toHaveBeenCalledWith(org,'browser-user');expect(f.membership).not.toHaveBeenCalled();expect(f.seats).not.toHaveBeenCalled();expect(f.device).not.toHaveBeenCalled();
  });
  it('denies an absent browser session before membership and persistence',async()=>{f.user.mockResolvedValue(null);await expect(binding.authority(request(),org)).rejects.toMatchObject({status:401});expect(f.membership).not.toHaveBeenCalled();expect(f.seats).not.toHaveBeenCalled();expect(f.select).not.toHaveBeenCalled();});
  it.each([true,false])('denies US expiry even if the legacy CHF subscription is active (device=%s)',async device=>{f.usAccess.mockRejectedValue(new UsAuthorityError('subscription_required',402));await expect(binding.authority(request(device),org)).rejects.toMatchObject({status:402,code:'management_entitlement_required'});expect(f.seats).not.toHaveBeenCalled();expect(f.select).not.toHaveBeenCalled();});
  it('rejects a foreign device workspace before loading rights or financial data',async()=>{f.device.mockResolvedValue({organizationId:'other',userId:'device-user',role:'owner'});await expect(binding.authority(request(true),org)).rejects.toMatchObject({status:403,code:'tenant_mismatch'});expect(f.seats).not.toHaveBeenCalled();expect(f.select).not.toHaveBeenCalled();});
  it('does not fall back to browser cookies after an invalid bearer session',async()=>{f.device.mockRejectedValue(new AccountPublicError('revoked device',401));await expect(binding.authority(request(true),org)).rejects.toMatchObject({status:401});expect(f.user).not.toHaveBeenCalled();expect(f.membership).not.toHaveBeenCalled();});
  it('loads only the scoped public seller identity and excludes secrets and mutable logo URLs',async()=>{
    f.select.mockResolvedValue([{organization_id:org,profile:{company_name:'Fictitious Seller',email:'seller@example.test',phone:'+1 212 555 0100',smtp_password:'SECRET',logo_url:'https://foreign.example/logo.png'}}]);
    const actor=(await binding.authority(request(),org)).actor;
    expect(await binding.seller!(actor)).toEqual({organizationId:org,displayName:'Fictitious Seller',contactEmail:'seller@example.test',contactPhone:'+1 212 555 0100'});
    expect(f.select).toHaveBeenCalledWith('zentra_company_profiles',{organization_id:`eq.${org}`,select:'organization_id,profile',limit:1});
  });
  it('refuses absent or foreign profile data without inventing a seller',async()=>{
    const actor=(await binding.authority(request(),org)).actor;expect(await binding.seller!(actor)).toBeNull();
    f.select.mockResolvedValue([{organization_id:'other',profile:{company_name:'Other Seller'}}]);expect(await binding.seller!(actor)).toBeNull();
  });
  it('does not substitute a fictitious tax engine when tax status is configured',async()=>{expect(await binding.taxProvider({} as Parameters<typeof binding.taxProvider>[0])).toBeNull();});
  it('rejects an invalid or missing US authority before financial data',async()=>{f.usAccess.mockRejectedValue(new UsAuthorityError('invalid_authority',422));await expect(binding.authority(request(),org)).rejects.toMatchObject({code:'service_unavailable',status:503});expect(f.select).not.toHaveBeenCalled();});
  it('refuses a foreign US projection rather than trusting a reader mismatch',async()=>{f.usAccess.mockResolvedValue({organizationId:'other',userId:'browser-user',role:'owner'});await expect(binding.authority(request(),org)).rejects.toMatchObject({code:'tenant_mismatch',status:403});});
  it('rejects stale device roles after current US membership permission changes',async()=>{f.usAccess.mockResolvedValue({organizationId:org,userId:'device-user',role:'read_only'});await expect(binding.authority(request(true),org)).rejects.toMatchObject({code:'financial_permission_required',status:403});});
});
