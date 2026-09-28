import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announceCompanyRevision, watchCompanyRevision } from './company-realtime';
class FakeSocket extends EventTarget {
  accepted=false;
  accept=vi.fn(()=>{this.accepted=true;}); send=vi.fn();
  close=vi.fn(()=>{if(!this.accepted)throw new Error('Socket must be accepted before close');});
  message(event:string,payload:unknown,topic='realtime:zentra:company:one',ref?:string) {
    this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({topic,event,payload,ref})}));
  }
}
const configuration={url:'https://example.supabase.co',secretKey:'test-server-only'};
function fixture(organization='one') {
  const socket=new FakeSocket(),controller=new AbortController(); let revision=1;
  const head=vi.fn(async()=>({organizationId:organization,revision,enabled:true}));
  const fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
    if(init?.redirect==='error')throw new TypeError('Unsupported redirect mode on Workers');
    return {webSocket:socket} as unknown as Response;
  });
  const watch=watchCompanyRevision(organization,1,controller.signal,{configuration,head,fetch:fetcher});
  return {socket,controller,head,fetcher,watch,change:(next:number)=>{revision=next;}};
}
describe('private realtime company notifications',()=>{
  beforeEach(()=>vi.useFakeTimers()); afterEach(()=>{vi.useRealTimers();});
  it('closes the read/subscribe race and returns only durable revisions',async()=>{
    const f=fixture(); await vi.advanceTimersByTimeAsync(0);
    f.change(2); f.socket.message('phx_reply',{status:'ok'},undefined,'join');
    expect(await f.watch).toEqual({organizationId:'one',revision:2,enabled:true,realtime:true});
    expect(f.socket.close).toHaveBeenCalledTimes(1);
    expect(f.head).toHaveBeenCalledTimes(2);
  });
  it('ignores repeated join acknowledgements instead of multiplying durable reads',async()=>{
    const f=fixture(); await vi.advanceTimersByTimeAsync(0);
    for(let i=0;i<100;i++)f.socket.message('phx_reply',{status:'ok'},undefined,'join');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.head).toHaveBeenCalledTimes(2);
    f.change(2);f.socket.message('broadcast',{event:'revision',payload:{revision:2}});
    await f.watch;expect(f.head).toHaveBeenCalledTimes(3);
  });
  it('releases the subscription before a slow final durable read finishes',async()=>{
    const f=fixture();await vi.advanceTimersByTimeAsync(0);
    f.socket.message('phx_reply',{status:'ok'},undefined,'join');await vi.advanceTimersByTimeAsync(0);
    let resolve!: (value:Awaited<ReturnType<typeof f.head>>)=>void;
    f.head.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    f.socket.message('broadcast',{event:'revision',payload:{revision:2}});
    await vi.advanceTimersByTimeAsync(0);
    expect(f.socket.close).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
    f.socket.message('phx_reply',{status:'ok'},undefined,'join');
    expect(f.head).toHaveBeenCalledTimes(3);
    resolve({organizationId:'one',revision:2,enabled:true});
    expect((await f.watch).revision).toBe(2);
  });
  it('does not start a private subscription after an abort during the first read',async()=>{
    const controller=new AbortController(),fetcher=vi.fn();
    let resolve!: (value:{organizationId:string;revision:number;enabled:boolean})=>void;
    const head=vi.fn(()=>new Promise<{organizationId:string;revision:number;enabled:boolean}>(done=>{resolve=done;}));
    const watch=watchCompanyRevision('one',1,controller.signal,{configuration,head,fetch:fetcher});
    const rejected=expect(watch).rejects.toThrow();
    controller.abort();resolve({organizationId:'one',revision:1,enabled:true});await rejected;
    expect(fetcher).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it('cannot restart reads from a late socket acknowledgement after cancellation',async()=>{
    const f=fixture();const rejected=expect(f.watch).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);f.controller.abort();await rejected;
    f.socket.message('phx_reply',{status:'ok'},undefined,'join');await vi.advanceTimersByTimeAsync(0);
    expect(f.head).toHaveBeenCalledTimes(1);
  });
  it('includes handshake time in the 25 second subscription budget',async()=>{
    const socket=new FakeSocket(),controller=new AbortController();
    const head=vi.fn(async()=>({organizationId:'one',revision:1,enabled:true}));
    const fetcher=vi.fn(async()=>{await new Promise(done=>setTimeout(done,4000));return {webSocket:socket} as unknown as Response;});
    const watch=watchCompanyRevision('one',1,controller.signal,{configuration,head,fetch:fetcher});
    await vi.advanceTimersByTimeAsync(4000);socket.message('phx_reply',{status:'ok'},undefined,'join');
    await vi.advanceTimersByTimeAsync(21_000);
    expect(socket.close).toHaveBeenCalledTimes(1);expect((await watch).revision).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a pending handshake when an earlier slow read exhausts the watch budget',async()=>{
    const controller=new AbortController();
    const head=vi.fn(async()=>{
      await new Promise(done=>setTimeout(done,24_000));
      return {organizationId:'one',revision:1,enabled:true};
    });
    let handshakeSignal:AbortSignal|undefined;
    const fetcher=vi.fn((_url:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      handshakeSignal=init?.signal??undefined;
      handshakeSignal?.addEventListener('abort',()=>reject(handshakeSignal?.reason),{once:true});
    }));
    const watch=watchCompanyRevision('one',1,controller.signal,{configuration,head,fetch:fetcher});
    const rejected=expect(watch).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(25_000);await rejected;
    expect(handshakeSignal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
  });
  it('ends immediately if the company is disabled during subscription setup',async()=>{
    const f=fixture();await vi.advanceTimersByTimeAsync(0);
    f.head.mockResolvedValueOnce({organizationId:'one',revision:0,enabled:false});
    f.socket.message('phx_reply',{status:'ok'},undefined,'join');await vi.advanceTimersByTimeAsync(0);
    expect(f.socket.close).toHaveBeenCalledTimes(1);
    expect(await f.watch).toEqual({organizationId:'one',revision:0,enabled:false,realtime:true});
  });
  it('accepts and closes a handshake response arriving after cancellation',async()=>{
    const socket=new FakeSocket(),controller=new AbortController();
    const head=vi.fn(async()=>({organizationId:'one',revision:1,enabled:true}));
    const fetcher=vi.fn(async()=>{controller.abort();return {webSocket:socket} as unknown as Response;});
    await expect(watchCompanyRevision('one',1,controller.signal,{configuration,head,fetch:fetcher})).rejects.toThrow();
    expect(socket.accept).toHaveBeenCalledTimes(1);expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.accept.mock.invocationCallOrder[0]).toBeLessThan(socket.close.mock.invocationCallOrder[0]);
    expect(socket.send).not.toHaveBeenCalled();expect(head).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('accepts and closes a late handshake after the watch budget expires',async()=>{
    const socket=new FakeSocket(),controller=new AbortController();
    const head=vi.fn(async()=>({organizationId:'one',revision:1,enabled:true}));
    head.mockImplementationOnce(async()=>{await new Promise(done=>setTimeout(done,24_000));return {organizationId:'one',revision:1,enabled:true};});
    // A transport response can win its own completion race despite abort.
    const fetcher=vi.fn(async()=>{await new Promise(done=>setTimeout(done,1100));return {webSocket:socket} as unknown as Response;});
    const watch=watchCompanyRevision('one',1,controller.signal,{configuration,head,fetch:fetcher});
    await vi.advanceTimersByTimeAsync(25_100);
    expect(await watch).toEqual({organizationId:'one',revision:1,enabled:true,realtime:false});
    expect(socket.accept).toHaveBeenCalledTimes(1);expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.accept.mock.invocationCallOrder[0]).toBeLessThan(socket.close.mock.invocationCallOrder[0]);
    expect(socket.send).not.toHaveBeenCalled();expect(head).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never substitutes an older in-flight join read for a fresh broadcast read',async()=>{
    const f=fixture();await vi.advanceTimersByTimeAsync(0);
    let resolveJoin!: (value:Awaited<ReturnType<typeof f.head>>)=>void;
    f.head.mockImplementationOnce(()=>new Promise(done=>{resolveJoin=done;}));
    f.socket.message('phx_reply',{status:'ok'},undefined,'join');
    f.change(3);f.socket.message('broadcast',{event:'revision',payload:{revision:3}});
    expect((await f.watch).revision).toBe(3);
    resolveJoin({organizationId:'one',revision:2,enabled:true});await vi.advanceTimersByTimeAsync(0);
    expect(f.head).toHaveBeenCalledTimes(3);expect(f.socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps 450 simulated watches isolated and recovers dropped notices without leaked timers',async()=>{
    // 150 companies, 3 devices each. This verifies request lifecycle/isolation;
    // it is not a production capacity or latency benchmark.
    const clients=Array.from({length:450},(_,index)=>{
      const organization=`company-${Math.floor(index/3)}`;
      return {...fixture(organization),organization,topic:`realtime:zentra:company:${organization}`};
    });
    await vi.advanceTimersByTimeAsync(0);
    for(const f of clients) {
      for(let i=0;i<3;i++)f.socket.message('phx_reply',{status:'ok'},f.topic,'join');
      f.socket.message('broadcast',{event:'revision',payload:{revision:999}},'realtime:zentra:company:unrelated');
    }
    await vi.advanceTimersByTimeAsync(0);
    for(const f of clients) {
      expect(f.head).toHaveBeenCalledTimes(2);expect(f.socket.close).not.toHaveBeenCalled();f.change(2);
    }
    for(const [index,f] of clients.entries()) {
      if(index%2===0)f.socket.message('broadcast',{event:'revision',payload:{revision:999}},f.topic);
    }
    await vi.advanceTimersByTimeAsync(25_000);
    const heads=await Promise.all(clients.map(f=>f.watch));
    for(const [index,f] of clients.entries()) {
      expect(heads[index]).toEqual({organizationId:f.organization,revision:2,enabled:true,realtime:true});
      expect(f.head).toHaveBeenCalledTimes(3);expect(f.socket.close).toHaveBeenCalledTimes(1);
    }
    expect(vi.getTimerCount()).toBe(0);
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
  it('marks a closed subscription unhealthy even after it successfully joined',async()=>{
    const f=fixture();await vi.advanceTimersByTimeAsync(0);
    f.socket.message('phx_reply',{status:'ok'},undefined,'join');await vi.advanceTimersByTimeAsync(0);
    f.socket.dispatchEvent(new Event('close'));
    expect((await f.watch).realtime).toBe(false);expect(vi.getTimerCount()).toBe(0);
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
