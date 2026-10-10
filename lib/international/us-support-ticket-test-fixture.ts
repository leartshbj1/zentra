import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { supportTriageFixture } from './us-support-triage-test-fixture';
import { d1UsSupportTicketStore } from './us-support-ticket-d1';
import type { UsSupportTicketRequest, UsSupportRoutingRequest } from './us-support-ticket-contract';
import type { UsSupportTriageRequest, UsSupportTriageSource, UsSupportTriageDecision, UsSupportTriageGrant } from './us-support-triage-contract';

export const supportTicketSql=readFileSync(new URL('../../drizzle/0097_international_us_support_tickets.sql',import.meta.url),'utf8');
/** Actual SQLite0000..0097. Auth/SaaS/provider observations remain synthetic. */
export async function supportTicketFixture(includeTickets=true){
  const f=await supportTriageFixture();if(includeTickets)f.sql.exec(supportTicketSql);
  async function completeJob(options:{request?:Partial<UsSupportTriageRequest>;source?:Partial<UsSupportTriageSource>;decision?:Partial<UsSupportTriageDecision>;grant?:UsSupportTriageGrant}={}){
    const q=f.request(options.request),source=f.source({uid:q.uid,messageVersion:q.expectedMessageVersion,...options.source});
    const claimed=await f.triage.claim(f.context(),{request:q,source,grant:options.grant??f.grant()},async()=>f.context()),reference={requestId:q.requestId,requestHash:claimed.requestHash,dispatchId:randomUUID()};
    const dispatched=await f.triage.dispatch(f.context(),reference,async()=>f.context());
    return f.triage.complete(f.context(),{...reference,dispatchId:dispatched.result.job.dispatchId!,decision:f.decision(options.decision)},async()=>f.context());
  }
  const ticketRequest=(jobId:string,patch:Partial<UsSupportTicketRequest>={}):UsSupportTicketRequest=>({schemaVersion:1,requestId:randomUUID(),action:'create',jobId,...patch}) as UsSupportTicketRequest;
  const routingRequest=(patch:Partial<UsSupportRoutingRequest>={}):UsSupportRoutingRequest=>({schemaVersion:1,requestId:randomUUID(),expectedRevision:0,enabled:false,threshold:0.9,routes:[],...patch});
  return {...f,tickets:d1UsSupportTicketStore(f.database,{now:f.now}),completeJob,ticketRequest,routingRequest};
}
export const ticketFixture=supportTicketFixture;
