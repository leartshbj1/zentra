import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
} from '@/lib/account';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { authenticateFounderCommand } from '@/lib/founder-admin';
import {
  parsePlatformAction,
  platformCommand,
  PLATFORM_DOMAIN,
  PLATFORM_PATH,
} from '@/lib/founder-platform';
import { SupportError } from '@/lib/support/types';
import { DecisionFailure } from '@/lib/automation/types';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const action = await authenticateFounderCommand(
      await readJsonObjectWithinLimit(request, 20000),
      request,
      PLATFORM_PATH,
      PLATFORM_DOMAIN,
      parsePlatformAction,
    );
    if (action.operation !== 'state')
      await enforceAccountRateLimit(
        request,
        'founder-platform',
        'founder-pc',
        40,
      );
    return Response.json(await platformCommand(action), {
      headers: accountNoStoreHeaders(),
    });
  } catch (error) {
    if (error instanceof SupportError)
      return Response.json(
        { error: error.message },
        { status: error.status, headers: accountNoStoreHeaders() },
      );
    if (error instanceof DecisionFailure)
      return Response.json(
        {
          error:
            'La vérification Automation n’a pas abouti. La clé existante est conservée. Vérifiez les droits Jev et réessayez.',
        },
        // Provider verification finishes before any key write. This definitive
        // rejection lets the PC clear its pending request and try another key.
        { status: 422, headers: accountNoStoreHeaders() },
      );
    return accountJsonError(error);
  }
}
