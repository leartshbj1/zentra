import { accountJsonError, accountNoStoreHeaders } from '@/lib/account';
import {
  businessFileStatus,
  uploadBusinessFilePart,
  verifyBusinessFile,
} from '@/lib/business-sync-files';
import {
  businessFileIndex,
  businessFilesSession,
} from '@/lib/business-sync-files-http';
import { readJsonObjectWithinLimit } from '@/lib/request-body';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const session = await businessFilesSession(request),
      query = new URL(request.url).searchParams;
    return Response.json(
      await businessFileStatus(
        session,
        query.get('transfer_id'),
        query.get('sha256'),
      ),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function POST(request: Request) {
  try {
    const session = await businessFilesSession(request),
      input = await readJsonObjectWithinLimit(request, 2048);
    return Response.json(
      await verifyBusinessFile(session, input.transfer_id, input.sha256),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function PUT(request: Request) {
  try {
    const session = await businessFilesSession(request),
      query = new URL(request.url).searchParams;
    return Response.json(
      await uploadBusinessFilePart(
        session,
        query.get('transfer_id'),
        query.get('sha256'),
        businessFileIndex(query.get('part')),
        request,
      ),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
