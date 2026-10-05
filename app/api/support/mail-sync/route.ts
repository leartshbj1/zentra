import { requireMailScheduler } from '@/lib/support/mail-sync';
import { readMailBacklog, runMailSyncBatch } from '@/lib/support/mail-sync-batch';
import { supportError, supportJson } from '@/lib/support/service';
import { runDueWorkflows } from '@/lib/automation/workflows';
import { reportSchedulerCycle, createSchedulerProgress } from '@/lib/service-diagnostics';
import {startSchedulerHeartbeat,finishSchedulerHeartbeat,readSchedulerHealth} from '@/lib/scheduler-health';
import {readWorkflowBacklog} from '@/lib/support/scheduler-dispatch';
export const dynamic = 'force-dynamic';
// A read-only endpoint for an independent uptime monitor. Never wakes the worker.
export async function GET(request: Request) {
  try {
    await requireMailScheduler(request);
    const health=await readSchedulerHealth();
    return supportJson(health,health.background?200:503);
  } catch (error) {return supportError(error,{operation:'support.scheduler.health',request});}
}
export async function POST(request: Request) {
  const startedAt=Date.now();
  let authorized=false;
  let heartbeat: string | null=null;
  try {
    await requireMailScheduler(request);
    authorized=true;
    // A plan is an advisory snapshot. Recheck on arrival: peer claims, a pause
    // or elapsed readiness can make an async dispatch obsolete.
    const mailDemand=await readMailBacklog();
    heartbeat=await startSchedulerHeartbeat(startedAt);
    const result=mailDemand.due>0?await runMailSyncBatch(request):{
      idle:mailDemand.due===0,failed:false,imported:0,processed:0,more:false,
      incomplete:false,syncing:mailDemand.active>0,paused:false,
      mailboxes:{checked:0,failed:0,...mailDemand,budgetExhausted:false},
    };
    // Mail intake may queue new Automation work after the initial observation.
    // Conversely, another worker may have claimed the previously due jobs.
    const workflowDemand=await readWorkflowBacklog();
    const workflows=workflowDemand.due>0||workflowDemand.expired>0
      ?await createSchedulerProgress()('workflows', () => runDueWorkflows())
      :{checked:0,failed:0,interrupted:0,more:false};
    const failed=Boolean(result.failed || workflows.failed || workflows.interrupted);
    const idle=result.idle && workflows.checked===0 && !workflows.more && workflowDemand.active===0 && !failed;
    const outcome=failed?'failed':result.incomplete||result.paused||result.syncing||result.more||workflows.more||workflowDemand.active>0?'partial':idle?'idle':'completed';
    if(heartbeat)await finishSchedulerHeartbeat(heartbeat,outcome,result.reference);
    reportSchedulerCycle({
      startedAt,
      outcome,
      imported:result.imported,processed:result.processed,
      workflowsChecked:workflows.checked,workflowsFailed:workflows.failed,
      workflowsInterrupted:workflows.interrupted,reference:result.reference,
      mailboxesChecked:result.mailboxes?.checked,mailboxesFailed:result.mailboxes?.failed,
      mailboxesDue:result.mailboxes?.due,mailboxesOverdue:result.mailboxes?.overdue,
      mailboxesActive:result.mailboxes?.active,mailboxBudgetExhausted:result.mailboxes?.budgetExhausted,
    });
    return supportJson({...result,idle,failed,workflows});
  } catch (error) {
    const response=supportError(error,{operation:'support.scheduler',request,startedAt});
    if(heartbeat)await finishSchedulerHeartbeat(heartbeat,'failed',response.headers.get('X-Zentra-Request-Id')??undefined);
    if(authorized || response.status>=500) reportSchedulerCycle({startedAt,outcome:'failed',reference:response.headers.get('X-Zentra-Request-Id')??undefined});
    return response;
  }
}
