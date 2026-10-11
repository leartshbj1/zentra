import type { DeviceSessionContext } from '@/lib/account';
import {
  AccountPublicError,
  isAccountRole,
  roleCanWriteInvoices,
  sha256Hex,
} from '@/lib/account-security';
import {
  collaborationSnapshot,
  downloadCollaborationChunk,
} from '@/lib/company-collaboration';
import { requireLegacyCountryTransport } from '@/lib/international/legacy-country-guard';
import { database } from '@/lib/runtime';
import { supabaseServerClient } from '@/lib/supabase-server-runtime';
import {
  backupManifest,
  MAX_BACKUP_CHUNKS,
  type BackupManifest,
} from '@/lib/workspace-backup';
import { capturePublicationRpcResult } from './publication-coordinator';
import { verifyPublicationFact } from './publication-gateway';
import {
  capturePublicationAttempt,
  createPublicationLedger,
} from './publication-ledger';
import {
  PublicationLedgerError,
  type PublicationAttempt,
} from './publication-ledger-types';
import {
  CanonicalQuoteArchiveError,
  QUOTE_ARCHIVE_MAX_BYTES,
  readCanonicalQuoteArchive,
} from './quote-archive';

const invalid = (): never => {
  throw new PublicationLedgerError('invalid_record');
};
function record(raw: unknown): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    return invalid();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    const field = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== 'string' || !field?.enumerable || !('value' in field))
      return invalid();
    copy[key] = field.value;
  }
  return copy;
}
function exact(raw: unknown, keys: readonly string[]) {
  const value = record(raw);
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return invalid();
  return value;
}
function identifier(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    raw.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(raw)
  )
    return invalid();
  return raw;
}
function captureSession(
  raw: DeviceSessionContext,
): Readonly<DeviceSessionContext> {
  const value = exact(raw, [
    'organizationId',
    'organizationName',
    'subscriptionId',
    'role',
    'sessionId',
    'userId',
    'installationId',
    'entitlementValidUntil',
  ]);
  if (!isAccountRole(value.role) || !roleCanWriteInvoices(value.role))
    throw new AccountPublicError(
      'Votre rôle ne permet pas cette confirmation.',
      403,
    );
  if (
    typeof value.organizationName !== 'string' ||
    value.organizationName.length > 500 ||
    typeof value.entitlementValidUntil !== 'number' ||
    !Number.isSafeInteger(value.entitlementValidUntil) ||
    value.entitlementValidUntil < 1
  )
    return invalid();
  return Object.freeze({
    organizationId: identifier(value.organizationId),
    organizationName: value.organizationName,
    subscriptionId: identifier(value.subscriptionId),
    role: value.role,
    sessionId: identifier(value.sessionId),
    userId: identifier(value.userId),
    installationId: identifier(value.installationId),
    entitlementValidUntil: value.entitlementValidUntil,
  });
}
function captureManifest(raw: unknown): Readonly<BackupManifest> {
  const value = exact(raw, [
    'format',
    'version',
    'app_version',
    'sha256',
    'size_bytes',
    'chunks',
  ]);
  const chunks = value.chunks;
  if (
    !Array.isArray(chunks) ||
    Object.getPrototypeOf(chunks) !== Array.prototype ||
    chunks.length < 1 ||
    chunks.length > MAX_BACKUP_CHUNKS ||
    Reflect.ownKeys(chunks).length !== chunks.length + 1
  )
    return invalid();
  const parts = [];
  for (let index = 0; index < chunks.length; index++) {
    const field = Object.getOwnPropertyDescriptor(chunks, String(index));
    if (!field?.enumerable || !('value' in field)) return invalid();
    parts.push(exact(field.value, ['sha256', 'size_bytes']));
  }
  const manifest = backupManifest({ ...value, chunks: parts });
  // Capture before the next authorization await. The transport JSON itself need
  // not be canonical; its normalized, closed manifest hash must be exact.
  for (const part of manifest.chunks) Object.freeze(part);
  Object.freeze(manifest.chunks);
  return Object.freeze(manifest);
}
function identity(attempt: PublicationAttempt) {
  const {
    state: _state,
    result: _result,
    settledAt: _settledAt,
    ...value
  } = attempt;
  return JSON.stringify(value);
}
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
function intrinsic(name: PropertyKey): (this: unknown) => unknown {
  // oxlint-disable-next-line typescript/unbound-method -- Only Reflect.apply below invokes this getter, with the typed-array receiver.
  return Object.getOwnPropertyDescriptor(typedArrayPrototype, name)!.get!;
}
const byteLength = intrinsic('byteLength'),
  arrayBuffer = intrinsic('buffer'),
  byteOffset = intrinsic('byteOffset'),
  arrayTag = intrinsic(Symbol.toStringTag);
// oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below invokes this brand-checking getter with its ArrayBuffer receiver.
const arrayBufferLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)!.get!;
// oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below supplies the owned destination receiver.
const setBytes = Uint8Array.prototype.set;
function captureChunk(
  raw: Uint8Array,
  expectedBytes: number,
): Uint8Array<ArrayBuffer> {
  const buffer: unknown = Reflect.apply(arrayBuffer, raw, []);
  const offset: unknown = Reflect.apply(byteOffset, raw, []);
  if (
    Reflect.apply(arrayTag, raw, []) !== 'Uint8Array' ||
    !(buffer instanceof ArrayBuffer) ||
    typeof offset !== 'number' ||
    Reflect.apply(byteLength, raw, []) !== expectedBytes
  )
    return invalid();
  // The intrinsic brand rejects SharedArrayBuffer even if its prototype was
  // changed. Neither a subclass iterator, own getter nor species participates.
  Reflect.apply(arrayBufferLength, buffer, []);
  const copy = new Uint8Array(expectedBytes);
  Reflect.apply(setBytes, copy, [
    new Uint8Array(buffer, offset, expectedBytes),
  ]);
  return copy;
}

/** First canonical proof only. This private loader never reads a current head,
 * enables coordination, commits/closes a publication, or supplies permission.
 * A retained fact alone is insufficient when the actual archive was pruned.
 * The caller still has to verify SQLite business facts and atomically fence
 * their evidence/confirmation; D1, PG and storage are not one transaction. */
export async function loadCanonicalQuotePublication(
  rawSession: DeviceSessionContext,
  rawAttempt: PublicationAttempt,
  rawAuthorize: () => Promise<void>,
): Promise<{
  publication: PublicationAttempt;
  sqliteBytes: Uint8Array<ArrayBuffer>;
}> {
  let session: Readonly<DeviceSessionContext>, attempt: PublicationAttempt;
  try {
    session = captureSession(rawSession);
    attempt = capturePublicationAttempt(rawAttempt);
    if (typeof rawAuthorize !== 'function') return invalid();
    if (
      attempt.organizationId !== session.organizationId ||
      attempt.userId !== session.userId ||
      attempt.installationId !== session.installationId
    )
      throw new AccountPublicError(
        'Cette publication ne correspond pas à votre appareil.',
        403,
      );
    if (
      attempt.state === 'cancelled' ||
      attempt.sizeBytes > QUOTE_ARCHIVE_MAX_BYTES
    )
      return invalid();
  } catch (error) {
    if (
      error instanceof AccountPublicError ||
      error instanceof PublicationLedgerError
    )
      throw error;
    return invalid();
  }
  const authorize = rawAuthorize.bind(undefined);
  // Capture every port result BEFORE awaiting the post-operation authority.
  // A delayed/rejected network operation must never bypass that last check.
  async function checked<T, U>(
    operation: () => Promise<T>,
    capture: (value: T) => U,
  ): Promise<U> {
    await authorize();
    let value: U;
    try {
      value = capture(await operation());
    } catch (error) {
      await authorize();
      throw error;
    }
    await authorize();
    return value;
  }
  try {
    await checked(
      () => requireLegacyCountryTransport(session.organizationId),
      () => undefined,
    );
    const ledger = await checked(
      async () => createPublicationLedger(database()),
      (value) => value,
    );
    const saved = await checked(
      () => ledger.read(attempt.organizationId, attempt.snapshotId),
      (value) =>
        value === null ? invalid() : capturePublicationAttempt(value),
    );
    if (
      identity(saved) !== identity(attempt) ||
      saved.state === 'cancelled' ||
      (attempt.state === 'committed' &&
        JSON.stringify(saved) !== JSON.stringify(attempt))
    )
      throw new PublicationLedgerError('conflict');
    attempt = saved;

    const fact = await checked(
      () =>
        supabaseServerClient().rpc<unknown>(
          'zentra_action_publication_fact_v1',
          { p_organization: attempt.organizationId, p_operation: attempt.id },
        ),
      (raw) => {
        const value = exact(raw, [
          'operationId',
          'organizationId',
          'snapshotId',
          'installationId',
          'userId',
          'baseRevision',
          'state',
          'manifest',
          'sizeBytes',
          'contentVersion',
          'result',
        ]);
        const result = capturePublicationRpcResult(value.result, attempt);
        if (!result.committed || value.state !== 'committed') return invalid();
        return Object.freeze({
          ...value,
          contentVersion: value.contentVersion,
          manifest: captureManifest(value.manifest),
          result,
        });
      },
    );
    await checked(
      () => verifyPublicationFact(fact, attempt, fact.result),
      () => undefined,
    );
    if (attempt.state === 'pending') {
      const previous = attempt;
      attempt = await checked(
        () => ledger.settle(previous, fact.result),
        capturePublicationAttempt,
      );
      if (
        identity(attempt) !== identity(previous) ||
        attempt.state !== 'committed' ||
        JSON.stringify(attempt.result) !== JSON.stringify(fact.result)
      )
        return invalid();
    } else if (JSON.stringify(attempt.result) !== JSON.stringify(fact.result)) {
      throw new PublicationLedgerError('conflict');
    }
    const snapshot = await checked(
      () => collaborationSnapshot(session, attempt.snapshotId),
      (raw) => {
        const value = record(raw);
        return Object.freeze({
          id: value.id,
          organizationId: value.organization_id,
          installationId: value.installation_id,
          userId: value.created_by,
          baseRevision: value.base_revision,
          revision: value.revision,
          sizeBytes: value.size_bytes,
          contentVersion: value.content_version,
          manifest: captureManifest(value.manifest),
        });
      },
    );
    if (
      snapshot.id !== attempt.snapshotId ||
      snapshot.organizationId !== attempt.organizationId ||
      snapshot.installationId !== attempt.installationId ||
      snapshot.userId !== attempt.userId ||
      snapshot.baseRevision !== attempt.baseRevision ||
      snapshot.revision !== fact.result.revision ||
      snapshot.sizeBytes !== attempt.sizeBytes ||
      snapshot.contentVersion !== fact.contentVersion ||
      ![0, 1].includes(snapshot.contentVersion as number) ||
      JSON.stringify(snapshot.manifest) !== JSON.stringify(fact.manifest)
    )
      throw new PublicationLedgerError('conflict');
    const manifest = snapshot.manifest;
    if (
      manifest.size_bytes !== attempt.sizeBytes ||
      manifest.size_bytes > QUOTE_ARCHIVE_MAX_BYTES ||
      manifest.sha256 !== attempt.archiveSha256 ||
      (await checked(
        () => sha256Hex(JSON.stringify(manifest)),
        (value) => value,
      )) !== attempt.manifestSha256
    )
      throw new PublicationLedgerError('conflict');
    const archive = new Uint8Array(manifest.size_bytes);
    let offset = 0;
    for (let index = 0; index < manifest.chunks.length; index++) {
      const expected = manifest.chunks[index];
      const bytes = await checked(
        () =>
          downloadCollaborationChunk(
            session,
            attempt.snapshotId,
            String(index),
          ),
        (value) => captureChunk(value, expected.size_bytes),
      );
      if (
        (await checked(
          () => sha256Hex(bytes),
          (value) => value,
        )) !== expected.sha256
      )
        return invalid();
      if (offset + bytes.byteLength > archive.byteLength) return invalid();
      archive.set(bytes, offset);
      offset += bytes.byteLength;
    }
    if (
      offset !== archive.byteLength ||
      (await checked(
        () => sha256Hex(archive),
        (value) => value,
      )) !== attempt.archiveSha256
    )
      return invalid();
    const decoded = await checked(
      () =>
        readCanonicalQuoteArchive(archive, {
          organizationId: attempt.organizationId,
          snapshotId: attempt.snapshotId,
          baseRevision: attempt.baseRevision,
          archiveSha256: attempt.archiveSha256,
        }),
      (value) => captureChunk(value.sqliteBytes, value.sqliteBytes.byteLength),
    );
    return Object.freeze({ publication: attempt, sqliteBytes: decoded });
  } catch (error) {
    if (
      error instanceof AccountPublicError ||
      error instanceof PublicationLedgerError ||
      error instanceof CanonicalQuoteArchiveError
    )
      throw error;
    throw new PublicationLedgerError('service_unavailable');
  }
}
