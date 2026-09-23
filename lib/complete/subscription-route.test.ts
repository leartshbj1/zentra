import {beforeEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({user:vi.fn(),member:vi.fn(),device:vi.fn(),rate:vi.fn(),journey:vi.fn(),skip:vi.fn(),quote:vi.fn(),change:vi.fn(),write:vi.fn()}));
vi.mock('@/app/zentra-auth',()=>({getZentraUser:mocks.user}));
vi.mock('@/lib/runtime',()=>({runtimeValue:()=>'',stripeConfiguration:()=>({siteUrl:'https://zentraapp.ch',siteOriginAliases:''}),database:()=>({prepare:()=>({bind:()=>({run:mocks.write})})})}));
vi.mock('@/lib/account',async original=>({...await original<object>(),requireBrowserMembership:mocks.member,requireDeviceSession:mocks.device,enforceAccountRateLimit:mocks.rate}));
vi.mock('./journey',()=>({subscriptionJourney:mocks.journey,skipJourneyStep:mocks.skip}));
vi.mock('./change',()=>({quotePlanChange:mocks.quote,changePlan:mocks.change}));
import {GET,POST} from '@/app/api/account/subscription/route';
import {AccountPublicError} from '@/lib/account-security';
import {COMPLETE_TERMS_VERSION} from './plans';
const user={userId:'owner',email:'owner@example.test',emailConfirmed:true,provider:'supabase'};
const post=(body:Record<string,unknown>={},headers:Record<string,string>={})=>new Request('https://zentraapp.ch/api/account/subscription',{method:'POST',headers:{origin:'https://zentraapp.ch','content-type':'application/json',...headers},body:JSON.stringify({organizationId:'org-a',action:'quote',plan:'pro',...body})});
beforeEach(()=>{vi.resetAllMocks();mocks.user.mockResolvedValue(user);mocks.member.mockResolvedValue({organizationId:'org-a',role:'owner'});mocks.device.mockResolvedValue({organizationId:'org-a',userId:'owner',role:'owner'});mocks.journey.mockResolvedValue({organizationId:'org-a'});mocks.quote.mockResolvedValue({fingerprint:'quoted',snapshot:{secret:'internal'}});mocks.change.mockResolvedValue({state:'scheduled'});});
it('returns only the current membership and non-cacheable shared summary',async()=>{
 const response=await GET(new Request('https://zentraapp.ch/api/account/subscription?organizationId=org-a'));
 expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');expect(mocks.member).toHaveBeenCalledWith('owner','org-a',undefined);
 mocks.member.mockRejectedValue(new AccountPublicError('Accès refusé.',403));
 expect((await GET(new Request('https://zentraapp.ch/api/account/subscription?organizationId=org-other'))).status).toBe(403);
 expect(mocks.journey).toHaveBeenCalledTimes(1);
});
it('never exposes the billing source snapshot in a quote',async()=>{
 const response=await POST(post({userId:'forged'}));expect(await response.json()).toEqual({fingerprint:'quoted'});
 expect(mocks.quote).toHaveBeenCalledWith('owner','org-a','pro');expect(mocks.write).not.toHaveBeenCalled();
});
it('requires same-origin before reaching the billing functions',async()=>{
 expect((await POST(post({}, {origin:'https://attacker.test'}))).status).toBe(403);
 expect(mocks.quote).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();
});
it('denies anonymous, non-owner and unconfirmed billing actions',async()=>{
 mocks.user.mockResolvedValue(null);expect((await POST(post())).status).toBe(401);
 mocks.user.mockResolvedValue({...user,emailConfirmed:false});expect((await POST(post())).status).toBe(403);
 mocks.user.mockResolvedValue(user);mocks.member.mockResolvedValue({organizationId:'org-a',role:'admin'});expect((await POST(post())).status).toBe(403);
 expect(mocks.quote).not.toHaveBeenCalled();expect(mocks.change).not.toHaveBeenCalled();
});
it('allows native read only for the bound company and forbids bearer billing even for owner',async()=>{
 const get=(org:string)=>new Request('https://zentraapp.ch/api/account/subscription?organizationId='+org,{headers:{authorization:'Bearer fixture'}});
 expect((await GET(get('org-a'))).status).toBe(200);expect((await GET(get('org-other'))).status).toBe(403);
 expect((await POST(post({}, {authorization:'Bearer fixture',origin:'tauri://localhost'}))).status).toBe(403);
 expect(mocks.quote).not.toHaveBeenCalled();
});
it('requires explicit current conditions before recording a change and rate limits retries',async()=>{
 expect((await POST(post({action:'change'}))).status).toBe(400);expect(mocks.change).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();
 expect((await POST(post({action:'change',acceptTerms:true,legalVersion:COMPLETE_TERMS_VERSION,fingerprint:'quoted'}))).status).toBe(200);
 expect(mocks.change).toHaveBeenCalledWith('owner','org-a','pro','quoted');expect(mocks.write).toHaveBeenCalledOnce();
 mocks.rate.mockRejectedValue(new AccountPublicError('Patientez.',429));expect((await POST(post())).status).toBe(429);expect(mocks.quote).not.toHaveBeenCalled();
});
it('hides internal provider failures and leaves company-bound skipped steps separate from billing',async()=>{
 mocks.quote.mockRejectedValue(new Error('secret provider payload'));const response=await POST(post());expect(response.status).toBe(500);expect(await response.text()).not.toContain('secret provider');
 const skip=await POST(post({action:'skip',step:'connection',skip:true}));expect(skip.status).toBe(200);expect(mocks.skip).toHaveBeenCalledWith(expect.objectContaining({organizationId:'org-a',userId:'owner'}),'connection',true);expect(mocks.change).not.toHaveBeenCalled();
});
