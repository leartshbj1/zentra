import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import {
  abandonBootstrap,
  beginBootstrap,
  bootstrapStatus,
  uploadBootstrapChunk,
} from '@/lib/business-sync-bootstrap';
import { readJsonObjectWithinLimit } from '@/lib/request-body';

export const dynamic = 'force-dynamic';

async function sessionFor(request: Request) {
  const session = await requireDeviceSession(request);
  await enforceAccountRateLimit(
    request,
    'business-sync-bootstrap',
    `${session.organizationId}:${session.installationId}`,
    240,
  );
  return session;
}

export async function GET(request: Request) {
  try {
    const session = await sessionFor(request);
    const id = new URL(request.url).searchParams.get('transfer_id');
    return Response.json(await bootstrapStatus(session, id), {
      headers: accountNoStoreHeaders(),
    });
  } catch (error) {
    return accountJsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await sessionFor(request);
    const input = await readJsonObjectWithinLimit(request, 1024 * 1024);
    return Response.json(
      await beginBootstrap(session, input.transfer_id, input.manifest),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await sessionFor(request);
    const query = new URL(request.url).searchParams;
    const index = query.get('chunk');
    if (!index || !/^(0|[1-9][0-9]*)$/.test(index))
      throw new AccountPublicError('Numéro de fragment invalide.');
    return Response.json(
      await uploadBootstrapChunk(
        session,
        query.get('transfer_id'),
        Number(index),
        request,
      ),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await sessionFor(request);
    const id = new URL(request.url).searchParams.get('transfer_id');
    return Response.json(await abandonBootstrap(session, id), {
      headers: accountNoStoreHeaders(),
    });
  } catch (error) {
    return accountJsonError(error);
  }
}
