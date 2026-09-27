import { accountJsonError, accountNoStoreHeaders } from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import { automationActor } from '@/lib/automation/access';
import { gestionActive } from '@/lib/supplier-inbox/service';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import {
  connectSharedMail,
  disconnectSharedMail,
  sendSharedMail,
  sharedMailState,
  sharedMailReceipt,
} from '@/lib/company-mail/service';

export const dynamic = 'force-dynamic';
const json = (data: unknown) =>
  Response.json(data, { headers: accountNoStoreHeaders() });
export async function GET(request: Request) {
  try {
    const url = new URL(request.url),
      actor = await automationActor(
        request,
        url.searchParams.get('organizationId'),
      );
    const entity = url.searchParams.get('entity'),
      id = url.searchParams.get('documentId');
    const requestId = url.searchParams.get('requestId');
    if (requestId)
      return json({
        organizationId: actor.organizationId,
        receipt: await sharedMailReceipt(actor, requestId),
      });
    if (
      (entity || id) &&
      (!entity ||
        !id ||
        !['quotes', 'invoices', 'reminders'].includes(entity) ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))
    )
      throw new AccountPublicError('Choisissez le document à consulter.');
    const state = await sharedMailState(
      actor,
      entity && id ? { entity, id: id.toLowerCase() } : undefined,
    );
    return json({
      ...state,
      canSend:
        state.canSend &&
        (await gestionActive(actor.organizationId, actor.userId)),
    });
  } catch (error) {
    return accountJsonError(error, {
      request,
      operation: 'company-mail.read',
      startedAt: Date.now(),
    });
  }
}
export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const raw = await readJsonObjectWithinLimit(request, 9 * 1024 * 1024);
    if (!['connect', 'disconnect', 'send'].includes(String(raw.action)))
      throw new AccountPublicError('Cette action n’est pas disponible.');
    const authorize = async () => {
      const actor = await automationActor(
        request,
        raw.organizationId,
        raw.action !== 'send',
      );
      if (
        raw.action !== 'disconnect' &&
        !(await gestionActive(actor.organizationId, actor.userId))
      )
        throw new AccountPublicError(
          'Activez Zentra Gestion pour envoyer les documents de cette entreprise.',
          402,
        );
      return actor;
    };
    const actor = await authorize();
    if (raw.action === 'connect')
      return json(await connectSharedMail(actor, raw, authorize));
    if (raw.action === 'disconnect')
      return json(await disconnectSharedMail(actor));
    return json({
      organizationId: actor.organizationId,
      ...(await sendSharedMail(actor, raw, authorize)),
    });
  } catch (error) {
    return accountJsonError(error, {
      request,
      operation: 'company-mail.action',
      startedAt,
    });
  }
}
