import { requireAutomationEntitlement } from '@/lib/automation/entitlement';
import { waitUntil } from 'cloudflare:workers';
import { accountJsonError, accountNoStoreHeaders } from '@/lib/account';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { automationActor } from '@/lib/automation/access';
import { saveSettings } from '@/lib/automation/config';
import { automationCompanyState } from '@/lib/automation/activity';
import { recordFeedback, requestDecision } from '@/lib/automation/service';
import { DecisionFailure } from '@/lib/automation/types';
import { AccountPublicError } from '@/lib/account-security';
import { workflowCentre, saveWorkflow, previewWorkflow, workflowAction, runDueWorkflows } from '@/lib/automation/workflows';
export const dynamic = 'force-dynamic';
const json = (v: unknown) =>
  Response.json(v, { headers: accountNoStoreHeaders() });
export async function GET(request: Request) {
  try {
    const actor = await automationActor(
      request,
      new URL(request.url).searchParams.get('organizationId'),
    );
    return json(await automationCompanyState(actor));
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function POST(request: Request) {
  try {
    const body = await readJsonObjectWithinLimit(request, 100000);
    if (body.action === 'decide')
      return json(await requestDecision(request, body));
    const actor = await automationActor(
      request,
      body.organizationId,
      body.action === 'settings',
    );
    if (body.action === 'settings') {
      if (body.enabled === true) await requireAutomationEntitlement(actor);
      return json(await saveSettings(actor.organizationId, actor.userId, body));
    }
    if (body.action === 'feedback')
      return json(await recordFeedback(actor, body));
    if (body.action === 'centre') {
      const centre = await workflowCentre(actor); // Verifies the current entitlement first.
      // Keep the response immediate. This advances only already-authorized rules
      // of this company; a remote scheduler is still needed when nobody is online.
      waitUntil(runDueWorkflows(actor.organizationId).catch(() => {}));
      return json(centre);
    }
    if (body.action === 'workflow_save') return json(await saveWorkflow(actor, body));
    if (body.action === 'workflow_preview') return json(await previewWorkflow(actor, body));
    if (['workflow_confirm','workflow_cancel','workflow_retry','workflow_undo','work_item_update'].includes(String(body.action)))
      return json(await workflowAction(actor,body));
    throw new AccountPublicError('Cette action n’est pas disponible.');
  } catch (error) {
    return accountJsonError(
      error instanceof DecisionFailure
        ? new AccountPublicError(
            'Complétez les informations nécessaires avant de demander une suggestion.',
          )
        : error,
    );
  }
}
