import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { startCompanyRealtime, type CompanyRevisionNotice } from './companyRealtime';
describe('company realtime lifecycle',()=>{
  beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
  it('reports a failed or unavailable notification channel so fallback checks resume',async()=>{
    const onHealth=vi.fn();const watch=vi.fn().mockResolvedValueOnce({enabled:true,realtime:true,revision:1}).mockRejectedValueOnce(new Error('socket lost')).mockResolvedValueOnce({enabled:true,realtime:false,revision:1});
    const loop=startCompanyRealtime({watch,onHealth,onRevision:vi.fn(),available:()=>true});
    await vi.advanceTimersByTimeAsync(1000);expect(onHealth).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(250);expect(onHealth).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(5000);expect(onHealth).toHaveBeenLastCalledWith(false);loop.stop();
  });
  it('keeps one watch and ignores a response after logout',async()=>{
    let resolve!:(n:CompanyRevisionNotice)=>void;
    const watch=vi.fn(()=>new Promise<CompanyRevisionNotice>(r=>{resolve=r;})),onRevision=vi.fn();
    const loop=startCompanyRealtime({watch,onRevision,available:()=>true});
    await vi.advanceTimersByTimeAsync(1000); for(let i=0;i<10;i++)loop.wake();
    await vi.advanceTimersByTimeAsync(10000);expect(watch).toHaveBeenCalledTimes(1);
    loop.stop();resolve({enabled:true,revision:2,changed:true,realtime:true});
    await vi.advanceTimersByTimeAsync(1000);expect(onRevision).not.toHaveBeenCalled();
  });
  it('passes the observed revision and pauses offline, then resumes on return',async()=>{
    let available=true;
    const watch=vi.fn(async()=>({enabled:true,organizationId:'one',revision:4,changed:true,realtime:true})),onRevision=vi.fn();
    const loop=startCompanyRealtime({watch,onRevision,available:()=>available});
    await vi.advanceTimersByTimeAsync(1000);expect(onRevision).toHaveBeenCalledTimes(1);
    available=false;await vi.advanceTimersByTimeAsync(10000);expect(watch).toHaveBeenCalledTimes(1);
    available=true;loop.wake();await vi.advanceTimersByTimeAsync(250);expect(watch).toHaveBeenLastCalledWith(4);loop.stop();
  });
  it('backs off errors without stopping the durable synchronization scheduler',async()=>{
    const watch=vi.fn(async()=>{throw new Error('offline');});
    const loop=startCompanyRealtime({watch,onRevision:vi.fn(),available:()=>true});
    await vi.advanceTimersByTimeAsync(1000);await vi.advanceTimersByTimeAsync(4999);expect(watch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(watch).toHaveBeenCalledTimes(2);loop.stop();
  });
});
