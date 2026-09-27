import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

// Execute the actual bounded CI client with a fake HTTP endpoint. No token or
// mailbox is used; this protects its contract with the server response.
const workflow = readFileSync(new URL('../../.github/workflows/support-mail-sync.yml', import.meta.url), 'utf8');
const script = workflow.split("<<'JS'")[1]?.split(/\r?\n\s*JS\s*(?:\r?\n|$)/)[0];
if (!script) throw new Error('Scheduled mail client not found');

function run(results: Record<string, unknown>[]) {
  const log = vi.fn();
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://zentraapp.ch/api/support/mail-sync');
    expect(init).toMatchObject({method:'POST',redirect:'error',headers:{Authorization:'Bearer fixture-only'}});
    const result = results.shift();
    if (!result) throw new Error('Unexpected extra scheduler request');
    return Response.json(result);
  });
  const promise = runInNewContext(`(async()=>{${script}\n})()`, {
    process:{env:{SUPPORT_MAIL_SYNC_TOKEN:'fixture-only'}}, Date, AbortSignal,
    fetch:fetcher, console:{log},
  }) as Promise<void>;
  return {promise,log,fetcher};
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
  expect(JSON.parse(log.mock.calls[0][0])).toEqual({imported:3,processed:2,failed:1,workflowsChecked:3,workflowsFailed:1,workflowsInterrupted:1});
});
it('never discards an error from a terminal batch before counting it',async()=>{
  const {promise,log,fetcher}=run([{idle:true,failed:true,workflows:{checked:0,failed:0,interrupted:1}}]);
  await expect(promise).rejects.toThrow('Une boîte ou une action Automation');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({failed:1,workflowsInterrupted:1});
});
