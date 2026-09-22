import { database, runtimeValue } from '@/lib/runtime';
import { stripeSecretKeyLivemode } from '@/lib/stripe-event';
import { AccountPublicError } from '@/lib/account-security';
import { automationGrant } from './founder-access';
import type { AutomationActor } from './access';

export const AUTOMATION_REQUIRED =
  'Disponible avec Zentra Automation. Automatisez vos tâches répétitives pour +15 CHF/mois.';

/** Commercial access for one company. No account-wide or founder bypass. */
export async function automationEntitlement(actor: AutomationActor) {
  const row = await database()
    .prepare(`SELECT a.paid_from,a.paid_until,a.status,a.livemode FROM automation_subscriptions a
    JOIN organizations o ON o.organization_id=a.organization_id
    JOIN subscriptions s ON s.subscription_id=o.subscription_id
    WHERE a.organization_id=? AND s.entitlement_valid_until>unixepoch() AND s.livemode=a.livemode
    AND NOT EXISTS(SELECT 1 FROM automation_refunds r WHERE r.invoice_id=a.last_paid_invoice_id AND r.customer_id=a.customer_id AND r.livemode=a.livemode)`)
    .bind(actor.organizationId)
    .first<{
      paid_from: number;
      paid_until: number;
      status: string;
      livemode: number;
    }>();
  const now = Math.floor(Date.now() / 1000),
    live = stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY'));
  // past_due never extends access beyond an already-paid period. No implicit grace period.
  return (
    (!!row &&
      live !== null &&
      row.livemode === Number(live) &&
      row.paid_from <= now &&
      row.paid_until > now &&
      ['active', 'past_due'].includes(row.status)) ||
    !!(await automationGrant(actor.organizationId))
  );
}

/** Recheck membership on execution, including workers using a stored delegation. */
export async function requireAutomationEntitlement(actor: AutomationActor) {
  const member = await database()
    .prepare(
      'SELECT role FROM organization_members WHERE organization_id=? AND user_id=? AND revoked_at IS NULL',
    )
    .bind(actor.organizationId, actor.userId)
    .first<{ role: string }>();
  if (
    !member ||
    !['owner', 'admin', 'accountant', 'member'].includes(member.role)
  )
    throw new AccountPublicError(
      'Votre accès à cet espace ne permet pas cette action.',
      403,
    );
  if (!(await automationEntitlement(actor)))
    throw new AccountPublicError(AUTOMATION_REQUIRED, 402);
  return { ...actor, role: member.role };
}
