import {
  PublicationLedgerError,
  type PublicationAttempt,
  type PublicationIdentity,
  type PublicationLedger,
  type PublicationResult,
} from './publication-ledger-types';
import {
  capturePublicationAttempt,
  capturePublicationIdentity,
  capturePublicationResult,
} from './publication-ledger';

export { capturePublicationIdentity } from './publication-ledger';

/** Private server ports. A publication is transport metadata, never permission. */
export type PublicationCoordinatorPorts = Readonly<{
  ledger: PublicationLedger;
  enableGuard: (organizationId: string) => Promise<unknown>;
  commit: (attempt: PublicationAttempt) => Promise<unknown>;
  close: (attempt: PublicationAttempt) => Promise<unknown>;
  now?: () => number;
}>;

const RECOVERY_DELAY_SECONDS = 120;
const invalid = (): never => {
  throw new PublicationLedgerError('invalid_record');
};
function object(raw: unknown): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    return invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string') return invalid();
    const field = Object.getOwnPropertyDescriptor(raw, key);
    if (!field?.enumerable || !('value' in field)) return invalid();
    result[key] = field.value;
  }
  return result;
}
function exact(raw: unknown, keys: readonly string[]) {
  const value = object(raw);
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return invalid();
  return value;
}
function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    return invalid();
  return value;
}
function integer(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    return invalid();
  return value;
}

/** Closed service-RPC output. Extra fields are accepted only for v2 conflicts. */
export function capturePublicationRpcResult(
  raw: unknown,
  attempt: PublicationAttempt,
): PublicationResult {
  const value = object(raw),
    keys = Object.keys(value);
  if (
    typeof value.committed !== 'boolean' ||
    !['committed', 'revision', 'snapshotId'].every((key) =>
      Object.hasOwn(value, key),
    ) ||
    keys.some(
      (key) =>
        ![
          'committed',
          'revision',
          'snapshotId',
          'cancelled',
          'conflict',
        ].includes(key),
    )
  )
    return invalid();
  if (
    value.committed
      ? keys.length !== 3
      : keys.length !== 3 &&
        !(
          keys.length === 5 &&
          value.cancelled === true &&
          value.conflict === true
        )
  )
    return invalid();
  return capturePublicationResult(
    {
      committed: value.committed,
      revision: value.revision,
      snapshotId: value.snapshotId,
    },
    attempt,
  );
}

export function capturePublicationGuard(raw: unknown) {
  const value = exact(raw, ['guarded', 'revision', 'snapshotId']);
  const revision = integer(value.revision, 0);
  const snapshotId = value.snapshotId === null ? null : uuid(value.snapshotId);
  if (value.guarded !== true || (revision === 0) !== (snapshotId === null))
    return invalid();
  return Object.freeze({ guarded: true as const, revision, snapshotId });
}

/**
 * D1 pending -> guarded PostgreSQL CAS -> D1 terminal. A lost result retains the
 * pending barrier. Age only permits asking PostgreSQL to close under its head
 * lock; it NEVER releases D1 itself. The close RPC records a durable tombstone,
 * so a delayed original commit cannot arrive after the barrier was removed.
 * No activation, HTTP endpoint, native write or authorization is provided here.
 */
export function createPublicationCoordinator(
  ports: PublicationCoordinatorPorts,
) {
  const begin = ports.ledger.begin.bind(ports.ledger),
    settle = ports.ledger.settle.bind(ports.ledger),
    enableGuard = ports.enableGuard.bind(ports),
    commit = ports.commit.bind(ports),
    close = ports.close.bind(ports),
    now = ports.now ?? (() => Math.floor(Date.now() / 1000));

  return async (
    rawIdentity: PublicationIdentity,
  ): Promise<PublicationResult> => {
    const identity = capturePublicationIdentity(rawIdentity);
    capturePublicationGuard(await enableGuard(identity.organizationId));
    let reservation = await begin(identity);
    if (reservation.state === 'held') {
      const held = capturePublicationAttempt(reservation.attempt);
      // A malformed/cross-company capability must never be used in a close RPC.
      const time = integer(now(), 1, 253402300799);
      const createdAt = integer(held.createdAt, 1, 253402300799);
      if (
        held.organizationId !== identity.organizationId ||
        held.state !== 'pending' ||
        held.result !== null
      )
        return invalid();
      if (time < createdAt + RECOVERY_DELAY_SECONDS)
        throw new PublicationLedgerError('conflict');
      // PG may prove an earlier commit, or permanently cancel this operation.
      const proof = capturePublicationRpcResult(await close(held), held);
      await settle(held, proof);
      reservation = await begin(identity);
      if (reservation.state === 'held')
        throw new PublicationLedgerError('conflict');
    }
    const attempt = capturePublicationAttempt(reservation.attempt);
    const capturedIdentity = capturePublicationIdentity({
      organizationId: attempt.organizationId,
      snapshotId: attempt.snapshotId,
      installationId: attempt.installationId,
      userId: attempt.userId,
      baseRevision: attempt.baseRevision,
      archiveSha256: attempt.archiveSha256,
      manifestSha256: attempt.manifestSha256,
      sizeBytes: attempt.sizeBytes,
    });
    if (JSON.stringify(capturedIdentity) !== JSON.stringify(identity))
      return invalid();
    if (reservation.state === 'settled') {
      if (!attempt.result) return invalid();
      return capturePublicationRpcResult(attempt.result, attempt);
    }
    // PostgreSQL serializes retries of this operation and returns its first fact.
    const result = capturePublicationRpcResult(await commit(attempt), attempt);
    await settle(attempt, result);
    // Callers can announce/prune only AFTER the durable D1 settlement succeeds.
    return result;
  };
}
