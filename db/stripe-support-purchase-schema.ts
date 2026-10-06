import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Financial inputs are write-once. Only provider receipts and the final closure
// can advance; the common purchase intent owns all cross-provider footprints.
export const stripeSupportPurchaseRequests = sqliteTable(
  'stripe_support_purchase_requests',
  {
    requestId: text('request_id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    organizationId: text('organization_id'),
    ownerId: text('owner_id').notNull(),
    environment: text('environment').notNull(),
    providerScope: text('provider_scope').notNull(),
    planId: text('plan_id').notNull(),
    accountEmail: text('account_email').notNull(),
    origin: text('origin').notNull(),
    legalVersion: text('legal_version').notNull(),
    acceptedAt: integer('accepted_at').notNull(),
    parametersJson: text('parameters_json').notNull(),
    intentId: text('intent_id'),
    sessionId: text('session_id'),
    sessionUrl: text('session_url'),
    subscriptionId: text('subscription_id'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    closedAt: integer('closed_at'),
  },
  (table) => [
    uniqueIndex('stripe_support_request_current_target')
      .on(table.workspaceId, table.environment)
      .where(sql`${table.closedAt} IS NULL`),
    index('stripe_support_request_owner').on(table.ownerId, table.createdAt),
    uniqueIndex('stripe_support_request_intent_unique').on(table.intentId),
    uniqueIndex('stripe_support_request_session_unique').on(table.sessionId),
    uniqueIndex('stripe_support_request_subscription_unique').on(
      table.subscriptionId,
    ),
    check(
      'stripe_support_request_environment',
      sql`${table.environment} IN ('TEST','PRODUCTION')`,
    ),
    check(
      'stripe_support_request_parameters',
      sql`json_valid(${table.parametersJson}) AND json_type(${table.parametersJson})='object' AND length(CAST(${table.parametersJson} AS BLOB))<=16384`,
    ),
    check(
      'stripe_support_request_timestamps',
      sql`${table.createdAt}>0 AND ${table.acceptedAt}=${table.createdAt} AND ${table.expiresAt}>${table.createdAt}`,
    ),
  ],
);
