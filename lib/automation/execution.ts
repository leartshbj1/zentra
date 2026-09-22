import { AccountPublicError } from '@/lib/account-security';
import { database } from '@/lib/runtime';
import type { AutomationActor } from './access';
import {
  automationEntitlement,
  requireAutomationEntitlement,
  AUTOMATION_REQUIRED,
} from './entitlement';
import { settingsFor, globalFlags } from './config';
import type { Feature } from './types';

export async function requireAutomationExecution(
  actor: AutomationActor,
  feature: Feature,
) {
  const verified = await requireAutomationEntitlement(actor);
  const [settings, flags] = await Promise.all([
    settingsFor(actor.organizationId),
    globalFlags(),
  ]);
  if (
    !settings.enabled ||
    !settings.consent ||
    !settings.flags.includes(feature) ||
    !flags.includes(feature)
  )
    throw new AccountPublicError(
      'Cette automatisation est en pause. Le traitement manuel reste disponible.',
      409,
    );
  return { actor: verified, settings };
}

/** A fresh check before every HTTP attempt, including a provider retry. */
export function automationFetch(
  actor: AutomationActor,
  feature: Feature,
  fetcher: typeof fetch = fetch,
): typeof fetch {
  return async (...args) => {
    await requireAutomationExecution(actor, feature);
    return fetcher(...args);
  };
}

/** The saved Support connection is a delegation, never a client-selected tenant. */
export async function supportAutomationState(
  workspaceId: string,
  feature: Feature = 'email_classification',
) {
  const link = await database()
    .prepare(`SELECT l.organization_id,l.connected_by,m.role FROM support_gestion_links l
    JOIN organization_members m ON m.organization_id=l.organization_id AND m.user_id=l.connected_by AND m.revoked_at IS NULL
    JOIN support_workspaces w ON w.id=l.workspace_id
    WHERE l.workspace_id=? AND l.enabled=1 AND m.role IN ('owner','admin')
    AND (w.owner_id=l.connected_by OR EXISTS(SELECT 1 FROM support_members sm WHERE sm.workspace_id=w.id AND lower(sm.email)=lower(m.email) AND sm.role='admin'))`)
    .bind(workspaceId)
    .first<{ organization_id: string; connected_by: string; role: string }>();
  if (!link)
    return { active: false, enabled: false, organizationId: null, actor: null };
  const actor: AutomationActor = {
    organizationId: link.organization_id,
    userId: link.connected_by,
    role: link.role,
    founder: false,
  };
  const [active, settings, flags] = await Promise.all([
    automationEntitlement(actor),
    settingsFor(actor.organizationId),
    globalFlags(),
  ]);
  return {
    active,
    enabled:
      active &&
      settings.enabled &&
      settings.consent &&
      settings.flags.includes(feature) &&
      flags.includes(feature),
    organizationId: actor.organizationId,
    actor,
  };
}
export async function requireSupportAutomation(
  workspaceId: string,
  feature: Feature = 'email_classification',
) {
  const state = await supportAutomationState(workspaceId, feature);
  if (!state.active || !state.actor)
    throw new AccountPublicError(AUTOMATION_REQUIRED, 402);
  if (!state.enabled)
    throw new AccountPublicError(
      'Cette automatisation est en pause. Le traitement manuel reste disponible.',
      409,
    );
  return requireAutomationExecution(state.actor, feature);
}
export function supportAutomationFetch(
  workspaceId: string,
  feature: Feature,
  fetcher: typeof fetch = fetch,
): typeof fetch {
  return async (...args) => {
    await requireSupportAutomation(workspaceId, feature);
    return fetcher(...args);
  };
}
