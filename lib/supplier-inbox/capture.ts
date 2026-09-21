import { database, fileArchive } from '@/lib/runtime';
import { decisionApiKey } from '@/lib/automation/config';
import { JevDecisionProvider } from '@/lib/automation/provider';
import { extractInvoice, emptyExtraction } from './extraction';
import { invoiceMedia, invoiceText, type PreparedMailDocument } from './documents';
import {
  documentDigest,
  gestionActive,
  mailReceiptId,
  workspaceLink,
} from './service';
import { readMailAttachment } from '@/lib/support/infomaniak';
import type { SourceTicket, Workspace } from '@/lib/support/types';
import { finishAnalysis, reserveAnalysis } from '@/lib/support/billing';

export async function mailboxCaptureNeeded(
  workspace: string,
  connection: string,
  message: string,
) {
  const link = await workspaceLink(workspace);
  if (!link?.enabled) return false;
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
    const prepared = input.documents?.get(attachment.id);
    const bytes = prepared?.bytes ?? (input.readAttachment ? await input.readAttachment(attachment.id) : await readMailAttachment(
        input.token,
        input.mailboxId,
        input.folderId,
        input.uid,
        attachment.id,
      )),
      media = prepared ? prepared.media : invoiceMedia(bytes);
    if (!media) continue;
    const sha = await documentDigest(bytes);
    if (
      await db
        .prepare(
          'SELECT id FROM supplier_inbox WHERE organization_id=? AND source_sha256=?',
        )
        .bind(link.organization_id, sha)
        .first()
    )
      continue;
    let text = '';
    try {
      text = prepared ? prepared.text : await invoiceText(bytes, media);
    } catch {
      /* Preserve the original for manual review. */
    }
    let extraction = emptyExtraction(
      'Ce scan ou document ne contient pas de texte lisible. Vérifiez le justificatif et complétez ses informations.',
    );
    const reservation = text
      ? await reserveAnalysis(
          input.workspace,
          `invoice:${sha}`,
          crypto.randomUUID(),
        )
      : null;
    try {
      if (text)
        extraction = await extractInvoice(
          text,
          company?.name || '',
          new JevDecisionProvider(await decisionApiKey()),
        );
      if (
        extraction.kind === 'other' &&
        (extraction.kindConfidence ?? 0) >= 0.95
      ) {
        await finishAnalysis(reservation, true);
        continue;
      }
      const id = crypto.randomUUID(),
        key = `supplier-inbox/${link.organization_id}/${sha}`;
      await fileArchive().put(key, bytes, {
        httpMetadata: { contentType: media },
      });
      await db
        .prepare(
          `INSERT INTO supplier_inbox(id,organization_id,workspace_id,connection_id,message_id,source_sha256,file_name,media_type,object_key,size_bytes,sender,subject,extraction,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,source_sha256) DO NOTHING`,
        )
        .bind(
          id,
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
        )
        .run();
      await finishAnalysis(reservation, true);
    } catch (error) {
      await finishAnalysis(reservation, false);
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
