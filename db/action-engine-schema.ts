import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// SQL migration 0099 adds the CHECKs, compound FKs and append-only triggers.
// No route is exposed until the production admission and publication fences exist.
export const actionEngineAtomicAssertions = sqliteTable(
  'action_engine_atomic_assertions',
  {
    operationId: text('operation_id').primaryKey(),
    allowed: integer('allowed').notNull(),
  },
);
export const actionEngineQuoteProposals = sqliteTable(
  'action_engine_quote_proposals',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    sourceId: text('source_id').notNull(),
    actionKind: text('action_kind').notNull(),
    fingerprint: text('fingerprint').notNull(),
    sourceRevision: text('source_revision').notNull(),
    contextRevision: text('context_revision').notNull(),
    planJson: text('plan_json').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('action_engine_quote_proposals_source').on(
      t.organizationId,
      t.sourceId,
      t.actionKind,
    ),
    uniqueIndex('action_engine_quote_proposals_identity').on(
      t.id,
      t.organizationId,
      t.fingerprint,
    ),
  ],
);
export const actionEngineQuoteReservations = sqliteTable(
  'action_engine_quote_reservations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    proposalId: text('proposal_id').notNull().unique(),
    fingerprint: text('fingerprint').notNull(),
    userId: text('user_id').notNull(),
    installationId: text('installation_id').notNull(),
    customerId: text('customer_id').notNull(),
    quoteId: text('quote_id').notNull(),
    createdAt: integer('created_at').notNull(),
    receiptJson: text('receipt_json'),
    confirmedAt: integer('confirmed_at'),
  },
  (t) => [
    uniqueIndex('action_engine_quote_reservations_quote').on(
      t.organizationId,
      t.quoteId,
    ),
    uniqueIndex('action_engine_quote_reservations_identity').on(
      t.id,
      t.organizationId,
      t.proposalId,
    ),
  ],
);
export const actionEngineQuoteEvents = sqliteTable(
  'action_engine_quote_events',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    proposalId: text('proposal_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    eventType: text('event_type').notNull(),
    actorUserId: text('actor_user_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('action_engine_quote_events_kind').on(
      t.proposalId,
      t.eventType,
    ),
    index('action_engine_quote_events_company').on(
      t.organizationId,
      t.createdAt,
    ),
  ],
);
