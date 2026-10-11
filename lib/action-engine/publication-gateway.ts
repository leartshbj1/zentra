import type { DeviceSessionContext } from '@/lib/account';
import {
  AccountPublicError,
  roleCanWriteInvoices,
  sha256Hex,
} from '@/lib/account-security';
import { requireLegacyCountryTransport } from '@/lib/international/legacy-country-guard';
import { database, runtimeValue } from '@/lib/runtime';
import { supabaseServerClient } from '@/lib/supabase-server-runtime';
import { backupId, backupManifest } from '@/lib/workspace-backup';
import {
  capturePublicationIdentity,
  capturePublicationGuard,
  capturePublicationRpcResult,
  createPublicationCoordinator,
} from './publication-coordinator';
import { createPublicationLedger } from './publication-ledger';
import {
  PublicationLedgerError,
  type PublicationAttempt,
  type PublicationResult,
} from './publication-ledger-types';

/** Explicit server allowlist. Empty by default; never a browser/account setting. */
export function publicationCoordinationEnabled(
  organizationId: string,
): boolean {
  const configured = runtimeValue('ACTION_ENGINE_PUBLICATION_ORGANIZATIONS');
  if (!configured) return false;
  try {
    const list: unknown = JSON.parse(configured);
    if (
      !Array.isArray(list) ||
      list.length > 1000 ||
      list.some(
        (id) =>
          typeof id !== 'string' ||
          id.length > 160 ||
          !/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(id),
      ) ||
      new Set(list).size !== list.length
    )
      throw new Error('invalid');
    return list.includes(organizationId);
  } catch {
    throw new AccountPublicError(
      'La configuration de synchronisation doit être vérifiée. Vos données restent sur cet appareil.',
      503,
    );
  }
}

function object(raw: unknown): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    throw new PublicationLedgerError('invalid_record');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    const field = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== 'string' || !field?.enumerable || !('value' in field))
      throw new PublicationLedgerError('invalid_record');
    result[key] = field.value;
  }
  return result;
}

/** Service-only PostgreSQL registry proof, retained when transport copies prune. */
export async function verifyPublicationFact(
  raw: unknown,
  attempt: PublicationAttempt,
  expected: PublicationResult,
): Promise<void> {
  const fact = object(raw);
  const keys = [
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
  ];
  if (
    Object.keys(fact).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(fact, key)) ||
    fact.operationId !== attempt.id ||
    fact.organizationId !== attempt.organizationId ||
    fact.snapshotId !== attempt.snapshotId ||
    fact.installationId !== attempt.installationId ||
    fact.userId !== attempt.userId ||
    fact.baseRevision !== attempt.baseRevision ||
    fact.state !== (expected.committed ? 'committed' : 'cancelled') ||
    ![0, 1, null].includes(fact.contentVersion as number | null)
  )
    throw new PublicationLedgerError('invalid_record');
  const result = capturePublicationRpcResult(fact.result, attempt);
  if (JSON.stringify(result) !== JSON.stringify(expected))
    throw new PublicationLedgerError('conflict');
  if (expected.committed) {
    const manifest = backupManifest(fact.manifest);
    if (
      fact.contentVersion === null ||
      fact.sizeBytes !== attempt.sizeBytes ||
      manifest.size_bytes !== attempt.sizeBytes ||
      manifest.sha256 !== attempt.archiveSha256 ||
      (await sha256Hex(JSON.stringify(manifest))) !== attempt.manifestSha256
    )
      throw new PublicationLedgerError('conflict');
  }
}

/**
 * Only called from the already authenticated CH collaboration gateway after
 * explicit deployment approval and per-company opt-in. It does not authorize
 * Automation, interpret a document, or create a quote. No secrets are returned.
 */
export async function commitCoordinatedCollaboration(
  actor: DeviceSessionContext,
  rawId: unknown,
) {
  if (!roleCanWriteInvoices(actor.role))
    throw new AccountPublicError(
      'Votre rôle permet de consulter l’entreprise, sans la modifier.',
      403,
    );
  await requireLegacyCountryTransport(actor.organizationId);
  const id = backupId(rawId),
    pg = supabaseServerClient();
  try {
    if (!publicationCoordinationEnabled(actor.organizationId)) {
      // The PostgreSQL guard is permanent. Removing an opt-in flag disables new
      // Automation preparations, but cannot revert the transport to an unsafe
      // old protocol. This check runs only after a definitive legacy PA103.
      const guards = await pg.select<{ organization_id: string }>(
        'zentra_action_publication_guards',
        {
          organization_id: `eq.${actor.organizationId}`,
          select: 'organization_id',
          limit: 1,
        },
      );
      if (
        guards.length !== 1 ||
        guards[0].organization_id !== actor.organizationId ||
        Object.keys(guards[0]).length !== 1
      )
        throw new AccountPublicError(
          'Cette entreprise ne dispose pas de ce mode de synchronisation.',
          409,
        );
    }
    // Freeze metadata before reading it: even pending snapshots become immutable
    // once the PostgreSQL guard is active. Existing in-flight legacy writes are
    // serialized before this opt-in, later legacy head changes are rejected.
    const guard = capturePublicationGuard(
      await pg.rpc<unknown>('zentra_enable_action_publication_guard_v1', {
        p_organization: actor.organizationId,
      }),
    );
    const ledger = createPublicationLedger(database());
    const verifyFact = async (
      attempt: PublicationAttempt,
      result: PublicationResult,
    ) => {
      const fact = await pg.rpc<unknown>('zentra_action_publication_fact_v1', {
        p_organization: attempt.organizationId,
        p_operation: attempt.id,
      });
      await verifyPublicationFact(fact, attempt, result);
    };
    const invoke = async (name: string, attempt: PublicationAttempt) => {
      const raw = await pg.rpc<unknown>(name, {
        p_organization: attempt.organizationId,
        p_snapshot: attempt.snapshotId,
        p_installation: attempt.installationId,
        p_actor: attempt.userId,
        p_base: attempt.baseRevision,
        p_operation: attempt.id,
      });
      const result = capturePublicationRpcResult(raw, attempt);
      await verifyFact(attempt, result);
      return result;
    };
    const coordinate = createPublicationCoordinator({
      ledger,
      enableGuard: async () => guard,
      commit: (attempt) => invoke('zentra_commit_workspace_v2', attempt),
      close: (attempt) => invoke('zentra_close_action_publication_v1', attempt),
    });
    const prior = await ledger.read(actor.organizationId, id);
    if (prior !== null) {
      if (
        prior.organizationId !== actor.organizationId ||
        prior.snapshotId !== id ||
        prior.installationId !== actor.installationId ||
        prior.userId !== actor.userId
      )
        throw new PublicationLedgerError('conflict');
      if (prior.state !== 'pending') {
        if (prior.result === null)
          throw new PublicationLedgerError('invalid_record');
        // A committed creation fact remains recoverable after transport pruning.
        // This read never inserts an obsolete catalogue witness or advances PG.
        await verifyFact(prior, prior.result);
        return prior.result.committed
          ? prior.result
          : { ...prior.result, conflict: true };
      }
      const result = await coordinate(
        capturePublicationIdentity({
          organizationId: prior.organizationId,
          snapshotId: prior.snapshotId,
          installationId: prior.installationId,
          userId: prior.userId,
          baseRevision: prior.baseRevision,
          archiveSha256: prior.archiveSha256,
          manifestSha256: prior.manifestSha256,
          sizeBytes: prior.sizeBytes,
        }),
      );
      return result.committed ? result : { ...result, conflict: true };
    }
    const rows = await pg.select<{
      id: string;
      organization_id: string;
      installation_id: string;
      created_by: string;
      base_revision: number;
      revision: number | null;
      manifest: unknown;
      size_bytes: number;
    }>('zentra_workspace_snapshots', {
      organization_id: `eq.${actor.organizationId}`,
      id: `eq.${id}`,
      limit: 1,
    });
    const snapshot = rows[0];
    if (
      !snapshot ||
      snapshot.id !== id ||
      snapshot.organization_id !== actor.organizationId ||
      snapshot.installation_id !== actor.installationId ||
      snapshot.created_by !== actor.userId
    )
      throw new PublicationLedgerError('conflict');
    const manifest = backupManifest(snapshot.manifest);
    if (
      snapshot.size_bytes !== manifest.size_bytes ||
      (snapshot.revision !== null &&
        snapshot.revision !== snapshot.base_revision + 1)
    )
      throw new PublicationLedgerError('invalid_record');
    if (
      snapshot.revision !== null &&
      (guard.revision !== snapshot.revision || guard.snapshotId !== snapshot.id)
    ) {
      // A pre-opt-in historical replay is a valid creation fact, NOT the current
      // catalogue. Do not bootstrap an obsolete D1 publication witness when the
      // newer pre-opt-in head has never been recorded there. An opt-in pending
      // attempt cannot become historical before another coordinator settles it.
      return {
        committed: true,
        revision: snapshot.revision,
        snapshotId: snapshot.id,
      };
    }
    const identity = capturePublicationIdentity({
      organizationId: actor.organizationId,
      snapshotId: id,
      installationId: actor.installationId,
      userId: actor.userId,
      baseRevision: snapshot.base_revision,
      archiveSha256: manifest.sha256,
      manifestSha256: await sha256Hex(JSON.stringify(manifest)),
      sizeBytes: manifest.size_bytes,
    });
    const result = await coordinate(identity);
    return result.committed ? result : { ...result, conflict: true };
  } catch (error) {
    if (error instanceof AccountPublicError) throw error;
    if (error instanceof PublicationLedgerError && error.code === 'conflict')
      throw new AccountPublicError(
        'Une autre version de l’entreprise est en cours de synchronisation. Réessayez dans un instant.',
        409,
      );
    // Never fall back to the legacy RPC after a coordinated/uncertain attempt.
    throw new AccountPublicError(
      'La synchronisation reprendra automatiquement. Vos données restent sur cet appareil.',
      503,
    );
  }
}
