import { database } from '@/lib/runtime';
import { prepaidMonthlyPeriod } from './prepaid-calendar';
import {
  prepaidProduct,
  type PrepaidProduct,
  type PrepaidProductKind,
} from './prepaid-catalog';

export type PrepaidAccess = Readonly<{
  contractId: string;
  ownerId: string;
  organizationId: string | null;
  workspaceId: string | null;
  productKind: PrepaidProductKind;
  catalog: PrepaidProduct;
  periodId: string;
  paidFrom: number;
  paidUntil: number;
  cancelAtPeriodEnd: boolean;
  customerName: string;
}>;

type AccessRow = {
  contract_id: string;
  owner_id: string;
  organization_id: string | null;
  workspace_id: string | null;
  api_origin: string;
  space_id: number;
  environment: string;
  product_key: string;
  contract_catalog_version: string;
  contract_catalog_json: string;
  contract_json_unique: number;
  anchor_start: number;
  cancelled_at: number | null;
  contract_created_at: number;
  period_id: string;
  ordinal: number;
  starts_at: number;
  ends_at: number;
  currency: string;
  price_chf_minor: number;
  period_catalog_version: string;
  period_catalog_json: string;
  period_json_unique: number;
  transaction_id: number;
  invoice_id: number;
  evidence_fingerprint: string;
  reconciled_at: number;
  actual_organization_id: string | null;
  actual_org_owner_id: string | null;
  actual_owner_membership_id: string | null;
  actual_subscription_id: string | null;
  actual_org_name: string | null;
  actual_workspace_id: string | null;
  actual_workspace_owner_id: string | null;
  actual_workspace_name: string | null;
  linked_workspace_id: string | null;
  linked_workspace_owner_id: string | null;
  linked_workspace_name: string | null;
};

export function isPrepaidContractId(value: unknown): boolean {
  // Reserve the whole namespace for dispatch. A malformed local ID must not
  // fall through to Stripe or a legacy entitlement reader.
  return typeof value === 'string' && value.startsWith('pfp_');
}

function validContractId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^pfp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 180 &&
    !Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function sameShape(value: unknown, expected: unknown): boolean {
  if (value === expected) return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(value) &&
      value.length === expected.length &&
      expected.every((item, index) => sameShape(value[index], item))
    );
  }
  if (expected !== null && typeof expected === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return false;
    const actual = value as Record<string, unknown>;
    const definition = expected as Record<string, unknown>;
    const keys = Object.keys(definition);
    return (
      Object.keys(actual).length === keys.length &&
      keys.every(
        (key) =>
          Object.hasOwn(actual, key) && sameShape(actual[key], definition[key]),
      )
    );
  }
  return false;
}

/** Reads the stored snapshot, not any mutable legacy plan/seat projection.
 * Unknown catalogue versions fail closed; retain approved historic definitions
 * here when a new catalogue version is introduced.
 */
function snapshot(row: AccessRow): PrepaidProduct | null {
  const expected = prepaidProduct(row.product_key);
  if (
    !expected ||
    row.contract_json_unique !== 1 ||
    row.period_json_unique !== 1 ||
    row.contract_catalog_version !== expected.catalogVersion ||
    row.period_catalog_version !== expected.catalogVersion ||
    row.currency !== 'CHF' ||
    row.price_chf_minor !== expected.priceChfMinor
  )
    return null;
  const encoder = new TextEncoder();
  if (
    typeof row.contract_catalog_json !== 'string' ||
    typeof row.period_catalog_json !== 'string' ||
    encoder.encode(row.contract_catalog_json).length > 8192 ||
    encoder.encode(row.period_catalog_json).length > 8192
  )
    return null;
  try {
    const catalog = JSON.parse(row.period_catalog_json) as unknown;
    if (
      !sameShape(catalog, expected) ||
      !sameShape(JSON.parse(row.contract_catalog_json), catalog)
    )
      return null;
    const result = catalog as PrepaidProduct;
    Object.freeze(result.includedProducts);
    if (result.gestion) Object.freeze(result.gestion);
    if (result.support) Object.freeze(result.support);
    return Object.freeze(result);
  } catch {
    return null;
  }
}

const SELECT_PAID = `SELECT c.contract_id,c.owner_id,c.organization_id,c.workspace_id,c.api_origin,c.space_id,c.environment,c.product_key,
  c.catalog_version AS contract_catalog_version,c.catalog_json AS contract_catalog_json,c.anchor_start,c.cancelled_at,c.created_at AS contract_created_at,
  CASE WHEN json_valid(c.catalog_json) AND length(CAST(c.catalog_json AS BLOB))<=8192
    THEN NOT EXISTS(SELECT 1 FROM json_tree(c.catalog_json) GROUP BY parent,key HAVING COUNT(*)>1) ELSE 0 END AS contract_json_unique,
  p.period_id,p.ordinal,p.starts_at,p.ends_at,p.currency,p.price_chf_minor,p.catalog_version AS period_catalog_version,p.catalog_json AS period_catalog_json,
  CASE WHEN json_valid(p.catalog_json) AND length(CAST(p.catalog_json AS BLOB))<=8192
    THEN NOT EXISTS(SELECT 1 FROM json_tree(p.catalog_json) GROUP BY parent,key HAVING COUNT(*)>1) ELSE 0 END AS period_json_unique,
  t.transaction_id,s.invoice_id,s.evidence_fingerprint,s.reconciled_at,
  o.organization_id AS actual_organization_id,o.created_by_user_id AS actual_org_owner_id,own.membership_id AS actual_owner_membership_id,o.subscription_id AS actual_subscription_id,o.name AS actual_org_name,
  w.id AS actual_workspace_id,w.owner_id AS actual_workspace_owner_id,w.name AS actual_workspace_name,
  lw.id AS linked_workspace_id,lw.owner_id AS linked_workspace_owner_id,lw.name AS linked_workspace_name
  FROM prepaid_contracts c JOIN prepaid_periods p ON p.contract_id=c.contract_id
  JOIN prepaid_transactions t ON t.period_id=p.period_id AND t.api_origin=c.api_origin AND t.space_id=c.space_id
  JOIN prepaid_settlement_proofs s ON s.period_id=p.period_id
  LEFT JOIN organizations o ON o.organization_id=c.organization_id
  LEFT JOIN organization_members own ON own.organization_id=o.organization_id AND own.user_id=c.owner_id AND own.role='owner' AND own.revoked_at IS NULL
  LEFT JOIN support_workspaces w ON w.id=c.workspace_id
  LEFT JOIN support_gestion_links l ON l.organization_id=o.organization_id
  LEFT JOIN support_workspaces lw ON lw.id=l.workspace_id
  WHERE c.environment='PRODUCTION' AND p.starts_at<=? AND p.ends_at>?
  AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id)`;

async function candidates(
  condition: string,
  ...identities: string[]
): Promise<AccessRow[]> {
  const now = Math.floor(Date.now() / 1000);
  const result = await database()
    .prepare(`${SELECT_PAID} AND (${condition})`)
    .bind(now, now, ...identities)
    .all<AccessRow>();
  return result.results;
}

function access(row: AccessRow, linkedWorkspace = false): PrepaidAccess | null {
  const now = Math.floor(Date.now() / 1000);
  if (
    !validContractId(row.contract_id) ||
    !validIdentity(row.owner_id) ||
    !positiveInteger(row.anchor_start) ||
    !positiveInteger(row.contract_created_at) ||
    row.contract_created_at > now ||
    !positiveInteger(row.transaction_id) ||
    !positiveInteger(row.invoice_id) ||
    !positiveInteger(row.space_id) ||
    !positiveInteger(row.reconciled_at) ||
    row.reconciled_at > now ||
    !/^[0-9a-f]{64}$/.test(row.evidence_fingerprint) ||
    !['https://checkout.postfinance.ch', 'https://app-wallee.com'].includes(
      row.api_origin,
    ) ||
    row.environment !== 'PRODUCTION'
  )
    return null;
  if (
    row.cancelled_at !== null &&
    (!positiveInteger(row.cancelled_at) ||
      row.cancelled_at < row.contract_created_at ||
      row.cancelled_at > now)
  )
    return null;
  if (
    !validIdentity(row.period_id) ||
    !positiveInteger(row.starts_at) ||
    !positiveInteger(row.ends_at) ||
    row.starts_at > now ||
    row.ends_at <= now
  )
    return null;
  try {
    const dates = prepaidMonthlyPeriod(row.anchor_start, row.ordinal);
    if (
      dates.startSeconds !== row.starts_at ||
      dates.endSeconds !== row.ends_at
    )
      return null;
  } catch {
    return null;
  }
  const catalog = snapshot(row);
  if (!catalog) return null;
  if (
    row.organization_id !== null &&
    (!validIdentity(row.organization_id) ||
      row.actual_organization_id !== row.organization_id ||
      row.actual_org_owner_id !== row.owner_id ||
      !row.actual_owner_membership_id)
  )
    return null;
  if (
    row.workspace_id !== null &&
    (!validIdentity(row.workspace_id) ||
      row.actual_workspace_id !== row.workspace_id ||
      row.actual_workspace_owner_id !== row.owner_id)
  )
    return null;
  if (catalog.productKind === 'gestion' || catalog.productKind === 'complete') {
    if (!row.organization_id || row.actual_subscription_id !== row.contract_id)
      return null;
  } else if (catalog.productKind === 'support') {
    if (!row.workspace_id) return null;
  } else if (!row.organization_id) return null;
  if (
    linkedWorkspace &&
    (!row.linked_workspace_id ||
      row.linked_workspace_owner_id !== row.owner_id ||
      (row.workspace_id !== null &&
        row.workspace_id !== row.linked_workspace_id))
  )
    return null;
  return Object.freeze({
    contractId: row.contract_id,
    ownerId: row.owner_id,
    organizationId: row.organization_id,
    workspaceId: linkedWorkspace ? row.linked_workspace_id : row.workspace_id,
    productKind: catalog.productKind,
    catalog,
    periodId: row.period_id,
    paidFrom: row.starts_at,
    paidUntil: row.ends_at,
    cancelAtPeriodEnd: row.cancelled_at !== null,
    customerName:
      row.actual_org_name ??
      (linkedWorkspace
        ? row.linked_workspace_name
        : row.actual_workspace_name) ??
      '',
  });
}

function only(values: (PrepaidAccess | null)[]): PrepaidAccess | null {
  const eligible = values.filter(
    (value): value is PrepaidAccess => value !== null,
  );
  // No ORDER BY/LIMIT winner when paid periods or product contracts conflict.
  return eligible.length === 1 ? eligible[0] : null;
}

function companyCandidates(rows: AccessRow[]): AccessRow[] {
  return rows.filter(
    (row) =>
      row.actual_org_owner_id === row.owner_id &&
      ['gestion', 'complete'].includes(
        prepaidProduct(row.product_key)?.productKind ?? '',
      ),
  );
}

function uniqueCompanyCoverage(row: AccessRow, rows: AccessRow[]): boolean {
  return (
    companyCandidates(rows).filter(
      (candidate) => candidate.organization_id === row.organization_id,
    ).length === 1
  );
}

/** These read-only APIs trust an already-recorded reconciliation proof. They do
 * not call or verify the merchant directly; the future reconciler must do that.
 * Authentication and current user membership remain the consumer's obligation.
 */
export async function prepaidCompanyAccess(
  organizationId: string,
): Promise<PrepaidAccess | null> {
  if (!validIdentity(organizationId)) return null;
  const rows = await candidates('c.organization_id=?', organizationId);
  const companyRows = companyCandidates(rows);
  // A stale organization projection must not conceal two paid contracts for
  // the same owner/company. Reconciliation must resolve that conflict first.
  // Raw current proofs must also be unambiguous: a second malformed period
  // cannot disappear during validation and expose another paid winner.
  if (companyRows.length !== 1) return null;
  return only(companyRows.map((row) => access(row)));
}

export async function prepaidSupportAccess(
  workspaceId: string,
): Promise<PrepaidAccess | null> {
  if (!validIdentity(workspaceId)) return null;
  const rows = await candidates(
    'c.workspace_id=? OR lw.id=?',
    workspaceId,
    workspaceId,
  );
  const supportRows = rows.filter((row) => {
    const kind = prepaidProduct(row.product_key)?.productKind;
    return (
      (kind === 'support' &&
        row.workspace_id === workspaceId &&
        row.actual_workspace_owner_id === row.owner_id) ||
      (kind === 'complete' &&
        row.linked_workspace_id === workspaceId &&
        row.linked_workspace_owner_id === row.owner_id &&
        row.actual_org_owner_id === row.owner_id)
    );
  });
  if (supportRows.length !== 1) return null;
  const row = supportRows[0];
  if (prepaidProduct(row.product_key)?.productKind === 'complete')
    return uniqueCompanyCoverage(row, rows) ? access(row, true) : null;
  return access(row);
}

/** An Automation add-on alone does not establish active Gestion access.
 * The consumer must also require that company's current Gestion entitlement.
 */
export async function prepaidAutomationAccess(
  organizationId: string,
): Promise<PrepaidAccess | null> {
  if (!validIdentity(organizationId)) return null;
  const rows = await candidates('c.organization_id=?', organizationId);
  const automationRows = rows.filter(
    (row) =>
      row.actual_org_owner_id === row.owner_id &&
      ['automation', 'complete'].includes(
        prepaidProduct(row.product_key)?.productKind ?? '',
      ),
  );
  if (automationRows.length !== 1) return null;
  const row = automationRows[0];
  if (
    prepaidProduct(row.product_key)?.productKind === 'complete' &&
    !uniqueCompanyCoverage(row, rows)
  )
    return null;
  return access(row);
}

export async function prepaidSubscriptionAccess(
  contractId: string,
): Promise<PrepaidAccess | null> {
  if (!validContractId(contractId)) return null;
  const selected = only(
    (await candidates('c.contract_id=?', contractId)).map((row) => access(row)),
  );
  if (!selected) return null;
  const scoped =
    selected.productKind === 'support'
      ? await prepaidSupportAccess(selected.workspaceId!)
      : selected.productKind === 'automation'
        ? await prepaidAutomationAccess(selected.organizationId!)
        : await prepaidCompanyAccess(selected.organizationId!);
  return scoped?.contractId === contractId ? scoped : null;
}
