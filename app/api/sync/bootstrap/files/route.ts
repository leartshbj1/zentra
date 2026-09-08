import { accountJsonError, accountNoStoreHeaders } from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import {
  beginBusinessFiles,
  businessFilesStatus,
  completeBusinessFiles,
  uploadBusinessFilePage,
} from '@/lib/business-sync-files';
import {
  businessFileIndex,
  businessFilesSession,
} from '@/lib/business-sync-files-http';
import { readJsonObjectWithinLimit } from '@/lib/request-body';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const session = await businessFilesSession(request);
    return Response.json(
      await businessFilesStatus(
        session,
        new URL(request.url).searchParams.get('transfer_id'),
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
      input = await readJsonObjectWithinLimit(request, 256 * 1024);
    if (input.action !== 'begin' && input.action !== 'complete')
      throw new AccountPublicError('Action de catalogue inconnue.');
    const result =
      input.action === 'begin'
        ? await beginBusinessFiles(session, input.transfer_id, input.manifest)
        : await completeBusinessFiles(session, input.transfer_id);
    return Response.json(result, { headers: accountNoStoreHeaders() });
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function PUT(request: Request) {
  try {
    const session = await businessFilesSession(request),
      query = new URL(request.url).searchParams;
    return Response.json(
      await uploadBusinessFilePage(
        session,
        query.get('transfer_id'),
        businessFileIndex(query.get('page')),
        request,
      ),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
