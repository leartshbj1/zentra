import {beforeEach,expect,it,vi} from 'vitest';
import {SupportError} from './types';
const mocks=vi.hoisted(()=>({mail:vi.fn(),authorize:vi.fn(),workflows:vi.fn(),cycle:vi.fn(),start:vi.fn(),finish:vi.fn(),health:vi.fn()}));
vi.mock('@/lib/runtime',()=>({database:()=>{throw new Error('No database expected in route test');},runtimeValue:()=>''}));
vi.mock('@/app/zentra-auth',()=>({getZentraUser:async()=>null}));
vi.mock('./mail-sync',()=>({runMailSync:mocks.mail,requireMailScheduler:mocks.authorize}));
vi.mock('@/lib/scheduler-health',()=>({startSchedulerHeartbeat:mocks.start,finishSchedulerHeartbeat:mocks.finish,readSchedulerHealth:mocks.health}));
vi.mock('@/lib/automation/workflows',()=>({runDueWorkflows:mocks.workflows}));
vi.mock('@/lib/service-diagnostics',()=>({reportSchedulerCycle:mocks.cycle,reportServiceFailure:()=>undefined}));
import {POST,GET} from '@/app/api/support/mail-sync/route';
const request=()=>new Request('https://zentraapp.ch/api/support/mail-sync',{method:'POST'});
beforeEach(()=>{vi.resetAllMocks();mocks.authorize.mockResolvedValue(undefined);mocks.start.mockResolvedValue(true);mocks.workflows.mockResolvedValue({checked:0,failed:0,interrupted:0,more:false});});
it('never processes or reports a successful heartbeat after refused scheduler authentication',async()=>{
  mocks.authorize.mockRejectedValue(new SupportError('Accès refusé.',401));
  const response=await POST(request());
  expect(response.status).toBe(401);
  expect(mocks.workflows).not.toHaveBeenCalled();
  expect(mocks.cycle).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.finish).not.toHaveBeenCalled();
  expect(mocks.mail).not.toHaveBeenCalled();
});
it('records idle only when both mailbox and Automation have no ready work',async()=>{
  mocks.mail.mockResolvedValue({idle:true});
  expect((await POST(request())).status).toBe(200);
  expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({outcome:'idle',workflowsChecked:0}));
  expect(mocks.finish).toHaveBeenCalledWith('idle',undefined);
});
it('keeps the scheduler running without new mail until all due workflows have been checked',async()=>{
  mocks.mail.mockResolvedValue({idle:true});
  mocks.workflows.mockResolvedValue({checked:20,failed:0,interrupted:0,more:true});
  const response=await POST(request());
  expect(await response.json()).toMatchObject({idle:false,failed:false,workflows:{checked:20,more:true}});
  expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({outcome:'partial',workflowsChecked:20}));
});
it('reports completed Automation work rather than idle when the last ready batch finishes',async()=>{
  mocks.mail.mockResolvedValue({idle:true});
  mocks.workflows.mockResolvedValue({checked:2,failed:0,interrupted:0,more:false});
  expect(await (await POST(request())).json()).toMatchObject({idle:false,failed:false});
  expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({outcome:'completed',workflowsChecked:2}));
});
it.each([{failed:1,interrupted:0},{failed:0,interrupted:1}])('reports workflow errors and expired workers even when mail is idle: %j',async counts=>{
  mocks.mail.mockResolvedValue({idle:true});
  mocks.workflows.mockResolvedValue({checked:0,more:false,...counts});
  expect(await (await POST(request())).json()).toMatchObject({idle:false,failed:true,workflows:counts});
  expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({outcome:'failed',workflowsFailed:counts.failed,workflowsInterrupted:counts.interrupted}));
});
it('retains fair workflow processing when one mailbox failed, without reporting success',async()=>{
  mocks.mail.mockResolvedValue({idle:false,failed:true,reference:'6b7b8220-4b90-4e24-a2c4-e9c5d64e1f01'});
  const response=await POST(request());
  expect(await response.json()).toMatchObject({failed:true});
  expect(mocks.workflows).toHaveBeenCalledOnce();
  expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({outcome:'failed',reference:'6b7b8220-4b90-4e24-a2c4-e9c5d64e1f01'}));
});
it('distinguishes deferred document capture from a completely processed batch',async()=>{
  mocks.mail.mockResolvedValue({idle:false,imported:3,processed:2,incomplete:true});
  await POST(request());
  expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({outcome:'partial',imported:3,processed:2}));
});
it('records an interrupted workflow cycle as failed, with its error HTTP status',async()=>{
  mocks.mail.mockResolvedValue({idle:true});
  mocks.workflows.mockRejectedValue(new SupportError('Réessayez.',503));
  expect((await POST(request())).status).toBe(503);
  expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({outcome:'failed'}));
  expect(mocks.finish).toHaveBeenCalledWith('failed',undefined);
});
it('continues useful work when heartbeat storage is unavailable',async()=>{
  mocks.start.mockResolvedValue(false);
  mocks.mail.mockResolvedValue({idle:false,imported:1});
  expect((await POST(request())).status).toBe(200);
  expect(mocks.mail).toHaveBeenCalledOnce();
  expect(mocks.workflows).toHaveBeenCalledOnce();
  expect(mocks.finish).not.toHaveBeenCalled();
});
it('never exposes health to an unauthenticated monitor',async()=>{
  mocks.authorize.mockRejectedValue(new SupportError('Accès refusé.',401));
  expect((await GET(request())).status).toBe(401);
  expect(mocks.health).not.toHaveBeenCalled();
});
it.each([true,false])('reads monitor health without starting work (background=%s)',async(background)=>{
  mocks.health.mockResolvedValue({background,state:background?'current':'delayed'});
  const response=await GET(request());
  expect(response.status).toBe(background?200:503);
  expect(await response.json()).toMatchObject({background});
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.finish).not.toHaveBeenCalled();
  expect(mocks.mail).not.toHaveBeenCalled();
  expect(mocks.workflows).not.toHaveBeenCalled();
});
it.each([{paused:true},{syncing:true},{more:true}])('does not count a deferred or ongoing batch as completed: %j',async result=>{
  mocks.mail.mockResolvedValue({idle:false,...result});
  await POST(request());
  expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({outcome:'partial'}));
});
