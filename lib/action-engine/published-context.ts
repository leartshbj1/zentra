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
import { database } from '@/lib/runtime';
import { senderAddress } from '@/lib/support/sender-policies';
import type { SourceTicket } from '@/lib/support/types';
import { backupManifest } from '@/lib/workspace-backup';
import { createDeviceQuoteAuthority } from './production-admission';
import { readPublishedResourcesPrefix } from './published-resources';
import { connectorSenderName, quoteMailBody } from './source-envelope';
import { ActionEngineError, type ActionSource } from './types';
import { actionIdentifier, validatePlanningContext } from './validation';

type SourceRow = {
  id: string;
  workspace_id: string;
  connection_id: string;
  external_id: string;
  subject: string;
  body: string;
  source_json: string;
  fingerprint: string;
  revision: number;
  connected_by: string;
  link_created_at: number;
  connection_created_at: number;
  provider: string;
};

/** Current persisted connector source under the owner's explicit Support/Gestion delegation. */
async function sourceFor(actor: DeviceSessionContext, sourceId: string) {
  const row = await database()
    .prepare(`SELECT t.id,t.workspace_id,t.connection_id,t.external_id,
      t.subject,t.body,t.source_json,t.fingerprint,t.revision,l.connected_by,
      l.created_at AS link_created_at,c.created_at AS connection_created_at,c.provider
    FROM support_tickets t
    JOIN support_connections c ON c.id=t.connection_id AND c.workspace_id=t.workspace_id AND c.active=1
    JOIN support_gestion_links l ON l.workspace_id=t.workspace_id AND l.enabled=1
    JOIN support_workspaces w ON w.id=l.workspace_id
    JOIN organization_members m ON m.organization_id=l.organization_id
      AND m.user_id=l.connected_by AND m.revoked_at IS NULL AND m.role IN ('owner','admin')
    WHERE t.id=? AND l.organization_id=?
      AND (w.owner_id=l.connected_by OR EXISTS(SELECT 1 FROM support_members sm
        WHERE sm.workspace_id=w.id AND lower(sm.email)=lower(m.email) AND sm.role='admin'))`)
    .bind(sourceId, actor.organizationId)
    .first<SourceRow>();
  if (
    !row ||
    row.id !== sourceId ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    typeof row.source_json !== 'string' ||
    row.source_json.length > 256_000
  )
    throw new ActionEngineError('invalid_context');
  let envelope: SourceTicket;
  try {
    envelope = JSON.parse(row.source_json) as SourceTicket;
  } catch {
    throw new ActionEngineError('invalid_context');
  }
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    envelope.externalId !== row.external_id ||
    envelope.subject !== row.subject ||
    envelope.body !== row.body ||
    envelope.closed !== false ||
    envelope.incomplete === true ||
    envelope.mail?.bodyIncomplete === true ||
    envelope.senderIdentityAmbiguous === true
  )
    throw new ActionEngineError('invalid_context');
  // The durable connector envelope is the only sender identity source. A missing
  // display name stays empty; neither message text nor a model may supply it.
  const senderEmail = senderAddress(envelope);
  const senderName = connectorSenderName(envelope.senderName) ?? '';
  const revision = await sha256Hex(
    JSON.stringify([
      'action-source-v1',
      row.id,
      row.workspace_id,
      row.connection_id,
      row.external_id,
      row.subject,
      row.body,
      row.source_json,
      row.fingerprint,
      row.revision,
      row.connected_by,
      row.link_created_at,
      row.connection_created_at,
      row.provider,
    ]),
  );
  const source: ActionSource = Object.freeze({
    id: sourceId,
    revision,
    organizationId: actor.organizationId,
    senderEmail,
    senderName,
    subject: row.subject,
    body: quoteMailBody(
      row.body,
      senderEmail,
      row.provider,
      Boolean(envelope.mail),
    ),
  });
  return Object.freeze({ source, workspaceId: row.workspace_id, revision });
}

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
  const originalSource = await sourceFor(session, sourceId);
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
  const publication = Object.freeze({
    organizationId: session.organizationId,
    snapshotId: snapshot.id,
    revision: head.revision,
    baseRevision: snapshot.base_revision,
    archiveSha256: manifest.sha256,
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
  const currentSource = await sourceFor(session, sourceId);
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
  });
}
