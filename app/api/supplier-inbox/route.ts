import {
  accountJsonError,
  accountNoStoreHeaders,
  requireDeviceSession,
} from '@/lib/account';
import { automationActor } from '@/lib/automation/access';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import {
  claimInvoice,
  finishInvoice,
  releaseInvoice,
  ignoreInvoice,
  inboxState,
  inboxDocument,
  rememberInvoice,
} from '@/lib/supplier-inbox/service';
import { AccountPublicError } from '@/lib/account-security';
import {forgetSupplier} from '@/lib/supplier-inbox/habits';
export const dynamic = 'force-dynamic';
const json = (value: unknown) =>
  Response.json(value, { headers: accountNoStoreHeaders() });
export async function GET(request: Request) {
  try {
    const url = new URL(request.url),
      actor = await automationActor(
        request,
        url.searchParams.get('organizationId'),
      );
    if (url.searchParams.has('document')) {
      const { row, object } = await inboxDocument(
        actor.organizationId,
        url.searchParams.get('document'),
      );
      return new Response(object.body, {
        headers: {
          ...accountNoStoreHeaders(),
          'Content-Type': row.media_type,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
          'Content-Security-Policy': "sandbox; default-src 'none'",
        },
      });
    }
    const session = request.headers.has('Authorization')
      ? await requireDeviceSession(request)
      : null;
    return json(await inboxState(actor, session?.installationId));
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function POST(request: Request) {
  try {
    const body = await readJsonObjectWithinLimit(request, 4000),
      actor = await automationActor(request, body.organizationId);
    if (body.action === 'ignore')
      return json(await ignoreInvoice(actor, body.id));
    if(body.action==='forgetHabit')return json(await forgetSupplier(actor,body.id));
    if (!actor.device)
      throw new AccountPublicError(
        'Ouvrez Gestion pour enregistrer la facture.',
        403,
      );
    const session = await requireDeviceSession(request, [
      'owner',
      'admin',
      'member',
    ]);
    if (body.action === 'claim') return json(await claimInvoice(session, body));
    if (body.action === 'remember') return json(await rememberInvoice(session,body));
    if (body.action === 'finish')
      return json(await finishInvoice(session, body));
    if (body.action === 'release')
      return json(await releaseInvoice(session, body));
    throw new AccountPublicError('Cette action n’est pas disponible.');
  } catch (error) {
    return accountJsonError(error);
  }
}
