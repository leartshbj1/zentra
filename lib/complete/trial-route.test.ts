import {beforeEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({user:vi.fn(),trial:vi.fn(),rate:vi.fn(),bind:vi.fn(),write:vi.fn()}));
vi.mock('@/app/zentra-auth',()=>({getZentraUser:mocks.user}));
vi.mock('@/lib/account-trial',()=>({startAccountTrial:mocks.trial}));
vi.mock('@/lib/account',()=>({enforceAccountRateLimit:mocks.rate}));
vi.mock('@/lib/runtime',()=>({database:()=>({prepare:()=>({bind:mocks.bind})}),runtimeValue:()=>''}));
import {POST} from '@/app/api/complete/trial/route';
import {AccountPublicError} from '@/lib/account-security';
import {COMPLETE_TERMS_VERSION} from './plans';
const user={userId:'trial-owner',email:'trial@example.test',emailConfirmed:true,provider:'supabase'};
const request=(changes:Record<string,unknown>={},origin='https://zentraapp.ch')=>new Request('https://zentraapp.ch/api/complete/trial',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({companyName:'PME fictive',acceptTerms:true,legalVersion:COMPLETE_TERMS_VERSION,...changes})});
beforeEach(()=>{
 vi.resetAllMocks();mocks.user.mockResolvedValue(user);
 mocks.trial.mockResolvedValue({organization_id:'org_trial',subscription_id:'trial_subscription',ends_at:1900000000});
 mocks.bind.mockImplementation((...args:unknown[])=>{if(args.some(v=>v===undefined))throw new Error('D1 refuses undefined bindings');return {run:mocks.write}});
});
it('starts the complete trial and stores its explicit terms with a real origin',async()=>{
 const response=await POST(request());expect(response.status).toBe(200);
 expect(await response.json()).toEqual({created:true,organizationId:'org_trial',endsAt:1900000000});
 expect(response.headers.get('cache-control')).toContain('no-store');
 expect(mocks.trial).toHaveBeenCalledWith(user,'PME fictive',true);
 expect(mocks.bind).toHaveBeenCalledWith('complete_trial_trial-owner','trial-owner',COMPLETE_TERMS_VERSION,'complete_trial','team','https://zentraapp.ch',expect.any(String));
 expect(mocks.write).toHaveBeenCalledOnce();
});
it('requires the complete pack conditions, not an older Gestion acceptance',async()=>{
 expect((await POST(request({acceptTerms:false}))).status).toBe(400);
 expect((await POST(request({legalVersion:'2026-09-14'}))).status).toBe(400);
 expect(mocks.trial).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();
});
it('rejects unconfirmed users and cross-origin submissions before creation',async()=>{
 expect((await POST(request({},'https://unrelated.example'))).status).toBe(403);
 mocks.user.mockResolvedValue({...user,emailConfirmed:false});expect((await POST(request())).status).toBe(401);
 mocks.user.mockResolvedValue(null);expect((await POST(request())).status).toBe(401);
 expect(mocks.trial).not.toHaveBeenCalled();
});
it('returns an actionable rate limit without opening an extra trial',async()=>{
 mocks.rate.mockRejectedValue(new AccountPublicError('Patientez avant de réessayer.',429));
 const response=await POST(request());expect(response.status).toBe(429);expect(await response.json()).toEqual({error:'Patientez avant de réessayer.'});
 expect(mocks.trial).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();
});
