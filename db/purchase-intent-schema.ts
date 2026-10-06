import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Provider-neutral purchase history. A state here never grants product access.
export const purchaseIntents = sqliteTable(
  'purchase_intents',
  {
    intentId: text('intent_id').primaryKey(),
    fingerprint: text('fingerprint').notNull().unique(),
    ownerId: text('owner_id').notNull(),
    environment: text('environment').notNull(),
    provider: text('provider').notNull(),
    providerScope: text('provider_scope').notNull(),
    product: text('product').notNull(),
    organizationId: text('organization_id'),
    workspaceId: text('workspace_id'),
    planId: text('plan_id'),
    parameters: text('parameters').notNull(),
    termsVersion: text('terms_version').notNull(),
    consentVersion: text('consent_version'),
    origin: text('origin').notNull(),
    acceptedAt: integer('accepted_at').notNull(),
    state: text('state').notNull().default('reserved'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    dispatchedAt: integer('dispatched_at'),
    providerReference: text('provider_reference'),
    evidenceFingerprint: text('evidence_fingerprint'),
    finalizedAt: integer('finalized_at'),
  },
  (table) => [
    index('purchase_intents_owner_created').on(table.ownerId, table.createdAt),
    uniqueIndex('purchase_intents_provider_reference').on(
      table.environment,
      table.provider,
      table.providerScope,
      table.providerReference,
    ),
    check(
      'purchase_intents_environment',
      sql`${table.environment} IN ('TEST','PRODUCTION')`,
    ),
    check(
      'purchase_intents_provider',
      sql`${table.provider} IN ('stripe','postfinance')`,
    ),
    check(
      'purchase_intents_product',
      sql`${table.product} IN ('gestion','support','automation','complete')`,
    ),
    check(
      'purchase_intents_state',
      sql`${table.state} IN ('reserved','dispatched','uncertain','settled','canceled','expired','released')`,
    ),
    check(
      'purchase_intents_dates',
      sql`${table.createdAt}>0 AND ${table.acceptedAt}=${table.createdAt} AND ${table.expiresAt}>${table.createdAt}`,
    ),
  ],
);

// Released footprints remain in history; the partial unique index protects only
// current reservations, irrespective of provider or merchant account.
export const purchaseIntentFootprints = sqliteTable(
  'purchase_intent_footprints',
  {
    intentId: text('intent_id')
      .notNull()
      .references(() => purchaseIntents.intentId),
    environment: text('environment').notNull(),
    scopeKind: text('scope_kind').notNull(),
    scopeId: text('scope_id').notNull(),
    entitlement: text('entitlement').notNull(),
    releasedAt: integer('released_at'),
  },
  (table) => [
    uniqueIndex('purchase_footprint_identity').on(
      table.intentId,
      table.scopeKind,
      table.scopeId,
      table.entitlement,
    ),
    uniqueIndex('purchase_footprint_exclusion')
      .on(table.environment, table.scopeKind, table.scopeId, table.entitlement)
      .where(sql`${table.releasedAt} IS NULL`),
    check(
      'purchase_footprint_scope',
      sql`${table.scopeKind} IN ('organization','workspace')`,
    ),
    check(
      'purchase_footprint_entitlement',
      sql`${table.entitlement} IN ('gestion','support','automation')`,
    ),
  ],
);
