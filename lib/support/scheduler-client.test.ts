import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

// Execute the actual bounded CI client with a fake HTTP endpoint. No token or
// mailbox is used; this protects its contract with the server response.
const workflow = readFileSync(new URL('../../.github/workflows/support-mail-sync.yml', import.meta.url), 'utf8');
const script = workflow.split("<<'JS'")[1]?.split(/\r?\n\s*JS\s*(?:\r?\n|$)/)[0];
if (!script) throw new Error('Scheduled mail client not found');

function run(results: (Record<string, unknown> | Response | Error)[], timings: number[] = []) {
  const log = vi.fn();
  let time = 0;
  const timeout = vi.fn((duration: number) => AbortSignal.timeout(duration));
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://zentraapp.ch/api/support/mail-sync');
    expect(init).toMatchObject({method:'POST',redirect:'error',headers:{Authorization:'Bearer fixture-only'}});
    const result = results.shift();
    if (!result) throw new Error('Unexpected extra scheduler request');
    time += timings.shift() ?? 0;
    if (result instanceof Error) throw result;
    if (result instanceof Response) return result;
    return Response.json(result);
  });
  const promise = runInNewContext(`(async()=>{${script}\n})()`, {
    process:{env:{SUPPORT_MAIL_SYNC_TOKEN:'fixture-only'}}, Date:{now:()=>time}, AbortSignal:{timeout},
    fetch:fetcher, console:{log},
  }) as Promise<void>;
  return {promise,log,fetcher,timeout};
}

it('drains workflow-only batches and stops after the server confirms both queues idle',async()=>{
  const {promise,log,fetcher}=run([
    {idle:false,failed:false,workflows:{checked:20,failed:0,interrupted:0,more:true}},
    {idle:false,failed:false,workflows:{checked:7,failed:0,interrupted:0,more:false}},
    {idle:true,failed:false,workflows:{checked:0,failed:0,interrupted:0,more:false}},
  ]);
  await promise;
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({failed:0,workflowsChecked:27});
  expect(JSON.stringify(log.mock.calls)).not.toContain('fixture-only');
});
it('continues healthy work after a failed batch but makes the scheduled job fail visibly',async()=>{
  const {promise,log,fetcher}=run([
    {idle:false,failed:true,workflows:{checked:2,failed:1,interrupted:1,more:true}},
    {idle:false,failed:false,imported:3,processed:2,workflows:{checked:1,failed:0,interrupted:0,more:false}},
    {idle:true,failed:false,workflows:{checked:0,failed:0,interrupted:0,more:false}},
  ]);
  await expect(promise).rejects.toThrow('Une boîte ou une action Automation');
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(JSON.parse(log.mock.calls[0][0])).toEqual({imported:3,processed:2,failed:1,workflowsChecked:3,workflowsFailed:1,workflowsInterrupted:1,batches:3,drained:true});
});
it('fails visibly when 60 batches finish without a drained queue',async()=>{
  const {promise,log,fetcher}=run(Array.from({length:60},()=>({idle:false,failed:false,processed:1})));
  await expect(promise).rejects.toThrow('avant de terminer la file');
  expect(fetcher).toHaveBeenCalledTimes(60);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({batches:60,processed:60,drained:false});
});
it('respects the elapsed time budget and bounds the final HTTP timeout by remaining time',async()=>{
  const {promise,log,fetcher,timeout}=run(Array.from({length:3},()=>({idle:false,failed:false})),[300000,300000,120000]);
  await expect(promise).rejects.toThrow('avant de terminer la file');
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(timeout.mock.calls.map(call=>call[0])).toEqual([300000,300000,120000]);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({batches:3,drained:false});
});
it('accepts idle on the last permitted batch without starting extra work',async()=>{
  const {promise,fetcher}=run(Array.from({length:60},(_,i)=>({idle:i===59,failed:false})));
  await expect(promise).resolves.toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(60);
});
it.each([{}, {idle:'true',failed:false}, {idle:true}, {idle:true,failed:'false'}])('rejects malformed success responses: %j',async result=>{
  const {promise,log}=run([result]);
  await expect(promise).rejects.toThrow('invalide');
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({batches:0,drained:false});
});
it('preserves a safe partial summary when HTTP fails without logging its response body',async()=>{
  const {promise,log,fetcher}=run([{idle:false,failed:false,processed:3},new Response('private customer secret-token',{status:503})]);
  await expect(promise).rejects.toThrow('indisponible (503)');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({batches:1,processed:3,drained:false});
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret|fixture-only/);
});
it.each(['private@example.test',-1,0.5,null])('never logs invalid counter data: %j',async imported=>{
  const {promise,log}=run([{idle:true,failed:false,imported}]);
  await expect(promise).rejects.toThrow('Compteur');
  expect(JSON.stringify(log.mock.calls)).not.toContain('private@example');
});
it('never discards an error from a terminal batch before counting it',async()=>{
  const {promise,log,fetcher}=run([{idle:true,failed:true,workflows:{checked:0,failed:0,interrupted:1}}]);
  await expect(promise).rejects.toThrow('Une boîte ou une action Automation');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({failed:1,workflowsInterrupted:1});
});
