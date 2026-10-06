import type { SwissMethod } from './postfinance-client';
import type { ZentraUser } from '@/app/zentra-auth';
import { prepaidProduct } from './prepaid-catalog';
import {
  postFinancePurchaseConfiguration,
  postFinanceTestPurchaseAllowed,
  type PostFinancePurchaseBinding,
} from './postfinance-purchase-configuration';

/** Display readiness only. Never reserves, creates a target, or sends money.
 * LIVE remains refused even when deployment flags are accidentally enabled. */
export async function postFinancePurchaseOption(
  productKey: unknown,
  origin: string,
  user: () => Promise<ZentraUser | null>,
  read: (name: PostFinancePurchaseBinding) => string,
) {
  const unavailable = {
    available: false,
    testMode: false,
    methods: [] as readonly SwissMethod[],
  } as const;
  const product = prepaidProduct(productKey);
  if (!product) return unavailable;
  try {
    const config = postFinancePurchaseConfiguration(read);
    if (
      !config.enabled ||
      config.connection.prepaidEnvironment !== 'TEST' ||
      config.connection.returnOrigin !== origin
    )
      return unavailable;
    const methods: readonly SwissMethod[] = (
      ['postfinance_pay', 'twint'] as const
    ).filter(
      (method) =>
        config.connection.prepaidProducts?.[product.productKey]
          ?.methodConfigurations[method] &&
        config.connectorConfigurations[method] &&
        (method === 'postfinance_pay'
          ? config.connection.postfinancePayTokenEnabled
          : config.connection.twintUserOnFileEnabled) === true,
    );
    if (!methods.length) return unavailable;
    const account = await user();
    if (
      !account?.emailConfirmed ||
      !postFinanceTestPurchaseAllowed(config, account.userId, read)
    )
      return unavailable;
    return { available: true, testMode: true, methods } as const;
  } catch {
    return unavailable;
  }
}

export type PostFinanceTargets = {
  organizations: { id: string; name: string }[];
  workspaces: { id: string; name: string; organizationId: string | null }[];
};
/** Owner-only discovery. Expired access does not prevent paying; revoked roles
 * and deleted accounts do. No default company is chosen from a partial list. */
export async function ownedPostFinanceTargets(
  db: Pick<D1Database, 'prepare'>,
  userId: string,
  complete = false,
): Promise<PostFinanceTargets> {
  const deleted = await db
    .prepare(
      'SELECT 1 FROM account_session_policy WHERE user_id=? AND deleted_at IS NOT NULL',
    )
    .bind(userId)
    .first();
  if (deleted) return { organizations: [], workspaces: [] };
  const [companies, workspaces] = await Promise.all([
    db
      .prepare(`SELECT o.organization_id AS id,o.name FROM organizations o
      JOIN organization_members m ON m.organization_id=o.organization_id AND m.user_id=? AND m.role='owner' AND m.revoked_at IS NULL
      WHERE o.created_by_user_id=? AND (?=0 OR NOT EXISTS(SELECT 1 FROM support_gestion_links l
        JOIN support_workspaces linked ON linked.id=l.workspace_id WHERE l.organization_id=o.organization_id AND linked.owner_id<>?))
      ORDER BY o.created_at,o.organization_id LIMIT 101`)
      .bind(userId, userId, complete ? 1 : 0, userId)
      .all<{ id: string; name: string }>(),
    db
      .prepare(`SELECT w.id,w.name,l.organization_id AS organizationId FROM support_workspaces w
      LEFT JOIN support_gestion_links l ON l.workspace_id=w.id WHERE w.owner_id=?
      AND (l.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o JOIN organization_members m
        ON m.organization_id=o.organization_id AND m.user_id=? AND m.role='owner' AND m.revoked_at IS NULL
        WHERE o.organization_id=l.organization_id AND o.created_by_user_id=?))
      ORDER BY w.created_at,w.id LIMIT 101`)
      .bind(userId, userId, userId)
      .all<{ id: string; name: string; organizationId: string | null }>(),
  ]);
  if (companies.results.length > 100 || workspaces.results.length > 100)
    throw Error('Too many payment targets.');
  return { organizations: companies.results, workspaces: workspaces.results };
}
