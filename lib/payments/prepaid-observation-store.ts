import {
  D1PostFinanceWebhookInbox,
  type WebhookFailure,
  type WebhookListener,
} from '@/lib/payments/postfinance-store';
import type { CheckoutWebhook } from '@/lib/payments/postfinance-client';
import {
  canonicalSettlementValue,
  isObservationWork,
  settlementDigest,
  SettlementWorkError,
  validateObservationBinding,
  type ObservationBinding,
  type ObservationWork,
  type SettlementWork,
} from './prepaid-settlement-work';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
export type ObservationScope = Readonly<{
  apiOrigin: string;
  spaceId: number;
  environment: 'TEST' | 'PRODUCTION';
}>;
export type SettlementQueueConfiguration = Readonly<{
  apiOrigin: string;
  spaceId: number;
  listeners: readonly WebhookListener[];
  observations?: { enabled: true; environment: 'TEST' | 'PRODUCTION' };
}>;
export type ObservationAdmission = Readonly<{
  jobId: string;
  periodId: string;
  transactionId: number;
  state: 'queued' | 'processing' | 'completed' | 'failed';
  attempts: number;
  provenance: 'create_recovery' | 'bound_fallback';
}>;
export type CreateRecoveryAdmission = Readonly<{
  periodId: string;
  transactionId: number;
  recoveryEvidenceFingerprint: string;
}>;
type JobRow = {
  job_id: string;
  scope_hash: string;
  period_id: string;
  transaction_id: number;
  binding_fingerprint: string;
  binding_json: string;
  provenance: 'create_recovery' | 'bound_fallback';
  state: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  lease: string | null;
  lease_until: number;
  recovery_evidence_fingerprint: string | null;
};
const origins = new Set([
  'https://checkout.postfinance.ch',
  'https://app-wallee.com',
]);
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const failureCodes = new Set<WebhookFailure>([
  'provider_unavailable',
  'settlement_pending',
  'ownership_mismatch',
  'ambiguous_period',
  'invalid_provider_state',
  'storage_unavailable',
]);
function clock(v: number) {
  if (!positive(v)) throw new SettlementWorkError('invalid');
  return v;
}
function scope(s: ObservationScope) {
  if (
    !origins.has(s.apiOrigin) ||
    !positive(s.spaceId) ||
    !['TEST', 'PRODUCTION'].includes(s.environment)
  )
    throw new SettlementWorkError('invalid');
}
function duration(v: number) {
  if (!Number.isSafeInteger(v) || v < 5 || v > 900)
    throw new SettlementWorkError('invalid');
}
function recoveryInput(i: CreateRecoveryAdmission) {
  if (
    !/^pfperiod_[a-f0-9]{64}$/.test(i.periodId) ||
    !positive(i.transactionId) ||
    !/^[a-f0-9]{64}$/.test(i.recoveryEvidenceFingerprint)
  )
    throw new SettlementWorkError('invalid');
}
async function decoded(raw: string): Promise<ObservationBinding> {
  if (new TextEncoder().encode(raw).byteLength > 16384)
    throw new SettlementWorkError('binding');
  let b: ObservationBinding;
  try {
    b = JSON.parse(raw) as ObservationBinding;
  } catch {
    throw new SettlementWorkError('binding');
  }
  await validateObservationBinding(b);
  if (canonicalSettlementValue(b) !== raw)
    throw new SettlementWorkError('binding');
  return Object.freeze(b);
}
async function identity(b: ObservationBinding) {
  const body = canonicalSettlementValue(b),
    hash = await settlementDigest(
      canonicalSettlementValue([
        b.apiOrigin,
        b.spaceId,
        b.environment,
        b.periodId,
        b.transactionId,
      ]),
    );
  return {
    body,
    hash,
    id: 'pfobserve_' + hash,
    fingerprint: await settlementDigest(body),
  };
}

/** An outbox admission observes an already-created transaction. It never calls a
 * merchant, releases a financial claim or fabricates a webhook. */
export class D1PrepaidObservations {
  constructor(
    private readonly db: Database,
    private readonly now = () => Math.floor(Date.now() / 1000),
  ) {}
  private async binding(periodId: string, transactionId: number) {
    const row = await this.db
      .prepare(
        `SELECT binding_json,transaction_id FROM prepaid_observation_sources WHERE period_id=? AND current_owner=1`,
      )
      .bind(periodId)
      .first<{ binding_json: string; transaction_id: number | null }>();
    if (
      !row ||
      (row.transaction_id !== null && row.transaction_id !== transactionId)
    )
      throw new SettlementWorkError('binding');
    const parsed = JSON.parse(row.binding_json) as ObservationBinding;
    return decoded(canonicalSettlementValue({ ...parsed, transactionId }));
  }
  private async insertion(
    b: ObservationBinding,
    provenance: JobRow['provenance'],
    evidence: string | null,
  ) {
    const k = await identity(b),
      at = clock(this.now());
    // The unconditional INSERT is also the final assertion inside recovery's
    // batch. BEFORE INSERT validates the bound transaction/receipt even when
    // ON CONFLICT keeps an existing terminal job unchanged.
    return this.db
      .prepare(`INSERT INTO postfinance_observation_jobs(job_id,scope_hash,period_id,api_origin,space_id,environment,transaction_id,binding_fingerprint,binding_json,provenance,recovery_evidence_fingerprint,state,attempts,lease,lease_until,due_at,created_at,updated_at,completed_at,last_error_code)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',0,NULL,0,?,?,?,NULL,NULL) ON CONFLICT(period_id) DO NOTHING`)
      .bind(
        k.id,
        k.hash,
        b.periodId,
        b.apiOrigin,
        b.spaceId,
        b.environment,
        b.transactionId,
        k.fingerprint,
        k.body,
        provenance,
        evidence,
        at,
        at,
        at,
      );
  }
  async prepareCreateRecoveryAdmission(
    input: CreateRecoveryAdmission,
  ): Promise<readonly D1PreparedStatement[]> {
    recoveryInput(input);
    return [
      await this.insertion(
        await this.binding(input.periodId, input.transactionId),
        'create_recovery',
        input.recoveryEvidenceFingerprint,
      ),
    ];
  }
  async ensureCreateRecoveryAdmission(
    input: CreateRecoveryAdmission,
  ): Promise<ObservationAdmission> {
    recoveryInput(input);
    const row = await this.db
      .prepare(`SELECT j.* FROM postfinance_observation_jobs j JOIN prepaid_observation_sources s ON s.period_id=j.period_id JOIN prepaid_create_recoveries r ON r.period_id=j.period_id
      WHERE j.period_id=? AND j.transaction_id=? AND s.current_owner=1 AND s.binding_json=j.binding_json AND r.transaction_id=j.transaction_id AND r.evidence_fingerprint=?`)
      .bind(
        input.periodId,
        input.transactionId,
        input.recoveryEvidenceFingerprint,
      )
      .first<JobRow>();
    if (!row) throw new SettlementWorkError('binding');
    await this.checked(row);
    return {
      jobId: row.job_id,
      periodId: row.period_id,
      transactionId: row.transaction_id,
      state: row.state === 'pending' ? 'queued' : row.state,
      attempts: row.attempts,
      provenance: row.provenance,
    };
  }
  private async checked(row: JobRow) {
    const b = await decoded(row.binding_json),
      k = await identity(b);
    if (
      row.job_id !== k.id ||
      row.scope_hash !== k.hash ||
      row.binding_fingerprint !== k.fingerprint ||
      row.period_id !== b.periodId ||
      row.transaction_id !== b.transactionId
    )
      throw new SettlementWorkError('binding');
    return b;
  }
  async admitBoundTransactions(
    s: ObservationScope,
    maximum = 4,
  ): Promise<{ admitted: number }> {
    scope(s);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4)
      throw new SettlementWorkError('invalid');
    const rows = await this.db
      .prepare(`SELECT s.binding_json FROM prepaid_observation_sources s WHERE s.api_origin=? AND s.space_id=? AND s.environment=? AND s.current_owner=1 AND s.transaction_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM postfinance_observation_jobs j WHERE j.period_id=s.period_id)
      AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=s.period_id)
      AND (NOT EXISTS(SELECT 1 FROM prepaid_settlement_proofs p WHERE p.period_id=s.period_id)
        OR (s.ordinal=0 AND s.environment='PRODUCTION' AND (NOT EXISTS(SELECT 1 FROM prepaid_purchase_projections p WHERE p.period_id=s.period_id AND p.closed_at IS NOT NULL)
          OR NOT EXISTS(SELECT 1 FROM prepaid_tokens t WHERE t.contract_id=s.contract_id))))
      ORDER BY s.transaction_created_at,s.period_id LIMIT ?`)
      .bind(s.apiOrigin, s.spaceId, s.environment, maximum)
      .all<{ binding_json: string }>();
    let admitted = 0;
    for (const row of rows.results) {
      const b = await decoded(row.binding_json),
        result = await (await this.insertion(b, 'bound_fallback', null)).run();
      admitted += result.meta.changes;
    }
    return { admitted };
  }
}

/** One fair queue, not webhook-first priority. Selection and exact-row CAS keep
 * concurrent workers from claiming a different job after losing the race. */
export class D1PostFinanceSettlementQueue {
  private readonly config: SettlementQueueConfiguration;
  private readonly inbox: D1PostFinanceWebhookInbox | null;
  private readonly environment: Promise<string>;
  constructor(
    private readonly db: Database,
    config: SettlementQueueConfiguration,
    private readonly now = () => Math.floor(Date.now() / 1000),
  ) {
    if (
      !origins.has(config.apiOrigin) ||
      !positive(config.spaceId) ||
      config.listeners.length > 16 ||
      (!config.listeners.length && !config.observations) ||
      (config.observations &&
        (config.observations.enabled !== true ||
          !['TEST', 'PRODUCTION'].includes(config.observations.environment)))
    )
      throw new SettlementWorkError('invalid');
    this.config = structuredClone(config);
    this.inbox = config.listeners.length
      ? new D1PostFinanceWebhookInbox(
          db,
          {
            apiOrigin: config.apiOrigin,
            spaceId: config.spaceId,
            listeners: [...config.listeners],
          },
          now,
        )
      : null;
    this.environment = settlementDigest(
      config.apiOrigin + '|' + config.spaceId,
    );
  }
  private observationScope() {
    if (!this.config.observations) throw new SettlementWorkError('invalid');
    return [
      this.config.apiOrigin,
      this.config.spaceId,
      this.config.observations.environment,
    ];
  }
  async claimNext(leaseSeconds = 300): Promise<SettlementWork | null> {
    duration(leaseSeconds);
    const at = clock(this.now()),
      ids = this.config.listeners.map((l) => l.id),
      ph = ids.map(() => '?').join(',');
    const selects: string[] = [],
      values: (string | number)[] = [];
    if (this.inbox) {
      const env = await this.environment;
      await this.db
        .prepare(
          `UPDATE postfinance_webhook_inbox SET state='failed',lease=NULL,lease_until=0,updated_at=?,last_error_code='storage_unavailable' WHERE state='processing' AND lease_until<=? AND attempts>=8 AND environment_hash=? AND listener_id IN(${ph})`,
        )
        .bind(at, at, env, ...ids)
        .run();
      selects.push(
        `SELECT 'webhook' AS kind,scope_hash AS id,due_at,created_at FROM postfinance_webhook_inbox WHERE environment_hash=? AND listener_id IN(${ph}) AND attempts<8 AND ((state='pending' AND due_at<=?) OR(state='processing' AND lease_until<=?))`,
      );
      values.push(env, ...ids, at, at);
    }
    if (this.config.observations) {
      const s = this.observationScope();
      await this.db
        .prepare(
          `UPDATE postfinance_observation_jobs SET state='failed',lease=NULL,lease_until=0,updated_at=?,last_error_code='storage_unavailable' WHERE state='processing' AND lease_until<=? AND attempts>=8 AND api_origin=? AND space_id=? AND environment=?`,
        )
        .bind(at, at, ...s)
        .run();
      selects.push(
        `SELECT 'observation' AS kind,job_id AS id,due_at,created_at FROM postfinance_observation_jobs WHERE api_origin=? AND space_id=? AND environment=? AND attempts<8 AND((state='pending' AND due_at<=?) OR(state='processing' AND lease_until<=?))`,
      );
      values.push(...s, at, at);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = await this.db
        .prepare(
          `SELECT * FROM(${selects.join(' UNION ALL ')}) ORDER BY due_at,created_at,id LIMIT 1`,
        )
        .bind(...values)
        .first<{ kind: 'webhook' | 'observation'; id: string }>();
      if (!candidate) return null;
      const lease = crypto.randomUUID();
      if (candidate.kind === 'observation') {
        const row = await this.db
          .prepare(
            `UPDATE postfinance_observation_jobs SET state='processing',lease=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE job_id=? AND api_origin=? AND space_id=? AND environment=? AND attempts<8 AND((state='pending' AND due_at<=?) OR(state='processing' AND lease_until<=?)) RETURNING *`,
          )
          .bind(
            lease,
            at + leaseSeconds,
            at,
            candidate.id,
            ...this.observationScope(),
            at,
            at,
          )
          .first<JobRow>();
        if (!row) continue;
        const binding = await decoded(row.binding_json),
          k = await identity(binding);
        if (
          k.id !== row.job_id ||
          k.hash !== row.scope_hash ||
          k.fingerprint !== row.binding_fingerprint
        )
          throw new SettlementWorkError('binding');
        return Object.freeze({
          kind: 'observation',
          jobId: row.job_id,
          scopeHash: row.scope_hash,
          bindingFingerprint: row.binding_fingerprint,
          provenance: row.provenance,
          binding,
          lease: row.lease!,
          leaseUntil: row.lease_until,
          attempts: row.attempts,
        });
      }
      const row = await this.db
        .prepare(
          `UPDATE postfinance_webhook_inbox SET state='processing',lease=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE scope_hash=? AND environment_hash=? AND listener_id IN(${ph}) AND attempts<8 AND((state='pending' AND due_at<=?) OR(state='processing' AND lease_until<=?)) RETURNING scope_hash,event_json,lease,lease_until,attempts`,
        )
        .bind(
          lease,
          at + leaseSeconds,
          at,
          candidate.id,
          await this.environment,
          ...ids,
          at,
          at,
        )
        .first<{
          scope_hash: string;
          event_json: string;
          lease: string;
          lease_until: number;
          attempts: number;
        }>();
      if (!row) continue;
      const event = JSON.parse(row.event_json) as CheckoutWebhook,
        listener = this.config.listeners.find(
          (l) => l.id === event.webhookListenerId,
        );
      if (
        new TextEncoder().encode(row.event_json).byteLength > 65536 ||
        !listener ||
        event.spaceId !== this.config.spaceId ||
        event.listenerEntityId !== listener.entityId ||
        (listener.technicalName !== undefined &&
          listener.technicalName !== event.listenerEntityTechnicalName) ||
        ![
          event.eventId,
          event.entityId,
          event.webhookListenerId,
          event.listenerEntityId,
          event.spaceId,
        ].every(positive) ||
        row.scope_hash !==
          (await settlementDigest(
            `${this.config.apiOrigin}|${event.spaceId}|${event.webhookListenerId}|${event.eventId}`,
          ))
      )
        throw new SettlementWorkError('binding');
      return Object.freeze({
        scopeHash: row.scope_hash,
        event,
        lease: row.lease,
        leaseUntil: row.lease_until,
        attempts: row.attempts,
      });
    }
    return null;
  }
  private async update(
    work: ObservationWork,
    set: string,
    values: readonly (string | number | null)[],
  ) {
    const b = await decoded(canonicalSettlementValue(work.binding)),
      k = await identity(b);
    if (
      work.jobId !== k.id ||
      work.scopeHash !== k.hash ||
      work.bindingFingerprint !== k.fingerprint ||
      !Number.isSafeInteger(work.attempts) ||
      work.attempts < 1 ||
      work.attempts > 8 ||
      !/^[-a-f0-9]{36}$/.test(work.lease)
    )
      throw new SettlementWorkError('binding');
    const result = await this.db
      .prepare(
        `UPDATE postfinance_observation_jobs SET ${set} WHERE job_id=? AND scope_hash=? AND binding_fingerprint=? AND provenance=? AND state='processing' AND lease=? AND lease_until>? AND attempts=? AND api_origin=? AND space_id=? AND environment=?`,
      )
      .bind(
        ...values,
        work.jobId,
        work.scopeHash,
        work.bindingFingerprint,
        work.provenance,
        work.lease,
        clock(this.now()),
        work.attempts,
        ...this.observationScope(),
      )
      .run();
    return result.meta.changes === 1;
  }
  async renewWork(work: SettlementWork, leaseSeconds = 300) {
    duration(leaseSeconds);
    if (!isObservationWork(work))
      return this.inbox ? this.inbox.renewWork(work, leaseSeconds) : false;
    const at = clock(this.now());
    return this.update(work, 'lease_until=?,updated_at=?', [
      at + leaseSeconds,
      at,
    ]);
  }
  async completeWork(work: SettlementWork) {
    if (!isObservationWork(work))
      return this.inbox ? this.inbox.completeWork(work) : false;
    const at = clock(this.now());
    return this.update(
      work,
      "state='completed',lease=NULL,lease_until=0,completed_at=?,updated_at=?,last_error_code=NULL",
      [at, at],
    );
  }
  async failWork(work: SettlementWork, code: WebhookFailure) {
    if (!failureCodes.has(code)) throw new SettlementWorkError('invalid');
    if (!isObservationWork(work))
      return this.inbox ? this.inbox.failWork(work, code) : false;
    const at = clock(this.now());
    return this.update(
      work,
      "state=CASE WHEN attempts>=8 THEN 'failed' ELSE 'pending' END,due_at=?,lease=NULL,lease_until=0,updated_at=?,last_error_code=?",
      [at + Math.min(3600, 30 * 2 ** Math.min(work.attempts, 7)), at, code],
    );
  }
}
