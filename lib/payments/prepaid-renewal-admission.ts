/** Scheduling only: this lease never authorizes payment or expires a financial claim. */
type Database = Pick<D1Database, 'prepare'>;
export type RenewalScope = Readonly<{
  apiOrigin: string;
  spaceId: number;
  environment: 'TEST' | 'PRODUCTION';
}>;
export type DueRenewal = Readonly<{
  contract_id: string;
  anchor_start: number;
  ordinal: number;
  starts_at: number;
  ends_at: number;
}>;
export type RenewalAdmission = DueRenewal &
  Readonly<{
    lease_token: string;
    lease_until: number;
    last_attempt_at: number;
  }>;
export type MandateFailureCode = 'mandate_rejected' | 'mandate_unavailable';
export const RENEWAL_ADMISSION_LEASE_SECONDS = 130;
export const RENEWAL_ADMISSION_MAX_BACKOFF_SECONDS = 3600;
// SQLite's '+1 month' on a day-31 timestamp can overflow into March. Start at
// the original anchor's month, then clamp its original day within the target
// month and retain its UTC time. These expressions match prepaidMonthlyPeriod.
function anchoredBoundary(offset: number) {
  return `CAST(strftime('%s',date(c.anchor_start,'unixepoch','start of month',
    printf('+%d months',p.ordinal+${offset}),printf('+%d days',min(
      CAST(strftime('%d',c.anchor_start,'unixepoch') AS INTEGER),
      CAST(strftime('%d',date(c.anchor_start,'unixepoch','start of month',
        printf('+%d months',p.ordinal+${offset + 1}),'-1 day')) AS INTEGER))-1))
    ||' '||strftime('%H:%M:%S',c.anchor_start,'unixepoch')) AS INTEGER)`;
}
const DUE_RENEWALS = `SELECT c.contract_id,c.anchor_start,p.ordinal+1 AS ordinal,
      p.ends_at AS starts_at,${anchoredBoundary(2)} AS ends_at
      FROM prepaid_contracts c JOIN prepaid_purchase_projections x ON x.contract_id=c.contract_id AND x.closed_at IS NOT NULL
      JOIN prepaid_periods p ON p.contract_id=c.contract_id JOIN prepaid_settlement_proofs proof ON proof.period_id=p.period_id
      JOIN prepaid_tokens token ON token.contract_id=c.contract_id AND token.owner_id=c.owner_id
        AND token.organization_id IS c.organization_id AND token.workspace_id IS c.workspace_id
        AND token.api_origin=c.api_origin AND token.space_id=c.space_id AND token.environment=c.environment
      WHERE c.cancelled_at IS NULL AND c.api_origin=? AND c.space_id=? AND c.environment=? AND p.ends_at<=?
      AND p.ends_at=${anchoredBoundary(1)} AND ${anchoredBoundary(2)}>?
      AND proof.reconciled_at<=?
      AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id)
      AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=token.initial_period_id)
      AND NOT EXISTS(SELECT 1 FROM prepaid_periods newer JOIN prepaid_settlement_proofs s ON s.period_id=newer.period_id
        WHERE newer.contract_id=c.contract_id AND newer.ordinal>p.ordinal)
      AND NOT EXISTS(SELECT 1 FROM account_session_policy a WHERE a.user_id=c.owner_id AND a.deleted_at IS NOT NULL)
      AND (c.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o
        JOIN organization_members member ON member.organization_id=o.organization_id
        WHERE o.organization_id=c.organization_id AND o.created_by_user_id=c.owner_id
        AND member.user_id=c.owner_id AND member.role='owner' AND member.revoked_at IS NULL
        AND (c.product_key NOT LIKE 'gestion:%' AND c.product_key NOT LIKE 'complet:%' OR o.subscription_id=c.contract_id)))
      AND (c.workspace_id IS NULL OR EXISTS(SELECT 1 FROM support_workspaces workspace
        WHERE workspace.id=c.workspace_id AND workspace.owner_id=c.owner_id))
      AND NOT EXISTS(SELECT 1 FROM prepaid_periods next
        JOIN prepaid_renewal_requests renewal ON renewal.period_id=next.period_id AND renewal.contract_id=c.contract_id
        LEFT JOIN postfinance_mutations created ON created.scope_hash=renewal.create_scope_hash
        LEFT JOIN postfinance_mutations applied ON applied.scope_hash=renewal.apply_scope_hash
        WHERE next.contract_id=c.contract_id AND next.ordinal=p.ordinal+1
        AND (created.state IN ('claimed','uncertain') OR applied.scope_hash IS NOT NULL))`;
function clockValue(value: number) {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    !Number.isSafeInteger(value + RENEWAL_ADMISSION_MAX_BACKOFF_SECONDS)
  )
    throw Error('Invalid scheduling clock.');
  return value;
}
function scopeValues(scope: RenewalScope, now: number) {
  if (
    scope.apiOrigin !== 'https://checkout.postfinance.ch' ||
    !Number.isSafeInteger(scope.spaceId) ||
    scope.spaceId <= 0 ||
    !['TEST', 'PRODUCTION'].includes(scope.environment)
  )
    throw Error('Invalid scheduling scope.');
  return [scope.apiOrigin, scope.spaceId, scope.environment, now, now, now];
}
export class D1PrepaidRenewalAdmission {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** The candidate and its scheduling lease are acquired in one SQL statement.
   * No SELECT-then-claim race; the original financial exclusions remain exact. */
  async claimNext(scope: RenewalScope): Promise<RenewalAdmission | null> {
    const now = clockValue(this.clock()),
      token = crypto.randomUUID();
    return this.db
      .prepare(`INSERT INTO prepaid_renewal_admissions
      (contract_id,ordinal,anchor_start,starts_at,ends_at,last_attempt_at,retry_at,
       lease_token,lease_until,failure_count,last_failure_code,updated_at)
      SELECT due.contract_id,due.ordinal,due.anchor_start,due.starts_at,due.ends_at,
        ?,?,?,?,0,NULL,? FROM (${DUE_RENEWALS}) due
      LEFT JOIN prepaid_renewal_admissions admission
        ON admission.contract_id=due.contract_id AND admission.ordinal=due.ordinal
      WHERE (admission.lease_token IS NULL OR admission.lease_until<=?)
        AND (admission.retry_at IS NULL OR admission.retry_at<=?)
      ORDER BY COALESCE(admission.last_attempt_at,0),due.starts_at,due.contract_id LIMIT 1
      ON CONFLICT(contract_id,ordinal) DO UPDATE SET
        last_attempt_at=excluded.last_attempt_at,retry_at=excluded.retry_at,
        lease_token=excluded.lease_token,lease_until=excluded.lease_until,
        updated_at=excluded.updated_at
      WHERE prepaid_renewal_admissions.lease_until<=excluded.last_attempt_at
        AND prepaid_renewal_admissions.retry_at<=excluded.last_attempt_at
        AND prepaid_renewal_admissions.anchor_start=excluded.anchor_start
        AND prepaid_renewal_admissions.starts_at=excluded.starts_at
        AND prepaid_renewal_admissions.ends_at=excluded.ends_at
      RETURNING contract_id,ordinal,anchor_start,starts_at,ends_at,
        last_attempt_at,lease_token,lease_until`)
      .bind(
        now,
        now,
        token,
        now + RENEWAL_ADMISSION_LEASE_SECONDS,
        now,
        ...scopeValues(scope, now),
        now,
        now,
      )
      .first<RenewalAdmission>();
  }

  /** Only the live lease holder records a failed GET admission. No token,
   * settlement proof, contract or merchant mutation is changed here. */
  async defer(
    admission: RenewalAdmission,
    code: MandateFailureCode,
  ): Promise<boolean> {
    if (!['mandate_rejected', 'mandate_unavailable'].includes(code))
      throw Error('Invalid scheduling failure.');
    const now = clockValue(this.clock());
    const result = await this.db
      .prepare(`UPDATE prepaid_renewal_admissions SET
      failure_count=min(failure_count+1,8),last_failure_code=?,updated_at=?,
      retry_at=?+min(3600,60*(1 << min(failure_count,6))),lease_token=NULL,lease_until=0
      WHERE contract_id=? AND ordinal=? AND lease_token=? AND last_attempt_at=?
        AND lease_until>? AND updated_at<=?`)
      .bind(
        code,
        now,
        now,
        admission.contract_id,
        admission.ordinal,
        admission.lease_token,
        admission.last_attempt_at,
        now,
        now,
      )
      .run();
    return result.meta.changes === 1;
  }

  /** Completes the scheduling attempt only. Submitted/uncertain merchant
   * operations stay immutable in their separate financial ledger. */
  async complete(admission: RenewalAdmission): Promise<boolean> {
    const now = clockValue(this.clock());
    const result = await this.db
      .prepare(`UPDATE prepaid_renewal_admissions SET
      failure_count=0,last_failure_code=NULL,updated_at=?,retry_at=?,lease_token=NULL,lease_until=0
      WHERE contract_id=? AND ordinal=? AND lease_token=? AND last_attempt_at=?
        AND lease_until>? AND updated_at<=?`)
      .bind(
        now,
        now,
        admission.contract_id,
        admission.ordinal,
        admission.lease_token,
        admission.last_attempt_at,
        now,
        now,
      )
      .run();
    return result.meta.changes === 1;
  }
}
