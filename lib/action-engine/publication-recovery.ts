import type { DeviceSessionContext } from '@/lib/account';
import {
  AccountPublicError,
  isAccountRole,
  roleCanWriteInvoices,
  sha256Hex,
} from '@/lib/account-security';
import { requireLegacyCountryTransport } from '@/lib/international/legacy-country-guard';
import { database } from '@/lib/runtime';
import { supabaseServerClient } from '@/lib/supabase-server-runtime';
import { backupManifest, MAX_BACKUP_CHUNKS } from '@/lib/workspace-backup';
import { capturePublicationRpcResult } from './publication-coordinator';
import { verifyPublicationFact } from './publication-gateway';
import {
  capturePublicationAttempt,
  capturePublicationIdentity,
  createPublicationLedger,
} from './publication-ledger';
import {
  PublicationLedgerError,
  type PublicationAttempt,
  type PublicationIdentity,
  type PublicationResult,
} from './publication-ledger-types';

export type PublicationRecovery =
  | Readonly<{ known: false }>
  | Readonly<{ known: true; pending: true }>
  | (Readonly<{ known: true }> & PublicationResult);

function record(raw: unknown): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    throw new PublicationLedgerError('invalid_record');
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    const field = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== 'string' || !field?.enumerable || !('value' in field))
      throw new PublicationLedgerError('invalid_record');
    copy[key] = field.value;
  }
  return copy;
}

function exact(raw: unknown, keys: readonly string[]) {
  const copy = record(raw);
  if (
    Object.keys(copy).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(copy, key))
  )
    throw new PublicationLedgerError('invalid_record');
  return copy;
}

/** Freeze nested transport metadata before any permission/network await. */
function captureManifest(raw: unknown) {
  const input = exact(raw, [
    'format',
    'version',
    'app_version',
    'sha256',
    'size_bytes',
    'chunks',
  ]);
  const chunks = input.chunks;
  if (
    !Array.isArray(chunks) ||
    Object.getPrototypeOf(chunks) !== Array.prototype ||
    chunks.length < 1 ||
    chunks.length > MAX_BACKUP_CHUNKS ||
    Reflect.ownKeys(chunks).length !== chunks.length + 1
  )
    throw new PublicationLedgerError('invalid_record');
  const captured = [];
  for (let index = 0; index < chunks.length; index++) {
    const field = Object.getOwnPropertyDescriptor(chunks, String(index));
    if (!field?.enumerable || !('value' in field))
      throw new PublicationLedgerError('invalid_record');
    captured.push(exact(field.value, ['sha256', 'size_bytes']));
  }
  return backupManifest({ ...input, chunks: captured });
}

function identityOf(attempt: PublicationAttempt) {
  return capturePublicationIdentity({
    organizationId: attempt.organizationId,
    snapshotId: attempt.snapshotId,
    installationId: attempt.installationId,
    userId: attempt.userId,
    baseRevision: attempt.baseRevision,
    archiveSha256: attempt.archiveSha256,
    manifestSha256: attempt.manifestSha256,
    sizeBytes: attempt.sizeBytes,
  });
}

/**
 * Read an existing guarded publication before the native app prepares or merges.
 * This is NOT a commit, lease transfer, catalogue proof, or Action Engine action.
 * It never enables a guard, starts/closes an attempt, uploads or prunes an archive.
 * Only a corroborated committed PG fact may settle a still-pending D1 attempt.
 * A pending result asks the caller to resume the existing commit with the SAME ID.
 * Historical recovery deliberately survives removal of the opt-in allowlist.
 */
export async function recoverCoordinatedPublication(
  actor: DeviceSessionContext,
  raw: unknown,
): Promise<PublicationRecovery> {
  let identity: PublicationIdentity;
  let manifestJson: string;
  try {
    const input = exact(raw, ['action', 'id', 'baseRevision', 'manifest']);
    if (input.action !== 'recover-publication')
      throw new PublicationLedgerError('invalid_record');
    const principal = record(actor);
    if (!isAccountRole(principal.role))
      throw new AccountPublicError(
        'Cet accès doit être vérifié. Reconnectez-vous.',
        403,
      );
    if (!roleCanWriteInvoices(principal.role))
      throw new AccountPublicError(
        'Votre rôle permet de consulter l’entreprise, sans la modifier.',
        403,
      );
    const manifest = captureManifest(input.manifest);
    // Validate and copy every identity field synchronously, before an await.
    identity = capturePublicationIdentity({
      organizationId: principal.organizationId,
      snapshotId: input.id,
      installationId: principal.installationId,
      userId: principal.userId,
      baseRevision: input.baseRevision,
      archiveSha256: manifest.sha256,
      manifestSha256: '0'.repeat(64),
      sizeBytes: manifest.size_bytes,
    });
    manifestJson = JSON.stringify(manifest);
  } catch (error) {
    if (error instanceof AccountPublicError) throw error;
    throw new AccountPublicError(
      'Les informations de synchronisation sont invalides.',
      400,
    );
  }

  try {
    await requireLegacyCountryTransport(identity.organizationId);
  } catch (error) {
    if (error instanceof AccountPublicError) throw error;
    throw new AccountPublicError(
      'La synchronisation reprendra automatiquement.',
      503,
    );
  }
  try {
    identity = capturePublicationIdentity({
      ...identity,
      manifestSha256: await sha256Hex(manifestJson),
    });
    const ledger = createPublicationLedger(database());
    const saved = await ledger.read(
      identity.organizationId,
      identity.snapshotId,
    );
    // Only genuine absence is unknown. Missing schema and SQL errors throw.
    if (saved === null) return { known: false };
    const attempt = capturePublicationAttempt(saved);
    if (JSON.stringify(identityOf(attempt)) !== JSON.stringify(identity))
      throw new PublicationLedgerError('conflict');
    const rawFact = await supabaseServerClient().rpc<unknown>(
      'zentra_action_publication_fact_v1',
      { p_organization: identity.organizationId, p_operation: attempt.id },
    );
    if (rawFact === null) {
      // Reservation may have survived a crash BEFORE PG was called. Returning
      // 503 forever would prevent the exact old commit from making progress.
      if (attempt.state === 'pending') return { known: true, pending: true };
      throw new PublicationLedgerError('invalid_record');
    }
    const fact = record(rawFact);
    const result = capturePublicationRpcResult(fact.result, attempt);
    if (result.committed) fact.manifest = captureManifest(fact.manifest);
    await verifyPublicationFact(fact, attempt, result);
    if (attempt.state === 'pending') {
      if (!result.committed) return { known: true, pending: true };
      const settled = capturePublicationAttempt(
        await ledger.settle(attempt, result),
      );
      if (
        settled.id !== attempt.id ||
        settled.createdAt !== attempt.createdAt ||
        settled.state !== 'committed' ||
        JSON.stringify(identityOf(settled)) !== JSON.stringify(identity) ||
        JSON.stringify(settled.result) !== JSON.stringify(result)
      )
        throw new PublicationLedgerError('invalid_record');
    } else if (JSON.stringify(attempt.result) !== JSON.stringify(result)) {
      throw new PublicationLedgerError('conflict');
    }
    // Return the historical revision, never the unrelated current head.
    return { known: true, ...result };
  } catch (error) {
    if (error instanceof PublicationLedgerError && error.code === 'conflict')
      throw new AccountPublicError(
        'Cette copie ne correspond pas à l’envoi initial. Vos données restent sur cet appareil.',
        409,
      );
    // No negative receipt or legacy fallback on an uncertain database/RPC read.
    throw new AccountPublicError(
      'La synchronisation reprendra automatiquement. Vos données restent sur cet appareil.',
      503,
    );
  }
}
