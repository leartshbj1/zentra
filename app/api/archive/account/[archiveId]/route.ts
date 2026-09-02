import { getChatGPTUser } from '@/app/chatgpt-auth';
import { accountJsonError, accountNoStoreHeaders } from '@/lib/account';
import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import { safeInvoiceFilename } from '@/lib/invoice-archive';
import { database, fileArchive } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ archiveId: string }> },
) {
  try {
    const user = await getChatGPTUser();
    if (!user) {
      throw new AccountPublicError(
        'Connectez-vous pour ouvrir cette archive.',
        401,
      );
    }
    const { archiveId: rawArchiveId } = await params;
    const archiveId = rawArchiveId.trim();
    if (!/^arc_[0-9a-f-]{36}$/i.test(archiveId)) {
      throw new AccountPublicError('La référence d’archive est invalide.');
    }
    const row = await database()
      .prepare(
        `SELECT archive.organization_id,archive.object_key,
                archive.invoice_number,archive.revision,
                archive.content_sha256,archive.chain_sha256,archive.size_bytes
           FROM invoice_archives archive
           JOIN organization_members member
             ON member.organization_id=archive.organization_id
            AND member.user_id=? AND member.revoked_at IS NULL
          WHERE archive.archive_id=? AND archive.storage_status='stored'
          LIMIT 1`,
      )
      .bind(user.userId, archiveId)
      .first<{
        organization_id: string;
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
      object.customMetadata?.organizationId !== row.organization_id ||
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
    const headers = new Headers(accountNoStoreHeaders());
    headers.set('Content-Type', 'application/pdf');
    headers.set('Content-Length', String(object.size));
    headers.set(
      'Content-Disposition',
      `attachment; filename="${safeInvoiceFilename(row.invoice_number, row.revision)}"`,
    );
    headers.set('X-Zentra-Content-SHA256', row.content_sha256);
    return new Response(bytes, { headers });
  } catch (error) {
    return accountJsonError(error);
  }
}
