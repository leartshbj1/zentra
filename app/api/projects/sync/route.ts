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
  deleteDocument,
  documentId,
  publicDocument,
  storeDocument,
  type ProjectDocumentEvent,
} from '@/lib/project-sync';
import { database } from '@/lib/runtime';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const session = await requireDeviceSession(request);
    const after = Number(new URL(request.url).searchParams.get('after') || 0);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new AccountPublicError('Curseur de synchronisation invalide.');
    const rows = await database()
      .prepare(
        'SELECT * FROM project_document_events WHERE organization_id=? AND sequence>? ORDER BY sequence ASC LIMIT 50',
      )
      .bind(session.organizationId, after)
      .all<ProjectDocumentEvent>();
    return Response.json(
      {
        events: rows.results.map(publicDocument),
        cursor: rows.results.at(-1)?.sequence || after,
        hasMore: rows.results.length === 50,
      },
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
async function writer(request: Request) {
  const session = await requireDeviceSession(request);
  if (!roleCanWriteInvoices(session.role))
    throw new AccountPublicError(
      'Votre accès est limité à la consultation.',
      403,
    );
  await enforceAccountRateLimit(
    request,
    'project-documents',
    session.organizationId,
    2000,
  );
  return session;
}
export async function PUT(request: Request) {
  try {
    const session = await writer(request);
    return Response.json(await storeDocument(request, session.organizationId), {
      headers: accountNoStoreHeaders(),
    });
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function DELETE(request: Request) {
  try {
    const session = await writer(request);
    const url = new URL(request.url);
    await deleteDocument(
      session.organizationId,
      documentId(url.searchParams.get('id')),
      documentId(url.searchParams.get('projectId')),
    );
    return Response.json(
      { deleted: true },
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
