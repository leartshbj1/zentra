import {
  accountJsonError,
  accountNoStoreHeaders,
  requireDeviceSession,
} from '@/lib/account';
import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import { safeInvoiceFilename } from '@/lib/invoice-archive';
import { database, fileArchive } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ archiveId: string }> },
) {
  try {
    const session = await requireDeviceSession(request);
    const { archiveId: rawArchiveId } = await params;
    const archiveId = rawArchiveId.trim();
    if (!/^arc_[0-9a-f-]{36}$/i.test(archiveId)) {
      throw new AccountPublicError('La référence d’archive est invalide.');
    }
    const row = await database()
      .prepare(
        `SELECT object_key,invoice_number,revision,content_sha256,chain_sha256,size_bytes
           FROM invoice_archives
          WHERE archive_id=? AND organization_id=? AND storage_status='stored'
          LIMIT 1`,
      )
      .bind(archiveId, session.organizationId)
      .first<{
        object_key: string;
        invoice_number: string;
        revision: number;
        content_sha256: string;
        chain_sha256: string;
        size_bytes: number;
      }>();
    if (!row) {
      throw new AccountPublicError('Cette archive est introuvable.', 404);
    }
    const object = await fileArchive().get(row.object_key);
    if (!object || object.size !== row.size_bytes) {
      throw new AccountPublicError(
        'Le PDF archivé est momentanément indisponible.',
        503,
      );
    }
    if (
      object.customMetadata?.contentSha256 !== row.content_sha256 ||
      object.customMetadata?.archiveId !== archiveId ||
      object.customMetadata?.organizationId !== session.organizationId ||
      object.customMetadata?.chainSha256 !== row.chain_sha256
    ) {
      throw new AccountPublicError(
        'La preuve du PDF archivé est incohérente.',
        503,
      );
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if ((await sha256Hex(bytes)) !== row.content_sha256) {
      throw new AccountPublicError(
        'L’intégrité du PDF archivé n’a pas pu être confirmée.',
        503,
      );
    }
    const filename = safeInvoiceFilename(row.invoice_number, row.revision);
    const responseHeaders = new Headers(accountNoStoreHeaders());
    responseHeaders.set('Content-Type', 'application/pdf');
    responseHeaders.set('Content-Length', String(object.size));
    responseHeaders.set(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    responseHeaders.set('X-Zentra-Content-SHA256', row.content_sha256);
    return new Response(bytes, { headers: responseHeaders });
  } catch (error) {
    return accountJsonError(error);
  }
}
