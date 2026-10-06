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
  constructor(
    private db: PaymentDatabase,
    private now = () => Math.floor(Date.now() / 1000),
  ) {}

  async claim(scope: string, fingerprint: string): Promise<Claim> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(fingerprint))
      throw new Error('Invalid payment request fingerprint.');
    const hash = await scopeHash(scope),
      token = crypto.randomUUID(),
      timestamp = time(this.now());
    const result = await this.db
      .prepare(`INSERT INTO postfinance_mutations
      (scope_hash,fingerprint,state,claim_token,created_at,updated_at)
      VALUES(?,?,'claimed',?,?,?) ON CONFLICT(scope_hash) DO NOTHING`)
      .bind(hash, fingerprint, token, timestamp, timestamp)
      .run();
    if (result.meta.changes === 1) {
      this.owned.set(hash, token);
      return { kind: 'claimed' };
    }
    const row = await this.db
      .prepare(`SELECT fingerprint,state,claim_token,response_json
      FROM postfinance_mutations WHERE scope_hash=?`)
      .bind(hash)
      .first<MutationRow>();
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
