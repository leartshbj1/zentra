import { accountJsonError, accountNoStoreHeaders } from '@/lib/account';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { authenticateFounder } from '@/lib/founder-admin';
import { changeAccess, listAccess, lookupAccess } from '@/lib/founder-access';
import {
  changeSupportAccess,
  listSupportAccess,
  lookupSupportAccess,
} from '@/lib/support/founder-access';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const body = await readJsonObjectWithinLimit(request, 12288);
    const action = await authenticateFounder(body, request);
    const result =
      action.product === 'support'
        ? action.operation === 'list'
          ? await listSupportAccess()
          : action.operation === 'lookup'
            ? await lookupSupportAccess(action.email!)
            : await changeSupportAccess(action)
        : action.operation === 'list'
          ? await listAccess()
          : action.operation === 'lookup'
            ? await lookupAccess(action.email!)
            : await changeAccess(action);
    return Response.json(result, { headers: accountNoStoreHeaders() });
  } catch (error) {
    return accountJsonError(error);
  }
}
