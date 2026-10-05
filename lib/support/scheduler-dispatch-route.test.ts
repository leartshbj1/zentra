import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {SupportError} from './types';
const mocks=vi.hoisted(()=>({auth:vi.fn(),demand:vi.fn(),start:vi.fn(),finish:vi.fn()}));
vi.mock('@/lib/runtime',()=>({database:()=>{throw new Error('No DB/provider call in private probe route test');},runtimeValue:()=>''}));
vi.mock('@/app/zentra-auth',()=>({getZentraUser:async()=>null}));
vi.mock('./mail-sync',()=>({requireMailScheduler:mocks.auth}));
vi.mock('./scheduler-dispatch',()=>({readSchedulerDemand:mocks.demand}));
vi.mock('@/lib/scheduler-health',()=>({startSchedulerHeartbeat:mocks.start,finishSchedulerHeartbeat:mocks.finish}));
vi.mock('@/lib/service-diagnostics',()=>({reportServiceFailure:()=>undefined}));
import {POST} from '@/app/api/support/mail-sync/dispatch/route';
const request=()=>new Request('https://zentraapp.ch/api/support/mail-sync/dispatch',{method:'POST'});
const plan=(desiredWorkers=0,activeMailboxes=0,activeWorkflows=0)=>({protocol:'zentra-scheduler-demand',version:1,
  observedAt:1_800_000_000,desiredWorkers,mailboxesDue:desiredWorkers,workflowsDue:0,expiredWorkflows:0,activeMailboxes,activeWorkflows});
beforeEach(()=>{vi.resetAllMocks();mocks.auth.mockResolvedValue(undefined);mocks.demand.mockResolvedValue({plan:plan()});mocks.start.mockResolvedValue('synthetic-idle-heartbeat');});
afterEach(()=>vi.restoreAllMocks());
it('authenticates before reading any D1 queue or recording an idle heartbeat',async()=>{
  mocks.auth.mockRejectedValue(new SupportError('Accès refusé.',401));
  expect((await POST(request())).status).toBe(401);
  expect(mocks.demand).not.toHaveBeenCalled();expect(mocks.start).not.toHaveBeenCalled();
});
it('returns only the closed plan and records a genuine idle heartbeat without claiming work',async()=>{
  const response=await POST(request());expect(await response.json()).toEqual(plan());
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(mocks.finish).toHaveBeenCalledWith('synthetic-idle-heartbeat','idle');
});
it.each([[1,0,0],[8,0,0],[0,1,0],[0,0,1]])('never reports planned or active work as successfully processed (%i,%i,%i)',async(a,b,c)=>{
  mocks.demand.mockResolvedValue({plan:plan(a,b,c)});
  expect(await (await POST(request())).json()).toEqual(plan(a,b,c));
  expect(mocks.start).not.toHaveBeenCalled();expect(mocks.finish).not.toHaveBeenCalled();
});
it('fails closed on an unavailable queue without inventing eight fallback workers',async()=>{
  mocks.demand.mockRejectedValue(new Error('private query metadata'));
  const response=await POST(request());expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('private query metadata');expect(mocks.start).not.toHaveBeenCalled();
});
it('continues a read-only empty admission when best-effort heartbeat storage is unavailable',async()=>{
  mocks.start.mockResolvedValue(null);expect(await (await POST(request())).json()).toEqual(plan());
  expect(mocks.finish).not.toHaveBeenCalled();
});
