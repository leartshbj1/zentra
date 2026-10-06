import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const stripeSupportPaidProjections = sqliteTable(
  'stripe_support_paid_projections',
  {
    requestId: text('request_id').primaryKey(),
    intentId: text('intent_id').notNull(),
    ownerId: text('owner_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    organizationId: text('organization_id'),
    environment: text('environment').notNull(),
    providerScope: text('provider_scope').notNull(),
    sessionId: text('session_id').notNull(),
    subscriptionId: text('subscription_id').notNull(),
    customerId: text('customer_id').notNull(),
    priceId: text('price_id').notNull(),
    planId: text('plan_id').notNull(),
    invoiceId: text('invoice_id').notNull(),
    paidFrom: integer('paid_from').notNull(),
    paidUntil: integer('paid_until').notNull(),
    evidenceFingerprint: text('evidence_fingerprint').notNull(),
    verifiedAt: integer('verified_at').notNull(),
  },
  (table) => [
    uniqueIndex('stripe_support_projection_intent_unique').on(table.intentId),
    uniqueIndex('stripe_support_projection_session_unique').on(table.sessionId),
    uniqueIndex('stripe_support_projection_invoice_unique').on(table.invoiceId),
    check(
      'stripe_support_projection_environment',
      sql`${table.environment} IN ('TEST','PRODUCTION')`,
    ),
    check(
      'stripe_support_projection_period',
      sql`${table.paidFrom}>0 AND ${table.paidUntil}>${table.paidFrom} AND ${table.verifiedAt}>0`,
    ),
    check(
      'stripe_support_projection_hash',
      sql`length(${table.evidenceFingerprint})=64 AND ${table.evidenceFingerprint} NOT GLOB '*[^a-f0-9]*'`,
    ),
  ],
);
export const supportRefunds = sqliteTable(
  'support_refunds',
  {
    invoiceId: text('invoice_id').primaryKey(),
    customerId: text('customer_id').notNull(),
    livemode: integer('livemode').notNull(),
    verifiedAt: integer('verified_at').notNull(),
  },
  (table) => [
    check('support_refund_environment', sql`${table.livemode} IN (0,1)`),
  ],
);
