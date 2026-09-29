import { database } from '@/lib/runtime';
import { reportServiceFailure } from '@/lib/service-diagnostics';
import { requireMailScheduler, runMailSync, type MailSyncResult } from './mail-sync';

// Small independent requests keep provider/subrequest work bounded. This is an
// admission deadline, not a response-time guarantee: started operations drain.
export const MAIL_BATCH_LIMIT = 4;
export const MAIL_BATCH_CONCURRENCY = 2;
export const MAIL_BATCH_ADMISSION_MS = 20_000;
export const MAIL_BACKLOG_DELAY_SECONDS = 15 * 60;

export async function readMailBacklog() {
  const time = Math.floor(Date.now() / 1000);
  const row = await database().prepare(`SELECT
    COALESCE(SUM(m.next_sync_at<=? AND m.lease_until<=?),0) AS due,
    COALESCE(SUM(m.next_sync_at<=? AND m.lease_until<=? AND COALESCE(NULLIF(m.next_sync_at,0),c.created_at)<?),0) AS overdue,
    COALESCE(SUM(m.lease_until>?),0) AS active,
    MIN(CASE WHEN m.next_sync_at<=? AND m.lease_until<=? THEN COALESCE(NULLIF(m.next_sync_at,0),c.created_at) END) AS oldest
    FROM support_mailboxes m
    JOIN support_connections c ON c.id=m.connection_id AND c.workspace_id=m.workspace_id
    JOIN support_workspaces w ON w.id=m.workspace_id
    WHERE c.active=1 AND c.provider='infomaniak' AND w.mode<>'paused'`)
    .bind(time,time,time,time,time-MAIL_BACKLOG_DELAY_SECONDS,time,time,time)
    .first<{due:number;overdue:number;active:number;oldest:number|null}>();
  if (!row || ![row.due,row.overdue,row.active].every(n=>Number.isSafeInteger(n)&&n>=0) ||
      (row.oldest!==null&&(!Number.isSafeInteger(row.oldest)||row.oldest<0||row.oldest>8_640_000_000_000)))
    throw new Error('Mailbox backlog unavailable');
  return {due:row.due,overdue:row.overdue,active:row.active,oldestDueAt:row.oldest===null?null:new Date(row.oldest*1000).toISOString()};
}

export async function runMailSyncBatch(request: Request) {
  await requireMailScheduler(request);
  const startedAt=Date.now(), deadline=startedAt+MAIL_BATCH_ADMISSION_MS;
  const results:MailSyncResult[]=[];
  let attempts=0, noDue=false, budgetExhausted=false;
  const work = async () => {
    while (!noDue && attempts<MAIL_BATCH_LIMIT) {
      if (request.signal.aborted || Date.now()>=deadline) {budgetExhausted=true;break;}
      // Increment before the first await; every lane shares this exact ceiling.
      attempts++;
      try {
        const result=await runMailSync(request,{deadline});
        results.push(result);
        if(result.idle)noDue=true;
        if(result.budgetExhausted)budgetExhausted=true;
      } catch(error) {
        const reference=reportServiceFailure(error,{operation:'support.scheduler.batch',request,startedAt});
        results.push({idle:false,failed:true,...(reference?{reference}:{})});
      }
    }
  };
  // No detached work or Promise.race timeout. Even a failing lane is awaited
  // before this request can report completion or a subsequent read can fail.
  await Promise.all(Array.from({length:MAIL_BATCH_CONCURRENCY},work));
  const backlog=await readMailBacklog();
  const checked=results.filter(r=>!r.idle).length;
  const failures=results.filter(r=>r.failed).length;
  const firstReference=results.find(r=>r.reference)?.reference;
  return {
    idle:checked===0 && failures===0 && backlog.due===0,
    failed:failures>0,
    imported:results.reduce((n,r)=>n+(r.imported??0),0),
    processed:results.reduce((n,r)=>n+(r.processed??0),0),
    more:backlog.due>0 || results.some(r=>r.more),
    incomplete:budgetExhausted || results.some(r=>r.incomplete),
    syncing:backlog.active>0 || results.some(r=>r.syncing),
    paused:results.some(r=>r.paused),
    ...(firstReference?{reference:firstReference}:{}),
    mailboxes:{checked,failed:failures,...backlog,budgetExhausted},
  };
}
