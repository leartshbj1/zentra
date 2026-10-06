import type { SwissMethod } from "./postfinance-client";
import type { ZentraUser } from "@/app/zentra-auth";
import { prepaidProduct } from "./prepaid-catalog";
import { validPrepaidReceiptId } from "./prepaid-receipt-types";
import type { PrepaidPurchaseConfiguration } from "./prepaid-purchase-preparation";
import {
  postFinancePurchaseConfiguration,
  postFinancePurchaseContext,
  postFinanceTestPurchaseAllowed,
  type PostFinancePurchaseBinding,
} from "./postfinance-purchase-configuration";

/** Display readiness only. Never reserves, creates a target, or sends money.
 * PRODUCTION requires the separate approved server activation. */
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
    if (!config.enabled || config.connection.returnOrigin !== origin) return unavailable;
    const methods: readonly SwissMethod[] = (["postfinance_pay", "twint"] as const).filter(
      (method) =>
        config.connection.prepaidProducts?.[product.productKey]?.methodConfigurations[method] &&
        config.connectorConfigurations[method] &&
        (method === "postfinance_pay"
          ? config.connection.postfinancePayTokenEnabled
          : config.connection.twintUserOnFileEnabled) === true,
    );
    if (!methods.length) return unavailable;
    const account = await user();
    if (!account?.emailConfirmed || !postFinanceTestPurchaseAllowed(config, account.userId, read))
      return unavailable;
    const purchaseContext = await postFinancePurchaseContext(
      config,
      productKey,
      origin,
      account.userId,
    );
    if (!purchaseContext) return unavailable;
    return {
      available: true,
      testMode: config.connection.prepaidEnvironment === "TEST",
      methods,
      purchaseContext,
    } as const;
  } catch {
    return unavailable;
  }
}

export type PostFinanceTargets = {
  organizations: { id: string; name: string }[];
  workspaces: { id: string; name: string; organizationId: string | null }[];
};

/** Server-only initial recovery selection. A receipt is a display pointer, so
 * match its environment to the real owner/target and frozen provider scope. */
export async function ownedPostFinanceInitialRecoveryTarget(
  db: Pick<D1Database, "prepare">,
  user: { userId: string; emailConfirmed: boolean },
  intentId: string,
  expectedEnvironment: "TEST" | "PRODUCTION",
  configuration: PrepaidPurchaseConfiguration,
): Promise<{ period_id: string; transaction_id: number | null } | null> {
  const c = configuration.connection;
  if (
    !user.emailConfirmed ||
    !validPrepaidReceiptId(intentId) ||
    !configuration.enabled ||
    c.prepaidEnvironment !== expectedEnvironment
  )
    return null;
  const found = await db
    .prepare(`SELECT p.period_id,t.transaction_id,i.parameters,c.product_key
    FROM purchase_intents i JOIN prepaid_purchase_targets x ON x.intent_id=i.intent_id
    JOIN prepaid_contracts c ON c.contract_id=x.contract_id
    JOIN prepaid_periods p ON p.contract_id=c.contract_id AND p.ordinal=0
    LEFT JOIN prepaid_transactions t ON t.period_id=p.period_id AND t.api_origin=c.api_origin AND t.space_id=c.space_id
    WHERE i.intent_id=? AND i.owner_id=? AND i.provider='postfinance' AND i.environment=?
    AND i.state IN('dispatched','uncertain') AND c.owner_id=i.owner_id AND c.environment=i.environment
    AND x.owner_id=i.owner_id AND x.organization_id IS i.organization_id AND x.workspace_id IS i.workspace_id
    AND c.organization_id IS i.organization_id AND c.workspace_id IS i.workspace_id
    AND c.api_origin=? AND c.space_id=? AND i.provider_scope=(c.api_origin||'|'||c.space_id)
    AND NOT EXISTS(SELECT 1 FROM account_session_policy a WHERE a.user_id=i.owner_id AND a.deleted_at IS NOT NULL)
    AND (i.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o JOIN organization_members m
      ON m.organization_id=o.organization_id AND m.user_id=i.owner_id AND m.role='owner' AND m.revoked_at IS NULL
      WHERE o.organization_id=i.organization_id AND o.created_by_user_id=i.owner_id))
    AND (i.workspace_id IS NULL OR EXISTS(SELECT 1 FROM support_workspaces w WHERE w.id=i.workspace_id AND w.owner_id=i.owner_id))
    AND NOT EXISTS(SELECT 1 FROM support_gestion_links l WHERE
      (i.organization_id IS NOT NULL AND l.organization_id=i.organization_id AND i.workspace_id IS NOT NULL AND l.workspace_id<>i.workspace_id)
      OR (i.workspace_id IS NOT NULL AND l.workspace_id=i.workspace_id AND l.organization_id IS NOT i.organization_id))
    LIMIT 2`)
    .bind(intentId, user.userId, expectedEnvironment, c.apiOrigin, c.spaceId)
    .all<{
      period_id: string;
      transaction_id: number | null;
      parameters: string;
      product_key: string;
    }>();
  if (found.results.length !== 1) return null;
  const row = found.results[0];
  if (
    !/^pfperiod_[a-f0-9]{64}$/.test(row.period_id) ||
    typeof row.parameters !== "string" ||
    new TextEncoder().encode(row.parameters).byteLength > 16_384
  )
    return null;
  try {
    const params: unknown = JSON.parse(row.parameters);
    if (!params || typeof params !== "object" || Array.isArray(params)) return null;
    const p = params as Record<string, unknown>;
    const product = prepaidProduct(row.product_key);
    const provider = c.prepaidProducts?.[row.product_key];
    const method = p.method;
    if (
      !product ||
      !provider ||
      !["twint", "postfinance_pay"].includes(String(method)) ||
      p.productKey !== product.productKey ||
      p.returnOrigin !== c.returnOrigin ||
      p.catalogVersion !== product.catalogVersion ||
      p.priceChfMinor !== product.priceChfMinor ||
      p.methodConfigurationId !== provider.methodConfigurations[method as SwissMethod] ||
      p.connectorConfigurationId !== configuration.connectorConfigurations[method as SwissMethod] ||
      (method === "twint" ? c.twintUserOnFileEnabled : c.postfinancePayTokenEnabled) !== true
    )
      return null;
    return { period_id: row.period_id, transaction_id: row.transaction_id };
  } catch {
    return null;
  }
}
/** Owner-only discovery. Expired access does not prevent paying; revoked roles
 * and deleted accounts do. No default company is chosen from a partial list. */
export async function ownedPostFinanceTargets(
  db: Pick<D1Database, "prepare">,
  userId: string,
  complete = false,
): Promise<PostFinanceTargets> {
  const deleted = await db
    .prepare("SELECT 1 FROM account_session_policy WHERE user_id=? AND deleted_at IS NOT NULL")
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
    throw Error("Too many payment targets.");
  return { organizations: companies.results, workspaces: workspaces.results };
}
