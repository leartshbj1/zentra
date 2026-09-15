import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announceCompanyRevision, watchCompanyRevision } from './company-realtime';
class FakeSocket extends EventTarget {
  accept=vi.fn(); send=vi.fn(); close=vi.fn();
  message(event:string,payload:unknown,topic='realtime:zentra:company:one',ref?:string) {
    this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({topic,event,payload,ref})}));
  }
}
const configuration={url:'https://example.supabase.co',secretKey:'test-server-only'};
function fixture() {
  const socket=new FakeSocket(),controller=new AbortController(); let revision=1;
  const head=vi.fn(async()=>({organizationId:'one',revision,enabled:true}));
  const fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
    if(init?.redirect==='error')throw new TypeError('Unsupported redirect mode on Workers');
    return {webSocket:socket} as unknown as Response;
  });
  const watch=watchCompanyRevision('one',1,controller.signal,{configuration,head,fetch:fetcher});
  return {socket,controller,head,fetcher,watch,change:(next:number)=>{revision=next;}};
}
describe('private realtime company notifications',()=>{
  beforeEach(()=>vi.useFakeTimers()); afterEach(()=>{vi.useRealTimers();});
  it('closes the read/subscribe race and returns only durable revisions',async()=>{
    const f=fixture(); await vi.advanceTimersByTimeAsync(0);
    f.change(2); f.socket.message('phx_reply',{status:'ok'},undefined,'join');
    expect(await f.watch).toEqual({organizationId:'one',revision:2,enabled:true,realtime:true});
    expect(f.socket.close).toHaveBeenCalledTimes(1);
  });
  it('wakes for the right company and ignores stale/forged payloads',async()=>{
    const f=fixture(); await vi.advanceTimersByTimeAsync(0);
    f.socket.message('phx_reply',{status:'ok'},undefined,'join');
    await vi.advanceTimersByTimeAsync(0);
    f.socket.message('broadcast',{event:'revision',payload:{revision:99}},'realtime:zentra:company:other');
    f.socket.message('broadcast',{event:'revision',payload:{revision:1}});
    await vi.advanceTimersByTimeAsync(50); expect(f.socket.close).not.toHaveBeenCalled();
    f.change(2); f.socket.message('broadcast',{event:'revision',payload:{revision:999}});
    expect((await f.watch).revision).toBe(2);
    expect(JSON.parse(f.socket.send.mock.calls[0][0] as string).payload.config.private).toBe(true);
  });
  it('recovers a missed broadcast at the bounded timeout',async()=>{
    const f=fixture(); await vi.advanceTimersByTimeAsync(0);
    f.socket.message('phx_reply',{status:'ok'},undefined,'join');
    await vi.advanceTimersByTimeAsync(10);f.change(3);
    await vi.advanceTimersByTimeAsync(25_000); expect((await f.watch).revision).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('closes the private subscription when the client disconnects',async()=>{
    const f=fixture(); const rejected=expect(f.watch).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0); f.controller.abort(); await rejected;
    expect(f.socket.close).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('broadcasts only a revision, with a server credential outside the body',async()=>{
    const send=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response(null,{status:202}));
    await announceCompanyRevision(configuration,'one',7,send);
    const init=send.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(init.body as string)).toEqual({messages:[{topic:'zentra:company:one',event:'revision',private:true,payload:{revision:7}}]});
    expect(init.body).not.toContain(configuration.secretKey);
  });
});
