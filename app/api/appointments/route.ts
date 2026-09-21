import {
  accountJsonError,
  accountNoStoreHeaders,
  requireDeviceSession,
} from '@/lib/account';
import { automationActor } from '@/lib/automation/access';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import {
  appointmentState,
  appointmentAction,
} from '@/lib/appointments/service';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const actor = await automationActor(
      request,
      new URL(request.url).searchParams.get('organizationId'),
    );
    const session = actor.device ? await requireDeviceSession(request) : null;
    return Response.json(
      await appointmentState(actor, session?.installationId),
      { headers: accountNoStoreHeaders() },
    );
  } catch (e) {
    return accountJsonError(e);
  }
}
export async function POST(request: Request) {
  try {
    await automationActor(request, null);
    const session = await requireDeviceSession(request, [
      'owner',
      'admin',
      'member',
    ]);
    return Response.json(
      await appointmentAction(
        session,
        await readJsonObjectWithinLimit(request, 4000),
      ),
      { headers: accountNoStoreHeaders() },
    );
  } catch (e) {
    return accountJsonError(e);
  }
}
