import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import {
  AccountPublicError,
  roleCanWriteInvoices,
} from '@/lib/account-security';
import {
  buildArchiveIdentity,
  MAX_ARCHIVE_REQUEST_BYTES,
  normalizeArchiveInput,
} from '@/lib/invoice-archive';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { database, fileArchive } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

type ArchiveRow = {
  archive_id: string;
  source_invoice_id: string;
  revision: number;
  invoice_number: string;
  issue_date: string;
  paid_at: string | null;
  correction_kind: string;
  correction_reason: string | null;
  supersedes_archive_id: string | null;
  object_key: string;
  content_sha256: string;
  size_bytes: number;
  media_type: string;
  previous_chain_sha256: string | null;
  chain_sha256: string;
  retention_until: string;
  stored_at: number;
  storage_status: string;
};

function publicArchive(row: ArchiveRow) {
  return {
    id: row.archive_id,
    sourceInvoiceId: row.source_invoice_id,
    revision: row.revision,
    invoiceNumber: row.invoice_number,
    issueDate: row.issue_date,
    paidAt: row.paid_at,
    correctionKind: row.correction_kind,
    correctionReason: row.correction_reason,
    supersedesArchiveId: row.supersedes_archive_id,
    contentSha256: row.content_sha256,
    sizeBytes: row.size_bytes,
    mediaType: row.media_type,
    previousChainSha256: row.previous_chain_sha256,
    chainSha256: row.chain_sha256,
    retentionUntil: row.retention_until,
    storedAt: new Date(row.stored_at * 1_000).toISOString(),
    status: row.storage_status,
    downloadUrl: `/api/archive/invoices/${encodeURIComponent(row.archive_id)}`,
  };
}

function archiveMatches(
  row: ArchiveRow,
  expected: {
    invoiceNumber: string;
    issueDate: string;
    paidAt: string | null;
    correctionKind: string;
    correctionReason: string | null;
    supersedesArchiveId: string | null;
    objectKey: string;
    contentSha256: string;
    sizeBytes: number;
    previousChainSha256: string | null;
    chainSha256: string;
    retentionUntil: string;
  },
) {
  return (
    row.invoice_number === expected.invoiceNumber &&
    row.issue_date === expected.issueDate &&
    row.paid_at === expected.paidAt &&
    row.correction_kind === expected.correctionKind &&
    row.correction_reason === expected.correctionReason &&
    row.supersedes_archive_id === expected.supersedesArchiveId &&
    row.object_key === expected.objectKey &&
    row.content_sha256 === expected.contentSha256 &&
    row.size_bytes === expected.sizeBytes &&
    row.previous_chain_sha256 === expected.previousChainSha256 &&
    row.chain_sha256 === expected.chainSha256 &&
    row.retention_until === expected.retentionUntil &&
    row.media_type === 'application/pdf'
  );
}

async function archiveRevision(
  db: D1Database,
  organizationId: string,
  sourceInvoiceId: string,
  revision: number,
) {
  return db
    .prepare(
      `SELECT archive_id,source_invoice_id,revision,invoice_number,issue_date,
              paid_at,correction_kind,correction_reason,supersedes_archive_id,
              object_key,content_sha256,size_bytes,media_type,
              previous_chain_sha256,chain_sha256,retention_until,stored_at,
              storage_status
         FROM invoice_archives
        WHERE organization_id=? AND source_invoice_id=? AND revision=? LIMIT 1`,
    )
    .bind(organizationId, sourceInvoiceId, revision)
    .first<ArchiveRow>();
}

export async function GET(request: Request) {
  try {
    const session = await requireDeviceSession(request);
    const url = new URL(request.url);
    const sourceInvoiceId = url.searchParams.get('sourceInvoiceId')?.trim();
    if (sourceInvoiceId && sourceInvoiceId.length > 160) {
      throw new AccountPublicError('La référence de facture est invalide.');
    }
    const result = await database()
      .prepare(
        `SELECT archive_id,source_invoice_id,revision,invoice_number,issue_date,
                paid_at,correction_kind,correction_reason,supersedes_archive_id,
                object_key,content_sha256,size_bytes,media_type,
                previous_chain_sha256,chain_sha256,retention_until,stored_at,
                storage_status
           FROM invoice_archives
          WHERE organization_id=? AND storage_status='stored'
            AND (? IS NULL OR source_invoice_id=?)
          ORDER BY stored_at DESC,revision DESC LIMIT 250`,
      )
      .bind(
        session.organizationId,
        sourceInvoiceId ?? null,
        sourceInvoiceId ?? null,
      )
      .all<ArchiveRow>();
    return Response.json(
      { archives: result.results.map(publicArchive) },
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireDeviceSession(request);
    if (!roleCanWriteInvoices(session.role)) {
      throw new AccountPublicError(
        'Votre accès est limité à la consultation.',
        403,
      );
    }
    await enforceAccountRateLimit(
      request,
      'invoice-archive',
      `${session.organizationId}:${session.sessionId}`,
      300,
    );
    await enforceAccountRateLimit(
      request,
      'invoice-archive-organization',
      session.organizationId,
      2_000,
    );
    const body = await readJsonObjectWithinLimit(
      request,
      MAX_ARCHIVE_REQUEST_BYTES,
    );
    const archive = normalizeArchiveInput(body);
    const db = database();
    await db
      .prepare(
        `DELETE FROM invoice_archives
          WHERE organization_id=? AND source_invoice_id=?
            AND storage_status='pending' AND stored_at<?`,
      )
      .bind(
        session.organizationId,
        archive.sourceInvoiceId,
        Math.floor(Date.now() / 1_000) - 15 * 60,
      )
      .run();
    const previous = await db
      .prepare(
        `SELECT archive_id,revision,chain_sha256,storage_status
           FROM invoice_archives
          WHERE organization_id=? AND source_invoice_id=?
          ORDER BY revision DESC LIMIT 1`,
      )
      .bind(session.organizationId, archive.sourceInvoiceId)
      .first<{
        archive_id: string;
        revision: number;
        chain_sha256: string;
        storage_status: string;
      }>();
    let exact = await archiveRevision(
      db,
      session.organizationId,
      archive.sourceInvoiceId,
      archive.revision,
    );

    if (!exact && previous && previous.storage_status !== 'stored') {
      throw new AccountPublicError(
        `La version ${previous.revision} doit finir son archivage avant la suivante.`,
        409,
      );
    }
    if (!exact && archive.revision !== (previous?.revision ?? 0) + 1) {
      throw new AccountPublicError(
        `La prochaine version attendue est ${(previous?.revision ?? 0) + 1}.`,
        409,
      );
    }
    const previousChainSha256 = exact
      ? exact.previous_chain_sha256
      : (previous?.chain_sha256 ?? null);
    const supersedesArchiveId = exact
      ? exact.supersedes_archive_id
      : (previous?.archive_id ?? null);
    const identity = await buildArchiveIdentity({
      organizationId: session.organizationId,
      archive,
      previousChainSha256,
    });
    const expected = {
      invoiceNumber: archive.invoiceNumber,
      issueDate: archive.issueDate,
      paidAt: archive.paidAt,
      correctionKind: archive.correctionKind,
      correctionReason: archive.correctionReason,
      supersedesArchiveId,
      objectKey: identity.objectKey,
      contentSha256: identity.contentSha256,
      sizeBytes: archive.pdfBytes.byteLength,
      previousChainSha256,
      chainSha256: identity.chainSha256,
      retentionUntil: identity.retentionUntil,
    };
    if (exact && !archiveMatches(exact, expected)) {
      throw new AccountPublicError(
        'Cette version existe déjà avec un contenu différent. Créez la version suivante.',
        409,
      );
    }
    if (exact?.storage_status === 'stored') {
      return Response.json(
        { archive: publicArchive(exact), alreadyStored: true },
        { headers: accountNoStoreHeaders() },
      );
    }

    let archiveId = exact?.archive_id ?? `arc_${crypto.randomUUID()}`;
    let storedAt = exact?.stored_at ?? Math.floor(Date.now() / 1_000);
    if (!exact) {
      try {
        await db
          .prepare(
            `INSERT INTO invoice_archives(
             archive_id,organization_id,source_invoice_id,revision,invoice_number,
             issue_date,paid_at,correction_kind,correction_reason,
             supersedes_archive_id,object_key,content_sha256,size_bytes,media_type,
             previous_chain_sha256,chain_sha256,retention_until,
             stored_by_session_id,stored_at,storage_status
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'application/pdf',?,?,?,?,?,'pending')`,
          )
          .bind(
            archiveId,
            session.organizationId,
            archive.sourceInvoiceId,
            archive.revision,
            archive.invoiceNumber,
            archive.issueDate,
            archive.paidAt,
            archive.correctionKind,
            archive.correctionReason,
            supersedesArchiveId,
            identity.objectKey,
            identity.contentSha256,
            archive.pdfBytes.byteLength,
            previousChainSha256,
            identity.chainSha256,
            identity.retentionUntil,
            session.sessionId,
            storedAt,
          )
          .run();
      } catch (error) {
        exact = await archiveRevision(
          db,
          session.organizationId,
          archive.sourceInvoiceId,
          archive.revision,
        );
        if (!exact) throw error;
        if (!archiveMatches(exact, expected)) {
          throw new AccountPublicError(
            'Cette version vient d’être archivée avec un contenu différent. Créez la version suivante.',
            409,
          );
        }
        if (exact.storage_status === 'stored') {
          return Response.json(
            { archive: publicArchive(exact), alreadyStored: true },
            { headers: accountNoStoreHeaders() },
          );
        }
        archiveId = exact.archive_id;
        storedAt = exact.stored_at;
      }
    }

    await fileArchive().put(identity.objectKey, archive.pdfBytes, {
      httpMetadata: {
        contentType: 'application/pdf',
        cacheControl: 'private, no-store',
      },
      customMetadata: {
        archiveId,
        organizationId: session.organizationId,
        contentSha256: identity.contentSha256,
        chainSha256: identity.chainSha256,
        retentionUntil: identity.retentionUntil,
      },
    });
    const stored = await db
      .prepare(
        `UPDATE invoice_archives SET storage_status='stored'
          WHERE archive_id=? AND storage_status='pending'`,
      )
      .bind(archiveId)
      .run();
    const completed = await archiveRevision(
      db,
      session.organizationId,
      archive.sourceInvoiceId,
      archive.revision,
    );
    if (
      !completed ||
      completed.archive_id !== archiveId ||
      completed.storage_status !== 'stored' ||
      !archiveMatches(completed, expected)
    ) {
      throw new Error('Invoice archive metadata was not finalized');
    }
    const alreadyStored = (stored.meta.changes ?? 0) === 0;
    return Response.json(
      { archive: publicArchive(completed), alreadyStored },
      {
        status: alreadyStored ? 200 : 201,
        headers: accountNoStoreHeaders(),
      },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
