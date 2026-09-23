import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const completeTrials = sqliteTable('complete_trials', {
  userId: text('user_id').primaryKey(),
  organizationId: text('organization_id').notNull().unique(),
  analyses: integer('analyses').notNull().default(250),
});
export const completePlanChanges = sqliteTable('complete_plan_changes', {
  organizationId:text('organization_id').primaryKey(),
  operationId:text('operation_id').notNull().unique(),
  userId:text('user_id').notNull(),
  subscriptionId:text('subscription_id').notNull(),
  targetPlan:text('target_plan').notNull(),
  effectiveAt:integer('effective_at').notNull(),
  state:text('state').notNull(),
  sourceJson:text('source_json').notNull(),
  scheduleId:text('schedule_id'),
  createdAt:integer('created_at').notNull(),
  updatedAt:integer('updated_at').notNull(),
});
export const completeOnboarding = sqliteTable('complete_onboarding', {
  organizationId:text('organization_id').primaryKey(),
  skippedJson:text('skipped_json').notNull().default('[]'),
  updatedAt:integer('updated_at').notNull(),
});

export const completeSubscriptions = sqliteTable('complete_subscriptions', {
  subscriptionId: text('subscription_id').primaryKey(),
  planId: text('plan_id').notNull(),
  paidPlanId: text('paid_plan_id'),
  paidFrom: integer('paid_from').notNull().default(0),
  paidUntil: integer('paid_until').notNull().default(0),
  lastPaidInvoiceId: text('last_paid_invoice_id'),
});
export const completeRefunds = sqliteTable('complete_refunds', {
  invoiceId: text('invoice_id').primaryKey(),
  customerId: text('customer_id').notNull(),
  livemode: integer('livemode').notNull(),
  verifiedAt: integer('verified_at').notNull(),
});
export const completeCheckouts = sqliteTable('complete_checkouts', {
  userId: text('user_id').primaryKey(),
  nonce: text('nonce').notNull(),
  planId: text('plan_id').notNull(),
  parameters: text('parameters').notNull(),
  expiresAt: integer('expires_at').notNull(),
  sessionId: text('session_id'),
  sessionUrl: text('session_url'),
});
