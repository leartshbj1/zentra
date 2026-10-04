import {afterEach,describe,expect,it,vi} from 'vitest';
import {createSchedulerProgress,SCHEDULER_PROGRESS_PHASES,type SchedulerProgressPhase,type MailSyncTransport} from './service-diagnostics';

afterEach(()=>vi.restoreAllMocks());
describe('closed scheduler progress without inspecting operation data',()=>{
  it.each(SCHEDULER_PROGRESS_PHASES)('emits %s before blocked work and completes only after it settles',async phase=>{
    const log=vi.spyOn(console,'info').mockImplementation(()=>{});
    let time=100;vi.spyOn(Date,'now').mockImplementation(()=>time);
    const track=createSchedulerProgress();
    let release!:()=>void;let done=false;
    const privateResult={mail:'private@example.test',password:'private-password',url:'https://private.invalid/?signature=private-signature'};
    const work=vi.fn(async()=>{await new Promise<void>(resolve=>{release=resolve;});return privateResult;});
    const promise=track(phase,work,'imap').then(value=>{done=true;return value;});
    expect(log).toHaveBeenCalledTimes(1);
    const begin=log.mock.calls[0][1];
    expect(begin).toMatchObject({phase,boundary:'begin',sequence:1,startedAtMs:100,mailTransport:'imap'});
    expect(begin.reference).toMatch(/^[a-f0-9-]{36}$/);
    expect(begin.wallDurationMs).toBeUndefined();expect(done).toBe(false);
    time=145;release();expect(await promise).toBe(privateResult);
    expect(work).toHaveBeenCalledOnce();
    expect(log.mock.calls[1][1]).toMatchObject({reference:begin.reference,phase,boundary:'end',sequence:1,wallDurationMs:45});
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|signature|password|https:/);
  });
  it.each(SCHEDULER_PROGRESS_PHASES)('preserves the exact %s failure and logs no exception contents',async phase=>{
    const log=vi.spyOn(console,'info').mockImplementation(()=>{});
    let time=200;vi.spyOn(Date,'now').mockImplementation(()=>time);
    const error=Object.freeze(new Error('private-email@example.test private-token https://private.invalid'));
    const track=createSchedulerProgress(),work=vi.fn(async()=>{time=275;throw error;});
    await expect(track(phase,work,'api')).rejects.toBe(error);
    expect(work).toHaveBeenCalledOnce();expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][1]).toMatchObject({phase,boundary:'failed',sequence:1,wallDurationMs:75,mailTransport:'api'});
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|token|https:/);
  });
  it('shares only an opaque trace with increasing phase sequence, and separates another operation',async()=>{
    const log=vi.spyOn(console,'info').mockImplementation(()=>{}),first=createSchedulerProgress(),second=createSchedulerProgress();
    await first('mail.prepare',async()=>1);await first('mail.capture',async()=>2);await second('workflows',async()=>3);
    expect(log.mock.calls[0][1].reference).toBe(log.mock.calls[2][1].reference);
    expect(log.mock.calls[2][1].sequence).toBe(2);
    expect(log.mock.calls[4][1].reference).not.toBe(log.mock.calls[0][1].reference);
    expect(log.mock.calls[4][1].sequence).toBe(1);
  });
  it('rejects arbitrary stages and transports rather than logging caller strings',async()=>{
    const log=vi.spyOn(console,'info').mockImplementation(()=>{}),track=createSchedulerProgress();
    expect(await track('private@example.test' as SchedulerProgressPhase,async()=>7)).toBe(7);
    expect(log).not.toHaveBeenCalled();
    await track('mail.prepare',async()=>8,'https://private.invalid' as MailSyncTransport);
    expect(log.mock.calls[0][1].mailTransport).toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|https:/);
    expect(Object.keys(log.mock.calls[0][1]).sort()).toEqual(['boundary','job','phase','reference','sequence','startedAtMs']);
  });
  it('does not allow a failed logger to change the result or mask a failure',async()=>{
    vi.spyOn(console,'info').mockImplementation(()=>{throw Error('logger unavailable');});
    const track=createSchedulerProgress(),value=Object.freeze({saved:true}),error=Object.freeze(new Error('operation failure'));
    const good=vi.fn(async()=>value),bad=vi.fn(async()=>{throw error;});
    expect(await track('mail.capture',good)).toBe(value);await expect(track('workflows',bad)).rejects.toBe(error);
    expect(good).toHaveBeenCalledOnce();expect(bad).toHaveBeenCalledOnce();
  });
  it.each(['throws','invalid'] as const)('does useful work with disabled diagnostics when UUID generation %s',async mode=>{
    const log=vi.spyOn(console,'info').mockImplementation(()=>{});
    const generate=vi.spyOn(crypto,'randomUUID');
    if(mode==='throws')generate.mockImplementation(()=>{throw Error('unavailable');});
    else generate.mockReturnValue('private@example.test' as ReturnType<typeof crypto.randomUUID>);
    expect(await createSchedulerProgress()('mail.prepare',async()=>true)).toBe(true);expect(log).not.toHaveBeenCalled();
  });
  it('does not manufacture duration or resource measurements when clock is invalid or moves backwards',async()=>{
    const log=vi.spyOn(console,'info').mockImplementation(()=>{});
    vi.spyOn(Date,'now').mockReturnValueOnce(NaN).mockReturnValueOnce(200).mockReturnValueOnce(100);
    const track=createSchedulerProgress();await track('mail.prepare',async()=>true);await track('mail.capture',async()=>true);
    expect(log.mock.calls[0][1].startedAtMs).toBeUndefined();expect(log.mock.calls[1][1].wallDurationMs).toBeUndefined();
    expect(log.mock.calls[3][1].wallDurationMs).toBeUndefined();
    for(const [,entry] of log.mock.calls)for(const field of ['cpuTimeMs','memoryBytes','cost','tokens'])expect(entry[field]).toBeUndefined();
  });
});
