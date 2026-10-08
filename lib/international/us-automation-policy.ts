import { snapshotPrivateJson } from './private-json';
import { assertUsWorkspaceAutomationAuthority, type UsWorkspaceAutomationAuthority } from './saas-authority';
import type { UsAutomationGrant } from './us-automation-contract';

export class UsAutomationPolicyError extends Error {
  readonly status = 503;
  constructor(readonly code: 'invalid_automation_policy' | 'automation_budget_unavailable') { super(code); this.name = 'UsAutomationPolicyError'; }
}
export interface UsAutomationBudgetPolicy {
  readonly schemaVersion: 1;
  readonly cadence: 'utc_calendar_month';
  readonly budgetPolicyVersion: string;
  readonly processingPolicyVersion: string;
  readonly entries: readonly Readonly<{ catalogVersion: string; priceId: string; limit: number }>[];
}
const fail = (): never => { throw new UsAutomationPolicyError('invalid_automation_policy'); };
const key = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function exact(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) return fail();
  return value;
}
/** Explicit server configuration only. Empty entries keep inference closed;
 * no amount, tier, environment, provider or implicit quota is guessed. */
export function parseUsAutomationBudgetPolicy(input: unknown): UsAutomationBudgetPolicy {
  let captured: unknown;
  try {
    if (typeof input === 'string') {
      if (new TextEncoder().encode(input).byteLength > 65_536) return fail();
      captured = snapshotPrivateJson(JSON.parse(input));
    } else captured = snapshotPrivateJson(input);
  } catch { return fail(); }
  const value = exact(captured, ['schemaVersion','cadence','budgetPolicyVersion','processingPolicyVersion','entries']);
  if (value.schemaVersion !== 1 || value.cadence !== 'utc_calendar_month' || !key(value.budgetPolicyVersion) || !key(value.processingPolicyVersion) || !Array.isArray(value.entries) || value.entries.length > 100) return fail();
  const seen = new Set<string>();
  const entries = value.entries.map(inputEntry => {
    const entry = exact(inputEntry, ['catalogVersion','priceId','limit']);
    if (!key(entry.catalogVersion) || typeof entry.priceId !== 'string' || !/^price_[A-Za-z0-9_]{1,122}$/.test(entry.priceId) || !Number.isSafeInteger(entry.limit) || (entry.limit as number) < 1 || (entry.limit as number) > 1_000_000) return fail();
    const scope = JSON.stringify([entry.catalogVersion,entry.priceId]);
    if (seen.has(scope)) return fail();
    seen.add(scope);
    return Object.freeze({ catalogVersion:entry.catalogVersion, priceId:entry.priceId, limit:entry.limit as number });
  });
  return Object.freeze({ schemaVersion:1, cadence:'utc_calendar_month', budgetPolicyVersion:value.budgetPolicyVersion, processingPolicyVersion:value.processingPolicyVersion, entries:Object.freeze(entries) });
}
/** Informative admission for a durable budget reservation, NOT consumption,
 * consent, payment verification or permission to call a provider. The usage key
 * is org/environment/bucket/month; changing price/plan/proof never resets it. */
export function createUsAutomationGrant(authority: UsWorkspaceAutomationAuthority, input: UsAutomationBudgetPolicy): UsAutomationGrant {
  assertUsWorkspaceAutomationAuthority(authority);
  const policy = parseUsAutomationBudgetPolicy(input);
  const entry = policy.entries.find(value => value.catalogVersion === authority.catalogVersion && value.priceId === authority.priceId);
  if (!entry) throw new UsAutomationPolicyError('automation_budget_unavailable');
  const instant = new Date(authority.checkedAt * 1000), year = instant.getUTCFullYear(), month = instant.getUTCMonth();
  if (!Number.isSafeInteger(authority.checkedAt) || authority.checkedAt < 0 || !Number.isFinite(instant.getTime()) || year < 1 || year > 9999 || year === 9999 && month === 11) return fail();
  // setUTCFullYear avoids Date.UTC's special handling of years 0..99.
  const start = new Date(0); start.setUTCFullYear(year,month,1); start.setUTCHours(0,0,0,0);
  const end = new Date(start); end.setUTCMonth(month + 1);
  return Object.freeze({ schemaVersion:1, organizationId:authority.organizationId, environment:authority.environment, bucket:'supplier_invoice_extract',
    periodId:`${String(year).padStart(4,'0')}-${String(month + 1).padStart(2,'0')}`, periodStart:start.getTime()/1000, periodEnd:end.getTime()/1000,
    limit:entry.limit, subscriptionId:authority.subscriptionId, authorityReference:authority.authorityReference, catalogVersion:authority.catalogVersion, priceId:authority.priceId,
    budgetPolicyVersion:policy.budgetPolicyVersion, processingPolicyVersion:policy.processingPolicyVersion, checkedAt:authority.checkedAt });
}
