import { requireMailScheduler } from '@/lib/support/mail-sync';
import { readSchedulerDemand } from '@/lib/support/scheduler-dispatch';
import { supportError, supportJson } from '@/lib/support/service';
import { startSchedulerHeartbeat, finishSchedulerHeartbeat } from '@/lib/scheduler-health';
export const dynamic = 'force-dynamic';

// One private control probe per cron tick. pg_net consumes its exact response on
// the following tick; this endpoint does not claim mail, advance workflows or
// dispatch detached HTTP work. A zero queue is not eight empty worker requests.
export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    await requireMailScheduler(request);
    const demand = await readSchedulerDemand();
    // Preserve an honest idle heartbeat, without marking a planned/leased task
    // as processed. Busy probes are not successful business-worker heartbeats.
    if (demand.plan.desiredWorkers === 0 && demand.plan.activeMailboxes === 0 && demand.plan.activeWorkflows === 0) {
      const heartbeat = await startSchedulerHeartbeat(startedAt);
      if (heartbeat) await finishSchedulerHeartbeat(heartbeat,'idle');
    }
    return supportJson(demand.plan);
  } catch (error) {
    return supportError(error,{operation:'support.scheduler.dispatch',request,startedAt});
  }
}
