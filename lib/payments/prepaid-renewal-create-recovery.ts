import {
  recoverPrepaidCreate,
  PrepaidCreateRecoveryError,
  type PrepaidCreateRecoveryConfiguration,
  type PrepaidCreateRecoveryResult,
} from '@/lib/payments/prepaid-create-recovery';
import type { RenewalScope } from '@/lib/payments/prepaid-renewal-admission';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
export type RenewalCreateRecoveryWork = Readonly<{
  period_id: string;
  contract_id: string;
  ordinal: number;
  api_origin: string;
  space_id: number;
  environment: 'TEST' | 'PRODUCTION';
  create_scope_hash: string;
  request_fingerprint: string;
  original_claim_token: string;
  lease_token: string;
  attempts: number;
  created_at: number;
}>;
export type RenewalRecoveryFailure =
  | 'absent'
  | 'ambiguous'
  | 'unstable'
  | 'unavailable'
  | 'binding'
  | 'not-claimed'
  | 'provider-binding';
export const RENEWAL_RECOVERY_LEASE_SECONDS = 130;
const failures: readonly string[] = [
  'absent',
  'ambiguous',
  'unstable',
  'unavailable',
  'binding',
  'not-claimed',
  'provider-binding',
];
function validScope(scope: RenewalScope) {
  if (
    !['https://checkout.postfinance.ch', 'https://app-wallee.com'].includes(
      scope.apiOrigin,
    ) ||
    !Number.isSafeInteger(scope.spaceId) ||
    scope.spaceId <= 0 ||
    !['TEST', 'PRODUCTION'].includes(scope.environment)
  )
    throw Error('Invalid recovery scope.');
}
function clockValue(value: number) {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    !Number.isSafeInteger(value + 3600)
  )
    throw Error('Invalid recovery clock.');
  return value;
}
const source = `FROM prepaid_periods p JOIN prepaid_contracts c ON c.contract_id=p.contract_id
  JOIN prepaid_renewal_requests r ON r.period_id=p.period_id AND r.contract_id=c.contract_id
  JOIN postfinance_mutations m ON m.scope_hash=r.create_scope_hash
  JOIN prepaid_purchase_targets t ON t.contract_id=c.contract_id
  JOIN prepaid_purchase_projections x ON x.contract_id=c.contract_id AND x.intent_id=t.intent_id
  JOIN purchase_intents i ON i.intent_id=t.intent_id`;
// No cancellation, current-period or current-token requirement: this is only
// discovery of an operation already attempted, never financial dispatch.
const identity = `p.ordinal>0 AND x.closed_at IS NOT NULL AND i.state='settled'
  AND i.provider='postfinance' AND i.provider_scope=(c.api_origin||'|'||c.space_id)
  AND i.environment=c.environment AND i.owner_id=c.owner_id
  AND i.organization_id IS c.organization_id AND i.workspace_id IS c.workspace_id
  AND t.owner_id=c.owner_id AND t.organization_id IS c.organization_id AND t.workspace_id IS c.workspace_id
  AND NOT EXISTS(SELECT 1 FROM account_session_policy a WHERE a.user_id=c.owner_id AND a.deleted_at IS NOT NULL)
  AND (c.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o JOIN organization_members member
    ON member.organization_id=o.organization_id WHERE o.organization_id=c.organization_id
    AND o.created_by_user_id=c.owner_id AND member.user_id=c.owner_id AND member.role='owner' AND member.revoked_at IS NULL))
  AND (c.workspace_id IS NULL OR EXISTS(SELECT 1 FROM support_workspaces w WHERE w.id=c.workspace_id AND w.owner_id=c.owner_id))
  AND NOT EXISTS(SELECT 1 FROM support_gestion_links l WHERE
    (l.organization_id=c.organization_id AND l.workspace_id IS NOT c.workspace_id AND c.workspace_id IS NOT NULL)
    OR(l.workspace_id=c.workspace_id AND l.organization_id IS NOT c.organization_id))`;
const live = `period_id=? AND contract_id=? AND ordinal=? AND api_origin=? AND space_id=? AND environment=?
  AND create_scope_hash=? AND request_fingerprint=? AND original_claim_token=? AND created_at=?
  AND state='processing' AND lease_token=? AND attempts=? AND lease_until>unixepoch() AND lease_until>?`;
function workValues(w: RenewalCreateRecoveryWork, now: number) {
  if (
    !/^pfperiod_[a-f0-9]{64}$/.test(w.period_id) ||
    !/^pfp_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      w.contract_id,
    ) ||
    !Number.isSafeInteger(w.ordinal) ||
    w.ordinal < 1 ||
    !/^[a-f0-9]{64}$/.test(w.create_scope_hash) ||
    !/^[A-Za-z0-9_-]{43}$/.test(w.request_fingerprint) ||
    !/^[a-f0-9-]{36}$/.test(w.original_claim_token) ||
    !/^[a-f0-9-]{36}$/.test(w.lease_token) ||
    !Number.isSafeInteger(w.attempts) ||
    w.attempts < 1 ||
    w.attempts > 8 ||
    !Number.isSafeInteger(w.created_at) ||
    w.created_at <= 0
  )
    throw Error('Invalid recovery work.');
  validScope({
    apiOrigin: w.api_origin,
    spaceId: w.space_id,
    environment: w.environment,
  });
  return [
    w.period_id,
    w.contract_id,
    w.ordinal,
    w.api_origin,
    w.space_id,
    w.environment,
    w.create_scope_hash,
    w.request_fingerprint,
    w.original_claim_token,
    w.created_at,
    w.lease_token,
    w.attempts,
    now,
  ];
}
/** Durable scheduling only. Its lease cannot replace or release a merchant claim. */
export class D1PrepaidRenewalCreateRecoveries {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async admit(scope: RenewalScope, maximum = 4): Promise<number> {
    validScope(scope);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4)
      throw Error('Invalid recovery bound.');
    const now = clockValue(this.clock());
    const result = await this.db
      .prepare(`INSERT INTO prepaid_renewal_create_recovery_jobs
      (period_id,contract_id,ordinal,api_origin,space_id,environment,create_scope_hash,request_fingerprint,
      original_claim_token,state,attempts,lease_token,lease_until,next_attempt_at,last_attempt_at,last_error_code,created_at,updated_at)
      SELECT p.period_id,c.contract_id,p.ordinal,c.api_origin,c.space_id,c.environment,r.create_scope_hash,m.fingerprint,
      m.claim_token,'queued',0,NULL,0,?,NULL,NULL,?,? ${source}
      WHERE ${identity} AND c.api_origin=? AND c.space_id=? AND c.environment=?
      AND m.state IN('claimed','uncertain') AND m.claim_token IS NOT NULL AND m.response_json IS NULL
      AND NOT EXISTS(SELECT 1 FROM prepaid_create_recoveries z WHERE z.period_id=p.period_id)
      AND NOT EXISTS(SELECT 1 FROM prepaid_renewal_create_recovery_jobs j WHERE j.period_id=p.period_id)
      ORDER BY p.starts_at,p.period_id LIMIT ? ON CONFLICT(period_id) DO NOTHING`)
      .bind(
        now,
        now,
        now,
        scope.apiOrigin,
        scope.spaceId,
        scope.environment,
        maximum,
      )
      .run();
    return result.meta.changes;
  }

  async claimNext(
    scope: RenewalScope,
    excludeContractId: string | null = null,
  ): Promise<RenewalCreateRecoveryWork | null> {
    validScope(scope);
    const now = clockValue(this.clock()),
      lease = crypto.randomUUID();
    // A crashed eighth attempt becomes terminal, without resetting any ledger.
    await this.db
      .prepare(`UPDATE prepaid_renewal_create_recovery_jobs SET state='failed',lease_token=NULL,lease_until=0,
      updated_at=?,last_error_code='unavailable' WHERE api_origin=? AND space_id=? AND environment=?
      AND state='processing' AND attempts=8 AND lease_until<=?`)
      .bind(now, scope.apiOrigin, scope.spaceId, scope.environment, now)
      .run();
    return this.db
      .prepare(`UPDATE prepaid_renewal_create_recovery_jobs SET state='processing',attempts=attempts+1,
      lease_token=?,lease_until=?,last_attempt_at=?,updated_at=?
      WHERE period_id=(SELECT period_id FROM prepaid_renewal_create_recovery_jobs
        WHERE api_origin=? AND space_id=? AND environment=? AND contract_id IS NOT ? AND attempts<8
        AND (state='queued' AND next_attempt_at<=? OR state='processing' AND lease_until<=?)
        ORDER BY COALESCE(last_attempt_at,0),created_at,period_id LIMIT 1)
      AND attempts<8 AND (state='queued' AND next_attempt_at<=? OR state='processing' AND lease_until<=?)
      RETURNING period_id,contract_id,ordinal,api_origin,space_id,environment,create_scope_hash,request_fingerprint,
      original_claim_token,lease_token,attempts,created_at`)
      .bind(
        lease,
        now + RENEWAL_RECOVERY_LEASE_SECONDS,
        now,
        now,
        scope.apiOrigin,
        scope.spaceId,
        scope.environment,
        excludeContractId,
        now,
        now,
        now,
        now,
      )
      .first<RenewalCreateRecoveryWork>();
  }

  async assertLive(work: RenewalCreateRecoveryWork): Promise<void> {
    const now = clockValue(this.clock());
    if (
      !(await this.db
        .prepare(
          `SELECT 1 FROM prepaid_renewal_create_recovery_jobs WHERE ${live}`,
        )
        .bind(...workValues(work, now))
        .first())
    )
      throw Error('Recovery lease lost.');
    const binding = await this.db
      .prepare(`SELECT 1 ${source} WHERE ${identity} AND p.period_id=? AND c.contract_id=?
      AND p.ordinal=? AND c.api_origin=? AND c.space_id=? AND c.environment=? AND r.create_scope_hash=?
      AND m.fingerprint=? AND (m.state IN('claimed','uncertain') AND m.claim_token=? AND m.response_json IS NULL
        OR m.state='completed' AND EXISTS(SELECT 1 FROM prepaid_create_recoveries z WHERE z.period_id=p.period_id
          AND z.original_claim_token=? AND z.request_fingerprint=m.fingerprint AND z.scope_hash=m.scope_hash))`)
      .bind(
        work.period_id,
        work.contract_id,
        work.ordinal,
        work.api_origin,
        work.space_id,
        work.environment,
        work.create_scope_hash,
        work.request_fingerprint,
        work.original_claim_token,
        work.original_claim_token,
      )
      .first();
    if (!binding) throw new PrepaidCreateRecoveryError('binding');
  }

  async renew(work: RenewalCreateRecoveryWork): Promise<boolean> {
    const now = clockValue(this.clock());
    const r = await this.db
      .prepare(
        `UPDATE prepaid_renewal_create_recovery_jobs SET lease_until=?,updated_at=? WHERE ${live}`,
      )
      .bind(now + RENEWAL_RECOVERY_LEASE_SECONDS, now, ...workValues(work, now))
      .run();
    return r.meta.changes === 1;
  }

  async defer(
    work: RenewalCreateRecoveryWork,
    code: RenewalRecoveryFailure,
  ): Promise<boolean> {
    if (!failures.includes(code)) throw Error('Invalid recovery failure.');
    const now = clockValue(this.clock());
    const r = await this.db
      .prepare(`UPDATE prepaid_renewal_create_recovery_jobs SET
      state=CASE WHEN attempts=8 THEN 'failed' ELSE 'queued' END,lease_token=NULL,lease_until=0,
      next_attempt_at=?+min(3600,60*(1 << min(attempts-1,6))),last_error_code=?,updated_at=? WHERE ${live}`)
      .bind(now, code, now, ...workValues(work, now))
      .run();
    return r.meta.changes === 1;
  }

  async complete(work: RenewalCreateRecoveryWork): Promise<boolean> {
    const now = clockValue(this.clock());
    const r = await this.db
      .prepare(`UPDATE prepaid_renewal_create_recovery_jobs SET
      state='completed',lease_token=NULL,lease_until=0,last_error_code=NULL,updated_at=? WHERE ${live}`)
      .bind(now, ...workValues(work, now))
      .run();
    return r.meta.changes === 1;
  }

  private leaseAssertion(
    work: RenewalCreateRecoveryWork,
    deadlineSeconds?: number,
  ) {
    const now = clockValue(this.clock());
    // This INSERT has zero rows for the actual lease holder. A miss attempts
    // an existing PK (or fails the source trigger), aborting the ENTIRE batch.
    // It neither creates a fake merchant operation nor silently accepts changes=0.
    return this.db
      .prepare(`INSERT INTO prepaid_renewal_create_recovery_jobs
      (period_id,contract_id,ordinal,api_origin,space_id,environment,create_scope_hash,request_fingerprint,
      original_claim_token,state,attempts,lease_token,lease_until,next_attempt_at,last_attempt_at,last_error_code,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,'queued',0,NULL,0,?,NULL,NULL,?,?
      WHERE NOT EXISTS(SELECT 1 FROM prepaid_renewal_create_recovery_jobs WHERE ${live}
        AND (? IS NULL OR unixepoch()<?))`)
      .bind(
        work.period_id,
        work.contract_id,
        work.ordinal,
        work.api_origin,
        work.space_id,
        work.environment,
        work.create_scope_hash,
        work.request_fingerprint,
        work.original_claim_token,
        work.created_at,
        work.created_at,
        now,
        ...workValues(work, now),
        deadlineSeconds ?? null,
        deadlineSeconds ?? null,
      );
  }

  fencedDatabase(
    work: RenewalCreateRecoveryWork,
    signal?: AbortSignal,
    deadlineSeconds?: number,
  ): Database {
    return {
      prepare: (query) => this.db.prepare(query),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        await this.assertLive(work);
        signal?.throwIfAborted();
        const results = await this.db.batch<T>([
          this.leaseAssertion(work, deadlineSeconds),
          ...statements,
          this.leaseAssertion(work, deadlineSeconds),
        ]);
        return results.slice(1, -1);
      },
    };
  }
}

export type RenewalCreateRecoveryResult =
  | Readonly<{ state: 'disabled' | 'idle' }>
  | Readonly<{
      state: 'pending' | 'failed';
      contractId: string;
      reason: RenewalRecoveryFailure;
    }>
  | (Extract<PrepaidCreateRecoveryResult, { state: 'bound' }> &
      Readonly<{ contractId: string }>);

/** One server-selected GET-only job. Never invokes the renewal dispatcher. */
export async function recoverOnePrepaidRenewalCreate(
  configuration: PrepaidCreateRecoveryConfiguration,
  dependencies: {
    database: () => Database;
    now?: () => number;
    fetch?: typeof fetch;
    signal?: AbortSignal;
    deadlineSeconds?: number;
    excludeContractId?: string | null;
  },
): Promise<RenewalCreateRecoveryResult> {
  if (
    configuration.enabled !== true ||
    configuration.createRecoveryEnabled !== true
  )
    return { state: 'disabled' };
  if (dependencies.deadlineSeconds !== undefined)
    clockValue(dependencies.deadlineSeconds);
  dependencies.signal?.throwIfAborted();
  const c = configuration.connection;
  if (
    !c.apiOrigin ||
    !c.spaceId ||
    !c.prepaidEnvironment ||
    c.enabled !== true ||
    c.merchantApproved !== true ||
    c.prepaidFeatureEnabled !== true ||
    c.chargeFlowEnabled !== true ||
    (c.prepaidEnvironment === 'PRODUCTION' &&
      configuration.settlementEvidenceVerified !== true)
  )
    throw Error('Invalid recovery configuration.');
  const scope = {
    apiOrigin: c.apiOrigin,
    spaceId: c.spaceId,
    environment: c.prepaidEnvironment,
  };
  const queue = new D1PrepaidRenewalCreateRecoveries(
    dependencies.database(),
    dependencies.now,
  );
  await queue.admit(scope);
  const work = await queue.claimNext(
    scope,
    dependencies.excludeContractId ?? null,
  );
  if (!work) return { state: 'idle' };
  const getOnly: typeof fetch = async (input, init) => {
    if (
      (init?.method ?? (input instanceof Request ? input.method : 'GET')) !==
        'GET' ||
      init?.body != null
    )
      throw Error('Recovery transport is GET-only.');
    await queue.assertLive(work);
    dependencies.signal?.throwIfAborted();
    if (!(await queue.renew(work))) throw Error('Recovery lease lost.');
    return (dependencies.fetch ?? fetch)(input, init);
  };
  let result: PrepaidCreateRecoveryResult;
  try {
    await queue.assertLive(work);
    dependencies.signal?.throwIfAborted();
    result = await recoverPrepaidCreate(
      configuration,
      { periodId: work.period_id },
      {
        ...dependencies,
        database: () =>
          queue.fencedDatabase(
            work,
            dependencies.signal,
            dependencies.deadlineSeconds,
          ),
        fetch: getOnly,
      },
    );
  } catch (error) {
    const reason: RenewalRecoveryFailure =
      error instanceof PrepaidCreateRecoveryError &&
      error.code !== 'configuration'
        ? error.code
        : 'unavailable';
    if (!(await queue.defer(work, reason))) throw Error('Recovery lease lost.');
    return {
      state: work.attempts === 8 ? 'failed' : 'pending',
      contractId: work.contract_id,
      reason,
    };
  }
  if (result.state === 'pending') {
    if (!(await queue.defer(work, result.reason)))
      throw Error('Recovery lease lost.');
    return {
      state: work.attempts === 8 ? 'failed' : 'pending',
      contractId: work.contract_id,
      reason: result.reason,
    };
  }
  if (result.state !== 'bound' || !(await queue.complete(work)))
    throw Error('Recovery lease lost.');
  return { ...result, contractId: work.contract_id };
}
