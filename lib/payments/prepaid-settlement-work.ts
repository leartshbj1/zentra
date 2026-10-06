import type { WebhookWork } from '@/lib/payments/postfinance-store';
import type { ReconciliationTarget } from '@/lib/payments/prepaid-reconciliation-store';
import { prepaidProduct } from '@/lib/payments/prepaid-catalog';
import { prepaidMonthlyPeriod } from '@/lib/payments/prepaid-calendar';

export type SettlementWorkContext = Readonly<{
  apiOrigin: string;
  spaceId: number;
  environment: 'TEST' | 'PRODUCTION';
  ownerId: string;
  organizationId: string | null;
  workspaceId: string | null;
  periodId: string;
  transactionId: number;
  contractId?: string;
  startsAt?: number;
  endsAt?: number;
  currency?: 'CHF';
  priceChfMinor?: number;
  catalogVersion?: string;
}>;
export type ObservationBinding = Readonly<{
  anchorStart: number;
  apiOrigin: string;
  catalogJson: string;
  catalogVersion: string;
  contractFingerprint: string;
  contractId: string;
  currency: 'CHF';
  customerReference: string;
  endsAt: number;
  environment: 'TEST' | 'PRODUCTION';
  expectationFingerprint: string;
  intentFingerprint: string;
  intentId: string;
  ordinal: number;
  organizationId: string | null;
  ownerId: string;
  paymentMethodConfigurationId: number;
  connectorConfigurationId: number;
  periodId: string;
  planReference: string;
  previousSubscriptionId: string | null;
  priceChfMinor: number;
  spaceId: number;
  startsAt: number;
  transactionId: number;
  workspaceId: string | null;
}>;
export type ObservationWork = Readonly<{
  kind: 'observation';
  jobId: string;
  scopeHash: string;
  bindingFingerprint: string;
  provenance: 'create_recovery' | 'bound_fallback';
  binding: ObservationBinding;
  lease: string;
  leaseUntil: number;
  attempts: number;
}>;
/** Existing webhook identities remain unmodified. Observations carry no event,
 * listener, timestamp or signature allegedly received from the provider. */
export type SettlementWork = WebhookWork | ObservationWork;
export type SettlementWorkFence = Readonly<{
  sql: string;
  values: readonly (string | number | null)[];
}>;
export class SettlementWorkError extends Error {
  constructor(public readonly code: 'invalid' | 'binding' | 'lost') {
    super(`Settlement work ${code}.`);
  }
}
export const isObservationWork = (
  work: SettlementWork,
): work is ObservationWork => 'kind' in work && work.kind === 'observation';
export function canonicalSettlementValue(value: unknown): string {
  const normalized = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(normalized)
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, child]) => [key, normalized(child)]),
          )
        : item;
  return JSON.stringify(normalized(value));
}
export async function settlementDigest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 180 &&
  Array.from(value).every(
    (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
  );
const origins = new Set([
  'https://checkout.postfinance.ch',
  'https://app-wallee.com',
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const bindingKeys = [
  'anchorStart',
  'apiOrigin',
  'catalogJson',
  'catalogVersion',
  'connectorConfigurationId',
  'contractFingerprint',
  'contractId',
  'currency',
  'customerReference',
  'endsAt',
  'environment',
  'expectationFingerprint',
  'intentFingerprint',
  'intentId',
  'ordinal',
  'organizationId',
  'ownerId',
  'paymentMethodConfigurationId',
  'periodId',
  'planReference',
  'previousSubscriptionId',
  'priceChfMinor',
  'spaceId',
  'startsAt',
  'transactionId',
  'workspaceId',
];

export async function validateObservationBinding(
  binding: ObservationBinding,
): Promise<void> {
  if (
    !binding ||
    canonicalSettlementValue(Object.keys(binding).sort()) !==
      canonicalSettlementValue(bindingKeys) ||
    !origins.has(binding.apiOrigin) ||
    !positive(binding.spaceId) ||
    !positive(binding.transactionId) ||
    !['TEST', 'PRODUCTION'].includes(binding.environment) ||
    !identity(binding.ownerId) ||
    (binding.organizationId !== null && !identity(binding.organizationId)) ||
    (binding.workspaceId !== null && !identity(binding.workspaceId)) ||
    !/^purchase_[a-f0-9-]{36}$/.test(binding.intentId) ||
    !uuid.test(binding.intentId.slice(9)) ||
    binding.contractId !== 'pfp_' + binding.intentId.slice(9) ||
    binding.periodId !== (await contextPeriodId(binding)) ||
    !hash(binding.contractFingerprint) ||
    !hash(binding.intentFingerprint) ||
    !hash(binding.expectationFingerprint) ||
    !positive(binding.anchorStart) ||
    !Number.isSafeInteger(binding.ordinal) ||
    binding.ordinal < 0 ||
    !positive(binding.startsAt) ||
    !positive(binding.endsAt) ||
    !positive(binding.priceChfMinor) ||
    binding.currency !== 'CHF' ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(binding.customerReference) ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(binding.planReference) ||
    !positive(binding.paymentMethodConfigurationId) ||
    !positive(binding.connectorConfigurationId) ||
    (binding.previousSubscriptionId !== null &&
      !identity(binding.previousSubscriptionId)) ||
    typeof binding.catalogJson !== 'string' ||
    new TextEncoder().encode(binding.catalogJson).byteLength > 8192
  )
    throw new SettlementWorkError('binding');
  let catalog: unknown;
  try {
    catalog = JSON.parse(binding.catalogJson);
  } catch {
    throw new SettlementWorkError('binding');
  }
  const product = prepaidProduct(
    catalog && typeof catalog === 'object'
      ? (catalog as Record<string, unknown>).productKey
      : null,
  );
  let dates: ReturnType<typeof prepaidMonthlyPeriod>;
  try {
    dates = prepaidMonthlyPeriod(binding.anchorStart, binding.ordinal);
  } catch {
    throw new SettlementWorkError('binding');
  }
  const periodId = await contextPeriodId(binding);
  if (
    !product ||
    binding.catalogJson !== JSON.stringify(product) ||
    binding.catalogVersion !== product.catalogVersion ||
    binding.planReference !== product.catalogVersion ||
    binding.priceChfMinor !== product.priceChfMinor ||
    binding.startsAt !== dates.startSeconds ||
    binding.endsAt !== dates.endSeconds ||
    (product.productKind !== 'support' && binding.organizationId === null) ||
    !!product.support !== !!binding.workspaceId ||
    binding.customerReference !==
      'pfpayer_' + (await settlementDigest(binding.ownerId)) ||
    binding.contractFingerprint !==
      (await settlementDigest(
        JSON.stringify([
          binding.ownerId,
          binding.organizationId,
          binding.workspaceId,
          binding.apiOrigin,
          binding.spaceId,
          binding.environment,
          product.productKey,
          binding.catalogJson,
        ]),
      )) ||
    binding.expectationFingerprint !==
      (await settlementDigest(
        JSON.stringify([
          periodId,
          binding.customerReference,
          binding.planReference,
          binding.paymentMethodConfigurationId,
          binding.connectorConfigurationId,
        ]),
      ))
  )
    throw new SettlementWorkError('binding');
}
export const contextPeriodId = async (
  binding: Pick<ObservationBinding, 'contractId' | 'ordinal'>,
) =>
  'pfperiod_' +
  (await settlementDigest(`${binding.contractId}|${binding.ordinal}`));

export async function assertObservationTarget(
  work: ObservationWork,
  target: ReconciliationTarget,
): Promise<void> {
  await validateObservationBinding(work.binding);
  const b = work.binding,
    p = target.period;
  if (
    b.apiOrigin !== target.apiOrigin ||
    b.spaceId !== target.spaceId ||
    b.environment !== target.environment ||
    b.ownerId !== target.ownerId ||
    b.organizationId !== target.organizationId ||
    b.workspaceId !== target.workspaceId ||
    b.transactionId !== target.transactionId ||
    p.periodId !== (await contextPeriodId(b)) ||
    p.contractId !== b.contractId ||
    p.ordinal !== b.ordinal ||
    p.startsAt !== b.startsAt ||
    p.endsAt !== b.endsAt ||
    p.currency !== b.currency ||
    p.priceChfMinor !== b.priceChfMinor ||
    p.catalogVersion !== b.catalogVersion ||
    JSON.stringify(p.catalog) !== b.catalogJson ||
    target.customerReference !== b.customerReference ||
    target.planReference !== b.planReference ||
    target.paymentMethodConfigurationId !== b.paymentMethodConfigurationId ||
    target.connectorConfigurationId !== b.connectorConfigurationId
  )
    throw new SettlementWorkError('binding');
}

export async function settlementWorkFence(
  work: SettlementWork,
  context: SettlementWorkContext,
  at: number,
  mode: 'positive' | 'negative' = 'positive',
): Promise<SettlementWorkFence> {
  if (
    !positive(at) ||
    !positive(context.spaceId) ||
    !positive(context.transactionId) ||
    !origins.has(context.apiOrigin) ||
    !['TEST', 'PRODUCTION'].includes(context.environment) ||
    !identity(context.ownerId) ||
    !/^pfperiod_[a-f0-9]{64}$/.test(context.periodId) ||
    !hash(work.scopeHash) ||
    !uuid.test(work.lease) ||
    !['positive', 'negative'].includes(mode)
  )
    throw new SettlementWorkError('invalid');
  if (!isObservationWork(work)) {
    if (
      work.event.spaceId !== context.spaceId ||
      work.scopeHash !==
        (await settlementDigest(
          `${context.apiOrigin}|${context.spaceId}|${work.event.webhookListenerId}|${work.event.eventId}`,
        ))
    )
      throw new SettlementWorkError('binding');
    // Preserve the exact legacy lease predicate. Webhook target resolution and
    // its immutable binding checks stay in the existing reconciliation pipeline.
    return {
      sql: "EXISTS(SELECT 1 FROM postfinance_webhook_inbox w WHERE w.scope_hash=? AND w.state='processing' AND w.lease=? AND w.lease_until>?)",
      values: [work.scopeHash, work.lease, at],
    };
  }
  await validateObservationBinding(work.binding);
  const b = work.binding,
    periodId = await contextPeriodId(b),
    raw = canonicalSettlementValue(b);
  const scopeHash = await settlementDigest(
    canonicalSettlementValue([
      b.apiOrigin,
      b.spaceId,
      b.environment,
      periodId,
      b.transactionId,
    ]),
  );
  if (
    work.jobId !== 'pfobserve_' + scopeHash ||
    work.scopeHash !== scopeHash ||
    !hash(work.bindingFingerprint) ||
    work.bindingFingerprint !== (await settlementDigest(raw)) ||
    !['create_recovery', 'bound_fallback'].includes(work.provenance) ||
    !Number.isSafeInteger(work.attempts) ||
    work.attempts < 1 ||
    work.attempts > 8 ||
    !positive(work.leaseUntil) ||
    context.periodId !== periodId ||
    context.apiOrigin !== b.apiOrigin ||
    context.spaceId !== b.spaceId ||
    context.environment !== b.environment ||
    context.ownerId !== b.ownerId ||
    context.organizationId !== b.organizationId ||
    context.workspaceId !== b.workspaceId ||
    context.transactionId !== b.transactionId ||
    (context.contractId !== undefined && context.contractId !== b.contractId) ||
    (context.startsAt !== undefined && context.startsAt !== b.startsAt) ||
    (context.endsAt !== undefined && context.endsAt !== b.endsAt) ||
    (context.currency !== undefined && context.currency !== b.currency) ||
    (context.priceChfMinor !== undefined &&
      context.priceChfMinor !== b.priceChfMinor) ||
    (context.catalogVersion !== undefined &&
      context.catalogVersion !== b.catalogVersion)
  )
    throw new SettlementWorkError('binding');
  return {
    sql: `EXISTS(SELECT 1 FROM postfinance_observation_jobs j JOIN prepaid_observation_sources s ON s.period_id=j.period_id
    WHERE j.job_id=? AND j.scope_hash=? AND j.binding_fingerprint=? AND j.binding_json=? AND s.binding_json=j.binding_json
    AND j.state='processing' AND j.lease=? AND j.lease_until>? AND j.attempts=? AND j.provenance=?${mode === 'positive' ? ' AND s.current_owner=1' : ''})`,
    values: [
      work.jobId,
      work.scopeHash,
      work.bindingFingerprint,
      raw,
      work.lease,
      at,
      work.attempts,
      work.provenance,
    ],
  };
}

/** A replay/read check does not replace the same predicate inside writes. The
 * returned JSON is the actual durable provenance, never a fabricated event. */
export async function assertSettlementWork(
  db: Pick<D1Database, 'prepare'>,
  work: SettlementWork,
  context: SettlementWorkContext,
  at: number,
  mode: 'positive' | 'negative' = 'positive',
): Promise<{ sourceJson: string }> {
  const fence = await settlementWorkFence(work, context, at, mode);
  const observation = isObservationWork(work);
  const row = await db
    .prepare(
      `SELECT ${observation ? 'binding_json' : 'event_json'} AS source_json FROM ${observation ? 'postfinance_observation_jobs' : 'postfinance_webhook_inbox'} WHERE ${observation ? 'job_id' : 'scope_hash'}=? AND ${fence.sql}`,
    )
    .bind(observation ? work.jobId : work.scopeHash, ...fence.values)
    .first<{ source_json: string }>();
  if (
    !row ||
    new TextEncoder().encode(row.source_json).byteLength >
      (observation ? 16384 : 65536)
  )
    throw new SettlementWorkError('lost');
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.source_json);
  } catch {
    throw new SettlementWorkError('binding');
  }
  if (
    canonicalSettlementValue(parsed) !==
    canonicalSettlementValue(observation ? work.binding : work.event)
  )
    throw new SettlementWorkError('binding');
  return { sourceJson: row.source_json };
}
