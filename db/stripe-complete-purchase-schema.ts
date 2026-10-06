import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  check,
} from 'drizzle-orm/sqlite-core';
export const stripeCompletePurchaseDrafts = sqliteTable(
  'stripe_complete_purchase_drafts',
  {
    ownerId: text('owner_id').notNull(),
    environment: text('environment').notNull(),
    organizationId: text('organization_id').notNull(),
    originalSubscriptionId: text('original_subscription_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('stripe_complete_draft_owner').on(t.ownerId, t.environment),
    uniqueIndex('stripe_complete_draft_org').on(t.organizationId),
    uniqueIndex('stripe_complete_draft_subscription').on(
      t.originalSubscriptionId,
    ),
    check(
      'stripe_complete_draft_environment',
      sql`${t.environment} IN ('TEST','PRODUCTION')`,
    ),
  ],
);
export const stripeCompletePurchaseRequests = sqliteTable(
  'stripe_complete_purchase_requests',
  {
    requestId: text('request_id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    previousSubscriptionId: text('previous_subscription_id').notNull(),
    trialSubscriptionId: text('trial_subscription_id'),
    environment: text('environment').notNull(),
    providerScope: text('provider_scope').notNull(),
    planId: text('plan_id').notNull(),
    accountEmail: text('account_email').notNull(),
    accountName: text('account_name').notNull(),
    origin: text('origin').notNull(),
    legalVersion: text('legal_version').notNull(),
    catalogJson: text('catalog_json').notNull(),
    claimHash: text('claim_hash').notNull(),
    parametersJson: text('parameters_json').notNull(),
    intentId: text('intent_id'),
    sessionId: text('session_id'),
    sessionUrl: text('session_url'),
    subscriptionId: text('subscription_id'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    closedAt: integer('closed_at'),
  },
  (t) => [
    uniqueIndex('stripe_complete_request_current_owner')
      .on(t.ownerId, t.environment)
      .where(sql`${t.closedAt} IS NULL`),
    uniqueIndex('stripe_complete_request_current_org')
      .on(t.organizationId, t.environment)
      .where(sql`${t.closedAt} IS NULL`),
    uniqueIndex('stripe_complete_request_current_workspace')
      .on(t.workspaceId, t.environment)
      .where(sql`${t.closedAt} IS NULL`),
    uniqueIndex('stripe_complete_request_claim').on(t.claimHash),
    uniqueIndex('stripe_complete_request_intent').on(t.intentId),
    uniqueIndex('stripe_complete_request_session').on(t.sessionId),
    uniqueIndex('stripe_complete_request_subscription').on(t.subscriptionId),
    check(
      'stripe_complete_request_environment',
      sql`${t.environment} IN ('TEST','PRODUCTION')`,
    ),
    check(
      'stripe_complete_request_json',
      sql`json_valid(${t.catalogJson}) AND json_type(${t.catalogJson})='object' AND length(CAST(${t.catalogJson} AS BLOB))<=8192 AND json_valid(${t.parametersJson}) AND json_type(${t.parametersJson})='object' AND length(CAST(${t.parametersJson} AS BLOB))<=16384`,
    ),
    check(
      'stripe_complete_request_time',
      sql`${t.createdAt}>0 AND ${t.expiresAt}=${t.createdAt}+3600`,
    ),
  ],
);
export const stripeCompletePaidProjections = sqliteTable(
  'stripe_complete_paid_projections',
  {
    requestId: text('request_id').primaryKey(),
    intentId: text('intent_id').notNull(),
    ownerId: text('owner_id').notNull(),
    organizationId: text('organization_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    previousSubscriptionId: text('previous_subscription_id').notNull(),
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
    paidAt: integer('paid_at').notNull(),
    evidenceFingerprint: text('evidence_fingerprint').notNull(),
    verifiedAt: integer('verified_at').notNull(),
  },
  (t) => [
    uniqueIndex('stripe_complete_projection_intent').on(t.intentId),
    uniqueIndex('stripe_complete_projection_session').on(t.sessionId),
    uniqueIndex('stripe_complete_projection_invoice').on(t.invoiceId),
    uniqueIndex('stripe_complete_projection_subscription').on(t.subscriptionId),
    check(
      'stripe_complete_projection_environment',
      sql`${t.environment} IN ('TEST','PRODUCTION')`,
    ),
    check(
      'stripe_complete_projection_time',
      sql`${t.paidFrom}>0 AND ${t.paidUntil}>${t.paidFrom} AND ${t.paidAt}>0 AND ${t.verifiedAt}>0`,
    ),
    check(
      'stripe_complete_projection_fingerprint',
      sql`length(${t.evidenceFingerprint})=64 AND ${t.evidenceFingerprint} NOT GLOB '*[^a-f0-9]*'`,
    ),
  ],
);
