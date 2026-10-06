import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { prepaidContracts, prepaidPeriods } from './prepaid-schema';

// GET-only renewal recovery scheduling. This table grants no paid access and
// never releases or retries a financial mutation claim.
export const prepaidRenewalCreateRecoveryJobs = sqliteTable(
  'prepaid_renewal_create_recovery_jobs',
  {
    periodId: text('period_id')
      .primaryKey()
      .references(() => prepaidPeriods.periodId),
    contractId: text('contract_id')
      .notNull()
      .references(() => prepaidContracts.contractId),
    ordinal: integer('ordinal').notNull(),
    apiOrigin: text('api_origin').notNull(),
    spaceId: integer('space_id').notNull(),
    environment: text('environment').notNull(),
    createScopeHash: text('create_scope_hash').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    originalClaimToken: text('original_claim_token').notNull(),
    state: text('state').notNull(),
    attempts: integer('attempts').notNull(),
    leaseToken: text('lease_token'),
    leaseUntil: integer('lease_until').notNull(),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    lastAttemptAt: integer('last_attempt_at'),
    lastErrorCode: text('last_error_code'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('prepaid_renewal_create_recovery_due').on(
      t.apiOrigin,
      t.spaceId,
      t.environment,
      t.state,
      t.nextAttemptAt,
      t.lastAttemptAt,
      t.createdAt,
      t.periodId,
    ),
    check(
      'prepaid_renewal_create_recovery_ordinal',
      sql`typeof(${t.ordinal})='integer' AND ${t.ordinal} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      'prepaid_renewal_create_recovery_origin',
      sql`${t.apiOrigin} IN ('https://checkout.postfinance.ch','https://app-wallee.com')`,
    ),
    check(
      'prepaid_renewal_create_recovery_space',
      sql`typeof(${t.spaceId})='integer' AND ${t.spaceId}>0`,
    ),
    check(
      'prepaid_renewal_create_recovery_environment',
      sql`${t.environment} IN ('TEST','PRODUCTION')`,
    ),
    check(
      'prepaid_renewal_create_recovery_scope_hash',
      sql`length(${t.createScopeHash})=64 AND ${t.createScopeHash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      'prepaid_renewal_create_recovery_request',
      sql`length(${t.requestFingerprint})=43 AND ${t.requestFingerprint} NOT GLOB '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      'prepaid_renewal_create_recovery_claim',
      sql`length(${t.originalClaimToken})=36 AND ${t.originalClaimToken} NOT GLOB '*[^a-f0-9-]*'`,
    ),
    check(
      'prepaid_renewal_create_recovery_state',
      sql`${t.state} IN ('queued','processing','completed','failed')`,
    ),
    check(
      'prepaid_renewal_create_recovery_attempts',
      sql`typeof(${t.attempts})='integer' AND ${t.attempts} BETWEEN 0 AND 8`,
    ),
    check(
      'prepaid_renewal_create_recovery_lease_until',
      sql`typeof(${t.leaseUntil})='integer' AND ${t.leaseUntil}>=0`,
    ),
    check(
      'prepaid_renewal_create_recovery_next_attempt',
      sql`typeof(${t.nextAttemptAt})='integer' AND ${t.nextAttemptAt}>0`,
    ),
    check(
      'prepaid_renewal_create_recovery_last_attempt',
      sql`${t.lastAttemptAt} IS NULL OR typeof(${t.lastAttemptAt})='integer' AND ${t.lastAttemptAt}>0`,
    ),
    check(
      'prepaid_renewal_create_recovery_error',
      sql`${t.lastErrorCode} IS NULL OR ${t.lastErrorCode} IN ('absent','ambiguous','unstable','unavailable','binding','not-claimed','provider-binding')`,
    ),
    check(
      'prepaid_renewal_create_recovery_created',
      sql`typeof(${t.createdAt})='integer' AND ${t.createdAt}>0`,
    ),
    check(
      'prepaid_renewal_create_recovery_updated',
      sql`typeof(${t.updatedAt})='integer' AND ${t.updatedAt}>=${t.createdAt}`,
    ),
    check(
      'prepaid_renewal_create_recovery_due',
      sql`${t.nextAttemptAt}>=${t.createdAt}`,
    ),
    check(
      'prepaid_renewal_create_recovery_lease',
      sql`(${t.state}='processing' AND length(${t.leaseToken})=36 AND ${t.leaseToken} NOT GLOB '*[^a-f0-9-]*' AND ${t.leaseUntil}>${t.updatedAt} AND ${t.leaseUntil}<=${t.updatedAt}+130 AND ${t.lastAttemptAt} IS NOT NULL) OR (${t.state}!='processing' AND ${t.leaseToken} IS NULL AND ${t.leaseUntil}=0)`,
    ),
    check(
      'prepaid_renewal_create_recovery_attempt_state',
      sql`(${t.state} IN ('processing','completed','failed') AND ${t.attempts}>0) OR ${t.state}='queued'`,
    ),
    check(
      'prepaid_renewal_create_recovery_failed',
      sql`${t.state}!='failed' OR ${t.attempts}=8`,
    ),
  ],
);
