import {beforeEach,expect,it,vi} from 'vitest';
import {SupportError} from './types';
const mocks=vi.hoisted(()=>({mail:vi.fn(),workflows:vi.fn(),cycle:vi.fn()}));
vi.mock('@/lib/runtime',()=>({database:()=>{throw new Error('No database expected in route test');},runtimeValue:()=>''}));
vi.mock('@/app/zentra-auth',()=>({getZentraUser:async()=>null}));
vi.mock('./mail-sync',()=>({runMailSync:mocks.mail}));
vi.mock('@/lib/automation/workflows',()=>({runDueWorkflows:mocks.workflows}));
vi.mock('@/lib/service-diagnostics',()=>({reportSchedulerCycle:mocks.cycle,reportServiceFailure:()=>undefined}));
import {POST} from '@/app/api/support/mail-sync/route';
const request=()=>new Request('https://zentraapp.ch/api/support/mail-sync',{method:'POST'});
beforeEach(()=>{vi.clearAllMocks();mocks.workflows.mockResolvedValue({checked:2});});
it('never processes or reports a successful heartbeat after refused scheduler authentication',async()=>{
  mocks.mail.mockRejectedValue(new SupportError('Accès refusé.',401));
  const response=await POST(request());
  expect(response.status).toBe(401);
  expect(mocks.workflows).not.toHaveBeenCalled();
  expect(mocks.cycle).not.toHaveBeenCalled();
});
it('records a real authenticated idle invocation, separately from checked workflows',async()=>{
  mocks.mail.mockResolvedValue({idle:true});
  expect((await POST(request())).status).toBe(200);
  expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({outcome:'idle',workflowsChecked:2}));
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
});
it.each([{paused:true},{syncing:true},{more:true}])('does not count a deferred or ongoing batch as completed: %j',async result=>{
  mocks.mail.mockResolvedValue({idle:false,...result});
  await POST(request());
  expect(mocks.cycle).toHaveBeenCalledWith(expect.objectContaining({outcome:'partial'}));
});
