import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: vi.fn(), prepare: vi.fn(), rate: vi.fn() }));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: mocks.user }));
vi.mock('@/lib/runtime', () => ({
  runtimeValue: (key: string) => key === 'ZENTRA_OWNER_EMAIL' ? 'owner@example.test' : '',
  stripeConfiguration: () => ({siteUrl:'https://zentraapp.ch',siteOriginAliases:''}),
}));
vi.mock('@/lib/account', async original => ({...await original<object>(),enforceAccountRateLimit:mocks.rate}));
vi.mock('./catalog-admin', () => ({prepareCompleteCatalog:mocks.prepare}));
import { POST } from '@/app/api/automation/admin/route';
import { AccountPublicError } from '@/lib/account-security';
const owner = {userId:'owner',email:'owner@example.test',emailConfirmed:true,provider:'supabase'};
const request = (origin='https://zentraapp.ch') => new Request('https://zentraapp.ch/api/automation/admin',{
  method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({action:'complete_catalog',userId:'forged'}),
});
beforeEach(()=>{vi.resetAllMocks();mocks.user.mockResolvedValue(owner);mocks.prepare.mockResolvedValue({checks:[]});});
it('permits only the confirmed founder and limits maintenance calls',async()=>{
  const result=await POST(request());
  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toContain('no-store');
  expect(mocks.rate).toHaveBeenCalledWith(expect.any(Request),'complete-catalog','owner',5);
  expect(mocks.prepare).toHaveBeenCalledOnce();
});
it('rejects anonymous, unverified, non-owner and forged-origin calls before any catalog write',async()=>{
  for(const identity of [null,{...owner,emailConfirmed:false},{...owner,email:'member@example.test'}]){
    mocks.user.mockResolvedValue(identity);
    expect((await POST(request())).status).toBe(403);
  }
  mocks.user.mockResolvedValue(owner);
  expect((await POST(request('https://attacker.example'))).status).toBe(403);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('stops repeated requests before touching Stripe',async()=>{
  mocks.rate.mockRejectedValue(new AccountPublicError('Patientez.',429));
  expect((await POST(request())).status).toBe(429);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
