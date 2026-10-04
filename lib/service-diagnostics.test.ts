import {afterEach, describe, expect, it, vi} from 'vitest';
import {reportServiceFailure,reportSchedulerCycle,markMailSyncFailure,mailSyncFailureStage,type MailSyncFailureStage} from './service-diagnostics';
import {SupabaseServerError,createSupabaseServerClient} from './supabase-server';
import {AccountPublicError} from './account-security';
import {SupportError} from './support/types';

afterEach(()=>vi.restoreAllMocks());
describe('private actionable service diagnostics',()=>{
  it('records the exact upstream status/code and safe relation with a correlation id',()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const ref=reportServiceFailure(new SupabaseServerError(404,'PGRST205','/rest/v1/zentra_workspaces'),{
      operation:'company.watch',startedAt:Date.now()-12,
      request:new Request('https://zentraapp.ch/api/account/collaboration?watch=66',{headers:{'User-Agent':'Zentra/1.90.0','Authorization':'Bearer private-session'}}),
    });
    expect(ref).toMatch(/^[a-f0-9-]{36}$/);
    expect(log).toHaveBeenCalledWith('zentra_service_failure',expect.objectContaining({reference:ref,operation:'company.watch',upstreamStatus:404,upstreamCode:'PGRST205',resource:'/rest/v1/zentra_workspaces',clientVersion:'1.90.0'}));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-session|watch=66|zentraapp.ch/);
  });
  it('never logs a sensitive error body, query, arbitrary code or client supplied URL',()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const error=new SupabaseServerError(403,'sb_secret_privatekey','/rest/v1/x?email=private@example.test');
    error.message='Password: customer-secret';
    reportServiceFailure(error,{operation:'https://secret.invalid',request:new Request('https://zentraapp.ch/?email=private@example.test',{headers:{'User-Agent':'private@example.test'}})});
    reportServiceFailure(new Error('Email private@example.test and token eyJ-private'),{operation:'automation.background'});
    const serialized=JSON.stringify(log.mock.calls);
    expect(serialized).not.toMatch(/private|customer-secret|secret.invalid|eyJ/);
    expect(log.mock.calls[0][1]).toMatchObject({operation:'unknown',upstreamStatus:403});
  });
  it('does not turn invalid inputs, refused access or a disconnected watch into incident noise',()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    expect(reportServiceFailure(new AccountPublicError('refused',401),{operation:'company.read'})).toBeUndefined();
    expect(reportServiceFailure(new SupportError('private-email subscription expired',403),{operation:'support.scheduler'})).toBeUndefined();
    const controller=new AbortController();controller.abort();
    expect(reportServiceFailure(new Error('aborted'),{operation:'company.watch',request:new Request('https://zentraapp.ch',{signal:controller.signal})})).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });
  it('records bounded scheduler facts without accepting secrets, arbitrary outcomes or invalid counters',()=>{
    const log=vi.spyOn(console,'info').mockImplementation(()=>{});
    reportSchedulerCycle({startedAt:Date.now()-5,outcome:'failed',imported:3,processed:2,workflowsChecked:4,workflowsFailed:1,workflowsInterrupted:2});
    expect(log).toHaveBeenCalledWith('zentra_scheduler_cycle',expect.objectContaining({job:'support.mail',outcome:'failed',imported:3,processed:2,workflowsChecked:4,workflowsFailed:1,workflowsInterrupted:2}));
    reportSchedulerCycle({startedAt:NaN,outcome:'private-secret' as 'failed',processed:-1,imported:Infinity,workflowsFailed:-1,workflowsInterrupted:NaN,reference:'email@private.test'});
    const serialized=JSON.stringify(log.mock.calls[1]);
    expect(serialized).not.toMatch(/private|Infinity/);
    expect(log.mock.calls[1][1]).toMatchObject({outcome:'failed',durationMs:0});
    expect(log.mock.calls[1][1].workflowsFailed).toBeUndefined();
    expect(log.mock.calls[1][1].workflowsInterrupted).toBeUndefined();
  });
  it('strips filters from failed database requests and never follows a credential redirect',async()=>{
    const fetcher=vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async()=>Response.json({code:'PGRST205',message:'private@example.test'},{status:404}));
    const client=createSupabaseServerClient({url:'https://example.supabase.co',secretKey:'sb_secret_'+ 'a'.repeat(32)},fetcher);
    await expect(client.select('zentra_workspaces',{organization_id:'eq.private-company'})).rejects.toMatchObject({status:404,code:'PGRST205',resource:'/rest/v1/zentra_workspaces'});
    expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:'manual'});
  });
  it('keeps the first closed mailbox stage on frozen errors without copying their contents',()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const error=Object.freeze(new Error('private-password mailbox@example.test'));
    expect(markMailSyncFailure(error,'read')).toBe(error);
    markMailSyncFailure(error,'finalize');
    expect(mailSyncFailureStage(error)).toBe('read');
    reportServiceFailure(error,{operation:'support.mailbox.sync',mailStage:'lookup'});
    expect(log.mock.calls[0][1]).toMatchObject({mailStage:'read',kind:'internal'});
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-password|mailbox@example/);
  });
  it('logs only a valid numeric status from a real SupportError at a known worker stage',()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    reportServiceFailure(markMailSyncFailure(new SupportError('private-password',503),'open'),{operation:'support.mailbox.sync'});
    expect(log.mock.calls[0][1]).toMatchObject({mailStage:'open',supportStatus:503});
    reportServiceFailure({status:503,message:'private-password',mailStage:'read'},{operation:'support.mailbox.sync',mailStage:'list'});
    expect(log.mock.calls[1][1]).toMatchObject({mailStage:'list'});
    expect(log.mock.calls[1][1].supportStatus).toBeUndefined();
    reportServiceFailure(markMailSyncFailure(new SupportError('private-password',700),'decrypt'),{operation:'support.mailbox.sync'});
    expect(log.mock.calls[2][1].supportStatus).toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-password/);
  });
  it('rejects arbitrary stages and primitive annotations while retaining upstream diagnostics',()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const error=new SupabaseServerError(503,'network_error','/rest/v1/support_mailboxes');
    markMailSyncFailure(error,'https://private.invalid/mailbox@example.test' as MailSyncFailureStage);
    expect(mailSyncFailureStage(error)).toBeUndefined();
    expect(markMailSyncFailure('private-password','open')).toBe('private-password');
    expect(mailSyncFailureStage('private-password')).toBeUndefined();
    reportServiceFailure(error,{operation:'support.mailbox.sync',mailStage:'private-password' as MailSyncFailureStage});
    expect(log.mock.calls[0][1]).toMatchObject({upstreamStatus:503,upstreamCode:'network_error',resource:'/rest/v1/support_mailboxes'});
    expect(log.mock.calls[0][1].mailStage).toBeUndefined();
    expect(log.mock.calls[0][1].supportStatus).toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-password|private.invalid|mailbox@example/);
  });
  it('still suppresses expected refusals and disconnected requests after a stage is recorded',()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    expect(reportServiceFailure(markMailSyncFailure(new SupportError('private subscription',403),'subscription'),{operation:'support.mailbox.sync'})).toBeUndefined();
    const controller=new AbortController();controller.abort();
    expect(reportServiceFailure(markMailSyncFailure(new SupportError('private connection',503),'open'),{operation:'support.mailbox.sync',request:new Request('https://zentraapp.ch',{signal:controller.signal})})).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });
});
