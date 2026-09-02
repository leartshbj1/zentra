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
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    uniqueIndex('license_activations_subscription_installation_idx').on(
      table.subscriptionId,
      table.installationId,
    ),
    index('license_activations_subscription_idx').on(table.subscriptionId),
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

export const stripeWebhookProofs = sqliteTable('stripe_webhook_proofs', {
  endpointId: text('endpoint_id').primaryKey(),
  secretSha256: text('secret_sha256').notNull(),
  livemode: integer('livemode', { mode: 'boolean' }).notNull(),
  apiVersion: text('api_version').notNull(),
  lastVerifiedEventId: text('last_verified_event_id').notNull(),
  verifiedAt: integer('verified_at').notNull(),
});

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

export const organizations = sqliteTable(
  'organizations',
  {
    organizationId: text('organization_id').primaryKey(),
    name: text('name').notNull(),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => subscriptions.subscriptionId, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    createdByUserId: text('created_by_user_id').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('organizations_subscription_idx').on(table.subscriptionId),
    index('organizations_creator_idx').on(table.createdByUserId),
  ],
);

export const organizationMembers = sqliteTable(
  'organization_members',
  {
    membershipId: text('membership_id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.organizationId, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    userId: text('user_id').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    role: text('role').notNull(),
    joinedAt: integer('joined_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    uniqueIndex('organization_members_user_idx').on(
      table.organizationId,
      table.userId,
    ),
    index('organization_members_email_idx').on(table.email),
    index('organization_members_active_idx').on(
      table.organizationId,
      table.revokedAt,
    ),
  ],
);

export const organizationInvitations = sqliteTable(
  'organization_invitations',
  {
    invitationId: text('invitation_id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.organizationId, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    tokenHash: text('token_hash').notNull(),
    invitedEmail: text('invited_email'),
    role: text('role').notNull(),
    createdByUserId: text('created_by_user_id').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    acceptedByUserId: text('accepted_by_user_id'),
    acceptedAt: integer('accepted_at'),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    uniqueIndex('organization_invitations_token_idx').on(table.tokenHash),
    index('organization_invitations_expiry_idx').on(table.expiresAt),
  ],
);

export const deviceAuthorizations = sqliteTable(
  'device_authorizations',
  {
    deviceCodeHash: text('device_code_hash').primaryKey(),
    userCode: text('user_code').notNull(),
    installationId: text('installation_id').notNull(),
    status: text('status').notNull(),
    organizationId: text('organization_id').references(
      () => organizations.organizationId,
      { onDelete: 'cascade', onUpdate: 'cascade' },
    ),
    approvedByUserId: text('approved_by_user_id'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    approvedAt: integer('approved_at'),
    consumedAt: integer('consumed_at'),
  },
  (table) => [
    uniqueIndex('device_authorizations_user_code_idx').on(table.userCode),
    index('device_authorizations_expiry_idx').on(table.expiresAt),
  ],
);

export const deviceSessions = sqliteTable(
  'device_sessions',
  {
    sessionId: text('session_id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.organizationId, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    userId: text('user_id').notNull(),
    installationId: text('installation_id').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    uniqueIndex('device_sessions_token_idx').on(table.tokenHash),
    index('device_sessions_organization_idx').on(
      table.organizationId,
      table.revokedAt,
    ),
    index('device_sessions_user_idx').on(table.userId, table.revokedAt),
  ],
);

export const invoiceArchives = sqliteTable(
  'invoice_archives',
  {
    archiveId: text('archive_id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.organizationId, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    sourceInvoiceId: text('source_invoice_id').notNull(),
    revision: integer('revision').notNull(),
    invoiceNumber: text('invoice_number').notNull(),
    issueDate: text('issue_date').notNull(),
    paidAt: text('paid_at'),
    correctionKind: text('correction_kind').notNull(),
    correctionReason: text('correction_reason'),
    supersedesArchiveId: text('supersedes_archive_id'),
    objectKey: text('object_key').notNull(),
    contentSha256: text('content_sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    mediaType: text('media_type').notNull(),
    previousChainSha256: text('previous_chain_sha256'),
    chainSha256: text('chain_sha256').notNull(),
    retentionUntil: text('retention_until').notNull(),
    storedBySessionId: text('stored_by_session_id').notNull(),
    storedAt: integer('stored_at').notNull(),
    storageStatus: text('storage_status').notNull(),
  },
  (table) => [
    uniqueIndex('invoice_archives_revision_idx').on(
      table.organizationId,
      table.sourceInvoiceId,
      table.revision,
    ),
    uniqueIndex('invoice_archives_object_idx').on(table.objectKey),
    index('invoice_archives_number_idx').on(
      table.organizationId,
      table.invoiceNumber,
    ),
    index('invoice_archives_retention_idx').on(table.retentionUntil),
  ],
);
