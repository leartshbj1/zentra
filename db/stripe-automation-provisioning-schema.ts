import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const stripeAutomationPaidProjections = sqliteTable(
  'stripe_automation_paid_projections',
  {
    requestId: text('request_id').primaryKey(),
    intentId: text('intent_id').notNull(),
    ownerId: text('owner_id').notNull(),
    organizationId: text('organization_id').notNull(),
    environment: text('environment').notNull(),
    providerScope: text('provider_scope').notNull(),
    sessionId: text('session_id').notNull(),
    subscriptionId: text('subscription_id').notNull(),
    customerId: text('customer_id').notNull(),
    priceId: text('price_id').notNull(),
    baseSubscriptionId: text('base_subscription_id').notNull(),
    baseCustomerId: text('base_customer_id').notNull(),
    invoiceId: text('invoice_id').notNull(),
    paidFrom: integer('paid_from').notNull(),
    paidUntil: integer('paid_until').notNull(),
    evidenceFingerprint: text('evidence_fingerprint').notNull(),
    verifiedAt: integer('verified_at').notNull(),
  },
  (table) => [
    uniqueIndex('stripe_automation_projection_intent_unique').on(
      table.intentId,
    ),
    uniqueIndex('stripe_automation_projection_session_unique').on(
      table.sessionId,
    ),
    uniqueIndex('stripe_automation_projection_invoice_unique').on(
      table.invoiceId,
    ),
    check(
      'stripe_automation_projection_environment',
      sql`${table.environment} IN ('TEST','PRODUCTION')`,
    ),
    check(
      'stripe_automation_projection_period',
      sql`${table.paidFrom}>0 AND ${table.paidUntil}>${table.paidFrom} AND ${table.verifiedAt}>0`,
    ),
    check(
      'stripe_automation_projection_hash',
      sql`length(${table.evidenceFingerprint})=64 AND ${table.evidenceFingerprint} NOT GLOB '*[^a-f0-9]*'`,
    ),
  ],
);
