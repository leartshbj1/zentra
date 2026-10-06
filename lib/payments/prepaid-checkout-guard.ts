import { database } from '@/lib/runtime';
import { AccountPublicError } from '@/lib/account-security';

/** Do not silently open a second provider subscription. This guard also covers
 * reserved contracts whose provider response has not yet been reconciled.
 * Cross-provider migrations require their own durable cancellation saga.
 */
export async function assertNoPrepaidAccountPurchase(userId: string) {
  const existing = await database()
    .prepare(`
    SELECT 1 FROM organizations o WHERE o.created_by_user_id=? AND substr(o.subscription_id,1,4)='pfp_'
    UNION ALL SELECT 1 FROM support_subscriptions s JOIN support_workspaces w ON w.id=s.workspace_id
      WHERE w.owner_id=? AND substr(s.subscription_id,1,4)='pfp_'
    UNION ALL SELECT 1 FROM automation_subscriptions a JOIN organizations o ON o.organization_id=a.organization_id
      WHERE o.created_by_user_id=? AND substr(a.subscription_id,1,4)='pfp_'
    UNION ALL SELECT 1 FROM prepaid_contracts c WHERE c.owner_id=? AND c.environment='PRODUCTION'
      AND (c.cancelled_at IS NULL OR EXISTS(SELECT 1 FROM prepaid_periods p JOIN prepaid_settlement_proofs s ON s.period_id=p.period_id
        WHERE p.contract_id=c.contract_id AND p.starts_at<=unixepoch() AND p.ends_at>unixepoch()
        AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id))) LIMIT 1`)
    .bind(userId, userId, userId, userId)
    .first();
  if (existing)
    throw new AccountPublicError(
      'Un abonnement existe déjà. Son changement de moyen de paiement doit être terminé avant d’en ouvrir un autre.',
      409,
    );
}

/** A plan change with an already linked, verified target must not block a
 * different company owned by the same account. Never use this as a substitute
 * for checking ownership or for selecting an unlinked workspace. */
export async function assertNoPrepaidCompanyPurchase(
  userId: string,
  organizationId: string,
  workspaceId: string,
) {
  const existing = await database()
    .prepare(`
    SELECT 1 FROM organizations o WHERE o.organization_id=? AND o.created_by_user_id=? AND substr(o.subscription_id,1,4)='pfp_'
    UNION ALL SELECT 1 FROM automation_subscriptions a JOIN organizations o ON o.organization_id=a.organization_id
      WHERE o.organization_id=? AND o.created_by_user_id=? AND substr(a.subscription_id,1,4)='pfp_'
    UNION ALL SELECT 1 FROM support_subscriptions s JOIN support_workspaces w ON w.id=s.workspace_id
      WHERE w.id=? AND w.owner_id=? AND substr(s.subscription_id,1,4)='pfp_'
    UNION ALL SELECT 1 FROM prepaid_contracts c WHERE c.owner_id=? AND c.environment='PRODUCTION'
      AND (c.organization_id=? OR c.workspace_id=?)
      AND (c.cancelled_at IS NULL OR EXISTS(SELECT 1 FROM prepaid_periods p JOIN prepaid_settlement_proofs s ON s.period_id=p.period_id
        WHERE p.contract_id=c.contract_id AND p.starts_at<=unixepoch() AND p.ends_at>unixepoch()
        AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id))) LIMIT 1`)
    .bind(
      organizationId,
      userId,
      organizationId,
      userId,
      workspaceId,
      userId,
      userId,
      organizationId,
      workspaceId,
    )
    .first();
  if (existing)
    throw new AccountPublicError(
      'Un abonnement existe déjà. Son changement de moyen de paiement doit être terminé avant d’en ouvrir un autre.',
      409,
    );
}
