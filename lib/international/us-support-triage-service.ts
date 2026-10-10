import { AccountPublicError } from '../account-security';
import { decryptSecret } from '../support/crypto';
import { canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { snapshotPrivateJson } from './private-json';
import { UsSupportWorkspaceError } from './us-support-workspace-contract';
import { UsMailboxError, validateUsMailboxContext, validateUsMailboxState, type UsMailboxConnection, type UsMailboxState, type UsMailboxStore } from './us-support-mailbox-contract';
import { sameUsSupportExecutionContext, validateUsSupportExecutionContext, usSupportExecutionMailboxEncryptionContext, type UsSupportExecutionContext } from './us-support-execution-contract';
import { UsSupportTriageError, hashUsSupportTriageExecutionRequest, validateUsSupportTriageRequest, validateUsSupportTriageResult, validateUsSupportTriageSource, validateUsSupportTriageDecision,
  type UsSupportTriageGrant, type UsSupportTriageDecision, type UsSupportTriageRequest, type UsSupportTriageResult, type UsSupportTriageSource, type UsSupportTriageStore, type UsSupportTriageUsage } from './us-support-triage-contract';
import { createUsSupportTriageGrant, parseUsSupportTriagePolicy, type UsSupportTriagePolicy } from './us-support-triage-policy';

export interface UsSupportTriageMessage { readonly source: UsSupportTriageSource; readonly subject: string; readonly body: string }
type Revalidate = () => Promise<UsSupportExecutionContext>;
export interface UsSupportTriageServiceDependencies {
  now(this: void): number;
  store(this: void): Promise<UsSupportTriageStore>;
  /** Worker bindings supply this execution-aware private reader. */
  mailbox?(this: void, context: UsSupportExecutionContext): Promise<UsMailboxState>;
  /** Existing authenticated HTTP bindings retain their human-only store. */
  mailboxStore?(this: void): Promise<UsMailboxStore>;
  policy(this: void): Promise<UsSupportTriagePolicy>;
  providerReady(this: void): Promise<boolean>;
  encryptionKey(this: void): Promise<string>;
  message(this: void, connection: UsMailboxConnection, token: string, request: UsSupportTriageRequest, check: () => Promise<unknown>): Promise<UsSupportTriageMessage>;
  classify(this: void, message: UsSupportTriageMessage, grant: UsSupportTriageGrant, check: () => Promise<unknown>): Promise<UsSupportTriageDecision>;
  recordTicket?(this: void, context: UsSupportExecutionContext, jobId: string, revalidate: Revalidate): Promise<void>;
  newId?(this: void): string;
}
export interface UsSupportTriageBudget { readonly processingPolicyVersion: string; readonly recipeVersion: string; readonly usage: UsSupportTriageUsage }
function fail(code: string, status = 503): never { throw new UsSupportTriageError(code, status); }
function accessFailure(error: unknown): boolean {
  return (error instanceof UsSupportTriageError || error instanceof UsMailboxError || error instanceof UsSupportWorkspaceError || error instanceof AccountPublicError)
    && [401, 402, 403, 404].includes(error.status);
}

/** Common H3a execution core. The caller supplies freshly verified human or
 * durable worker authority; no HTTP request, Auth session or consent is forged.
 * Lease expiry can allow a new scan, never a second inference after dispatch. */
export function createUsSupportTriageService(d: UsSupportTriageServiceDependencies) {
  function execution(input: UsSupportExecutionContext, revalidate: Revalidate) {
    const now = () => { const n = d.now(); if (!Number.isSafeInteger(n) || n <= 0) return fail('service_unavailable'); return n; };
    const initial = validateUsSupportExecutionContext(input, undefined, now()), organizationId = initial.authority.organizationId;
    if (!['owner', 'admin'].includes(initial.authority.role)) fail('support_management_required', 403);
    async function current() {
      const fresh = validateUsSupportExecutionContext(await revalidate(), organizationId, now());
      sameUsSupportExecutionContext(initial, fresh);
      if (!['owner', 'admin'].includes(fresh.authority.role)) fail('support_management_required', 403);
      return fresh;
    }
    let capturedPolicy: UsSupportTriagePolicy | undefined, capturedGrant: UsSupportTriageGrant | undefined;
    async function inferenceCurrent() {
      let changed: unknown, latest: UsSupportTriagePolicy | undefined;
      try { latest = parseUsSupportTriagePolicy(await d.policy()); } catch (error) { changed = error; }
      const fresh = await current();
      if (changed !== undefined) throw changed;
      if (!latest || !capturedPolicy || !capturedGrant || canonicalErpJson(latest) !== canonicalErpJson(capturedPolicy)
        || canonicalErpJson(createUsSupportTriageGrant(fresh, latest)) !== canonicalErpJson(capturedGrant)) fail('triage_policy_changed', 409);
      return fresh;
    }
    async function grant() {
      capturedPolicy = parseUsSupportTriagePolicy(await d.policy());
      capturedGrant = createUsSupportTriageGrant(await current(), capturedPolicy); await inferenceCurrent();
      const ready = await d.providerReady(); await inferenceCurrent();
      if (!ready) fail('triage_provider_unavailable');
      return capturedGrant;
    }
    return { initial, current, inferenceCurrent, grant };
  }
  return {
    async readBudget(context: UsSupportExecutionContext, revalidate: Revalidate): Promise<UsSupportTriageBudget> {
      const e = execution(context, revalidate); await e.current();
      const store = await d.store(); await e.current();
      const grant = await e.grant(), usage = await store.usage(await e.inferenceCurrent(), grant); await e.inferenceCurrent();
      if (!usage || usage.limit !== grant.limit || !Number.isSafeInteger(usage.used) || usage.used < 0 || !Number.isSafeInteger(usage.remaining)
        || usage.remaining !== Math.max(0, usage.limit - usage.used)) fail('invalid_triage_record');
      return { processingPolicyVersion: grant.processingPolicyVersion, recipeVersion: grant.recipeVersion, usage };
    },
    async triage(context: UsSupportExecutionContext, requestInput: UsSupportTriageRequest, revalidate: Revalidate): Promise<UsSupportTriageResult> {
      // Snapshot synchronously. A caller-owned envelope cannot change while its
      // source is observed or its provider dispatch is being committed.
      const request = validateUsSupportTriageRequest(requestInput), e = execution(context, revalidate);
      const organizationId = e.initial.authority.organizationId, workspaceId = e.initial.workspaceId;
      let store: UsSupportTriageStore | undefined, requestHash: string | undefined, dispatchId: string | undefined;
      function result(value: unknown): UsSupportTriageResult {
        const r = validateUsSupportTriageResult(value, organizationId, workspaceId);
        if (r.requestId !== request.requestId || r.requestHash !== requestHash || r.job.source.uid !== request.uid || r.job.source.messageVersion !== request.expectedMessageVersion) return fail('invalid_triage_record');
        return r;
      }
      async function finish(r: UsSupportTriageResult): Promise<UsSupportTriageResult> {
        const c = await e.current();
        if (r.job.state === 'completed' && d.recordTicket) { await d.recordTicket(c, r.job.id, e.current); await e.current(); }
        return r;
      }
      try {
        await e.current(); store = await d.store(); await e.current();
        requestHash = await hashUsSupportTriageExecutionRequest(e.initial, request);
        const saved = await store.find(await e.current(), request.requestId, requestHash); await e.current();
        // Durable completed/ambiguous work needs neither a mailbox nor current
        // provider configuration. Observing a dispatch never authorizes a retry.
        if (saved && result(saved).job.state !== 'reserved') return await finish(result(saved));
        const grant = await e.grant();
        if (request.processingPolicyVersion !== grant.processingPolicyVersion) fail('triage_policy_changed', 409);
        let mailbox: UsMailboxStore | undefined;
        if (!d.mailbox) {
          if (!d.mailboxStore || e.initial.authority.credential.kind === 'worker') fail('service_unavailable');
          mailbox = await d.mailboxStore(); await e.inferenceCurrent();
        }
        let connection: UsMailboxConnection | undefined;
        async function connected() {
          const c = await e.inferenceCurrent();
          const state = validateUsMailboxState(d.mailbox ? await d.mailbox(c) : await mailbox!.read(validateUsMailboxContext(c)), organizationId); await e.inferenceCurrent();
          if (state.workspaceId !== c.workspaceId) fail('invalid_mailbox_record');
          if (state.revision !== request.expectedMailboxRevision) fail('mailbox_revision_conflict', 409);
          if (!state.currentConnection || state.currentConnection.id !== request.connectionId) fail('mailbox_connection_required', 409);
          if (connection && canonicalErpJson(connection) !== canonicalErpJson(state.currentConnection)) fail('mailbox_revision_conflict', 409);
          connection = state.currentConnection; return c;
        }
        await connected();
        const key = await d.encryptionKey(); await connected();
        if (!connection?.credentialsCiphertext) fail('mailbox_connection_required', 409);
        const token = await decryptSecret(key, connection.credentialsCiphertext, usSupportExecutionMailboxEncryptionContext(e.initial, connection.id, connection.revision)); await connected();
        if (await sha256Hex(token) !== connection.tokenSha256) fail('invalid_mailbox_record');
        const message = snapshotPrivateJson(await d.message(connection, token, request, connected)) as UsSupportTriageMessage; await connected();
        if (!message || typeof message !== 'object' || Object.keys(message).sort().join(',') !== 'body,source,subject'
          || typeof message.subject !== 'string' || typeof message.body !== 'string') fail('triage_source_unavailable', 422);
        const source = validateUsSupportTriageSource(message.source);
        if (source.provider !== connection.provider || source.mailboxId !== connection.mailboxId || source.folderId !== connection.folderId
          || source.uid !== request.uid || source.messageVersion !== request.expectedMessageVersion) fail('triage_source_conflict', 409);
        const reserved = result(await store.claim(await connected(), { request, source, grant }, connected)); await connected();
        if (reserved.job.state !== 'reserved') return await finish(reserved);
        if (canonicalErpJson(reserved.job.grant) !== canonicalErpJson(grant)) fail('triage_policy_changed', 409);
        const candidate = (d.newId ?? (() => crypto.randomUUID()))();
        const dispatched = await store.dispatch(await connected(), { requestId: request.requestId, requestHash, dispatchId: candidate }, connected);
        const fenced = result(dispatched.result);
        if (!dispatched.mayDispatch) return await finish(fenced);
        // Capture the durable fence before ANY subsequent await. A late rights
        // loss cannot release an operation that might have been emitted.
        dispatchId = candidate;
        if (fenced.job.state !== 'dispatched' || fenced.job.dispatchId !== dispatchId) fail('invalid_triage_record');
        await e.inferenceCurrent();
        const decision = validateUsSupportTriageDecision(await d.classify(message, grant, connected), { source, grant }); await connected();
        const completed = result(await store.complete(await e.inferenceCurrent(), { requestId: request.requestId, requestHash, dispatchId, decision }, e.inferenceCurrent)); await e.inferenceCurrent();
        if (completed.job.state !== 'completed' || canonicalErpJson(completed.job.result) !== canonicalErpJson(decision)) fail('invalid_triage_record');
        return await finish(completed);
      } catch (error) {
        let outgoing = error;
        try { await e.current(); } catch (late) { if (accessFailure(late)) outgoing = late; }
        if (dispatchId && store && requestHash && !accessFailure(outgoing)) {
          try { await store.uncertain(await e.current(), { requestId: request.requestId, requestHash, dispatchId }, e.current); }
          catch { /* The committed dispatch is a permanent fence if marking fails. */ }
          if (outgoing instanceof UsSupportTriageError && outgoing.status === 422) outgoing = new UsSupportTriageError('triage_provider_unavailable', 503);
          try { await e.current(); } catch (late) { if (accessFailure(late)) outgoing = late; }
        }
        throw outgoing;
      }
    },
  };
}
