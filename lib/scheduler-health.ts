import { database, runtimeValue } from './runtime';
import { reportServiceFailure } from './service-diagnostics';

const JOB = 'support.mail';
export const SCHEDULER_STALE_MS = 15 * 60_000;
export const SCHEDULER_STALLED_MS = 10 * 60_000;
export type SchedulerOutcome = 'idle' | 'completed' | 'partial' | 'failed';
export type SchedulerHealthRow = {
  last_started_at: number;
  last_finished_at: number | null;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_outcome: SchedulerOutcome | null;
  last_reference: string | null;
};
export type SchedulerHealth = {
  configured: boolean;
  background: boolean;
  state:
    | 'inactive'
    | 'unverified'
    | 'current'
    | 'running'
    | 'delayed'
    | 'failed'
    | 'unavailable';
  checkedAt: string;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
};

/** Describes execution of the shared worker, never delivery of a tenant's mail. */
export function schedulerHealth(
  row: SchedulerHealthRow | null,
  configured: boolean,
  now = Date.now(),
): SchedulerHealth {
  const time = (value: number | null | undefined) =>
    Number.isSafeInteger(value) && value! > 0 && value! <= now ? value! : null;
  const started = time(row?.last_started_at),
    finished = time(row?.last_finished_at),
    success = time(row?.last_success_at);
  const running = started !== null && (finished === null || started > finished);
  let state: SchedulerHealth['state'];
  if (!configured) state = 'inactive';
  else if (running && now - started! > SCHEDULER_STALLED_MS) state = 'delayed';
  else if (finished === null) state = running ? 'running' : 'unverified';
  else if (now - finished > SCHEDULER_STALE_MS) state = 'delayed';
  else if (row?.last_outcome === 'failed') state = 'failed';
  else if (
    !['idle', 'completed', 'partial'].includes(row?.last_outcome || '') ||
    success === null
  )
    state = 'unverified';
  else state = running ? 'running' : 'current';
  return {
    configured,
    background:
      configured &&
      (state === 'current' ||
        (state === 'running' &&
          success !== null &&
          now - success <= SCHEDULER_STALE_MS)),
    state,
    checkedAt: new Date(now).toISOString(),
    lastFinishedAt: finished === null ? null : new Date(finished).toISOString(),
    lastSuccessAt: success === null ? null : new Date(success).toISOString(),
  };
}

export async function readSchedulerHealth(): Promise<SchedulerHealth> {
  const configured = runtimeValue('SUPPORT_MAIL_BACKGROUND_ENABLED') === '1';
  try {
    const row = await database()
      .prepare(
        'SELECT last_started_at,last_finished_at,last_success_at,last_failure_at,last_outcome,last_reference FROM service_scheduler_health WHERE job=?',
      )
      .bind(JOB)
      .first<SchedulerHealthRow>();
    return schedulerHealth(row, configured);
  } catch (error) {
    reportServiceFailure(error, { operation: 'support.scheduler.health.read' });
    return { ...schedulerHealth(null, configured), state: 'unavailable' };
  }
}

// Observability must not stop useful work if storage is temporarily unavailable.
// Call only after authenticating the scheduler; anonymous traffic writes nothing.
export async function startSchedulerHeartbeat(
  startedAt: number,
): Promise<boolean> {
  try {
    await database()
      .prepare(
        'INSERT INTO service_scheduler_health(job,last_started_at) VALUES(?,?) ON CONFLICT(job) DO UPDATE SET last_started_at=MAX(last_started_at,excluded.last_started_at)',
      )
      .bind(JOB, startedAt)
      .run();
    return true;
  } catch (error) {
    reportServiceFailure(error, {
      operation: 'support.scheduler.health.start',
    });
    return false;
  }
}

export async function finishSchedulerHeartbeat(
  outcome: SchedulerOutcome,
  reference?: string,
) {
  const finished = Date.now();
  const safeReference =
    reference && /^[a-f0-9-]{36}$/.test(reference) ? reference : null;
  try {
    await database()
      .prepare(`UPDATE service_scheduler_health SET
      last_success_at=CASE WHEN ?<>'failed' THEN MAX(COALESCE(last_success_at,0),?) ELSE last_success_at END,
      last_failure_at=CASE WHEN ?='failed' THEN MAX(COALESCE(last_failure_at,0),?) ELSE last_failure_at END,
      last_outcome=CASE WHEN COALESCE(last_finished_at,0)<=? THEN ? ELSE last_outcome END,
      last_reference=CASE WHEN COALESCE(last_finished_at,0)<=? THEN ? ELSE last_reference END,
      last_finished_at=MAX(COALESCE(last_finished_at,0),?) WHERE job=?`)
      .bind(
        outcome,
        finished,
        outcome,
        finished,
        finished,
        outcome,
        finished,
        safeReference,
        finished,
        JOB,
      )
      .run();
  } catch (error) {
    reportServiceFailure(error, {
      operation: 'support.scheduler.health.finish',
    });
  }
}
