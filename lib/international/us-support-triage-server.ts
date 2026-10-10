import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { decryptSecret } from '../support/crypto';
import { canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { erpClientSchemaVersion } from './erp-schema-capability';
import { creationUuid } from './workspace-creation';
import { UsSupportWorkspaceError } from './us-support-workspace-contract';
import { UsMailboxError, sameUsMailboxContext, usMailboxEncryptionContext, validateUsMailboxContext, validateUsMailboxState, type UsMailboxConnection, type UsMailboxContext, type UsMailboxStore } from './us-support-mailbox-contract';
import { UsSupportTriageError, hashUsSupportTriageRequest, validateUsSupportTriageRequest, validateUsSupportTriageResult, validateUsSupportTriageSource, validateUsSupportTriageDecision, type UsSupportTriageGrant, type UsSupportTriageDecision, type UsSupportTriageRequest, type UsSupportTriageResult, type UsSupportTriageSource, type UsSupportTriageStore } from './us-support-triage-contract';
import { createUsSupportTriageGrant, parseUsSupportTriagePolicy, type UsSupportTriagePolicy } from './us-support-triage-policy';

export interface UsSupportTriageMessage { readonly source: UsSupportTriageSource; readonly subject: string; readonly body: string }
export interface UsSupportTriageDependencies {
  enabled(this: void): Promise<boolean>; now(this: void): number;
  member(this: void, request: Request, organizationId: string): Promise<UsMailboxContext>;
  store(this: void): Promise<UsSupportTriageStore>; mailboxStore(this: void): Promise<UsMailboxStore>;
  policy(this: void): Promise<UsSupportTriagePolicy>; providerReady(this: void): Promise<boolean>; encryptionKey(this: void): Promise<string>;
  message(this: void, connection: UsMailboxConnection, token: string, request: UsSupportTriageRequest, check: () => Promise<unknown>): Promise<UsSupportTriageMessage>;
  classify(this: void, message: UsSupportTriageMessage, grant: UsSupportTriageGrant, check: () => Promise<unknown>): Promise<UsSupportTriageDecision>;
  newId?(this: void): string;
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
  invalid_support_context:503,invalid_support_record:503,
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
/** Classification only. No mail acknowledgement, route, reply, supplier,
 * appointment or financial command port is present in this service. */
export function createUsSupportTriageHandlers(d: UsSupportTriageDependencies) {
  function handler(operation: 'read' | 'triage') {
    return async (request: Request, organizationId: string): Promise<Response> => {
      let admitted: UsMailboxContext | undefined, capturedPolicy: UsSupportTriagePolicy | undefined, capturedGrant: UsSupportTriageGrant | undefined;
      let store: UsSupportTriageStore | undefined, input: UsSupportTriageRequest | undefined, requestHash: string | undefined, dispatchId: string | undefined;
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
      async function inferenceCurrent() {
        let changed: unknown, latest: UsSupportTriagePolicy | undefined;
        try { latest = parseUsSupportTriagePolicy(await d.policy()); }
        catch (error) { changed = error; }
        const fresh = await current();
        if (changed !== undefined) throw changed;
        if (!latest || !capturedPolicy || !capturedGrant || canonicalErpJson(latest) !== canonicalErpJson(capturedPolicy)
          || canonicalErpJson(createUsSupportTriageGrant(fresh,latest)) !== canonicalErpJson(capturedGrant)) denied('triage_policy_changed',409);
        return fresh;
      }
      function result(value: unknown) {
        const r = validateUsSupportTriageResult(value,organizationId,admitted!.workspaceId);
        if (!input || r.requestId !== input.requestId || r.requestHash !== requestHash || r.job.organizationId !== organizationId || r.job.workspaceId !== admitted!.workspaceId
          || r.job.source.uid !== input.uid || r.job.source.messageVersion !== input.expectedMessageVersion) return denied('invalid_triage_record');
        return r;
      }
      async function respond(r: UsSupportTriageResult) {
        const c = await current(), job = r.job;
        // Another first request may still be completing. An observed dispatch
        // is never permission for this HTTP request to repeat provider I/O.
        return Response.json({schemaVersion:1,organizationId,userId:c.authority.userId,role:c.authority.role,workspaceId:c.workspaceId,
          requestId:r.requestId,requestHash:r.requestHash,replayed:r.replayed,
          state:job.state === 'dispatched' ? 'uncertain' : job.state,jobId:job.id,createdAt:job.createdAt,result:job.result},{headers});
      }
      try {
        try { creationUuid(organizationId); } catch { denied('invalid_triage_request',422); }
        if (request.method !== (operation === 'read' ? 'GET' : 'POST') || new URL(request.url).search) denied('invalid_triage_request',422);
        if (!await d.enabled()) denied('feature_unavailable',404);
        admitted = validateUsMailboxContext(await d.member(request,organizationId),organizationId,now()); expected(request,admitted);
        if (operation === 'triage' && admitted.authority.credential.kind === 'browser') requireAccountSameOrigin(request);
        await d.rateLimit?.(request,operation,organizationId+':'+admitted.authority.userId); await current();
        store = await d.store(); await current();
        if (operation === 'triage') {
          input = validateUsSupportTriageRequest(await readJsonObjectWithinLimit(request,8192));
          requestHash = await hashUsSupportTriageRequest(organizationId,admitted.workspaceId,admitted.authority.userId,input);
          const saved = await store.find(await current(),input.requestId,requestHash); await current();
          if (saved && result(saved).job.state !== 'reserved') return respond(result(saved));
        }
        capturedPolicy = parseUsSupportTriagePolicy(await d.policy());
        capturedGrant = createUsSupportTriageGrant(await current(),capturedPolicy); await inferenceCurrent();
        const providerReady = await d.providerReady(); await inferenceCurrent();
        if (!providerReady) denied('triage_provider_unavailable');
        if (operation === 'read') {
          const usage = await store.usage(await inferenceCurrent(),capturedGrant); const c = await inferenceCurrent();
          if (!usage || usage.limit !== capturedGrant.limit || !Number.isSafeInteger(usage.used) || usage.used < 0 || !Number.isSafeInteger(usage.remaining) || usage.remaining !== Math.max(0,usage.limit-usage.used)) denied('invalid_triage_record');
          return Response.json({schemaVersion:1,organizationId,userId:c.authority.userId,role:c.authority.role,workspaceId:c.workspaceId,
            processingPolicyVersion:capturedGrant.processingPolicyVersion,recipeVersion:capturedGrant.recipeVersion,usage},{headers});
        }
        if (!input || !requestHash) return denied('invalid_triage_record');
        if (input.processingPolicyVersion !== capturedGrant.processingPolicyVersion) denied('triage_policy_changed',409);
        const mailbox = await d.mailboxStore(); await inferenceCurrent();
        let connection: UsMailboxConnection | undefined;
        async function connected() {
          const c = await inferenceCurrent(), state = validateUsMailboxState(await mailbox.read(c),organizationId); await inferenceCurrent();
          if (state.workspaceId !== c.workspaceId) denied('invalid_mailbox_record');
          if (state.revision !== input!.expectedMailboxRevision) denied('mailbox_revision_conflict',409);
          if (!state.currentConnection || state.currentConnection.id !== input!.connectionId) denied('mailbox_connection_required',409);
          if (connection && canonicalErpJson(connection) !== canonicalErpJson(state.currentConnection)) denied('mailbox_revision_conflict',409);
          connection = state.currentConnection; return c;
        }
        await connected();
        const key = await d.encryptionKey(); await connected();
        if (!connection?.credentialsCiphertext) denied('mailbox_connection_required',409);
        const token = await decryptSecret(key,connection.credentialsCiphertext,usMailboxEncryptionContext(admitted,connection.id,connection.revision)); await connected();
        if (await sha256Hex(token) !== connection.tokenSha256) denied('invalid_mailbox_record');
        const message = await d.message(connection,token,input,connected); await connected();
        const source = validateUsSupportTriageSource(message.source);
        if (source.provider !== connection.provider || source.mailboxId !== connection.mailboxId || source.folderId !== connection.folderId || source.uid !== input.uid || source.messageVersion !== input.expectedMessageVersion) denied('triage_source_conflict',409);
        const reserved = result(await store.claim(await connected(),{request:input,source,grant:capturedGrant},connected)); await connected();
        if (reserved.job.state !== 'reserved') return respond(reserved);
        if (canonicalErpJson(reserved.job.grant) !== canonicalErpJson(capturedGrant)) denied('triage_policy_changed',409);
        const candidateDispatchId = (d.newId ?? (() => crypto.randomUUID()))();
        const dispatched = await store.dispatch(await connected(),{requestId:input.requestId,requestHash,dispatchId:candidateDispatchId},connected);
        // Capture attempted durable dispatch before any further await. Even a
        // gate/Auth failure here cannot release a possibly emitted operation.
        const fenced = result(dispatched.result);
        if (!dispatched.mayDispatch) return respond(fenced);
        dispatchId = candidateDispatchId;
        if (fenced.job.state !== 'dispatched' || fenced.job.dispatchId !== dispatchId) denied('invalid_triage_record');
        await inferenceCurrent();
        const decision = validateUsSupportTriageDecision(await d.classify(message,capturedGrant,connected),{source,grant:capturedGrant}); await connected();
        const completed = result(await store.complete(await inferenceCurrent(),{requestId:input.requestId,requestHash,dispatchId,decision},inferenceCurrent)); await inferenceCurrent();
        if (completed.job.state !== 'completed' || canonicalErpJson(completed.job.result) !== canonicalErpJson(decision)) denied('invalid_triage_record');
        return respond(completed);
      } catch (error) {
        let outgoing = failure(error);
        // Auth/gate loss outranks a simultaneous private provider/store error.
        if (admitted) { try { await current(); } catch (late) { const f = failure(late); if ([401,402,403,404].includes(f.status)) outgoing = f; } }
        if (dispatchId && store && input && requestHash && admitted && ![401,402,403,404].includes(outgoing.status)) {
          try { await store.uncertain(await current(),{requestId:input.requestId,requestHash,dispatchId},current); }
          catch { /* A persisted dispatch is already a fence if this marker fails. */ }
          if (outgoing.status === 422) outgoing = {code:'triage_provider_unavailable',status:503};
          try { await current(); } catch (late) { const f = failure(late); if ([401,402,403,404].includes(f.status)) outgoing = f; }
        }
        d.diagnostic?.({operation,...outgoing});
        return Response.json({error:outgoing.code},{status:outgoing.status,headers});
      }
    };
  }
  return {read:handler('read'),triage:handler('triage')};
}
