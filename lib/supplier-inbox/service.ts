import { database, fileArchive } from '@/lib/runtime';
import {supplierHabits,rememberSupplier,normalizeSupplier} from './habits';
import {
  membershipsForUser,
  requireBrowserMembership,
  type DeviceSessionContext,
} from '@/lib/account';
import { effectiveAccountUntil } from '@/lib/founder-access';
import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import { automationEntitlement } from '@/lib/automation/service';
import { settingsFor, globalFlags } from '@/lib/automation/config';
import type { AutomationActor } from '@/lib/automation/access';
import { extractionIssues, type InvoiceExtraction } from './extraction';
import type { Workspace } from '@/lib/support/types';

const now = () => Math.floor(Date.now() / 1000);
export type GestionLink = {
  workspace_id: string;
  organization_id: string;
  enabled: number;
  auto_post: number;
  connected_by: string;
  created_at: number;
};
export type InboxRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  connection_id: string;
  message_id: string;
  source_sha256: string;
  file_name: string;
  media_type: string;
  object_key: string;
  size_bytes: number;
  sender: string;
  subject: string;
  extraction: string;
  state: string;
  claimed_installation: string | null;
  claim_token: string | null;
  invoice_id: string | null;
  automatic: number;
  created_at: number;
  imported_at: number | null;
};
export async function gestionActive(org: string, user: string) {
  const row = await database()
    .prepare(
      'SELECT s.subscription_id,s.entitlement_valid_until FROM organizations o JOIN subscriptions s ON s.subscription_id=o.subscription_id WHERE o.organization_id=?',
    )
    .bind(org)
    .first<{ subscription_id: string; entitlement_valid_until: number }>();
  return (
    !!row &&
    (await effectiveAccountUntil(
      row.subscription_id,
      user,
      row.entitlement_valid_until,
    )) > now()
  );
}
export async function workspaceLink(workspace: string) {
  return database()
    .prepare('SELECT * FROM support_gestion_links WHERE workspace_id=?')
    .bind(workspace)
    .first<GestionLink>();
}
export async function gestionLinkState(
  workspace: string,
  user: string,
  manage: boolean,
) {
  const link = await workspaceLink(workspace);
  const choices = manage
    ? (await membershipsForUser(user))
        .filter((m) => ['owner', 'admin'].includes(m.role))
        .map((m) => ({ id: m.organizationId, name: m.organizationName }))
    : [];
  // Names and document contents from Gestion are only exposed to its own members.
  const membership = link
    ? (await membershipsForUser(user)).find(
        (m) => m.organizationId === link.organization_id,
      )
    : null;
  return {
    linked: !!link?.enabled,
    organizationId: membership ? link!.organization_id : null,
    organizationName: membership?.organizationName ?? null,
    role: membership?.role ?? null,
    autoPost: !!link?.auto_post,
    choices,
  };
}
export async function saveGestionLink(
  workspace: Workspace & { role: string },
  user: string,
  raw: Record<string, unknown>,
) {
  if (!['owner', 'admin'].includes(workspace.role))
    throw new AccountPublicError(
      'Seul un administrateur peut relier Gestion.',
      403,
    );
  const org = typeof raw.organizationId === 'string' ? raw.organizationId : '';
  await requireBrowserMembership(user, org, ['owner', 'admin']);
  if (!(await gestionActive(org, user)))
    throw new AccountPublicError(
      'Activez Zentra Gestion pour cette entreprise.',
      402,
    );
  if (typeof raw.enabled !== 'boolean' || typeof raw.autoPost !== 'boolean')
    throw new AccountPublicError('Vérifiez les réglages de réception.');
  const old = await workspaceLink(workspace.id);
  if (old && old.organization_id !== org)
    throw new AccountPublicError(
      'Cet espace est déjà lié à une autre entreprise. Utilisez un espace Support distinct pour séparer les documents.',
      409,
    );
  const other = await database()
    .prepare(
      'SELECT workspace_id FROM support_gestion_links WHERE organization_id=? AND workspace_id<>?',
    )
    .bind(org, workspace.id)
    .first();
  if (other)
    throw new AccountPublicError(
      'Cette entreprise est déjà reliée à un autre espace Support.',
      409,
    );
  if (
    raw.autoPost &&
    !(await automationEntitlement({
      organizationId: org,
      userId: user,
      role: workspace.role,
      founder: false,
    }))
  )
    throw new AccountPublicError(
      'L’option Automation de cette entreprise est nécessaire pour comptabiliser automatiquement.',
      402,
    );
  await database()
    .prepare(
      `INSERT INTO support_gestion_links(workspace_id,organization_id,enabled,auto_post,connected_by,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET enabled=excluded.enabled,auto_post=excluded.auto_post,connected_by=excluded.connected_by`,
    )
    .bind(
      workspace.id,
      org,
      Number(raw.enabled),
      Number(raw.autoPost),
      user,
      now(),
    )
    .run();
  return { saved: true };
}
export async function publicInboxRow(row: InboxRow, installation?: string) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    fileName: row.file_name,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.source_sha256,
    sender: row.sender,
    subject: row.subject,
    extraction: JSON.parse(row.extraction) as InvoiceExtraction,
    state: row.state,
    invoiceId: row.invoice_id,
    automatic: row.automatic === 1,
    createdAt: row.created_at,
    importedAt: row.imported_at,
    otherDevice:
      !!row.claimed_installation && row.claimed_installation !== installation,
  };
}
export async function inboxState(
  actor: AutomationActor,
  installation?: string,
) {
  const db = database();
  const [link, rows] = await Promise.all([
    db
      .prepare('SELECT * FROM support_gestion_links WHERE organization_id=?')
      .bind(actor.organizationId)
      .first<GestionLink>(),
    db
      .prepare(
        "SELECT * FROM supplier_inbox WHERE organization_id=? ORDER BY CASE WHEN state='imported' OR state='ignored' THEN 1 ELSE 0 END,created_at DESC,id LIMIT 100",
      )
      .bind(actor.organizationId)
      .all<InboxRow>(),
  ]);
  const [active, settings, flags] = await Promise.all([
    automationEntitlement(actor),
    settingsFor(actor.organizationId),
    globalFlags(),
  ]);
  const autoPost =
    !!link?.enabled &&
    !!link.auto_post &&
    active &&
    settings.enabled &&
    settings.consent &&
    settings.mode === 'suggest' &&
    settings.flags.includes('supplier_routing') &&
    flags.includes('supplier_routing');
  return {
    organizationId: actor.organizationId,
    linked: !!link?.enabled,
    autoPost,
    automationActive: active,
    prepareEnabled:active&&settings.enabled&&settings.consent&&settings.mode==='suggest'&&settings.flags.includes('supplier_routing')&&flags.includes('supplier_routing'),
    habits:active?await supplierHabits(actor.organizationId):[],
    items: await Promise.all(
      rows.results.map((row) => publicInboxRow(row, installation)),
    ),
  };
}
export async function inboxItem(org: string, id: unknown) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
    throw new AccountPublicError('Choisissez une facture reçue.');
  const row = await database()
    .prepare('SELECT * FROM supplier_inbox WHERE organization_id=? AND id=?')
    .bind(org, id)
    .first<InboxRow>();
  if (!row)
    throw new AccountPublicError('Ce document n’est pas accessible.', 404);
  return row;
}
export async function inboxDocument(org: string, id: unknown) {
  const row = await inboxItem(org, id),
    object = await fileArchive().get(row.object_key);
  if (!object)
    throw new AccountPublicError(
      'Le justificatif est temporairement indisponible. Réessayez.',
      503,
    );
  return { row, object };
}
export async function automaticAllowed(actor: AutomationActor, row: InboxRow) {
  const [link, active, settings, flags] = await Promise.all([
    workspaceLink(row.workspace_id),
    automationEntitlement(actor),
    settingsFor(actor.organizationId),
    globalFlags(),
  ]);
  const extraction = JSON.parse(row.extraction) as InvoiceExtraction;
  return (
    !!link?.enabled &&
    link.organization_id === actor.organizationId &&
    !!link.auto_post &&
    active &&
    settings.enabled &&
    settings.consent &&
    settings.mode === 'suggest' &&
    settings.flags.includes('supplier_routing') &&
    flags.includes('supplier_routing') &&
    extraction.confidence >= Math.max(0.95, settings.thresholds.high) &&
    extractionIssues(extraction).length === 0
  );
}
/** A commit reservation does not silently expire: another offline device must never post the same invoice again. */
export async function claimInvoice(
  session: DeviceSessionContext,
  raw: Record<string, unknown>,
) {
  if (session.role === 'read_only')
    throw new AccountPublicError(
      'Votre rôle permet la consultation uniquement.',
      403,
    );
  let row = await inboxItem(session.organizationId, raw.id);
  if (row.state === 'imported')
    return {
      alreadyImported: true,
      item: await publicInboxRow(row, session.installationId),
    };
  if (row.state === 'ignored')
    throw new AccountPublicError('Ce document a été écarté.', 409);
  const actor = { ...session, founder: false, device: true };
  const automatic = raw.automatic === true;
  if (automatic && !(await automaticAllowed(actor, row)))
    throw new AccountPublicError(
      'Cette facture demande une vérification manuelle.',
      409,
    );
  const token = crypto.randomUUID();
  await database()
    .prepare(
      "UPDATE supplier_inbox SET claimed_installation=?,claim_token=?,state='processing' WHERE organization_id=? AND id=? AND claimed_installation IS NULL AND state IN ('ready','review')",
    )
    .bind(session.installationId, token, session.organizationId, row.id)
    .run();
  row = await inboxItem(session.organizationId, row.id);
  if (row.claimed_installation !== session.installationId)
    throw new AccountPublicError(
      'Cette facture est en cours d’enregistrement sur un autre appareil. Terminez son import sur cet appareil pour la retrouver ici.',
      409,
    );
  return {
    item: await publicInboxRow(row, session.installationId),
    habit:(await supplierHabits(actor.organizationId)).find(h=>h.sender===row.sender.trim().toLowerCase()&&h.supplierName===normalizeSupplier(JSON.parse(row.extraction).supplierName||''))||null,
    claimToken: row.claim_token,
    automaticAllowed: automatic && (await automaticAllowed(actor, row)),
  };
}
export async function finishInvoice(
  session: DeviceSessionContext,
  raw: Record<string, unknown>,
) {
  if (session.role === 'read_only')
    throw new AccountPublicError(
      'Votre rôle permet la consultation uniquement.',
      403,
    );
  const row = await inboxItem(session.organizationId, raw.id);
  if (row.state === 'imported' && row.invoice_id === raw.invoiceId)
    return { saved: true };
  if (
    row.state !== 'processing' ||
    row.claimed_installation !== session.installationId ||
    row.claim_token !== raw.claimToken ||
    raw.invoiceId !== row.id
  )
    throw new AccountPublicError(
      'La réception a changé. Rechargez les documents.',
      409,
    );
  await database()
    .prepare(
      "UPDATE supplier_inbox SET state='imported',invoice_id=?,automatic=?,imported_at=? WHERE organization_id=? AND id=? AND claim_token=?",
    )
    .bind(
      row.id,
      Number(raw.automatic === true),
      now(),
      session.organizationId,
      row.id,
      row.claim_token,
    )
    .run();
  if(raw.habit && raw.automatic!==true && await automationEntitlement({...session,founder:false,device:true}))await rememberSupplier({...session,founder:false,device:true},row.sender,JSON.parse(row.extraction).supplierName||'',raw.habit);
  return { saved: true };
}
export async function releaseInvoice(
  session: DeviceSessionContext,
  raw: Record<string, unknown>,
) {
  if (session.role === 'read_only')
    throw new AccountPublicError(
      'Votre rôle permet la consultation uniquement.',
      403,
    );
  const row = await inboxItem(session.organizationId, raw.id);
  if (
    row.state === 'imported' ||
    (row.claimed_installation &&
      row.claimed_installation !== session.installationId)
  )
    throw new AccountPublicError('La réception a changé.', 409);
  const extraction = JSON.parse(row.extraction) as InvoiceExtraction;
  const reason =
    typeof raw.reason === 'string'
      ? raw.reason.slice(0, 250)
      : 'Vérifiez les informations avant d’enregistrer.';
  extraction.issues = [...new Set([...extraction.issues, reason])].slice(0, 20);
  await database()
    .prepare(
      "UPDATE supplier_inbox SET state='review',claimed_installation=NULL,claim_token=NULL,extraction=? WHERE organization_id=? AND id=? AND state<>'imported' AND (claimed_installation IS NULL OR claimed_installation=?)",
    )
    .bind(
      JSON.stringify(extraction),
      session.organizationId,
      row.id,
      session.installationId,
    )
    .run();
  return { saved: true };
}
export async function ignoreInvoice(actor: AutomationActor, id: unknown) {
  if (actor.role === 'read_only')
    throw new AccountPublicError(
      'Votre rôle permet la consultation uniquement.',
      403,
    );
  const row = await inboxItem(actor.organizationId, id);
  if (row.claimed_installation || row.state === 'imported')
    throw new AccountPublicError(
      'Ce document est déjà en cours de traitement.',
      409,
    );
  await database()
    .prepare(
      "UPDATE supplier_inbox SET state='ignored' WHERE organization_id=? AND id=? AND claimed_installation IS NULL",
    )
    .bind(actor.organizationId, row.id)
    .run();
  return { saved: true };
}
export async function inboxDaily(org: string, from: number, until: number) {
  const [row, recent] = await Promise.all([
    database()
    .prepare(
      `SELECT SUM(created_at>=? AND created_at<?) AS received,SUM(state='imported' AND imported_at>=? AND imported_at<?) AS imported,SUM(state='imported' AND automatic=1 AND imported_at>=? AND imported_at<?) AS automatic,SUM(state IN ('review','ready','processing')) AS needsReview FROM supplier_inbox WHERE organization_id=?`,
    )
    .bind(from, until, from, until, from, until, org)
    .first<Record<string, number>>(),
    database()
    .prepare(
      'SELECT id,subject,state,automatic,imported_at FROM supplier_inbox WHERE organization_id=? AND imported_at>=? AND imported_at<? ORDER BY imported_at DESC,id LIMIT 5',
    )
    .bind(org, from, until)
    .all(),
  ]);
  return {
    received: Number(row?.received || 0),
    imported: Number(row?.imported || 0),
    automatic: Number(row?.automatic || 0),
    needsReview: Number(row?.needsReview || 0),
    recent: recent.results,
  };
}
export async function documentDigest(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
    ),
  )
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
/** Called after a received draft is explicitly validated in Gestion. */
export async function rememberInvoice(session:DeviceSessionContext,raw:Record<string,unknown>){
 const actor={...session,founder:false,device:true};
 if(session.role==='read_only'||!await automationEntitlement(actor))throw new AccountPublicError('Activez Automation pour retenir ce classement.',403);
 const row=await inboxItem(session.organizationId,raw.id);
 if(row.state!=='imported')throw new AccountPublicError('Enregistrez cette facture avant de retenir son classement.',409);
 const extraction=JSON.parse(row.extraction) as InvoiceExtraction;
 await rememberSupplier(actor,row.sender,extraction.supplierName||'',raw.habit);
 return{saved:true};
}
export const mailReceiptId = (
  org: string,
  connection: string,
  message: string,
) => sha256Hex(JSON.stringify([org, connection, message]));
