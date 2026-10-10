import { afterEach,describe,expect,it,vi } from 'vitest';
import { usSupportTriageEnabled,usSupportTriageHandlers } from './us-support-triage-bindings';

const runtime=vi.hoisted(()=>({env:{} as Record<string,string>}));
vi.mock('cloudflare:workers',()=>({env:runtime.env}));
afterEach(()=>{for(const key of Object.keys(runtime.env))delete runtime.env[key];});
describe('US Support classification readiness, no hosted services',()=>{
  it('is closed by default and requires all independent gates with exact true values',async()=>{
    expect(await usSupportTriageEnabled()).toBe(false);
    const keys=['INTERNATIONAL_CORE_ENABLED','INTERNATIONAL_US_ERP_ENABLED','INTERNATIONAL_US_SUPPORT_WORKSPACES_ENABLED','INTERNATIONAL_US_SUPPORT_MAILBOX_ENABLED','INTERNATIONAL_US_SUPPORT_TRIAGE_ENABLED'];
    for(const key of keys)runtime.env[key]='true';
    expect(await usSupportTriageEnabled()).toBe(true);
    for(const key of keys){delete runtime.env[key];expect(await usSupportTriageEnabled()).toBe(false);runtime.env[key]='true';}
    runtime.env.INTERNATIONAL_US_SUPPORT_TRIAGE_ENABLED='TRUE';expect(await usSupportTriageEnabled()).toBe(false);
  });
  it('does not borrow invoice import, Automation or supplier document gates',async()=>{
    for(const key of ['INTERNATIONAL_CORE_ENABLED','INTERNATIONAL_US_ERP_ENABLED','INTERNATIONAL_US_SUPPORT_WORKSPACES_ENABLED','INTERNATIONAL_US_SUPPORT_MAILBOX_ENABLED','INTERNATIONAL_US_SUPPORT_TRIAGE_ENABLED'])runtime.env[key]='true';
    expect(await usSupportTriageEnabled()).toBe(true);
  });
  it('rejects both routes while closed before attempting Auth, storage, keys or provider IO',async()=>{
    const org='11111111-1111-4111-8111-111111111111', url=`https://zentra.test/api/international/workspaces/${org}/support-mailbox/triage`;
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const get=await usSupportTriageHandlers.read(new Request(url),org);
      const post=await usSupportTriageHandlers.triage(new Request(url,{method:'POST',body:'{}'}),org);
      expect(get.status).toBe(404);expect(post.status).toBe(404);
      expect(await get.json()).toEqual({error:'feature_unavailable'});
      expect(await post.json()).toEqual({error:'feature_unavailable'});
    } finally {warn.mockRestore();}
  });
});
