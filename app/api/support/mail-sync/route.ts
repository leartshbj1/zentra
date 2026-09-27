import { runMailSync } from '@/lib/support/mail-sync';
import { supportError, supportJson } from '@/lib/support/service';
import { runDueWorkflows } from '@/lib/automation/workflows';
import { reportSchedulerCycle } from '@/lib/service-diagnostics';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const startedAt=Date.now();
  let authorized=false;
  try {
    const result=await runMailSync(request); // Authenticates the scheduler before any workflow is read.
    authorized=true;
    const workflows=await runDueWorkflows();
    const failed=Boolean(result.failed || workflows.failed || workflows.interrupted);
    const idle=result.idle && workflows.checked===0 && !workflows.more && !failed;
    reportSchedulerCycle({
      startedAt,
      outcome:failed?'failed':result.incomplete||result.paused||result.syncing||result.more||workflows.more?'partial':idle?'idle':'completed',
      imported:result.imported,processed:result.processed,
      workflowsChecked:workflows.checked,workflowsFailed:workflows.failed,
      workflowsInterrupted:workflows.interrupted,reference:result.reference,
    });
    return supportJson({...result,idle,failed,workflows});
  } catch (error) {
    const response=supportError(error,{operation:'support.scheduler',request,startedAt});
    if(authorized || response.status>=500) reportSchedulerCycle({startedAt,outcome:'failed',reference:response.headers.get('X-Zentra-Request-Id')??undefined});
    return response;
  }
}
