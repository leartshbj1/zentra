import type {
  CheckoutWebhook,
  Claim,
  MutationLedger,
  WebhookInbox,
} from './postfinance-client';

type PaymentDatabase = Pick<D1Database, 'prepare'>;
type MutationRow = {
  fingerprint: string;
  state: string;
  claim_token: string | null;
  response_json: string | null;
};
/** Server-owned period binding for a financial dispatch. Browser input and a
 * successful reservation alone are never permission to charge a customer. */
export type PrepaidMutationFence = Readonly<{
  periodId: string;
  contractId: string;
  ownerId: string;
  organizationId: string | null;
  workspaceId: string | null;
  apiOrigin: string;
  spaceId: number;
  environment: 'TEST' | 'PRODUCTION';
  operation: 'create' | 'confirm' | 'chargeflow' | 'cancel';
  transactionId?: number;
}>;
type WebhookRow = {
  scope_hash: string;
  event_json: string;
  lease: string;
  attempts: number;
  lease_until: number;
};
export type WebhookWork = Readonly<{
  scopeHash: string;
  lease: string;
  attempts: number;
  leaseUntil: number;
  event: CheckoutWebhook;
}>;
export type WebhookListener = {
  id: number;
  entityId: number;
  technicalName?: string;
};
export type WebhookFailure =
  | 'provider_unavailable'
  | 'settlement_pending'
  | 'ownership_mismatch'
  | 'ambiguous_period'
  | 'invalid_provider_state'
  | 'storage_unavailable';

/** Permanent data rejection is different from a retriable D1 failure. */
export class PostFinanceJournalError extends Error {
  constructor(
    public readonly kind: 'invalid_event' | 'replay_conflict',
    message: string,
  ) {
    super(message);
  }
}

const encoder = new TextEncoder();
const origins = new Set([
  'https://checkout.postfinance.ch',
  'https://app-wallee.com',
]);
const maxResponseBytes = 1_048_576;
const maxAttempts = 8;
const failureCodes = new Set<WebhookFailure>([
  'provider_unavailable',
  'settlement_pending',
  'ownership_mismatch',
  'ambiguous_period',
  'invalid_provider_state',
  'storage_unavailable',
]);

function positiveId(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('Invalid payment entity ID.');
}
function time(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('Invalid payment journal time.');
  return value;
}
async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(value)),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
async function scopeHash(scope: string) {
  if (
    !scope ||
    encoder.encode(scope).length > 1024 ||
    Array.from(scope).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error('Invalid payment journal scope.');
  }
  return digest(scope);
}
function json(value: string, maximum: number) {
  if (!value || encoder.encode(value).length > maximum)
    throw new Error('Oversized payment journal data.');
  JSON.parse(value);
  return value;
}

/** A payment mutation never expires or gets stolen, even after a worker restart.
 * A missing response may represent a successful charge. Only an explicit future
 * reconciliation can resolve it; retrying the POST is deliberately forbidden. */
export class D1PostFinanceMutationLedger implements MutationLedger {
  private owned = new Map<string, string>();
  private readonly prepaidFence: PrepaidMutationFence | undefined;
  constructor(
    private db: PaymentDatabase,
    private now = () => Math.floor(Date.now() / 1000),
    prepaidFence?: PrepaidMutationFence,
  ) {
    this.prepaidFence =
      prepaidFence && Object.freeze(structuredClone(prepaidFence));
  }

  private prepaidBinding(scope: string) {
    const f = this.prepaidFence;
    if (!f) return null;
    const identity = (value: unknown) =>
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 180 &&
      !Array.from(value).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      );
    if (
      !/^pfperiod_[0-9a-f]{64}$/.test(f.periodId) ||
      !/^pfp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        f.contractId,
      ) ||
      !identity(f.ownerId) ||
      (f.organizationId !== null && !identity(f.organizationId)) ||
      (f.workspaceId !== null && !identity(f.workspaceId)) ||
      (f.organizationId === null && f.workspaceId === null) ||
      !origins.has(f.apiOrigin) ||
      !['TEST', 'PRODUCTION'].includes(f.environment) ||
      !['create', 'confirm', 'chargeflow', 'cancel'].includes(f.operation)
    )
      throw new Error('Invalid prepaid payment dispatch context.');
    positiveId(f.spaceId);
    if (f.operation === 'create') {
      if (f.transactionId !== undefined)
        throw new Error('Invalid prepaid payment dispatch context.');
    } else positiveId(f.transactionId as number);
    const path =
      f.operation === 'create'
        ? '/payment/transactions'
        : `/payment/transactions/${f.transactionId}/${f.operation === 'confirm' ? 'confirm' : f.operation === 'cancel' ? 'charge-flow/cancel' : 'charge-flow/apply'}`;
    if (
      scope !==
      `${f.apiOrigin}|${f.spaceId}|POST|${path}|${f.periodId}_${f.operation}`
    )
      throw new Error('Prepaid payment dispatch scope mismatch.');
    const transaction =
      f.operation === 'create'
        ? ''
        : `AND EXISTS(
      SELECT 1 FROM prepaid_transactions t WHERE t.period_id=p.period_id
      AND t.api_origin=c.api_origin AND t.space_id=c.space_id AND t.transaction_id=?)`;
    // This immutable portion is also required for replay. It deliberately does
    // not require a current/uncancelled period when returning a completed result.
    const sql = `FROM prepaid_periods p JOIN prepaid_contracts c ON c.contract_id=p.contract_id
      JOIN prepaid_payment_expectations e ON e.period_id=p.period_id
      WHERE p.period_id=? AND c.contract_id=? AND c.owner_id=?
      AND c.organization_id IS ? AND c.workspace_id IS ?
      AND c.api_origin=? AND c.space_id=? AND c.environment=?
      AND p.currency='CHF' AND p.price_chf_minor>0 AND p.catalog_version=c.catalog_version
      AND p.catalog_json=c.catalog_json AND e.plan_reference=p.catalog_version
      AND length(e.customer_reference) BETWEEN 1 AND 120
      AND e.payment_method_configuration_id>0 AND e.connector_configuration_id>0
      AND length(e.fingerprint)=64 AND e.fingerprint NOT GLOB '*[^0-9a-f]*'
      AND (c.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o
        JOIN organization_members m ON m.organization_id=o.organization_id
        WHERE o.organization_id=c.organization_id AND o.created_by_user_id=c.owner_id
        AND m.user_id=c.owner_id AND m.role='owner' AND m.revoked_at IS NULL))
      AND (c.workspace_id IS NULL OR EXISTS(SELECT 1 FROM support_workspaces w
        WHERE w.id=c.workspace_id AND w.owner_id=c.owner_id)) ${transaction}`;
    const values = [
      f.periodId,
      f.contractId,
      f.ownerId,
      f.organizationId,
      f.workspaceId,
      f.apiOrigin,
      f.spaceId,
      f.environment,
      ...(f.operation === 'create' ? [] : [f.transactionId!]),
    ];
    return {
      sql,
      values,
      creation: f.operation === 'create',
      cancellation: f.operation === 'cancel',
      confirmation: f.operation === 'confirm',
    };
  }

  async claim(scope: string, fingerprint: string): Promise<Claim> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(fingerprint))
      throw new Error('Invalid payment request fingerprint.');
    const hash = await scopeHash(scope),
      token = crypto.randomUUID(),
      timestamp = time(this.now());
    const binding = this.prepaidBinding(scope);
    const result = binding
      ? await this.db
          .prepare(`INSERT INTO postfinance_mutations
      (scope_hash,fingerprint,state,claim_token,created_at,updated_at)
      SELECT ?,?,'claimed',?,?,? ${binding.sql}
      ${binding.cancellation ? 'AND c.cancelled_at IS NOT NULL AND p.ordinal>0' : 'AND c.cancelled_at IS NULL AND p.starts_at<=? AND p.ends_at>?'}
      AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id)
      AND NOT EXISTS(SELECT 1 FROM prepaid_settlement_proofs s WHERE s.period_id=p.period_id)
      ${
        binding.cancellation
          ? ''
          : `AND NOT EXISTS(SELECT 1 FROM account_session_policy account WHERE account.user_id=c.owner_id AND account.deleted_at IS NOT NULL)
        AND (p.ordinal=0 OR (
          (c.product_key NOT LIKE 'gestion:%' AND c.product_key NOT LIKE 'complet:%'
            OR EXISTS(SELECT 1 FROM organizations company WHERE company.organization_id=c.organization_id AND company.subscription_id=c.contract_id))
          AND (c.product_key NOT LIKE 'support:%' OR c.organization_id IS
            (SELECT organization_id FROM support_gestion_links WHERE workspace_id=c.workspace_id))
          AND (c.product_key NOT LIKE 'complet:%' OR EXISTS(SELECT 1 FROM support_gestion_links link
            WHERE link.organization_id=c.organization_id AND link.workspace_id=c.workspace_id))))`
      }
      ${binding.creation ? 'AND NOT EXISTS(SELECT 1 FROM prepaid_transactions t WHERE t.period_id=p.period_id)' : ''}
      ${
        binding.cancellation
          ? ''
          : `AND (p.ordinal<>0 OR NOT EXISTS(SELECT 1 FROM prepaid_purchase_targets r WHERE r.contract_id=c.contract_id)
        OR EXISTS(SELECT 1 FROM prepaid_purchase_targets r JOIN purchase_intents i ON i.intent_id=r.intent_id
          JOIN purchase_valid_targets valid ON valid.intent_id=i.intent_id
          WHERE r.contract_id=c.contract_id AND r.owner_id=c.owner_id
          AND r.organization_id IS c.organization_id AND r.workspace_id IS c.workspace_id
          AND i.state IN ('reserved','dispatched','uncertain') AND i.provider='postfinance'
          AND i.environment=c.environment AND i.provider_scope=(c.api_origin||'|'||c.space_id)
          AND (r.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o WHERE o.organization_id=r.organization_id
            AND o.subscription_id=r.previous_subscription_id AND o.created_by_user_id=r.owner_id))))`
      }
      ${
        binding.cancellation
          ? ''
          : `AND (p.ordinal=0 OR (${binding.confirmation ? '0' : '1'} AND EXISTS(
        SELECT 1 FROM prepaid_renewal_requests renewal JOIN prepaid_tokens token ON token.contract_id=renewal.contract_id
        JOIN prepaid_purchase_projections projection ON projection.contract_id=renewal.contract_id AND projection.closed_at IS NOT NULL
        WHERE renewal.period_id=p.period_id AND renewal.contract_id=c.contract_id
        AND renewal.token_id=token.token_id AND renewal.token_version_id=token.token_version_id
        AND token.owner_id=c.owner_id AND token.organization_id IS c.organization_id AND token.workspace_id IS c.workspace_id
        AND token.api_origin=c.api_origin AND token.space_id=c.space_id AND token.environment=c.environment
        AND token.customer_reference=e.customer_reference AND token.payment_method_configuration_id=e.payment_method_configuration_id
        AND token.connector_configuration_id=e.connector_configuration_id
        AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=token.initial_period_id))))`
      }
      ${
        binding.cancellation
          ? ''
          : `AND (p.ordinal=0 OR EXISTS(SELECT 1 FROM prepaid_periods previous
        JOIN prepaid_transactions pt ON pt.period_id=previous.period_id
        JOIN prepaid_settlement_proofs ps ON ps.period_id=previous.period_id
        WHERE previous.contract_id=c.contract_id AND previous.ordinal=p.ordinal-1
        AND previous.ends_at=p.starts_at AND pt.api_origin=c.api_origin AND pt.space_id=c.space_id
        AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=previous.period_id)))`
      }
      ON CONFLICT(scope_hash) DO NOTHING`)
          .bind(
            hash,
            fingerprint,
            token,
            timestamp,
            timestamp,
            ...binding.values,
            ...(binding.cancellation ? [] : [timestamp, timestamp]),
          )
          .run()
      : await this.db
          .prepare(`INSERT INTO postfinance_mutations
      (scope_hash,fingerprint,state,claim_token,created_at,updated_at)
      VALUES(?,?,'claimed',?,?,?) ON CONFLICT(scope_hash) DO NOTHING`)
          .bind(hash, fingerprint, token, timestamp, timestamp)
          .run();
    if (result.meta.changes === 1) {
      this.owned.set(hash, token);
      return { kind: 'claimed' };
    }
    const row = binding
      ? await this.db
          .prepare(`SELECT fingerprint,state,claim_token,response_json
      FROM postfinance_mutations WHERE scope_hash=? AND EXISTS(SELECT 1 ${binding.sql})`)
          .bind(hash, ...binding.values)
          .first<MutationRow>()
      : await this.db
          .prepare(`SELECT fingerprint,state,claim_token,response_json
        FROM postfinance_mutations WHERE scope_hash=?`)
          .bind(hash)
          .first<MutationRow>();
    if (!row && binding)
      throw new Error('Prepaid payment dispatch is unavailable.');
    if (!row) throw new Error('Payment journal reservation was not persisted.');
    if (row.fingerprint !== fingerprint) return { kind: 'conflict' };
    if (row.state === 'completed' && row.response_json !== null) {
      return {
        kind: 'completed',
        json: json(row.response_json, maxResponseBytes),
      };
    }
    return { kind: 'uncertain' };
  }

  async complete(scope: string, response: string) {
    const hash = await scopeHash(scope),
      token = this.owned.get(hash);
    if (!token)
      throw new Error('This worker does not own the payment mutation.');
    json(response, maxResponseBytes);
    const result = await this.db
      .prepare(`UPDATE postfinance_mutations
      SET state='completed',response_json=?,claim_token=NULL,updated_at=?
      WHERE scope_hash=? AND claim_token=? AND state='claimed'`)
      .bind(response, time(this.now()), hash, token)
      .run();
    if (result.meta.changes !== 1)
      throw new Error('Payment result was not persisted by its owner.');
    this.owned.delete(hash);
  }

  async markUncertain(scope: string) {
    const hash = await scopeHash(scope),
      token = this.owned.get(hash);
    if (!token) return; // A different worker must never downgrade a completed row.
    await this.db
      .prepare(`UPDATE postfinance_mutations SET state='uncertain',updated_at=?
      WHERE scope_hash=? AND claim_token=? AND state='claimed'`)
      .bind(time(this.now()), hash, token)
      .run();
    this.owned.delete(hash);
  }
}

/** Only use behind acceptWebhook's raw-byte signature validation. This store
 * additionally binds listeners to their expected entity; it grants no rights.
 * A worker must re-read provider state and apply idempotent business effects
 * BEFORE completing a work item. Lease recovery is safe for reconciliation GETs,
 * not for repeating financial POSTs (which use the separate mutation ledger). */
export class D1PostFinanceWebhookInbox implements WebhookInbox {
  private config: {
    apiOrigin: string;
    spaceId: number;
    listeners: WebhookListener[];
  };
  private environment: Promise<string>;
  constructor(
    private db: PaymentDatabase,
    config: {
      apiOrigin: string;
      spaceId: number;
      listeners: WebhookListener[];
    },
    private now = () => Math.floor(Date.now() / 1000),
  ) {
    if (!origins.has(config.apiOrigin))
      throw new Error('Unapproved webhook origin.');
    positiveId(config.spaceId);
    if (
      !config.listeners.length ||
      new Set(config.listeners.map((listener) => listener.id)).size !==
        config.listeners.length
    ) {
      throw new Error('Unique configured webhook listeners required.');
    }
    for (const listener of config.listeners) {
      positiveId(listener.id);
      positiveId(listener.entityId);
      if (
        listener.technicalName !== undefined &&
        (!listener.technicalName || listener.technicalName.length > 120)
      ) {
        throw new Error('Invalid listener entity name.');
      }
    }
    this.config = structuredClone(config);
    this.environment = digest(`${config.apiOrigin}|${config.spaceId}`);
  }

  private normalize(event: CheckoutWebhook): CheckoutWebhook {
    for (const value of [
      event.eventId,
      event.entityId,
      event.spaceId,
      event.webhookListenerId,
      event.listenerEntityId,
    ])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new PostFinanceJournalError(
          'invalid_event',
          'Invalid webhook entity ID.',
        );
    const listener = this.config.listeners.find(
      (candidate) => candidate.id === event.webhookListenerId,
    );
    if (
      event.spaceId !== this.config.spaceId ||
      !listener ||
      event.listenerEntityId !== listener.entityId ||
      (listener.technicalName !== undefined &&
        event.listenerEntityTechnicalName !== listener.technicalName)
    ) {
      throw new PostFinanceJournalError(
        'invalid_event',
        'Webhook does not match its configured entity and space.',
      );
    }
    if (
      typeof event.timestamp !== 'string' ||
      event.timestamp.length > 80 ||
      !Number.isFinite(Date.parse(event.timestamp))
    ) {
      throw new PostFinanceJournalError(
        'invalid_event',
        'Invalid payment webhook timestamp.',
      );
    }
    if (Date.parse(event.timestamp) > time(this.now()) * 1000 + 600_000)
      throw new PostFinanceJournalError(
        'invalid_event',
        'Payment webhook is in the future.',
      );
    if (
      event.state !== undefined &&
      (typeof event.state !== 'string' ||
        !event.state ||
        event.state.length > 80)
    ) {
      throw new PostFinanceJournalError(
        'invalid_event',
        'Invalid payment webhook state.',
      );
    }
    if (
      event.listenerEntityTechnicalName !== undefined &&
      (typeof event.listenerEntityTechnicalName !== 'string' ||
        !event.listenerEntityTechnicalName ||
        event.listenerEntityTechnicalName.length > 120)
    ) {
      throw new PostFinanceJournalError(
        'invalid_event',
        'Invalid payment webhook entity name.',
      );
    }
    return {
      eventId: event.eventId,
      entityId: event.entityId,
      spaceId: event.spaceId,
      webhookListenerId: event.webhookListenerId,
      listenerEntityId: event.listenerEntityId,
      timestamp: event.timestamp,
      ...(event.listenerEntityTechnicalName === undefined
        ? {}
        : { listenerEntityTechnicalName: event.listenerEntityTechnicalName }),
      ...(event.state === undefined ? {} : { state: event.state }),
    };
  }

  async acceptOnce(scope: string, event: CheckoutWebhook) {
    const normalized = this.normalize(event);
    const expected = `${this.config.apiOrigin}|${normalized.spaceId}|${normalized.webhookListenerId}|${normalized.eventId}`;
    if (scope !== expected)
      throw new PostFinanceJournalError(
        'invalid_event',
        'Webhook journal scope mismatch.',
      );
    const hash = await scopeHash(scope),
      body = JSON.stringify(normalized),
      fingerprint = await digest(body),
      timestamp = time(this.now());
    const result = await this.db
      .prepare(`INSERT INTO postfinance_webhook_inbox
      (scope_hash,environment_hash,listener_id,event_fingerprint,event_json,state,due_at,created_at,updated_at)
      VALUES(?,?,?,?,?,'pending',?,?,?) ON CONFLICT(scope_hash) DO NOTHING`)
      .bind(
        hash,
        await this.environment,
        normalized.webhookListenerId,
        fingerprint,
        body,
        timestamp,
        timestamp,
        timestamp,
      )
      .run();
    if (result.meta.changes === 1) return true;
    const row = await this.db
      .prepare(
        'SELECT event_fingerprint FROM postfinance_webhook_inbox WHERE scope_hash=?',
      )
      .bind(hash)
      .first<{ event_fingerprint: string }>();
    if (!row) throw new Error('Webhook journal reservation was not persisted.');
    if (row.event_fingerprint !== fingerprint)
      throw new PostFinanceJournalError(
        'replay_conflict',
        'Conflicting payment webhook replay.',
      );
    return false;
  }

  async claimNext(leaseSeconds = 300): Promise<WebhookWork | null> {
    if (
      !Number.isSafeInteger(leaseSeconds) ||
      leaseSeconds < 5 ||
      leaseSeconds > 900
    )
      throw new Error('Invalid reconciliation lease duration.');
    const timestamp = time(this.now()),
      lease = crypto.randomUUID(),
      environment = await this.environment;
    const listeners = this.config.listeners.map((listener) => listener.id);
    const placeholders = listeners.map(() => '?').join(',');
    // A crashed eighth attempt cannot silently sit in processing forever.
    await this.db
      .prepare(`UPDATE postfinance_webhook_inbox SET state='failed',lease=NULL,lease_until=0,
      updated_at=?,last_error_code='storage_unavailable' WHERE state='processing' AND lease_until<=? AND attempts>=?
        AND environment_hash=? AND listener_id IN (${placeholders})`)
      .bind(timestamp, timestamp, maxAttempts, environment, ...listeners)
      .run();
    const row = await this.db
      .prepare(`UPDATE postfinance_webhook_inbox
      SET state='processing',lease=?,lease_until=?,attempts=attempts+1,updated_at=?
      WHERE scope_hash=(SELECT scope_hash FROM postfinance_webhook_inbox
        WHERE environment_hash=? AND listener_id IN (${placeholders}) AND attempts<?
          AND ((state='pending' AND due_at<=?) OR (state='processing' AND lease_until<=?))
        ORDER BY due_at,created_at,scope_hash LIMIT 1)
      RETURNING scope_hash,event_json,lease,attempts,lease_until`)
      .bind(
        lease,
        timestamp + leaseSeconds,
        timestamp,
        environment,
        ...listeners,
        maxAttempts,
        timestamp,
        timestamp,
      )
      .first<WebhookRow>();
    if (!row) return null;
    return Object.freeze({
      scopeHash: row.scope_hash,
      lease: row.lease,
      attempts: row.attempts,
      leaseUntil: row.lease_until,
      event: this.normalize(
        JSON.parse(json(row.event_json, 65_536)) as CheckoutWebhook,
      ),
    });
  }

  private fence(work: WebhookWork) {
    if (
      !/^[a-f0-9]{64}$/.test(work.scopeHash) ||
      !/^[0-9a-f-]{36}$/.test(work.lease)
    ) {
      throw new Error('Invalid reconciliation ownership token.');
    }
  }
  async completeWork(work: WebhookWork) {
    this.fence(work);
    const timestamp = time(this.now()),
      listeners = this.config.listeners.map((listener) => listener.id);
    const result = await this.db
      .prepare(`UPDATE postfinance_webhook_inbox
      SET state='completed',lease=NULL,lease_until=0,completed_at=?,updated_at=?,last_error_code=NULL
      WHERE scope_hash=? AND state='processing' AND lease=? AND lease_until>? AND environment_hash=?
        AND listener_id IN (${listeners.map(() => '?').join(',')})`)
      .bind(
        timestamp,
        timestamp,
        work.scopeHash,
        work.lease,
        timestamp,
        await this.environment,
        ...listeners,
      )
      .run();
    return result.meta.changes === 1;
  }
  /** Renew only a lease which is still owned and unexpired. A long provider
   * read can never resurrect an abandoned or reassigned worker. */
  async renewWork(work: WebhookWork, leaseSeconds = 300) {
    this.fence(work);
    if (
      !Number.isSafeInteger(leaseSeconds) ||
      leaseSeconds < 5 ||
      leaseSeconds > 900
    )
      throw new Error('Invalid reconciliation lease duration.');
    const timestamp = time(this.now()),
      listeners = this.config.listeners.map((listener) => listener.id);
    const result = await this.db
      .prepare(`UPDATE postfinance_webhook_inbox SET lease_until=?,updated_at=?
      WHERE scope_hash=? AND state='processing' AND lease=? AND lease_until>? AND environment_hash=?
      AND listener_id IN (${listeners.map(() => '?').join(',')})`)
      .bind(
        timestamp + leaseSeconds,
        timestamp,
        work.scopeHash,
        work.lease,
        timestamp,
        await this.environment,
        ...listeners,
      )
      .run();
    return result.meta.changes === 1;
  }
  async failWork(work: WebhookWork, code: WebhookFailure) {
    this.fence(work);
    if (!failureCodes.has(code))
      throw new Error('Use a non-sensitive reconciliation error code.');
    const timestamp = time(this.now()),
      listeners = this.config.listeners.map((listener) => listener.id);
    const result = await this.db
      .prepare(`UPDATE postfinance_webhook_inbox
      SET state=CASE WHEN attempts>=? THEN 'failed' ELSE 'pending' END,
        due_at=?,lease=NULL,lease_until=0,updated_at=?,last_error_code=?
      WHERE scope_hash=? AND state='processing' AND lease=? AND lease_until>? AND environment_hash=?
        AND listener_id IN (${listeners.map(() => '?').join(',')})`)
      .bind(
        maxAttempts,
        timestamp + Math.min(3600, 30 * 2 ** Math.min(work.attempts, 7)),
        timestamp,
        code,
        work.scopeHash,
        work.lease,
        timestamp,
        await this.environment,
        ...listeners,
      )
      .run();
    return result.meta.changes === 1;
  }
}
