import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { prepaidTransactions } from './prepaid-schema';
/** Read-only provider observations have their own identity, not an alleged
 * webhook event. Terminal failures stay terminal until an explicit later tool. */
export const postfinanceObservationJobs = sqliteTable(
  'postfinance_observation_jobs',
  {
    jobId: text('job_id').primaryKey(),
    scopeHash: text('scope_hash').notNull(),
    periodId: text('period_id')
      .notNull()
      .references(() => prepaidTransactions.periodId),
    apiOrigin: text('api_origin').notNull(),
    spaceId: integer('space_id').notNull(),
    environment: text('environment').notNull(),
    transactionId: integer('transaction_id').notNull(),
    bindingFingerprint: text('binding_fingerprint').notNull(),
    bindingJson: text('binding_json').notNull(),
    provenance: text('provenance').notNull(),
    recoveryEvidenceFingerprint: text('recovery_evidence_fingerprint'),
    state: text('state').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lease: text('lease'),
    leaseUntil: integer('lease_until').notNull().default(0),
    dueAt: integer('due_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    completedAt: integer('completed_at'),
    lastErrorCode: text('last_error_code'),
  },
  (t) => [
    uniqueIndex('postfinance_observation_scope_unique').on(t.scopeHash),
    uniqueIndex('postfinance_observation_period_unique').on(t.periodId),
    index('postfinance_observation_due').on(
      t.apiOrigin,
      t.spaceId,
      t.environment,
      t.state,
      t.dueAt,
      t.leaseUntil,
    ),
    check(
      'postfinance_observation_identity',
      sql`length(${t.scopeHash})=64 AND ${t.scopeHash} NOT GLOB '*[^a-f0-9]*' AND ${t.jobId}=('pfobserve_'||${t.scopeHash}) AND length(${t.bindingFingerprint})=64 AND ${t.bindingFingerprint} NOT GLOB '*[^a-f0-9]*'`,
    ),
    check(
      'postfinance_observation_scope',
      sql`${t.apiOrigin} IN('https://checkout.postfinance.ch','https://app-wallee.com') AND ${t.spaceId}>0 AND ${t.transactionId}>0 AND ${t.environment} IN('TEST','PRODUCTION')`,
    ),
    check(
      'postfinance_observation_json',
      sql`json_valid(${t.bindingJson}) AND json_type(${t.bindingJson})='object' AND length(CAST(${t.bindingJson} AS BLOB))<=16384`,
    ),
    check(
      'postfinance_observation_provenance',
      sql`(${t.provenance}='bound_fallback' AND ${t.recoveryEvidenceFingerprint} IS NULL) OR(${t.provenance}='create_recovery' AND length(${t.recoveryEvidenceFingerprint})=64 AND ${t.recoveryEvidenceFingerprint} NOT GLOB '*[^a-f0-9]*')`,
    ),
    check(
      'postfinance_observation_state',
      sql`${t.state} IN('pending','processing','completed','failed') AND ${t.attempts} BETWEEN 0 AND 8 AND ((${t.state}='processing' AND ${t.lease} IS NOT NULL AND length(${t.lease})=36 AND ${t.leaseUntil}>0 AND ${t.attempts}>0) OR(${t.state}!='processing' AND ${t.lease} IS NULL AND ${t.leaseUntil}=0))`,
    ),
    check(
      'postfinance_observation_time',
      sql`${t.createdAt}>0 AND ${t.updatedAt}>=${t.createdAt} AND ${t.dueAt}>0 AND (${t.completedAt} IS NULL OR(${t.state}='completed' AND ${t.completedAt}=${t.updatedAt})) AND (${t.state}!='completed' OR ${t.completedAt} IS NOT NULL)`,
    ),
    check(
      'postfinance_observation_error',
      sql`${t.lastErrorCode} IS NULL OR ${t.lastErrorCode} IN('provider_unavailable','settlement_pending','ownership_mismatch','ambiguous_period','invalid_provider_state','storage_unavailable')`,
    ),
  ],
);
