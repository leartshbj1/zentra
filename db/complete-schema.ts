import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
