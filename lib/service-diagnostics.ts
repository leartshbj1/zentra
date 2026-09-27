import { AccountPublicError } from './account-security';
import { RequestBodyError } from './request-body';
import { SupabaseServerError } from './supabase-server';
import { SupportError } from './support/types';

export type ServiceDiagnosticContext = {
  operation: string;
  request?: Request;
  startedAt?: number;
};

/** Only structural identifiers belong in logs. Never serialize an exception,
 * request headers, URL query, database values or upstream response body. */
export function reportServiceFailure(error: unknown, context: ServiceDiagnosticContext): string | undefined {
  if (context.request?.signal.aborted) return undefined;
  if ((error instanceof AccountPublicError || error instanceof RequestBodyError || error instanceof SupportError) && error.status < 500) return undefined;
  const reference = crypto.randomUUID();
  const upstream = error instanceof SupabaseServerError ? error : undefined;
  const code = upstream?.code;
  const safeCode = code && /^(?:[A-Z0-9]{2,12}|timeout|network_error|invalid_json|unknown|service_restricted|company_storage(?:_empty|_size|_cleanup)?)$/.test(code) ? code : undefined;
  const version = context.request?.headers.get('User-Agent')?.match(/^Zentra(?:-Account)?\/(\d{1,3}\.\d{1,3}\.\d{1,3})(?:\s|$)/)?.[1];
  const operation = /^[a-z][a-z0-9._-]{0,79}$/.test(context.operation) ? context.operation : 'unknown';
  const resource = upstream?.resource && /^\/rest\/v1\/(?:rpc\/)?[a-z][a-z0-9_]{0,62}$/.test(upstream.resource) ? upstream.resource : undefined;
  const elapsed = context.startedAt === undefined ? undefined : Date.now() - context.startedAt;
  console.error('zentra_service_failure', {
    reference, operation, kind: upstream ? 'upstream' : 'internal',
    ...(version ? { clientVersion: version } : {}),
    ...(upstream ? { upstream: 'supabase', upstreamStatus: upstream.status } : {}),
    ...(safeCode ? { upstreamCode: safeCode } : {}),
    ...(resource ? { resource } : {}),
    ...(elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0 ? { durationMs: Math.round(elapsed) } : {}),
  });
  return reference;
}

/** Scheduler telemetry contains only a closed outcome vocabulary and counters.
 * A completed cycle proves execution, not delivery or completion of every item. */
export function reportSchedulerCycle(input: {
  startedAt: number;
  outcome: 'idle' | 'completed' | 'partial' | 'failed';
  imported?: number;
  processed?: number;
  workflowsChecked?: number;
  workflowsFailed?: number;
  workflowsInterrupted?: number;
  reference?: string;
}) {
  const count = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value : undefined;
  const elapsed = Date.now() - input.startedAt;
  const outcome = ['idle', 'completed', 'partial', 'failed'].includes(input.outcome) ? input.outcome : 'failed';
  console.info('zentra_scheduler_cycle', {
    job: 'support.mail', outcome,
    durationMs: Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : 0,
    imported: count(input.imported), processed: count(input.processed), workflowsChecked: count(input.workflowsChecked),
    workflowsFailed: count(input.workflowsFailed), workflowsInterrupted: count(input.workflowsInterrupted),
    ...(input.reference && /^[a-f0-9-]{36}$/.test(input.reference) ? {reference:input.reference} : {}),
  });
}
