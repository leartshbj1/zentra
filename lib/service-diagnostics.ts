import { AccountPublicError } from './account-security';
import { RequestBodyError } from './request-body';
import { SupabaseServerError } from './supabase-server';
import { SupportError } from './support/types';

export const MAIL_SYNC_FAILURE_STAGES = [
  'lookup', 'subscription', 'lease', 'decrypt', 'open', 'list', 'read',
  'prepare', 'capture', 'ingest', 'progress', 'classify', 'finalize',
] as const;
export type MailSyncFailureStage = typeof MAIL_SYNC_FAILURE_STAGES[number];
const mailFailures = new WeakMap<object, MailSyncFailureStage>();
export type MailSyncTransport = 'api' | 'imap';
const mailTransports = new WeakMap<object, MailSyncTransport>();

/** Preserve only the first failing boundary, without changing or retaining an
 * exception's content. Wrapping an error must not erase its worker stage. */
export function markMailSyncFailure<T>(error: T, stage: MailSyncFailureStage, transport?: MailSyncTransport): T {
  if (error !== null && (typeof error === 'object' || typeof error === 'function') &&
      MAIL_SYNC_FAILURE_STAGES.includes(stage) && !mailFailures.has(error)) {
    mailFailures.set(error, stage);
  }
  if (error !== null && (typeof error === 'object' || typeof error === 'function') &&
      (transport === 'api' || transport === 'imap') && !mailTransports.has(error)) {
    mailTransports.set(error, transport);
  }
  return error;
}
export function mailSyncFailureStage(error: unknown): MailSyncFailureStage | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? mailFailures.get(error) : undefined;
}
export function mailSyncFailureTransport(error: unknown): MailSyncTransport | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? mailTransports.get(error) : undefined;
}

export type ServiceDiagnosticContext = {
  operation: string;
  request?: Request;
  startedAt?: number;
  mailStage?: MailSyncFailureStage;
  mailTransport?: MailSyncTransport;
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
  const stage = mailSyncFailureStage(error) ?? context.mailStage;
  const mailStage = stage && MAIL_SYNC_FAILURE_STAGES.includes(stage) ? stage : undefined;
  const transport = mailSyncFailureTransport(error) ?? context.mailTransport;
  const mailTransport = transport === 'api' || transport === 'imap' ? transport : undefined;
  const supportStatus = error instanceof SupportError && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : undefined;
  const elapsed = context.startedAt === undefined ? undefined : Date.now() - context.startedAt;
  console.error('zentra_service_failure', {
    reference, operation, kind: upstream ? 'upstream' : 'internal',
    ...(version ? { clientVersion: version } : {}),
    ...(upstream ? { upstream: 'supabase', upstreamStatus: upstream.status } : {}),
    ...(safeCode ? { upstreamCode: safeCode } : {}),
    ...(resource ? { resource } : {}),
    ...(mailStage ? { mailStage } : {}),
    ...(mailStage && mailTransport ? { mailTransport } : {}),
    ...(mailStage && supportStatus !== undefined ? { supportStatus } : {}),
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
  mailboxesChecked?: number;
  mailboxesFailed?: number;
  mailboxesDue?: number;
  mailboxesOverdue?: number;
  mailboxesActive?: number;
  mailboxBudgetExhausted?: boolean;
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
    mailboxesChecked:count(input.mailboxesChecked),mailboxesFailed:count(input.mailboxesFailed),
    mailboxesDue:count(input.mailboxesDue),mailboxesOverdue:count(input.mailboxesOverdue),mailboxesActive:count(input.mailboxesActive),
    mailboxBudgetExhausted:typeof input.mailboxBudgetExhausted==='boolean'?input.mailboxBudgetExhausted:undefined,
    ...(input.reference && /^[a-f0-9-]{36}$/.test(input.reference) ? {reference:input.reference} : {}),
  });
}
