import { decryptSecret } from '../support/crypto';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson } from './erp-contract';
import {
  sameUsSupportExecutionContext,
  usSupportExecutionMailboxEncryptionContext,
  validateUsSupportExecutionContext,
  type UsSupportWorkerContext,
} from './us-support-execution-contract';
import {
  validateUsMailboxState,
  type UsMailboxConnection,
  type UsMailboxState,
} from './us-support-mailbox-contract';
import type {
  UsSupportIntakeDiscovery,
  UsSupportIntakeScan,
} from './us-support-intake-provider';
import {
  validateUsSupportTriageRequest,
  validateUsSupportTriageResult,
  type UsSupportTriageRequest,
  type UsSupportTriageResult,
} from './us-support-triage-contract';
import {
  UsSupportWorkerError,
  type UsSupportWorkerDiscovered,
  type UsSupportWorkerOutcome,
  type UsSupportWorkerStore,
} from './us-support-worker-contract';

export interface UsSupportWorkerDependencies {
  enabled(this: void): Promise<boolean>;
  now(this: void): number;
  store(this: void): Promise<UsSupportWorkerStore>;
  mailbox(this: void, context: UsSupportWorkerContext): Promise<UsMailboxState>;
  encryptionKey(this: void): Promise<string>;
  discover(
    this: void,
    connection: UsMailboxConnection,
    token: string,
    scan: UsSupportIntakeScan,
    check: () => Promise<unknown>,
  ): Promise<UsSupportIntakeDiscovery>;
  resolveVersion(
    this: void,
    connection: UsMailboxConnection,
    token: string,
    uid: string,
    check: () => Promise<unknown>,
  ): Promise<{ readonly messageVersion: string; readonly receivedAt: number }>;
  triage(
    this: void,
    context: UsSupportWorkerContext,
    request: UsSupportTriageRequest,
    revalidate: () => Promise<UsSupportWorkerContext>,
  ): Promise<UsSupportTriageResult>;
  processingPolicyVersion(
    this: void,
    context: UsSupportWorkerContext,
  ): Promise<string>;
  newId?(this: void): string;
  diagnostic?(
    this: void,
    event: Readonly<{
      operation: 'intake';
      code: string;
      outcome: UsSupportWorkerOutcome;
      runId?: string;
      organizationId?: string;
      workspaceId?: string;
    }>,
  ): void;
}
export interface UsSupportWorkerTickResult {
  readonly acquired: number;
  readonly ticketed: number;
  readonly outcomes: readonly UsSupportWorkerOutcome[];
}
// Paid D1 permits 1000 SQL executions per invocation. Fresh authority checks
// consume a material share of that allowance; keep this pilot turn bounded.
export const US_SUPPORT_WORKER_MAX_LEASES_PER_TICK = 1;
export const US_SUPPORT_WORKER_MAX_MESSAGES_PER_LEASE = 1;
const known = new Set([
  'feature_unavailable',
  'forbidden',
  'unauthorized',
  'subscription_required',
  'worker_revoked',
  'worker_lease_expired',
  'worker_authority_changed',
  'worker_policy_changed',
  'worker_connection_changed',
  'configuration_changed',
  'triage_policy_changed',
  'mailbox_revision_conflict',
  'triage_connection_changed',
  'mailbox_connection_required',
  'triage_quota_exceeded',
  'triage_capacity_exceeded',
  'ticket_capacity_exceeded',
  'worker_capacity_exceeded',
  'intake_capacity_exceeded',
  'triage_source_conflict',
  'triage_source_unavailable',
  'intake_source_conflict',
  'intake_source_unavailable',
  'before_consent_date',
  'connection_replaced',
]);
function code(error: unknown): string {
  return error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    known.has(error.code)
    ? error.code
    : 'intake_failed';
}
function outcome(error: unknown): UsSupportWorkerOutcome {
  const value = code(error);
  if (value.includes('quota')) return 'budget_blocked';
  if (value.includes('capacity')) return 'capacity_blocked';
  if (value.includes('policy')) return 'policy_changed';
  if (value.includes('connection') || value === 'mailbox_revision_conflict')
    return 'connection_changed';
  if (
    [
      'forbidden',
      'unauthorized',
      'subscription_required',
      'worker_revoked',
      'worker_lease_expired',
      'worker_authority_changed',
      'feature_unavailable',
    ].includes(value) ||
    (error instanceof Error &&
      'status' in error &&
      [401, 402, 403, 404].includes(Number(error.status)))
  )
    return 'revoked';
  return 'failed';
}
const rejected = new Set([
  'triage_source_conflict',
  'triage_source_unavailable',
  'intake_source_conflict',
  'intake_source_unavailable',
  'before_consent_date',
  'connection_replaced',
]);

/** A bounded scheduled turn. All durable work is owned by D1, never by a timer,
 * browser session or in-memory queue. There are no send/payment/ledger ports. */
export function createUsSupportWorker(d: UsSupportWorkerDependencies) {
  return {
    async tick(): Promise<UsSupportWorkerTickResult> {
      if (!(await d.enabled()))
        return { acquired: 0, ticketed: 0, outcomes: [] };
      const store = await d.store();
      let acquired = 0,
        ticketed = 0;
      const outcomes: UsSupportWorkerOutcome[] = [];
      // Remaining work stays durable for later scheduled invocations.
      for (let turn = 0; turn < US_SUPPORT_WORKER_MAX_LEASES_PER_TICK; turn++) {
        if (!(await d.enabled())) break;
        const acquiredLease = await store.acquire({
          runId: (d.newId ?? (() => crypto.randomUUID()))(),
          leaseSeconds: 120,
        });
        if (!acquiredLease) break;
        const lease = acquiredLease;
        const report = (error: unknown, value: UsSupportWorkerOutcome) => {
          try {
            d.diagnostic?.({
              operation: 'intake',
              code: code(error),
              outcome: value,
              runId: lease.runId,
              organizationId: lease.organizationId,
              workspaceId: lease.workspaceId,
            });
          } catch {
            /* Diagnostics contain only opaque authority IDs and codes. */
          }
        };
        acquired++;
        let admitted: UsSupportWorkerContext | undefined,
          result: UsSupportWorkerOutcome = 'idle';
        const now = () => {
          const n = d.now();
          if (!Number.isSafeInteger(n) || n <= 0)
            throw new UsSupportWorkerError('invalid_worker_clock', 503);
          return n;
        };
        async function current(): Promise<UsSupportWorkerContext> {
          if (now() >= lease.expiresAt)
            throw new UsSupportWorkerError('worker_lease_expired', 403);
          const enabled = await d.enabled();
          const fresh = validateUsSupportExecutionContext(
            await store.revalidate(admitted ?? lease),
            lease.organizationId,
            now(),
          );
          if (fresh.authority.credential.kind !== 'worker')
            throw new UsSupportWorkerError('worker_authority_changed', 403);
          const worker = fresh as UsSupportWorkerContext;
          if (
            worker.workspaceId !== lease.workspaceId ||
            worker.authority.credential.workerId !== lease.workerId ||
            worker.authority.credential.runId !== lease.runId ||
            worker.authority.credential.delegationId !== lease.delegationId ||
            worker.authority.credential.delegationRevision !==
              lease.delegationRevision
          )
            throw new UsSupportWorkerError('worker_authority_changed', 403);
          if (admitted) sameUsSupportExecutionContext(admitted, worker);
          if (!enabled || !(await d.enabled()))
            throw new UsSupportWorkerError('feature_unavailable', 404);
          if (now() >= lease.expiresAt)
            throw new UsSupportWorkerError('worker_lease_expired', 403);
          admitted = worker;
          return worker;
        }
        try {
          await current();
          const previous = await store.pending(
            await current(),
            US_SUPPORT_WORKER_MAX_MESSAGES_PER_LEASE,
          );
          await current();
          const recovery = previous.filter((item) => item.request !== null);
          const attempted = new Set<string>();
          const preserveRecovery = () => {
            if (result === 'completed') result = 'partial';
          };
          async function process(
            item: UsSupportWorkerDiscovered,
            check: () => Promise<UsSupportWorkerContext>,
            prepare?: () => Promise<UsSupportWorkerDiscovered>,
          ) {
            if (
              attempted.has(item.id) ||
              attempted.size >= US_SUPPORT_WORKER_MAX_MESSAGES_PER_LEASE
            )
              return;
            attempted.add(item.id);
            try {
              const prepared = item.request
                ? item
                : prepare
                  ? await prepare()
                  : item;
              if (!prepared.request)
                throw new UsSupportWorkerError('invalid_worker_record', 503);
              const request = validateUsSupportTriageRequest(prepared.request);
              if (
                prepared.id !== item.id ||
                prepared.requestId !== item.requestId ||
                request.requestId !== item.requestId ||
                request.uid !== item.uid ||
                request.connectionId !== item.connectionId ||
                request.expectedMailboxRevision !== item.mailboxRevision
              )
                throw new UsSupportWorkerError('invalid_worker_record', 503);
              const c = await check(),
                triaged = validateUsSupportTriageResult(
                  await d.triage(c, request, check),
                  lease.organizationId,
                  lease.workspaceId,
                );
              await check();
              if (
                triaged.requestId !== request.requestId ||
                triaged.job.source.uid !== request.uid ||
                triaged.job.source.messageVersion !==
                  request.expectedMessageVersion
              )
                throw new UsSupportWorkerError('invalid_worker_record', 503);
              if (triaged.job.state !== 'completed') {
                await store.stage(
                  await check(),
                  {
                    discoveryId: item.id,
                    stage: 'uncertain',
                    jobId: triaged.job.id,
                    code: 'dispatch_uncertain',
                  },
                  check,
                );
                result = 'uncertain';
                return;
              }
              // The shared service returns only after its ticket sink succeeds.
              await store.stage(
                await check(),
                {
                  discoveryId: item.id,
                  stage: 'ticketed',
                  jobId: triaged.job.id,
                  code: null,
                },
                check,
              );
              await check();
              ticketed++;
              if (result === 'idle') result = 'completed';
              else if (result === 'failed') result = 'partial';
            } catch (error) {
              // Fresh authority loss outranks a provider/transport failure.
              await current();
              // The shared service replays any durable dispatch/completion
              // before mailbox admission. A live new lease plus this refusal
              // therefore identifies an old, un-emitted connection request.
              const rejection =
                item.request &&
                [
                  'mailbox_revision_conflict',
                  'mailbox_connection_required',
                ].includes(code(error))
                  ? 'connection_replaced'
                  : rejected.has(code(error))
                    ? code(error)
                    : null;
              if (rejection) {
                await store.stage(
                  await current(),
                  {
                    discoveryId: item.id,
                    stage: 'rejected',
                    jobId: item.jobId,
                    code: rejection,
                  },
                  current,
                );
                if (result === 'idle' || result === 'completed')
                  result = 'partial';
                return;
              }
              if (outcome(error) !== 'failed') throw error;
              // A transient failure keeps the immutable request pending for
              // the next lease. Other messages in this batch can still run.
              await store.defer(
                await current(),
                { discoveryId: item.id, code: code(error) },
                current,
              );
              await current();
              if (result === 'idle') result = 'failed';
              else if (result === 'completed') result = 'partial';
              report(error, 'failed');
            }
          }
          // Recover before accessing the mailbox or provider configuration. A
          // subsequent intake outage cannot undo a durable ticket recovery.
          for (const item of recovery) await process(item, current);
          try {
            const state = validateUsMailboxState(
              await d.mailbox(await current()),
              lease.organizationId,
            );
            await current();
            const connection = state.currentConnection;
            if (
              state.workspaceId !== lease.workspaceId ||
              !connection?.credentialsCiphertext
            )
              throw new UsSupportWorkerError(
                'mailbox_connection_required',
                409,
              );
            async function connected() {
              const c = await current(),
                latest = validateUsMailboxState(
                  await d.mailbox(c),
                  lease.organizationId,
                );
              await current();
              if (
                latest.workspaceId !== lease.workspaceId ||
                canonicalErpJson(latest) !== canonicalErpJson(state)
              )
                throw new UsSupportWorkerError(
                  'triage_connection_changed',
                  409,
                );
              return c;
            }
            const key = await d.encryptionKey();
            await connected();
            const token = await decryptSecret(
              key,
              connection.credentialsCiphertext,
              usSupportExecutionMailboxEncryptionContext(
                await current(),
                connection.id,
                connection.revision,
              ),
            );
            await connected();
            if ((await sha256Hex(token)) !== connection.tokenSha256)
              throw new UsSupportWorkerError('invalid_mailbox_record', 503);
            await connected();
            async function processConnected(item: UsSupportWorkerDiscovered) {
              await process(
                item,
                item.request ? current : connected,
                async () => {
                  if (
                    item.connectionId !== connection!.id ||
                    item.mailboxRevision !== state.revision
                  )
                    throw new UsSupportWorkerError('connection_replaced', 409);
                  let version = item.version,
                    receivedAt = item.receivedAt;
                  if (!version || receivedAt === null) {
                    const resolved = await d.resolveVersion(
                      connection!,
                      token,
                      item.uid,
                      connected,
                    );
                    await connected();
                    version = resolved.messageVersion;
                    receivedAt = resolved.receivedAt;
                  }
                  if (
                    !Number.isSafeInteger(receivedAt) ||
                    receivedAt <= 0 ||
                    receivedAt > 253_402_300_799
                  )
                    throw new UsSupportWorkerError(
                      'intake_source_unavailable',
                      422,
                    );
                  // Provider dates are not arrival proofs. Clearly older sources
                  // are rejected before preparation, quota or classification.
                  if (receivedAt < lease.sinceAt)
                    throw new UsSupportWorkerError('before_consent_date', 422);
                  const processingPolicyVersion =
                    await d.processingPolicyVersion(await connected());
                  await connected();
                  const prepared = await store.prepare(
                    await connected(),
                    {
                      discoveryId: item.id,
                      request: {
                        schemaVersion: 1,
                        requestId: item.requestId,
                        connectionId: connection!.id,
                        expectedMailboxRevision: connection!.revision,
                        uid: item.uid,
                        expectedMessageVersion: version,
                        processingPolicyVersion,
                        consent: true,
                      },
                    },
                    connected,
                  );
                  await connected();
                  return prepared;
                },
              );
            }
            // Drain received work even when a new discovery page would exceed
            // the pilot capacity. Failed page admission must not block it.
            for (const item of previous)
              if (!item.request) await processConnected(item);
            async function discover(offset: number, headOnly = false) {
              const page = await d.discover(
                connection!,
                token,
                { offset, sinceAt: lease.sinceAt },
                connected,
              );
              await connected();
              if (page.offset !== offset)
                throw new UsSupportWorkerError('invalid_intake_page', 503);
              await store.discover(
                await connected(),
                {
                  offset,
                  nextOffset: page.nextOffset,
                  ...(headOnly ? { headOnly: true } : {}),
                  references: page.references.map((ref) => ({
                    uid: ref.uid,
                    version: ref.versionHint,
                    receivedAt: ref.receivedAt,
                  })),
                  issues: page.issues.map((issue) => ({
                    code: issue.code,
                    uid: null,
                    fingerprint: issue.fingerprint,
                  })),
                },
                connected,
              );
              await connected();
            }
            // Refresh the head while a long scan is underway; never advance a
            // high date watermark that could silently skip late messages.
            if (lease.scanOffset > 0) await discover(0, true);
            await discover(lease.scanOffset);
            const pending =
              attempted.size < US_SUPPORT_WORKER_MAX_MESSAGES_PER_LEASE
                ? await store.pending(
                    await connected(),
                    US_SUPPORT_WORKER_MAX_MESSAGES_PER_LEASE + attempted.size,
                  )
                : [];
            await connected();
            for (const item of pending) await processConnected(item);
          } catch (error) {
            await current();
            if (!attempted.size || outcome(error) !== 'failed') throw error;
            preserveRecovery();
            report(error, 'failed');
          }
        } catch (error) {
          result = outcome(error);
          report(error, result);
        }
        outcomes.push(result);
        try {
          await store.finish(await current(), {
            outcome: result,
            nextDueAt:
              now() +
              ([
                'budget_blocked',
                'capacity_blocked',
                'policy_changed',
                'connection_changed',
              ].includes(result)
                ? 300
                : 60),
          });
        } catch {
          /* A revoked/expired lease cannot regain authority to finish. The next lease replays durable receipts. */
        }
      }
      return { acquired, ticketed, outcomes };
    },
  };
}
