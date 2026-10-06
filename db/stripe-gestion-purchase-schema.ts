import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Only the zero-company fallback. The organization/subscription begin inactive,
// without a trial or paid proof. Explicit companies are never replaced here.
export const gestionPurchaseDrafts = sqliteTable(
  'gestion_purchase_drafts',
  {
    ownerId: text('owner_id').notNull(),
    environment: text('environment').notNull(),
    organizationId: text('organization_id').notNull().unique(),
    originalSubscriptionId: text('original_subscription_id').notNull().unique(),
    referralCode: text('referral_code'),
    referralClaimId: text('referral_claim_id'),
    couponId: text('coupon_id'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('gestion_draft_owner_environment').on(
      table.ownerId,
      table.environment,
    ),
    check(
      'gestion_draft_environment',
      sql`${table.environment} IN ('TEST','PRODUCTION')`,
    ),
  ],
);

export const gestionPurchaseRequests = sqliteTable(
  'gestion_purchase_requests',
  {
    requestId: text('request_id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    organizationId: text('organization_id').notNull(),
    previousSubscriptionId: text('previous_subscription_id').notNull(),
    environment: text('environment').notNull(),
    providerScope: text('provider_scope').notNull(),
    planId: text('plan_id').notNull(),
    accountEmail: text('account_email').notNull(),
    accountName: text('account_name').notNull(),
    origin: text('origin').notNull(),
    legalVersion: text('legal_version').notNull(),
    referralCode: text('referral_code'),
    referralClaimId: text('referral_claim_id'),
    couponId: text('coupon_id'),
    claimHash: text('claim_hash').notNull().unique(),
    sealedClaim: text('sealed_claim').notNull(),
    parametersJson: text('parameters_json').notNull(),
    intentId: text('intent_id').unique(),
    sessionId: text('session_id').unique(),
    sessionUrl: text('session_url'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    closedAt: integer('closed_at'),
  },
  (table) => [
    uniqueIndex('gestion_request_current_target')
      .on(table.organizationId, table.environment)
      .where(sql`${table.closedAt} IS NULL`),
    index('gestion_request_owner').on(table.ownerId, table.createdAt),
    check(
      'gestion_request_environment',
      sql`${table.environment} IN ('TEST','PRODUCTION')`,
    ),
  ],
);
