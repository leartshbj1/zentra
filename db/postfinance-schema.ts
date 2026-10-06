import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

// These journals do not grant access. Provider settlement is reconciled separately.
export const postfinanceMutations = sqliteTable(
  'postfinance_mutations',
  {
    scopeHash: text('scope_hash').primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    state: text('state').notNull(),
    claimToken: text('claim_token'),
    responseJson: text('response_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('postfinance_mutations_state_idx').on(table.state, table.updatedAt),
    check(
      'postfinance_mutations_state_check',
      sql`${table.state} IN ('claimed','completed','uncertain')`,
    ),
    check(
      'postfinance_mutations_result_check',
      sql`(${table.state}='completed' AND ${table.responseJson} IS NOT NULL AND ${table.claimToken} IS NULL) OR (${table.state} IN ('claimed','uncertain') AND ${table.responseJson} IS NULL AND ${table.claimToken} IS NOT NULL)`,
    ),
  ],
);

// The durable inbox row IS the queue item: an accepted event cannot lose its work.
export const postfinanceWebhookInbox = sqliteTable(
  'postfinance_webhook_inbox',
  {
    scopeHash: text('scope_hash').primaryKey(),
    environmentHash: text('environment_hash').notNull(),
    listenerId: integer('listener_id').notNull(),
    eventFingerprint: text('event_fingerprint').notNull(),
    eventJson: text('event_json').notNull(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lease: text('lease'),
    leaseUntil: integer('lease_until').notNull().default(0),
    dueAt: integer('due_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    completedAt: integer('completed_at'),
    lastErrorCode: text('last_error_code'),
  },
  (table) => [
    index('postfinance_webhook_work_idx').on(
      table.environmentHash,
      table.state,
      table.dueAt,
      table.leaseUntil,
    ),
    check(
      'postfinance_webhook_state_check',
      sql`${table.state} IN ('pending','processing','completed','failed')`,
    ),
    check(
      'postfinance_webhook_attempts_check',
      sql`${table.attempts} >= 0 AND ${table.attempts} <= 8`,
    ),
    check(
      'postfinance_webhook_lease_check',
      sql`(${table.state}='processing' AND ${table.lease} IS NOT NULL AND ${table.leaseUntil}>0) OR (${table.state}<>'processing' AND ${table.lease} IS NULL AND ${table.leaseUntil}=0)`,
    ),
  ],
);
