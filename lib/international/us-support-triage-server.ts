import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { erpClientSchemaVersion } from './erp-schema-capability';
import { creationUuid } from './workspace-creation';
import { UsSupportWorkspaceError } from './us-support-workspace-contract';
import { UsMailboxError, sameUsMailboxContext, validateUsMailboxContext, type UsMailboxContext, type UsMailboxStore } from './us-support-mailbox-contract';
import { UsSupportTriageError, validateUsSupportTriageRequest } from './us-support-triage-contract';
import { createUsSupportTriageService, type UsSupportTriageServiceDependencies } from './us-support-triage-service';

export type { UsSupportTriageMessage } from './us-support-triage-service';
export interface UsSupportTriageDependencies extends Omit<UsSupportTriageServiceDependencies, 'mailbox' | 'mailboxStore' | 'recordTicket'> {
  enabled(this: void): Promise<boolean>;
  member(this: void, request: Request, organizationId: string): Promise<UsMailboxContext>;
  mailboxStore(this: void): Promise<UsMailboxStore>;
  /** Optional separately gated body-free Support lifecycle. */
  recordTicket?(this: void, context: UsMailboxContext, jobId: string, revalidate: () => Promise<UsMailboxContext>): Promise<void>;
  rateLimit?(this: void, request: Request, operation: 'read' | 'triage', key: string): Promise<void>;
  diagnostic?(this: void, event: Readonly<{ operation: 'read' | 'triage'; code: string; status: number }>): void;
}
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const codes: Readonly<Record<string, number>> = {
  unauthorized:401,session_changed:401,subscription_required:402,forbidden:403,email_confirmation_required:403,
  support_management_required:403,feature_unavailable:404,client_upgrade_required:409,configuration_changed:409,
  support_workspace_required:409,mailbox_connection_required:409,mailbox_revision_conflict:409,
  triage_source_conflict:409,triage_idempotency_conflict:409,triage_quota_exceeded:409,triage_capacity_exceeded:409,
  triage_policy_changed:409,triage_dispatch_conflict:409,triage_not_reserved:409,triage_not_dispatched:409,
  triage_connection_changed:409,triage_grant_expired:409,
  invalid_triage_request:422,triage_source_unavailable:422,mailbox_credentials_rejected:422,
  rate_limited:429,service_unavailable:503,triage_provider_unavailable:503,triage_budget_unavailable:503,
  invalid_triage_record:503,invalid_triage_policy:503,invalid_mailbox_record:503,invalid_mailbox_context:503,
  invalid_support_context:503,invalid_support_record:503,invalid_support_execution:503,
};
function denied(code: string, status = 503): never { throw new UsSupportTriageError(code,status); }
function failure(error: unknown) {
  if ((error instanceof UsSupportTriageError || error instanceof UsMailboxError || error instanceof UsSupportWorkspaceError) && codes[error.code] === error.status) return {code:error.code,status:error.status};
  if (error instanceof AccountPublicError && [401,402,403,429].includes(error.status)) return {code:error.status === 401 ? 'unauthorized' : error.status === 402 ? 'subscription_required' : error.status === 429 ? 'rate_limited' : 'forbidden',status:error.status};
  if (error instanceof RequestBodyError) return {code:'invalid_triage_request',status:422};
  return {code:'service_unavailable',status:503};
}
function expected(request: Request, c: UsMailboxContext) {
  if (request.headers.get('X-Zentra-Expected-User') !== null && request.headers.get('X-Zentra-Expected-User') !== c.authority.userId) denied('session_changed',401);
  if ((c.authority.credential.kind === 'device') !== request.headers.has('Authorization')) denied('unauthorized',401);
  if (erpClientSchemaVersion(request) !== 4 || c.authority.credential.kind === 'device' && c.authority.credential.supportedSchemaVersion !== 4) denied('client_upgrade_required',409);
  if (!['owner','admin'].includes(c.authority.role)) denied('support_management_required',403);
}
/** Human HTTP admission remains separate from delegated worker authority. Both
 * call the same source/quota/dispatch service without synthetic HTTP sessions. */
export function createUsSupportTriageHandlers(d: UsSupportTriageDependencies) {
  function handler(operation: 'read' | 'triage') {
    return async (request: Request, organizationId: string): Promise<Response> => {
      let admitted: UsMailboxContext | undefined;
      const now = () => { const n = d.now(); if (!Number.isSafeInteger(n) || n <= 0) return denied('service_unavailable'); return n; };
      async function current() {
        if (!admitted) return denied('unauthorized',401);
        let available = false, gateError: unknown;
        try { available = await d.enabled(); } catch (error) { gateError = error; }
        const fresh = validateUsMailboxContext(await d.member(request,organizationId),organizationId,now());
        expected(request,fresh); sameUsMailboxContext(admitted,fresh);
        if (!available || !await d.enabled()) denied('feature_unavailable',404);
        if (gateError !== undefined) throw gateError;
        return fresh;
      }
      try {
        try { creationUuid(organizationId); } catch { denied('invalid_triage_request',422); }
        if (request.method !== (operation === 'read' ? 'GET' : 'POST') || new URL(request.url).search) denied('invalid_triage_request',422);
        if (!await d.enabled()) denied('feature_unavailable',404);
        admitted = validateUsMailboxContext(await d.member(request,organizationId),organizationId,now()); expected(request,admitted);
        if (operation === 'triage' && admitted.authority.credential.kind === 'browser') requireAccountSameOrigin(request);
        await d.rateLimit?.(request,operation,organizationId+':'+admitted.authority.userId); await current();
        const service = createUsSupportTriageService({
          now:() => d.now(), store:() => d.store(), mailboxStore:() => d.mailboxStore(), policy:() => d.policy(),
          providerReady:() => d.providerReady(), encryptionKey:() => d.encryptionKey(),
          message:(connection,token,input,check) => d.message(connection,token,input,check), classify:(message,grant,check) => d.classify(message,grant,check),
          ...(d.newId ? {newId:() => d.newId!()} : {}),
          ...(d.recordTicket ? {recordTicket:async (context,jobId,check) => { await d.recordTicket!(validateUsMailboxContext(context),jobId,async () => validateUsMailboxContext(await check())); }} : {}),
        });
        if (operation === 'read') {
          const budget = await service.readBudget(await current(), current), c = await current();
          return Response.json({schemaVersion:1,organizationId,userId:c.authority.userId,role:c.authority.role,workspaceId:c.workspaceId,...budget},{headers});
        }
        const input = validateUsSupportTriageRequest(await readJsonObjectWithinLimit(request,8192));
        const r = await service.triage(await current(), input, current), c = await current(), job = r.job;
        return Response.json({schemaVersion:1,organizationId,userId:c.authority.userId,role:c.authority.role,workspaceId:c.workspaceId,
          requestId:r.requestId,requestHash:r.requestHash,replayed:r.replayed,
          state:job.state === 'dispatched' ? 'uncertain' : job.state,jobId:job.id,createdAt:job.createdAt,result:job.result},{headers});
      } catch (error) {
        let outgoing = failure(error);
        // Auth/gate loss still outranks a simultaneous private service error.
        if (admitted) { try { await current(); } catch (late) { const f = failure(late); if ([401,402,403,404].includes(f.status)) outgoing = f; } }
        try { d.diagnostic?.({operation,...outgoing}); } catch { /* Diagnostics never replace the public failure. */ }
        return Response.json({error:outgoing.code},{status:outgoing.status,headers});
      }
    };
  }
  return {read:handler('read'),triage:handler('triage')};
}
