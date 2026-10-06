import { database } from '@/lib/runtime';
import { automationEntitlement } from '@/lib/automation/entitlement';
import { prepaidSubscriptionAccess, prepaidSupportAccess, type PrepaidAccess } from './prepaid-access';
import { prepaidMonthlyPeriod } from './prepaid-calendar';
import { prepaidProduct } from './prepaid-catalog';
import { validPrepaidReceiptId, type PrepaidReceipt } from './prepaid-receipt-types';

type Database = Pick<D1Database, 'prepare'>;
type User = { userId: string; emailConfirmed: boolean };
type Row = {
  intent_id: string; owner_id: string; environment: 'TEST' | 'PRODUCTION';
  product: string; plan_id: string; state: string; created_at: number; parameters: string;
  provider_scope: string; organization_id: string | null; workspace_id: string | null;
  organization_name: string | null; workspace_name: string | null;
  contract_id: string | null; contract_owner_id: string | null;
  contract_organization_id: string | null; contract_workspace_id: string | null;
  contract_environment: string | null; product_key: string | null; api_origin: string | null;
  space_id: number | null; catalog_json: string | null; catalog_version: string | null;
  target_intent_id: string | null; target_contract_id: string | null; target_owner_id: string | null;
  target_organization_id: string | null; target_workspace_id: string | null;
  projection_contract_id: string | null; projection_owner_id: string | null; intent_evidence: string | null;
  projection_organization_id: string | null; projection_workspace_id: string | null;
  closed_at: number | null; projection_evidence: string | null; open_footprints: number;
  period_id: string | null; starts_at: number | null; ends_at: number | null;
  period_currency: string | null; period_price: number | null; period_catalog: string | null;
  period_catalog_version: string | null; transaction_id: number | null;
  invoice_id: number | null; evidence_fingerprint: string | null; reconciled_at: number | null;
  revoked: number; cancelled_at: number | null; anchor_start: number | null; catalog_unique: number; period_catalog_unique: number;
};

// Frozen initial purchase + first period. Later renewals cannot rewrite this
// receipt's amount, company or purchased dates. Account and ownership checks
// deliberately do not require paid seats, or an enabled merchant credential.
export const OWNED_PREPAID_RECEIPT_SQL = `SELECT i.intent_id,i.owner_id,i.environment,i.product,i.plan_id,i.state,i.created_at,i.parameters,i.provider_scope,i.organization_id,i.workspace_id,i.evidence_fingerprint AS intent_evidence,
  o.name AS organization_name,w.name AS workspace_name,
  c.contract_id,c.owner_id AS contract_owner_id,c.organization_id AS contract_organization_id,c.workspace_id AS contract_workspace_id,c.environment AS contract_environment,c.product_key,c.api_origin,c.space_id,c.catalog_json,c.catalog_version,c.cancelled_at,c.anchor_start,
  CASE WHEN json_valid(c.catalog_json) AND length(CAST(c.catalog_json AS BLOB))<=8192 THEN NOT EXISTS(SELECT 1 FROM json_tree(c.catalog_json) GROUP BY parent,key HAVING COUNT(*)>1) ELSE 0 END AS catalog_unique,
  CASE WHEN json_valid(p.catalog_json) AND length(CAST(p.catalog_json AS BLOB))<=8192 THEN NOT EXISTS(SELECT 1 FROM json_tree(p.catalog_json) GROUP BY parent,key HAVING COUNT(*)>1) ELSE 0 END AS period_catalog_unique,
  x.intent_id AS target_intent_id,x.contract_id AS target_contract_id,x.owner_id AS target_owner_id,x.organization_id AS target_organization_id,x.workspace_id AS target_workspace_id,
  a.contract_id AS projection_contract_id,a.owner_id AS projection_owner_id,a.organization_id AS projection_organization_id,a.workspace_id AS projection_workspace_id,a.closed_at,a.evidence_fingerprint AS projection_evidence,
  (SELECT COUNT(*) FROM purchase_intent_footprints f WHERE f.intent_id=i.intent_id AND f.released_at IS NULL) AS open_footprints,
  p.period_id,p.starts_at,p.ends_at,p.currency AS period_currency,p.price_chf_minor AS period_price,p.catalog_json AS period_catalog,p.catalog_version AS period_catalog_version,
  t.transaction_id,s.invoice_id,s.evidence_fingerprint,s.reconciled_at,
  EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id) AS revoked
  FROM purchase_intents i
  LEFT JOIN organizations o ON o.organization_id=i.organization_id
  LEFT JOIN support_workspaces w ON w.id=i.workspace_id
  LEFT JOIN prepaid_contracts c ON c.contract_id=('pfp_'||substr(i.intent_id,10))
  LEFT JOIN prepaid_purchase_targets x ON x.intent_id=i.intent_id
  LEFT JOIN prepaid_periods p ON p.contract_id=c.contract_id AND p.ordinal=0
  LEFT JOIN prepaid_purchase_projections a ON a.intent_id=i.intent_id AND a.period_id=p.period_id
  LEFT JOIN prepaid_transactions t ON t.period_id=p.period_id AND t.api_origin=c.api_origin AND t.space_id=c.space_id
  LEFT JOIN prepaid_settlement_proofs s ON s.period_id=t.period_id
  WHERE i.intent_id=? AND i.owner_id=? AND i.provider='postfinance'
  AND NOT EXISTS(SELECT 1 FROM account_session_policy deleted WHERE deleted.user_id=i.owner_id AND deleted.deleted_at IS NOT NULL)
  AND (i.organization_id IS NULL OR (o.created_by_user_id=i.owner_id AND EXISTS(
    SELECT 1 FROM organization_members m WHERE m.organization_id=o.organization_id AND m.user_id=i.owner_id AND m.role='owner' AND m.revoked_at IS NULL)))
  AND (i.workspace_id IS NULL OR w.owner_id=i.owner_id)
  AND NOT EXISTS(SELECT 1 FROM support_gestion_links l WHERE
    (i.organization_id IS NOT NULL AND l.organization_id=i.organization_id AND i.workspace_id IS NOT NULL AND l.workspace_id<>i.workspace_id)
    OR (i.workspace_id IS NOT NULL AND l.workspace_id=i.workspace_id AND l.organization_id IS NOT i.organization_id))`;

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const sameCatalog = (raw: string | null, expected: unknown) => {
  if (!raw || new TextEncoder().encode(raw).byteLength > 8192) return false;
  try {
    const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)])) : value;
    return JSON.stringify(normalize(JSON.parse(raw))) === JSON.stringify(normalize(expected));
  } catch { return false; }
};

/** SELECT-only receipt reader. An HTTP return, cached projection, expired
 * reservation or payment-provider redirect can never activate an entitlement. */
export async function ownedPrepaidReceipt(user: User, intentId: unknown, dependencies: {
  database?: () => Database;
  access?: (contractId: string) => Promise<PrepaidAccess | null>;
  support?: (workspaceId: string) => Promise<PrepaidAccess | null>;
  automation?: (organizationId: string, ownerId: string) => Promise<boolean>;
  now?: () => number;
} = {}): Promise<PrepaidReceipt | null> {
  if (!user.userId || !user.emailConfirmed || !validPrepaidReceiptId(intentId)) return null;
  const row = await (dependencies.database ?? database)().prepare(OWNED_PREPAID_RECEIPT_SQL)
    .bind(intentId, user.userId).first<Row>();
  if (!row || row.owner_id !== user.userId || !['TEST', 'PRODUCTION'].includes(row.environment)) return null;
  let params: Record<string, unknown>;
  try {
    if (new TextEncoder().encode(row.parameters).byteLength > 16384) return null;
    const parsed: unknown = JSON.parse(row.parameters);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    params = parsed as Record<string, unknown>;
  } catch { return null; }
  const product = prepaidProduct(params.productKey);
  const method = params.method;
  if (!product || product.productKind !== row.product || product.planId !== row.plan_id ||
    params.priceChfMinor !== product.priceChfMinor || params.catalogVersion !== product.catalogVersion ||
    typeof method !== 'string' || !['twint', 'postfinance_pay'].includes(method) ||
    (product.productKind !== 'support' && !row.organization_id) ||
    (!!product.support !== !!row.workspace_id) ||
    (row.contract_id !== null && (row.contract_id !== `pfp_${intentId.slice(9)}` ||
      row.contract_owner_id !== row.owner_id || row.contract_environment !== row.environment ||
      row.contract_organization_id !== row.organization_id || row.contract_workspace_id !== row.workspace_id ||
      !positive(row.space_id) || !['https://checkout.postfinance.ch', 'https://app-wallee.com'].includes(row.api_origin ?? '') ||
      row.provider_scope !== `${row.api_origin}|${row.space_id}` || product.productKey !== row.product_key ||
      row.catalog_unique !== 1 || row.catalog_version !== product.catalogVersion || !sameCatalog(row.catalog_json, product)))) return null;
  const now = (dependencies.now ?? (() => Math.floor(Date.now() / 1000)))();
  if (!positive(now) || !positive(row.created_at) || row.created_at > now) return null;
  let calendarValid = false;
  if (positive(row.anchor_start)) {
    try {
      const period = prepaidMonthlyPeriod(row.anchor_start, 0);
      calendarValid = period.startSeconds === row.starts_at && period.endSeconds === row.ends_at;
    } catch { return null; }
  }
  const periodValid = calendarValid && row.period_catalog_unique === 1 && positive(row.starts_at) && positive(row.ends_at) && row.ends_at > row.starts_at &&
    row.period_currency === 'CHF' && row.period_price === product.priceChfMinor &&
    row.period_catalog_version === product.catalogVersion && sameCatalog(row.period_catalog, product);
  const paid = periodValid && positive(row.transaction_id) && positive(row.invoice_id) &&
    positive(row.reconciled_at) && row.reconciled_at <= now && /^[0-9a-f]{64}$/.test(row.evidence_fingerprint ?? '');
  const targetMatches = row.target_intent_id === intentId && row.target_contract_id === row.contract_id &&
    row.target_owner_id === row.owner_id && row.target_organization_id === row.organization_id &&
    row.target_workspace_id === row.workspace_id;
  if ((row.target_intent_id !== null && !targetMatches) ||
    (row.projection_contract_id !== null && (row.projection_contract_id !== row.contract_id ||
      row.projection_owner_id !== row.owner_id || row.projection_organization_id !== row.organization_id ||
      row.projection_workspace_id !== row.workspace_id || row.projection_evidence !== row.evidence_fingerprint))) return null;
  const closed = paid && targetMatches && row.state === 'settled' && positive(row.closed_at) && row.closed_at <= now &&
    row.open_footprints === 0 && row.projection_contract_id === row.contract_id &&
    row.projection_owner_id === row.owner_id && row.projection_organization_id === row.organization_id &&
    row.projection_workspace_id === row.workspace_id && row.projection_evidence === row.evidence_fingerprint &&
    row.intent_evidence === row.evidence_fingerprint;
  // Read genuine current coverage separately: this may be a renewed period.
  const access = closed && row.environment === 'PRODUCTION' && row.contract_id
    ? await (dependencies.access ?? prepaidSubscriptionAccess)(row.contract_id) : null;
  let active = !!access && access.ownerId === row.owner_id && access.contractId === row.contract_id &&
    access.organizationId === row.organization_id && access.workspaceId === row.workspace_id && access.paidFrom <= now && access.paidUntil > now;
  if (active && product.productKind === 'automation') active = await (dependencies.automation ??
    ((organizationId, ownerId) => automationEntitlement({ organizationId, userId: ownerId, role: 'owner', founder: false })))(row.organization_id!, row.owner_id);
  if (active && product.productKind === 'complete') {
    const support = await (dependencies.support ?? prepaidSupportAccess)(row.workspace_id!);
    const automation = await (dependencies.automation ?? ((organizationId, ownerId) => automationEntitlement({ organizationId, userId: ownerId, role: 'owner', founder: false })))(row.organization_id!, row.owner_id);
    active = !!support && support.contractId === row.contract_id && support.ownerId === row.owner_id &&
      support.organizationId === row.organization_id && support.workspaceId === row.workspace_id &&
      support.paidFrom <= now && support.paidUntil > now && automation;
  }
  const stopped = ['canceled', 'expired', 'released'].includes(row.state);
  const status: PrepaidReceipt['status'] = row.revoked ? 'refunded'
    : paid && row.environment === 'TEST' ? 'test_confirmed'
      : active ? 'active'
        : closed ? (row.ends_at! <= now ? 'ended' : 'verification_required')
          : paid ? (targetMatches ? 'activation_pending' : 'verification_required')
            : stopped ? 'not_completed'
              : row.state === 'uncertain' || row.state === 'settled' ? 'verification_required' : 'pending';
  const cancelled = positive(row.cancelled_at) && row.cancelled_at <= now;
  return {
    intentId, environment: row.environment, name: product.name, priceChfMinor: product.priceChfMinor,
    method: method as PrepaidReceipt['method'],
    organization: row.organization_id ? { id: row.organization_id, name: row.organization_name ?? '' } : null,
    workspace: row.workspace_id ? { id: row.workspace_id, name: row.workspace_name ?? '' } : null,
    status, purchasedPeriod: periodValid ? { from: row.starts_at!, until: row.ends_at! } : null,
    paidUntil: status === 'active' ? access!.paidUntil : null, cancelAtPeriodEnd: cancelled,
    canCancel: closed && row.environment === 'PRODUCTION' && !cancelled, contractId: closed && row.environment === 'PRODUCTION' ? row.contract_id : null,
    subscriptionHref: row.organization_id ? `/compte/abonnement?organizationId=${encodeURIComponent(row.organization_id)}` : `/support/espace?section=subscription&workspace=${encodeURIComponent(row.workspace_id!)}`,
    poll: ['pending', 'activation_pending', 'verification_required'].includes(status),
  };
}
