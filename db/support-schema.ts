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
  mode: text('mode').notNull().default('review'),
  threshold: integer('threshold').notNull().default(85),
  baselineSeconds: integer('baseline_seconds').notNull().default(60),
  aiSecret: text('ai_secret'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
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
    directoryJson: text('directory_json').notNull(),
    routesJson: text('routes_json').notNull(),
    active: integer('active').notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('support_connections_workspace').on(t.workspaceId)],
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
