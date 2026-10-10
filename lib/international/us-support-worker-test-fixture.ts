import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { supportTicketFixture } from './us-support-ticket-test-fixture';
import { d1UsSupportWorkerStore } from './us-support-worker-d1';
import { US_SUPPORT_WORKER_CONSENT_VERSION, type UsSupportWorkerManageRequest } from './us-support-worker-contract';
export const supportWorkerSql=readFileSync(new URL('../../drizzle/0098_international_us_support_worker.sql',import.meta.url),'utf8');
/** Actual SQLite0000..0098. Auth, catalogue and provider inputs are synthetic. */
export async function supportWorkerFixture(includeWorker=true){
  const f=await supportTicketFixture();if(includeWorker)f.sql.exec(supportWorkerSql);
  const options={now:f.now,policy:async()=>({...f.saasPolicy,now:f.now()}),triagePolicy:async()=>f.policy};
  const worker=d1UsSupportWorkerStore(f.database,options);
  const manageRequest=(patch:Partial<UsSupportWorkerManageRequest>={}):UsSupportWorkerManageRequest=>({schemaVersion:1,requestId:randomUUID(),expectedRevision:0,action:'enable',connectionId:f.connection.connectionId,expectedMailboxRevision:1,processingPolicyVersion:f.policy.processingPolicyVersion,recipeVersion:f.policy.recipeVersion,consentVersion:US_SUPPORT_WORKER_CONSENT_VERSION,consent:true,expiresAt:f.now()+86400,...patch})as UsSupportWorkerManageRequest;
  async function enable(){return worker.manage(f.context(),manageRequest(),async()=>f.context());}
  async function acquire(){const lease=await worker.acquire({runId:randomUUID(),leaseSeconds:120});if(!lease)throw Error('fixture lease absent');const context=await worker.revalidate(lease);return {lease,context,current:()=>worker.revalidate(context)};}
  return {...f,worker,workerOptions:options,manageRequest,enable,acquire};
}
