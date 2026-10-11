import { requireDeviceSession, type DeviceSessionContext } from '@/lib/account';
import {
  ACCOUNT_ROLES,
  roleCanWriteInvoices,
  sha256Hex,
} from '@/lib/account-security';
import {
  collaborationHead,
  collaborationSnapshot,
  downloadCollaborationChunk,
} from '@/lib/company-collaboration';
import { backupManifest } from '@/lib/workspace-backup';
import { createDeviceQuoteAuthority } from './production-admission';
import { readPublishedResourcesPrefix } from './published-resources';
import { readSupportQuoteSource } from './support-source';
import { ActionEngineError } from './types';
import { actionIdentifier, validatePlanningContext } from './validation';

export type PublishedQuotePublication = Readonly<{
  organizationId: string;
  snapshotId: string;
  revision: number;
  baseRevision: number;
  archiveSha256: string;
  manifestSha256: string;
  firstChunkSha256: string;
  sidecarSha256: string;
  resourcesHash: string;
}>;

function identityMatches(
  session: DeviceSessionContext,
  authority: Awaited<ReturnType<typeof createDeviceQuoteAuthority>>,
) {
  if (
    session.organizationId !== authority.actor.organizationId ||
    session.userId !== authority.actor.userId ||
    session.installationId !== authority.installationId
  )
    throw new ActionEngineError('forbidden');
}

/**
 * Private server loader, not a route and not a write fence. Reads only the current
 * published native archive via existing authenticated collaboration helpers.
 * D1 + Supabase are not one transaction: persistence/commit MUST separately fence
 * the source, admission, central reservation and native resource hash.
 */
export async function loadDeviceQuotePlanningContext(
  request: Request,
  rawSourceId: string,
) {
  const sourceId = actionIdentifier(rawSourceId);
  const captured = new Request(request.url, {
    headers: new Headers(request.headers),
  });
  const authority = await createDeviceQuoteAuthority(captured);
  const admission = await authority.preflight();
  const session = await requireDeviceSession(
    captured,
    ACCOUNT_ROLES.filter(roleCanWriteInvoices),
  );
  identityMatches(session, authority);
  const originalSource = await readSupportQuoteSource(
    authority.actor,
    sourceId,
  );
  const head = await collaborationHead(session);
  if (
    !head.enabled ||
    !head.snapshotId ||
    !Number.isSafeInteger(head.revision) ||
    head.revision < 1 ||
    !head.manifest
  )
    throw new ActionEngineError('invalid_context');
  const snapshot = await collaborationSnapshot(session, head.snapshotId);
  const manifest = backupManifest(snapshot.manifest);
  if (
    snapshot.organization_id !== session.organizationId ||
    snapshot.id !== head.snapshotId ||
    snapshot.revision !== head.revision ||
    !Number.isSafeInteger(snapshot.base_revision) ||
    snapshot.base_revision < 0 ||
    snapshot.base_revision >= head.revision ||
    JSON.stringify(manifest) !== JSON.stringify(backupManifest(head.manifest))
  )
    throw new ActionEngineError('stale_plan');
  const bytes = await downloadCollaborationChunk(session, snapshot.id, '0');
  if (
    bytes.byteLength !== manifest.chunks[0].size_bytes ||
    (await sha256Hex(bytes)) !== manifest.chunks[0].sha256
  )
    throw new ActionEngineError('invalid_context');
  const published = await readPublishedResourcesPrefix(bytes, {
    organizationId: session.organizationId,
    snapshotId: snapshot.id,
    baseRevision: snapshot.base_revision,
  });
  const publication: PublishedQuotePublication = Object.freeze({
    organizationId: session.organizationId,
    snapshotId: snapshot.id,
    revision: head.revision,
    baseRevision: snapshot.base_revision,
    archiveSha256: manifest.sha256,
    manifestSha256: await sha256Hex(JSON.stringify(manifest)),
    firstChunkSha256: manifest.chunks[0].sha256,
    sidecarSha256: published.sidecarSha256,
    resourcesHash: published.resourcesHash,
  });
  const revision = await sha256Hex(
    JSON.stringify(['action-context-v1', publication, originalSource.revision]),
  );
  const context = validatePlanningContext({
    organizationId: session.organizationId,
    revision,
    currency: published.resources.company.currency,
    source: originalSource.source,
    customers: published.customers,
    articles: published.articles,
  });
  // Awaited reads cannot carry their old authority/head/source into a proposal.
  const currentSource = await readSupportQuoteSource(authority.actor, sourceId);
  const currentHead = await collaborationHead(session);
  const currentAdmission = await authority.preflight();
  if (
    currentSource.revision !== originalSource.revision ||
    !currentHead.enabled ||
    currentHead.snapshotId !== snapshot.id ||
    currentHead.revision !== head.revision ||
    !currentHead.manifest ||
    JSON.stringify(backupManifest(currentHead.manifest)) !==
      JSON.stringify(manifest) ||
    currentAdmission.revision !== admission.revision
  )
    throw new ActionEngineError('stale_plan');
  return Object.freeze({
    context,
    publication,
    admission: currentAdmission,
    workspaceId: originalSource.workspaceId,
    sourceCapability: originalSource,
  });
}
