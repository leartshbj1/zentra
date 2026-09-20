import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const supportWorkspaces = sqliteTable('support_workspaces', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().unique(),
  name: text('name').notNull(),
  triageContext: text('triage_context').notNull().default(''),
  mode: text('mode').notNull().default('review'),
  threshold: integer('threshold').notNull().default(85),
  baselineSeconds: integer('baseline_seconds').notNull().default(60),
  aiSecret: text('ai_secret'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
export const founderSupportGrants = sqliteTable('founder_support_grants', {
  email: text('email').primaryKey(),
  grantId: text('grant_id').notNull().unique(),
  userId: text('user_id').unique(),
  workspaceId: text('workspace_id')
    .unique()
    .references(() => supportWorkspaces.id),
  planId: text('plan_id').notNull(),
  validFrom: integer('valid_from').notNull(),
  validUntil: integer('valid_until').notNull(),
  revokedAt: integer('revoked_at'),
  revision: integer('revision').notNull(),
  note: text('note').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  lastOperationId: text('last_operation_id').notNull(),
});
export const founderSupportEvents = sqliteTable('founder_support_events', {
  operationId: text('operation_id').primaryKey(),
  email: text('email').notNull(),
  actionHash: text('action_hash').notNull(),
  operation: text('operation').notNull(),
  validUntil: integer('valid_until').notNull(),
  createdAt: integer('created_at').notNull(),
  revision: integer('revision').notNull(),
});
export const founderSupportUsage = sqliteTable(
  'founder_support_usage',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => supportWorkspaces.id),
    periodStart: integer('period_start').notNull(),
    ticketId: text('ticket_id').notNull(),
    state: text('state').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('founder_support_usage_period').on(
      t.workspaceId,
      t.periodStart,
      t.state,
    ),
  ],
);
export const supportMembers = sqliteTable(
  'support_members',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => supportWorkspaces.id),
    email: text('email').notNull(),
    role: text('role').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('support_member_identity').on(t.workspaceId, t.email)],
);
export const supportConnections = sqliteTable(
  'support_connections',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => supportWorkspaces.id),
    provider: text('provider').notNull(),
    label: text('label').notNull(),
    domain: text('domain').notNull(),
    login: text('login').notNull(),
    secret: text('secret').notNull(),
    hookHash: text('hook_hash').notNull(),
    refreshLease: text('refresh_lease'),
    refreshLeaseUntil: integer('refresh_lease_until').notNull().default(0),
    directoryJson: text('directory_json').notNull(),
    routesJson: text('routes_json').notNull(),
    active: integer('active').notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('support_connections_workspace').on(t.workspaceId)],
);
export const supportMailboxes = sqliteTable(
  'support_mailboxes',
  {
    connectionId: text('connection_id')
      .primaryKey()
      .references(() => supportConnections.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => supportWorkspaces.id),
    email: text('email').notNull(),
    mailboxId: text('mailbox_id').notNull(),
    folderId: text('folder_id').notNull(),
    sinceAt: integer('since_at').notNull(),
    scanOffset: integer('scan_offset').notNull().default(0),
    nextSyncAt: integer('next_sync_at').notNull().default(0),
    lastSyncAt: integer('last_sync_at'),
    lastError: text('last_error'),
    lease: text('lease'),
    leaseUntil: integer('lease_until').notNull().default(0),
  },
  (t) => [
    uniqueIndex('support_mailboxes_identity').on(t.workspaceId, t.email),
    index('support_mailboxes_due').on(t.nextSyncAt, t.leaseUntil),
  ],
);

export const supportTickets = sqliteTable(
  'support_tickets',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => supportWorkspaces.id),
    connectionId: text('connection_id')
      .notNull()
      .references(() => supportConnections.id),
    externalId: text('external_id').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    sourceJson: text('source_json').notNull(),
    fingerprint: text('fingerprint').notNull(),
    revision: integer('revision').notNull().default(1),
    state: text('state').notNull().default('pending'),
    decisionJson: text('decision_json'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    lease: text('lease'),
    leaseUntil: integer('lease_until'),
    automatic: integer('automatic').notNull().default(0),
    corrected: integer('corrected').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    routedAt: integer('routed_at'),
  },
  (t) => [
    uniqueIndex('support_ticket_external').on(t.connectionId, t.externalId),
    index('support_ticket_inbox').on(t.workspaceId, t.updatedAt),
    index('support_ticket_pending').on(t.workspaceId, t.state),
  ],
);
export const supportEvents = sqliteTable(
  'support_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => supportWorkspaces.id),
    ticketId: text('ticket_id').references(() => supportTickets.id),
    kind: text('kind').notNull(),
    detail: text('detail').notNull(),
    actor: text('actor').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('support_events_workspace_time').on(t.workspaceId, t.createdAt),
    index('support_events_ticket_time').on(t.ticketId, t.createdAt),
  ],
);
export const supportSecrets = sqliteTable('support_platform_secrets', {
  id: text('id').primaryKey(),
  secret: text('secret').notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const supportBillingConfig = sqliteTable('support_billing_config', {
  id: text('id').primaryKey(),
  configuration: text('configuration').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
export const supportSubscriptions = sqliteTable('support_subscriptions', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => supportWorkspaces.id),
  subscriptionId: text('subscription_id').notNull().unique(),
  customerId: text('customer_id').notNull(),
  planId: text('plan_id').notNull(),
  status: text('status').notNull(),
  paidFrom: integer('paid_from').notNull().default(0),
  paidUntil: integer('paid_until').notNull().default(0),
  paidPlanId: text('paid_plan_id'),
  lastPaidInvoiceId: text('last_paid_invoice_id'),
  cancelAtPeriodEnd: integer('cancel_at_period_end').notNull().default(0),
  livemode: integer('livemode').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
export const supportCheckouts = sqliteTable('support_checkouts', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => supportWorkspaces.id),
  nonce: text('nonce').notNull(),
  planId: text('plan_id').notNull(),
  sessionId: text('session_id'),
  sessionUrl: text('session_url'),
  expiresAt: integer('expires_at').notNull(),
  ownerId: text('owner_id').notNull(),
  acceptedVersion: text('accepted_version').notNull(),
  acceptedAt: integer('accepted_at').notNull(),
});
export const supportAnalysisUsage = sqliteTable(
  'support_analysis_usage',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => supportWorkspaces.id),
    periodStart: integer('period_start').notNull(),
    ticketId: text('ticket_id').notNull(),
    state: text('state').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('support_usage_period').on(t.workspaceId, t.periodStart, t.state),
  ],
);

export const supportCheckoutAcceptances = sqliteTable(
  'support_checkout_acceptances',
  {
    sessionId: text('session_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => supportWorkspaces.id),
    ownerId: text('owner_id').notNull(),
    planId: text('plan_id').notNull(),
    legalVersion: text('legal_version').notNull(),
    acceptedAt: integer('accepted_at').notNull(),
  },
);

export const supportOauthStates = sqliteTable('support_oauth_states', {
  stateHash: text('state_hash').primaryKey(),
  userId: text('user_id').notNull(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => supportWorkspaces.id),
  domain: text('domain').notNull(),
  label: text('label').notNull(),
  verifier: text('verifier').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
