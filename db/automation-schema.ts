import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { organizations } from './schema';
export const founderPlatformOperations = sqliteTable(
  'founder_platform_operations',
  {
    operationId: text('operation_id').primaryKey(),
    actionHash: text('action_hash').notNull(),
    resultJson: text('result_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
);

export const founderAutomationGrants = sqliteTable(
  'founder_automation_grants',
  {
    email: text('email').primaryKey(),
    grantId: text('grant_id').notNull().unique(),
    userId: text('user_id').unique(),
    organizationId: text('organization_id')
      .unique()
      .references(() => organizations.organizationId),
    validFrom: integer('valid_from').notNull(),
    validUntil: integer('valid_until').notNull(),
    revokedAt: integer('revoked_at'),
    revision: integer('revision').notNull(),
    note: text('note').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastOperationId: text('last_operation_id').notNull(),
  },
);
export const founderAutomationEvents = sqliteTable(
  'founder_automation_events',
  {
    operationId: text('operation_id').primaryKey(),
    email: text('email').notNull(),
    actionHash: text('action_hash').notNull(),
    operation: text('operation').notNull(),
    validUntil: integer('valid_until').notNull(),
    createdAt: integer('created_at').notNull(),
    revision: integer('revision').notNull(),
  },
);

export const automationPlatform = sqliteTable('automation_platform', {
  id: text('id').primaryKey(),
  value: text('value').notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
export const automationSettings = sqliteTable('automation_settings', {
  revision: integer('revision').notNull().default(1),
  organizationId: text('organization_id')
    .primaryKey()
    .references(() => organizations.organizationId),
  enabled: integer('enabled').notNull().default(0),
  mode: text('mode').notNull().default('shadow'),
  flags: text('flags').notNull().default('[]'),
  mediumThreshold: real('medium_threshold').notNull().default(0.65),
  highThreshold: real('high_threshold').notNull().default(0.9),
  consentVersion: text('consent_version'),
  consentBy: text('consent_by'),
  consentAt: integer('consent_at'),
  updatedAt: integer('updated_at').notNull(),
});
export const automationSubscriptions = sqliteTable('automation_subscriptions', {
  organizationId: text('organization_id')
    .primaryKey()
    .references(() => organizations.organizationId),
  subscriptionId: text('subscription_id').notNull().unique(),
  customerId: text('customer_id').notNull(),
  status: text('status').notNull(),
  paidFrom: integer('paid_from').notNull().default(0),
  paidUntil: integer('paid_until').notNull().default(0),
  lastPaidInvoiceId: text('last_paid_invoice_id'),
  cancelAtPeriodEnd: integer('cancel_at_period_end').notNull().default(0),
  livemode: integer('livemode').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
// Keep refund evidence separate from the paid-period watermark. A delayed
// invoice.paid event must never restore access to a refunded period.
export const automationRefunds = sqliteTable('automation_refunds', {
  invoiceId: text('invoice_id').primaryKey(),
  customerId: text('customer_id').notNull(),
  livemode: integer('livemode').notNull(),
  verifiedAt: integer('verified_at').notNull(),
});
export const automationCheckouts = sqliteTable('automation_checkouts', {
  organizationId: text('organization_id')
    .primaryKey()
    .references(() => organizations.organizationId),
  attemptId: text('attempt_id').notNull(),
  requestJson: text('request_json'),
  sessionId: text('session_id').unique(),
  userId: text('user_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
});
export const automationDecisions = sqliteTable(
  'automation_decisions',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.organizationId),
    userId: text('user_id').notNull(),
    requestId: text('request_id').notNull(),
    feature: text('feature').notNull(),
    mode: text('mode').notNull(),
    contextHash: text('context_hash').notNull(),
    options: text('options').notNull(),
    result: text('result'),
    confidence: real('confidence'),
    provider: text('provider'),
    model: text('model'),
    policyVersion: text('policy_version').notNull(),
    errorCode: text('error_code'),
    latencyMs: integer('latency_ms').notNull().default(0),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cost: real('cost'),
    state: text('state').notNull(),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
    feedback: text('feedback'),
    finalChoices: text('final_choices'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: integer('reviewed_at'),
  },
  (t) => [
    uniqueIndex('automation_request_identity').on(
      t.organizationId,
      t.userId,
      t.requestId,
    ),
    index('automation_org_created').on(t.organizationId, t.createdAt),
    index('automation_org_completed').on(t.organizationId, t.completedAt),
    index('automation_org_reviewed').on(t.organizationId, t.reviewedAt),
    index('automation_decision_created').on(t.createdAt),
  ],
);

export const referralCodes = sqliteTable('referral_codes', {
  organizationId: text('organization_id')
    .primaryKey()
    .references(() => organizations.organizationId),
  code: text('code').notNull().unique(),
  createdAt: integer('created_at').notNull(),
});
export const referralClaims = sqliteTable(
  'referral_claims',
  {
    id: text('id').primaryKey(),
    referrerOrganizationId: text('referrer_organization_id')
      .notNull()
      .references(() => organizations.organizationId),
    referredUserId: text('referred_user_id').notNull().unique(),
    referredOrganizationId: text('referred_organization_id')
      .unique()
      .references(() => organizations.organizationId),
    checkoutSessionId: text('checkout_session_id').unique(),
    subscriptionId: text('subscription_id').unique(),
    state: text('state').notNull(),
    firstInvoiceId: text('first_invoice_id').unique(),
    rewardCouponId: text('reward_coupon_id'),
    rewardSubscriptionId: text('reward_subscription_id'),
    rewardInvoiceId: text('reward_invoice_id').unique(),
    rewardAppliedAt: integer('reward_applied_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('referral_referrer_state').on(t.referrerOrganizationId, t.state),
  ],
);
