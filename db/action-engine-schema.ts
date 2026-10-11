import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { organizations } from './schema';

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

// 0100 is authoritative for immutable identities, transitions and audit guards.
export const actionEngineQuoteIntake = sqliteTable(
  'action_engine_quote_intake',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    sourceId: text('source_id').notNull(),
    actionKind: text('action_kind').notNull(),
    engineVersion: text('engine_version').notNull(),
    sourceRevision: text('source_revision').notNull(),
    contextRevision: text('context_revision').notNull(),
    contextHash: text('context_hash').notNull(),
    inputHash: text('input_hash').notNull(),
    inputJson: text('input_json').notNull(),
    state: text('state').notNull(),
    ownerUserId: text('owner_user_id').notNull(),
    ownerToken: text('owner_token').notNull(),
    leaseUntil: integer('lease_until').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    resultJson: text('result_json'),
    resultFingerprint: text('result_fingerprint'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('action_engine_quote_intake_source').on(
      t.organizationId,
      t.sourceId,
      t.actionKind,
    ),
    uniqueIndex('action_engine_quote_intake_identity').on(
      t.id,
      t.organizationId,
      t.inputHash,
    ),
    index('action_engine_quote_intake_due').on(
      t.state,
      t.leaseUntil,
      t.updatedAt,
      t.id,
    ),
  ],
);
export const actionEngineQuoteIntakeEvents = sqliteTable(
  'action_engine_quote_intake_events',
  {
    id: text('id').primaryKey(),
    intakeId: text('intake_id').notNull(),
    organizationId: text('organization_id').notNull(),
    inputHash: text('input_hash').notNull(),
    eventType: text('event_type').notNull(),
    ownerToken: text('owner_token').notNull(),
    actorUserId: text('actor_user_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('action_engine_quote_intake_events_identity').on(
      t.intakeId,
      t.ownerToken,
      t.eventType,
    ),
    index('action_engine_quote_intake_events_company').on(
      t.organizationId,
      t.createdAt,
    ),
  ],
);

// 0101 creates a separate opt-in; no seed or endpoint enables it in this phase.
export const actionEngineQuoteSettings = sqliteTable(
  'action_engine_quote_settings',
  {
    organizationId: text('organization_id')
      .primaryKey()
      .references(() => organizations.organizationId, { onDelete: 'cascade' }),
    revision: integer('revision').notNull().default(1),
    enabled: integer('enabled').notNull().default(0),
    consentVersion: text('consent_version'),
    grantedBy: text('granted_by'),
    grantedAt: integer('granted_at'),
    updatedAt: integer('updated_at').notNull(),
  },
);

// 0102 is authoritative for bounded transport identities, terminal transitions,
// immutable audit and REPLACE/IGNORE guards. These rows grant no permission.
export const actionEnginePublicationAttempts = sqliteTable(
  'action_engine_publication_attempts',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    snapshotId: text('snapshot_id').notNull(),
    installationId: text('installation_id').notNull(),
    userId: text('user_id').notNull(),
    baseRevision: integer('base_revision').notNull(),
    archiveSha256: text('archive_sha256').notNull(),
    manifestSha256: text('manifest_sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    state: text('state').notNull(),
    resultJson: text('result_json'),
    createdAt: integer('created_at').notNull(),
    settledAt: integer('settled_at'),
  },
  (t) => [
    uniqueIndex('action_engine_publication_pending')
      .on(t.organizationId)
      .where(sql`${t.state}='pending'`),
    uniqueIndex('action_engine_publication_snapshot').on(
      t.organizationId,
      t.snapshotId,
    ),
    uniqueIndex('action_engine_publication_committed_revision')
      .on(t.organizationId, sql`json_extract(${t.resultJson},'$.revision')`)
      .where(sql`${t.state}='committed'`),
    index('action_engine_publication_company').on(
      t.organizationId,
      t.createdAt,
      t.id,
    ),
  ],
);
export const actionEnginePublicationEvents = sqliteTable(
  'action_engine_publication_events',
  {
    attemptId: text('attempt_id').notNull(),
    organizationId: text('organization_id').notNull(),
    eventType: text('event_type').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.eventType] }),
    index('action_engine_publication_events_company').on(
      t.organizationId,
      t.createdAt,
      t.attemptId,
    ),
  ],
);
