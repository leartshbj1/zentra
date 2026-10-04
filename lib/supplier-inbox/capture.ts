import {
  supportAutomationState,
  requireSupportAutomation,
  supportAutomationFetch,
} from '@/lib/automation/execution';
import { database, fileArchive } from '@/lib/runtime';
import { decisionApiKey } from '@/lib/automation/config';
import { JevDecisionProvider } from '@/lib/automation/provider';
import {
  extractInvoice,
  invoiceTextCanBeAnalyzed,
  emptyExtraction,
  type InvoiceExtraction,
} from './extraction';
import {
  invoiceMedia,
  invoiceText,
  type PreparedMailDocument,
} from './documents';
import {
  documentDigest,
  gestionActive,
  mailReceiptId,
  workspaceLink,
} from './service';
import { readMailAttachment } from '@/lib/support/infomaniak';
import {
  SupportError,
  type SourceTicket,
  type Workspace,
} from '@/lib/support/types';
import {
  finishCapturedAnalysis,
  reserveAnalysis,
  requireSupportSubscription,
  analysisReservationAdmission,
} from '@/lib/support/billing';

type CaptureAnalysis = {
  workspace_id: string;
  source_sha256: string;
  organization_id: string;
  inbox_id: string;
  owner_token: string;
  owner_until: number;
  state: string;
  reservation: string | null;
  extraction: string | null;
  analysis_required: number;
};
const captureTime = () => Math.floor(Date.now() / 1000);
const CAPTURE_OWNER_SECONDS = 600;
const CAPTURE_BUSY =
  'Ce document est déjà en cours d’analyse. Sa réception reprendra sans lancer une seconde analyse.';
const CAPTURE_UNCERTAIN =
  'L’analyse de ce document n’est pas confirmée. Une vérification est nécessaire avant toute nouvelle analyse.';
const captureConflict = () =>
  new SupportError(
    'Le lien avec Gestion a changé. Vérifiez la connexion de cette entreprise avant de reprendre.',
    409,
  );

function retainedExtraction(raw: string | null): InvoiceExtraction {
  if (!raw || raw.length > 64_000)
    throw new SupportError(CAPTURE_UNCERTAIN, 409);
  let value: InvoiceExtraction;
  try {
    value = JSON.parse(raw) as InvoiceExtraction;
  } catch {
    throw new SupportError(CAPTURE_UNCERTAIN, 409);
  }
  const unit = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (
    !value ||
    !['supplier_invoice', 'other', 'unknown'].includes(value.kind) ||
    !unit(value.confidence) ||
    !Array.isArray(value.issues) ||
    !value.issues.every((issue) => typeof issue === 'string') ||
    !value.evidence ||
    typeof value.evidence !== 'object' ||
    Array.isArray(value.evidence) ||
    !Object.values(value.evidence).every(
      (evidence) => typeof evidence === 'string',
    )
  )
    throw new SupportError(CAPTURE_UNCERTAIN, 409);
  for (const field of [
    'supplierName',
    'reference',
    'invoiceDate',
    'dueDate',
    'currency',
    'category',
  ] as const)
    if (value[field] !== null && typeof value[field] !== 'string')
      throw new SupportError(CAPTURE_UNCERTAIN, 409);
  for (const field of ['netCents', 'vatCents', 'totalCents', 'vatBp'] as const)
    if (
      value[field] !== null &&
      (!Number.isSafeInteger(value[field]) || value[field]! < 0)
    )
      throw new SupportError(CAPTURE_UNCERTAIN, 409);
  return value;
}

async function quotaState(reservation: string) {
  const founder = reservation.startsWith('founder:');
  return (
    (
      await database()
        .prepare(
          `SELECT state FROM ${founder ? 'founder_support_usage' : 'support_analysis_usage'} WHERE id=?`,
        )
        .bind(founder ? reservation.slice(8) : reservation)
        .first<{ state: string }>()
    )?.state ?? null
  );
}

async function ownCapture(
  workspace: string,
  organization: string,
  sha: string,
) {
  const db = database(),
    owner = crypto.randomUUID(),
    time = captureTime();
  await db
    .prepare(`INSERT INTO supplier_capture_analyses(workspace_id,source_sha256,organization_id,inbox_id,owner_token,owner_until,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'preparing',?,?) ON CONFLICT(workspace_id,source_sha256) DO NOTHING`)
    .bind(
      workspace,
      sha,
      organization,
      crypto.randomUUID(),
      owner,
      time + CAPTURE_OWNER_SECONDS,
      time,
      time,
    )
    .run();
  const read = () =>
    db
      .prepare(
        'SELECT * FROM supplier_capture_analyses WHERE workspace_id=? AND source_sha256=?',
      )
      .bind(workspace, sha)
      .first<CaptureAnalysis>();
  let row = await read();
  if (!row || row.organization_id !== organization) throw captureConflict();
  if (row.state === 'completed') return null;
  if (row.state === 'analyzing' || row.state === 'uncertain')
    throw new SupportError(
      row.state === 'analyzing' && row.owner_until > time
        ? CAPTURE_BUSY
        : CAPTURE_UNCERTAIN,
      409,
    );
  if (row.owner_token !== owner) {
    await db
      .prepare(`UPDATE supplier_capture_analyses SET owner_token=?,owner_until=?,state=CASE WHEN state='retryable' THEN 'preparing' ELSE state END,updated_at=?
      WHERE workspace_id=? AND source_sha256=? AND organization_id=? AND state IN ('preparing','retryable','analyzed') AND owner_until<=?`)
      .bind(
        owner,
        time + CAPTURE_OWNER_SECONDS,
        time,
        workspace,
        sha,
        organization,
        time,
      )
      .run();
    row = await read();
    if (!row || row.organization_id !== organization) throw captureConflict();
    if (row.owner_token !== owner) throw new SupportError(CAPTURE_BUSY, 409);
  }
  return row;
}

export async function mailboxCaptureNeeded(
  workspace: string,
  connection: string,
  message: string,
) {
  const link = await workspaceLink(workspace);
  if (
    !link?.enabled ||
    !(await supportAutomationState(workspace, 'supplier_routing')).enabled
  )
    return false;
  return !(await database()
    .prepare('SELECT id FROM supplier_mail_receipts WHERE id=?')
    .bind(await mailReceiptId(link.organization_id, connection, message))
    .first());
}
export async function captureMailboxInvoices(input: {
  workspace: Workspace;
  connectionId: string;
  source: SourceTicket;
  token: string;
  mailboxId: string;
  folderId: string;
  uid: string;
  readAttachment?: (id: string) => Promise<Uint8Array>;
  documents?: Map<string, PreparedMailDocument>;
}) {
  const workspaceId = input.workspace.id;
  if (!(await supportAutomationState(workspaceId, 'supplier_routing')).enabled)
    return;
  const link = await workspaceLink(workspaceId);
  if (
    !link?.enabled ||
    !(await gestionActive(link.organization_id, link.connected_by))
  )
    return;
  const db = database(),
    now = Math.floor(Date.now() / 1000),
    receipt = await mailReceiptId(
      link.organization_id,
      input.connectionId,
      input.source.externalId,
    );
  if (
    await db
      .prepare('SELECT id FROM supplier_mail_receipts WHERE id=?')
      .bind(receipt)
      .first()
  )
    return;
  const company = await db
    .prepare('SELECT name FROM organizations WHERE organization_id=?')
    .bind(link.organization_id)
    .first<{ name: string }>();
  const attachments = input.source.mail?.attachments || [];
  // Do not silently mark an oversized mail as complete: the mailbox surfaces the reason and will retry.
  if (attachments.length > 12) throw new Error('too_many_invoice_attachments');
  for (const attachment of attachments) {
    await requireSupportAutomation(workspaceId, 'supplier_routing');
    const prepared = input.documents?.get(attachment.id);
    const bytes =
        prepared?.bytes ??
        (input.readAttachment
          ? await input.readAttachment(attachment.id)
          : await readMailAttachment(
              input.token,
              input.mailboxId,
              input.folderId,
              input.uid,
              attachment.id,
            )),
      media = prepared ? prepared.media : invoiceMedia(bytes);
    if (!media) continue;
    const sha = await documentDigest(bytes);
    const existing = await db
      .prepare(
        'SELECT id FROM supplier_inbox WHERE organization_id=? AND source_sha256=?',
      )
      .bind(link.organization_id, sha)
      .first();
    // Historical imports retain their original duplicate behavior. A new
    // capture that lost its final acknowledgement still settles its own quota.
    if (
      existing &&
      !(await db
        .prepare(
          'SELECT 1 FROM supplier_capture_analyses WHERE workspace_id=? AND source_sha256=? AND state<>?',
        )
        .bind(workspaceId, sha, 'completed')
        .first())
    )
      continue;
    const owned = await ownCapture(workspaceId, link.organization_id, sha);
    if (!owned) continue;
    const own = () =>
      db
        .prepare(
          'SELECT * FROM supplier_capture_analyses WHERE workspace_id=? AND source_sha256=? AND organization_id=? AND owner_token=?',
        )
        .bind(workspaceId, sha, link.organization_id, owned.owner_token)
        .first<CaptureAnalysis>();
    const fresh = async () => {
      const { actor } = await requireSupportAutomation(
        workspaceId,
        'supplier_routing',
      );
      const currentLink = await workspaceLink(workspaceId);
      if (
        actor.organizationId !== link.organization_id ||
        !currentLink?.enabled ||
        currentLink.organization_id !== link.organization_id ||
        currentLink.connected_by !== link.connected_by ||
        !(await gestionActive(link.organization_id, link.connected_by))
      )
        throw captureConflict();
      const current = await own();
      if (
        !current ||
        !['preparing', 'analyzing', 'analyzed'].includes(current.state) ||
        (current.state !== 'analyzing' && current.owner_until <= captureTime())
      )
        throw new SupportError(CAPTURE_BUSY, 409);
    };
    let reservation = owned.reservation;
    let preparingQuotaKnown = true;
    let reservationIntegrityKnown = !reservation;
    let analysisRequired = owned.analysis_required === 1;
    let reservationPeriod: number | null = null;
    const finishOwned = (success: boolean, state: 'preparing' | 'analyzed') =>
      finishCapturedAnalysis(reservation, success, {
        workspaceId,
        sourceSha256: sha,
        ownerToken: owned.owner_token,
        state,
        periodStart: reservationPeriod,
      });
    const reservationAdmission = async () => {
      reservationIntegrityKnown = false;
      const admission = await analysisReservationAdmission(
        input.workspace,
        `invoice:${sha}`,
        reservation!,
      );
      reservationIntegrityKnown = true;
      reservationPeriod = admission.periodStart;
      return admission;
    };
    const admitQuota = async (state: 'preparing' | 'analyzed') => {
      await fresh();
      if ((await own())?.state !== state)
        throw new SupportError(CAPTURE_UNCERTAIN, 409);
      await requireSupportSubscription(input.workspace);
      if (reservation) {
        const admission = await reservationAdmission();
        if (admission.state === 'charged') {
          if (state === 'preparing') {
            preparingQuotaKnown = false;
            throw new SupportError(CAPTURE_UNCERTAIN, 409);
          }
          await fresh();
          return;
        }
        if (!admission.admitted) {
          if (!(await finishOwned(false, state)))
            throw new SupportError(CAPTURE_BUSY, 409);
          reservation = null;
          reservationPeriod = null;
        }
      }
      if (!reservation && analysisRequired) {
        reservation = await reserveAnalysis(
          input.workspace,
          `invoice:${sha}`,
          crypto.randomUUID(),
        );
        reservationIntegrityKnown = true;
        const renewed = await db
          .prepare(
            'UPDATE supplier_capture_analyses SET reservation=?,updated_at=? WHERE workspace_id=? AND source_sha256=? AND owner_token=? AND state=? AND owner_until>?',
          )
          .bind(
            reservation,
            captureTime(),
            workspaceId,
            sha,
            owned.owner_token,
            state,
            captureTime(),
          )
          .run();
        if (!renewed.meta.changes) {
          await finishOwned(false, state);
          throw new SupportError(CAPTURE_BUSY, 409);
        }
        if (reservation && !(await reservationAdmission()).admitted)
          throw new SupportError(CAPTURE_BUSY, 409);
      }
      await fresh();
    };
    try {
      await fresh();
      let extraction: InvoiceExtraction;
      if (owned.state === 'analyzed') {
        extraction = retainedExtraction(owned.extraction);
        // Retain the validated result, but not a stale quota admission.
        await admitQuota('analyzed');
      } else {
        // Recovery before HTTP admission is safe only while this owner still
        // holds the preparing state. It cannot release a charged analysis.
        if (reservation) {
          preparingQuotaKnown = false;
          const admission = await reservationAdmission();
          if (admission.state === 'charged')
            throw new SupportError(CAPTURE_UNCERTAIN, 409);
          if (!(await finishOwned(false, 'preparing')))
            throw new SupportError(CAPTURE_BUSY, 409);
          reservation = null;
          reservationPeriod = null;
          preparingQuotaKnown = true;
        }
        let text = '';
        try {
          text = prepared ? prepared.text : await invoiceText(bytes, media);
        } catch {
          /* The original remains available for manual review. */
        }
        analysisRequired = invoiceTextCanBeAnalyzed(text);
        reservation = analysisRequired
          ? await reserveAnalysis(
              input.workspace,
              `invoice:${sha}`,
              crypto.randomUUID(),
            )
          : null;
        reservationIntegrityKnown = true;
        const reserved = await db
          .prepare(
            'UPDATE supplier_capture_analyses SET reservation=?,analysis_required=?,updated_at=? WHERE workspace_id=? AND source_sha256=? AND owner_token=? AND state=? AND owner_until>?',
          )
          .bind(
            reservation,
            Number(analysisRequired),
            captureTime(),
            workspaceId,
            sha,
            owned.owner_token,
            'preparing',
            captureTime(),
          )
          .run();
        if (!reserved.meta.changes) {
          await finishOwned(false, 'preparing');
          throw new SupportError(CAPTURE_BUSY, 409);
        }
        extraction = emptyExtraction(
          text
            ? 'Le document doit être lu ou complété manuellement.'
            : 'Ce scan ou document ne contient pas de texte lisible. Vérifiez le justificatif et complétez ses informations.',
        );
        if (analysisRequired) {
          const providerKey = await decisionApiKey();
          let admissionFailure: unknown;
          const fetchOnce: typeof fetch = async (...args) => {
            try {
              await admitQuota('preparing');
              const admitted = await db
                .prepare(
                  "UPDATE supplier_capture_analyses SET state='analyzing',updated_at=? WHERE workspace_id=? AND source_sha256=? AND owner_token=? AND state='preparing' AND owner_until>?",
                )
                .bind(
                  captureTime(),
                  workspaceId,
                  sha,
                  owned.owner_token,
                  captureTime(),
                )
                .run();
              if (!admitted.meta.changes)
                throw new SupportError(CAPTURE_UNCERTAIN, 409);
            } catch (error) {
              // The shared provider classifies transport exceptions. Preserve
              // this actual local fence error instead of calling it a network failure.
              admissionFailure = error;
              throw error;
            }
            return fetch(...args);
          };
          try {
            extraction = await extractInvoice(
              text,
              company?.name || '',
              new JevDecisionProvider(
                providerKey,
                supportAutomationFetch(
                  workspaceId,
                  'supplier_routing',
                  fetchOnce,
                ),
              ),
            );
          } catch (error) {
            throw admissionFailure ?? error;
          }
        }
        await fresh();
        const retained = JSON.stringify(extraction);
        if (retained.length > 64_000)
          throw new SupportError(CAPTURE_UNCERTAIN, 409);
        const saved = await db
          .prepare(
            "UPDATE supplier_capture_analyses SET extraction=?,state='analyzed',owner_until=?,updated_at=? WHERE workspace_id=? AND source_sha256=? AND owner_token=? AND state IN ('preparing','analyzing')",
          )
          .bind(
            retained,
            captureTime() + CAPTURE_OWNER_SECONDS,
            captureTime(),
            workspaceId,
            sha,
            owned.owner_token,
          )
          .run();
        if (!saved.meta.changes) throw new SupportError(CAPTURE_UNCERTAIN, 409);
      }
      await fresh();
      if (
        !(
          extraction.kind === 'other' &&
          (extraction.kindConfidence ?? 0) >= 0.95
        )
      ) {
        const key = `supplier-inbox/${link.organization_id}/${sha}`;
        await fileArchive().put(key, bytes, {
          httpMetadata: { contentType: media },
        });
        await admitQuota('analyzed');
        // A superseded capture cannot publish an inbox item after a late R2 ACK.
        const inserted = await db
          .prepare(`INSERT INTO supplier_inbox(id,organization_id,workspace_id,connection_id,message_id,source_sha256,file_name,media_type,object_key,size_bytes,sender,subject,extraction,state,created_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM supplier_capture_analyses a JOIN support_gestion_links l ON l.workspace_id=a.workspace_id WHERE a.workspace_id=? AND a.source_sha256=? AND a.owner_token=? AND a.state='analyzed' AND a.owner_until>? AND l.enabled=1 AND l.organization_id=a.organization_id AND l.connected_by=?) ON CONFLICT(organization_id,source_sha256) DO NOTHING`)
          .bind(
            owned.inbox_id,
            link.organization_id,
            workspaceId,
            input.connectionId,
            input.source.externalId,
            sha,
            attachment.name,
            media,
            key,
            bytes.length,
            input.source.mail?.sender || '',
            input.source.subject,
            JSON.stringify(extraction),
            extraction.issues.length ? 'review' : 'ready',
            now,
            workspaceId,
            sha,
            owned.owner_token,
            captureTime(),
            link.connected_by,
          )
          .run();
        if (
          !inserted.meta.changes &&
          !(await db
            .prepare(
              'SELECT 1 FROM supplier_inbox WHERE organization_id=? AND source_sha256=?',
            )
            .bind(link.organization_id, sha)
            .first())
        )
          throw new SupportError(CAPTURE_BUSY, 409);
      }
      await admitQuota('analyzed');
      if (!(await finishOwned(true, 'analyzed')))
        throw new SupportError(CAPTURE_BUSY, 409);
      const completed = await db
        .prepare(
          "UPDATE supplier_capture_analyses SET state='completed',extraction=NULL,owner_until=0,updated_at=? WHERE workspace_id=? AND source_sha256=? AND owner_token=? AND state='analyzed' AND owner_until>?",
        )
        .bind(captureTime(), workspaceId, sha, owned.owner_token, captureTime())
        .run();
      if (!completed.meta.changes)
        throw new SupportError(CAPTURE_UNCERTAIN, 409);
    } catch (error) {
      // A failed read/write here never grants a fresh owner. In particular an
      // unknown provider outcome is not converted into an automatically retryable lease.
      try {
        const current = await own();
        if (current?.state === 'preparing') {
          if (preparingQuotaKnown && reservationIntegrityKnown) {
            await finishOwned(false, 'preparing');
            await db
              .prepare(
                "UPDATE supplier_capture_analyses SET state='retryable',reservation=NULL,owner_until=0,updated_at=? WHERE workspace_id=? AND source_sha256=? AND owner_token=? AND state='preparing'",
              )
              .bind(captureTime(), workspaceId, sha, owned.owner_token)
              .run();
          } else {
            await db
              .prepare(
                "UPDATE supplier_capture_analyses SET state='uncertain',owner_until=0,updated_at=? WHERE workspace_id=? AND source_sha256=? AND owner_token=? AND state='preparing'",
              )
              .bind(captureTime(), workspaceId, sha, owned.owner_token)
              .run();
          }
        } else if (current?.state === 'analyzing') {
          await db
            .prepare(
              "UPDATE supplier_capture_analyses SET state='uncertain',owner_until=0,updated_at=? WHERE workspace_id=? AND source_sha256=? AND owner_token=? AND state='analyzing'",
            )
            .bind(captureTime(), workspaceId, sha, owned.owner_token)
            .run();
        } else if (current?.state === 'analyzed') {
          if (reservationIntegrityKnown) await finishOwned(false, 'analyzed');
          const released =
            reservationIntegrityKnown &&
            reservation &&
            (await quotaState(reservation)) === 'released';
          await db
            .prepare(
              "UPDATE supplier_capture_analyses SET reservation=?,owner_until=0,updated_at=? WHERE workspace_id=? AND source_sha256=? AND owner_token=? AND state='analyzed'",
            )
            .bind(
              released ? null : reservation,
              captureTime(),
              workspaceId,
              sha,
              owned.owner_token,
            )
            .run();
        }
      } catch {
        /* Preserve the original error; uncertain ownership remains closed. */
      }
      throw error;
    }
  }
  await db
    .prepare(
      'INSERT INTO supplier_mail_receipts(id,workspace_id,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',
    )
    .bind(receipt, workspaceId, now)
    .run();
}
