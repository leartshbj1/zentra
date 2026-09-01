import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const checkoutAttempts = sqliteTable(
  'checkout_attempts',
  {
    claimHash: text('claim_hash').primaryKey(),
    checkoutSessionId: text('checkout_session_id'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [
    uniqueIndex('checkout_attempts_session_idx').on(table.checkoutSessionId),
    index('checkout_attempts_expiry_idx').on(table.expiresAt),
  ],
);

export const subscriptions = sqliteTable(
  'subscriptions',
  {
    subscriptionId: text('subscription_id').primaryKey(),
    customerId: text('customer_id').notNull(),
    checkoutSessionId: text('checkout_session_id'),
    customerEmail: text('customer_email'),
    customerName: text('customer_name'),
    priceId: text('price_id').notNull(),
    status: text('status').notNull(),
    currentPeriodEnd: integer('current_period_end').notNull(),
    cancelAtPeriodEnd: integer('cancel_at_period_end', { mode: 'boolean' })
      .notNull()
      .default(false),
    livemode: integer('livemode', { mode: 'boolean' }).notNull().default(false),
    entitlementValidUntil: integer('entitlement_valid_until')
      .notNull()
      .default(0),
    lastPaidInvoiceId: text('last_paid_invoice_id'),
    lastPaidAt: integer('last_paid_at'),
    lastPaymentFailureInvoiceId: text('last_payment_failure_invoice_id'),
    lastPaymentFailureAt: integer('last_payment_failure_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('subscriptions_checkout_session_idx').on(
      table.checkoutSessionId,
    ),
    index('subscriptions_customer_idx').on(table.customerId),
    index('subscriptions_status_idx').on(table.status, table.currentPeriodEnd),
  ],
);

export const licenseActivations = sqliteTable(
  'license_activations',
  {
    licenseId: text('license_id').primaryKey(),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => subscriptions.subscriptionId, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    installationId: text('installation_id').notNull(),
    activatedAt: integer('activated_at').notNull(),
    lastIssuedAt: integer('last_issued_at').notNull(),
  },
  (table) => [
    uniqueIndex('license_activations_subscription_installation_idx').on(
      table.subscriptionId,
      table.installationId,
    ),
    uniqueIndex('license_activations_one_device_idx').on(table.subscriptionId),
  ],
);

export const stripeEvents = sqliteTable(
  'stripe_events',
  {
    eventId: text('event_id').primaryKey(),
    eventType: text('event_type').notNull(),
    livemode: integer('livemode', { mode: 'boolean' }).notNull(),
    eventCreatedAt: integer('event_created_at').notNull().default(0),
    receivedAt: integer('received_at').notNull(),
    processingStartedAt: integer('processing_started_at'),
    processingAttempts: integer('processing_attempts').notNull().default(0),
    processedAt: integer('processed_at'),
  },
  (table) => [
    index('stripe_events_processed_idx').on(table.processedAt),
    index('stripe_events_processing_idx').on(table.processingStartedAt),
  ],
);

export const checkoutRateLimits = sqliteTable(
  'checkout_rate_limits',
  {
    rateKey: text('rate_key').primaryKey(),
    count: integer('count').notNull().default(1),
    windowStartedAt: integer('window_started_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('checkout_rate_limits_expiry_idx').on(table.expiresAt)],
);
