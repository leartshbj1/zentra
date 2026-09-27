import { runMailSync, requireMailScheduler } from '@/lib/support/mail-sync';
import { supportError, supportJson } from '@/lib/support/service';
import { runDueWorkflows } from '@/lib/automation/workflows';
import { reportSchedulerCycle } from '@/lib/service-diagnostics';
import {startSchedulerHeartbeat,finishSchedulerHeartbeat,readSchedulerHealth} from '@/lib/scheduler-health';
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
  let heartbeat=false;
  try {
    await requireMailScheduler(request);
    authorized=true;
    heartbeat=await startSchedulerHeartbeat(startedAt);
    const result=await runMailSync(request);
    const workflows=await runDueWorkflows();
    const failed=Boolean(result.failed || workflows.failed || workflows.interrupted);
    const idle=result.idle && workflows.checked===0 && !workflows.more && !failed;
    const outcome=failed?'failed':result.incomplete||result.paused||result.syncing||result.more||workflows.more?'partial':idle?'idle':'completed';
    if(heartbeat)await finishSchedulerHeartbeat(outcome,result.reference);
    reportSchedulerCycle({
      startedAt,
      outcome,
      imported:result.imported,processed:result.processed,
      workflowsChecked:workflows.checked,workflowsFailed:workflows.failed,
      workflowsInterrupted:workflows.interrupted,reference:result.reference,
    });
    return supportJson({...result,idle,failed,workflows});
  } catch (error) {
    const response=supportError(error,{operation:'support.scheduler',request,startedAt});
    if(heartbeat)await finishSchedulerHeartbeat('failed',response.headers.get('X-Zentra-Request-Id')??undefined);
    if(authorized || response.status>=500) reportSchedulerCycle({startedAt,outcome:'failed',reference:response.headers.get('X-Zentra-Request-Id')??undefined});
    return response;
  }
}
