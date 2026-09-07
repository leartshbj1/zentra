import {
  accountJsonError,
  accountNoStoreHeaders,
  requireDeviceSession,
} from '@/lib/account';
import { documentId, downloadDocument } from '@/lib/project-sync';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const session = await requireDeviceSession(request);
    const { row, file } = await downloadDocument(
      session.organizationId,
      documentId(new URL(request.url).searchParams.get('id')),
    );
    const headers = new Headers(accountNoStoreHeaders());
    headers.set('Content-Type', row.media_type);
    headers.set('Content-Length', String(row.size_bytes));
    headers.set('X-Zentra-Sha256', row.sha256);
    headers.set(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
    );
    return new Response(file.body, { headers });
  } catch (error) {
    return accountJsonError(error);
  }
}
