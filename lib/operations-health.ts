import { database, runtimeValue } from './runtime';
import { supabaseAuthConfiguration } from './supabase-auth-runtime';
import { readJsonObjectWithinLimit } from './request-body';
import { readSchedulerHealth, schedulerHealth } from './scheduler-health';
import { reportServiceFailure } from './service-diagnostics';
import { digest, equalHash } from './support/crypto';
import { SupportError } from './support/types';

export const OPERATIONS_DELAY_SECONDS = 15 * 60;
export const AUTH_PROBE_TIMEOUT_MS = 4_000;
export const OPERATIONS_CHECK_TIMEOUT_MS = 5_000;

// Separate read-only credential: this token never authorizes a worker run.
export async function requireOperationsMonitor(request: Request) {
  const expected = runtimeValue('OPERATIONS_MONITOR_TOKEN');
  const header = request.headers.get('authorization') ?? '';
  const actual = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(header)?.[1];
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(expected) || !actual ||
      !equalHash(await digest(expected), await digest(actual))) {
    throw new SupportError('Accès refusé.', 401);
  }
}

export type AuthenticationHealth = {
  state: 'available' | 'restricted' | 'misconfigured' | 'unavailable' | 'timeout' | 'invalid_response';
  durationMs: number;
  upstreamStatus?: number;
};

/** A settings read proves service reachability, not signup, SMTP or a real login.
 * No user, session, e-mail, quota-changing mutation or privileged key is used. */
export async function readAuthenticationHealth(fetcher: typeof fetch = fetch): Promise<AuthenticationHealth> {
  const started = Date.now();
  const result = (state: AuthenticationHealth['state'], upstreamStatus?: number): AuthenticationHealth =>
    ({state, durationMs: Math.max(0, Date.now() - started), ...(upstreamStatus === undefined ? {} : {upstreamStatus})});
  let configuration;
  try { configuration = supabaseAuthConfiguration(); }
  catch { return result('misconfigured'); }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_PROBE_TIMEOUT_MS);
  try {
    const response = await fetcher(`${configuration.url}/auth/v1/settings`, {
      method: 'GET', headers: {apikey: configuration.publishableKey, Accept: 'application/json'},
      redirect: 'error', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return result(response.status === 402 ? 'restricted' : [401,403].includes(response.status) ? 'misconfigured' : 'unavailable', response.status);
    }
    try {
      const payload = await readJsonObjectWithinLimit(response, 16_384);
      const providers = payload.external;
      return result(providers && typeof providers === 'object' && !Array.isArray(providers) &&
        typeof (providers as Record<string, unknown>).email === 'boolean' && typeof payload.disable_signup === 'boolean'
        ? 'available' : 'invalid_response', response.status);
    } catch {
      await response.body?.cancel().catch(() => undefined);
      return result(controller.signal.aborted ? 'timeout' : 'invalid_response', response.status);
    }
  } catch { return result(controller.signal.aborted ? 'timeout' : 'unavailable'); }
  finally { clearTimeout(timeout); }
}

type QueueCounters = { due: number; overdue: number; errors: number; stalled: number; oldest_due_at: number | null };
type QueueSummary = { due: number; overdue: number; errors: number; stalled: number; oldestDueAt: string | null };
export type QueueHealth = {
  state: 'current' | 'attention' | 'delayed' | 'unavailable';
  mailboxes?: QueueSummary;
  tickets?: QueueSummary;
  workflows?: QueueSummary;
};

const summarize = (row: QueueCounters | null): QueueSummary => {
  if (!row || !['due','overdue','errors','stalled'].every(key => Number.isSafeInteger(row[key as keyof QueueCounters]) && Number(row[key as keyof QueueCounters]) >= 0)) throw new Error('Invalid queue health');
  const oldest = row.oldest_due_at;
  if (oldest !== null && (!Number.isSafeInteger(oldest) || oldest < 0 || oldest > 8_640_000_000_000)) throw new Error('Invalid queue time');
  return {due:row.due,overdue:row.overdue,errors:row.errors,stalled:row.stalled,oldestDueAt:oldest===null?null:new Date(oldest*1000).toISOString()};
};

/** Counts only, across active connections/rules. Never select a subject, e-mail,
 * organization identifier, body, error message, attachment or provider secret. */
export async function readQueueHealth(now = Math.floor(Date.now()/1000)): Promise<QueueHealth> {
  try {
    const db = database(), cutoff = now - OPERATIONS_DELAY_SECONDS;
    const [mailboxes,tickets,workflows] = await Promise.all([
      db.prepare(`SELECT
        COALESCE(SUM(m.next_sync_at<=? AND m.lease_until<=?),0) AS due,
        COALESCE(SUM(COALESCE(NULLIF(m.next_sync_at,0),c.created_at)<? AND m.lease_until<=?),0) AS overdue,
        COALESCE(SUM(m.last_error IS NOT NULL AND m.last_error<>''),0) AS errors,
        COALESCE(SUM(m.lease IS NOT NULL AND m.lease_until<=?),0) AS stalled,
        MIN(CASE WHEN m.next_sync_at<=? AND m.lease_until<=? THEN COALESCE(NULLIF(m.next_sync_at,0),c.created_at) END) AS oldest_due_at
        FROM support_mailboxes m JOIN support_connections c ON c.id=m.connection_id
        JOIN support_workspaces w ON w.id=c.workspace_id WHERE c.active=1 AND w.mode<>'paused'`)
        .bind(now,now,cutoff,now,now,now,now).first<QueueCounters>(),
      // Pending tickets may intentionally await Automation consent/subscription.
      // Count them for diagnosis, but only an expired running lease is a delay.
      db.prepare(`SELECT COALESCE(SUM(t.state='pending'),0) AS due,0 AS overdue,
        COALESCE(SUM(t.state='error'),0) AS errors,
        COALESCE(SUM(t.state='processing' AND COALESCE(t.lease_until,0)<=?),0) AS stalled,
        MIN(CASE WHEN t.state='pending' THEN t.created_at END) AS oldest_due_at
        FROM support_tickets t JOIN support_connections c ON c.id=t.connection_id
        JOIN support_workspaces w ON w.id=t.workspace_id
        WHERE t.state IN ('pending','processing','error') AND c.active=1 AND w.mode<>'paused'`)
        .bind(now).first<QueueCounters>(),
      db.prepare(`SELECT COALESCE(SUM(r.state IN ('queued','waiting') AND r.due_at<=? AND r.lease_until<=?),0) AS due,
        COALESCE(SUM(r.state IN ('queued','waiting') AND COALESCE(NULLIF(r.due_at,0),r.created_at)<? AND r.lease_until<=?),0) AS overdue,
        COALESCE(SUM(r.state='failed'),0) AS errors,
        COALESCE(SUM(r.state='running' AND r.lease_until<=?),0) AS stalled,
        MIN(CASE WHEN r.state IN ('queued','waiting') AND r.due_at<=? AND r.lease_until<=? THEN COALESCE(NULLIF(r.due_at,0),r.created_at) END) AS oldest_due_at
        FROM automation_workflow_runs r JOIN automation_workflows w ON w.id=r.workflow_id
        WHERE r.state IN ('queued','waiting','running','failed') AND w.enabled=1`)
        .bind(now,now,cutoff,now,now,now,now).first<QueueCounters>(),
    ]);
    const summaries = {mailboxes:summarize(mailboxes),tickets:summarize(tickets),workflows:summarize(workflows)};
    const rows = Object.values(summaries);
    return {state: rows.some(row=>row.overdue||row.stalled)?'delayed':rows.some(row=>row.errors)?'attention':'current',...summaries};
  } catch(error) {
    reportServiceFailure(error,{operation:'operations.queues.read'});
    return {state:'unavailable'};
  }
}

async function boundedCheck<T>(check: Promise<T>, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([check,new Promise<T>(resolve=>{timer=setTimeout(()=>resolve(fallback()),OPERATIONS_CHECK_TIMEOUT_MS);})]); }
  finally { clearTimeout(timer); }
}

export async function operationsHealth() {
  const [authentication,scheduler,queues] = await Promise.all([
    boundedCheck(readAuthenticationHealth(),()=>({state:'timeout',durationMs:OPERATIONS_CHECK_TIMEOUT_MS})),
    boundedCheck(readSchedulerHealth(),()=>({...schedulerHealth(null,runtimeValue('SUPPORT_MAIL_BACKGROUND_ENABLED')==='1'),state:'unavailable'})),
    boundedCheck(readQueueHealth(),()=>({state:'unavailable'})),
  ]);
  const state = authentication.state==='available' && scheduler.background && queues.state==='current' ? 'healthy' : 'degraded';
  return {state,checkedAt:new Date().toISOString(),authentication,scheduler,queues};
}
