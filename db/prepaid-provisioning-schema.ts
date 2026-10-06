import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { purchaseIntents } from './purchase-intent-schema';
import { prepaidContracts, prepaidPeriods } from './prepaid-schema';

// Frozen before the first financial dispatch. This target never grants access.
export const prepaidPurchaseTargets = sqliteTable(
  'prepaid_purchase_targets',
  {
    intentId: text('intent_id')
      .primaryKey()
      .references(() => purchaseIntents.intentId),
    contractId: text('contract_id')
      .notNull()
      .references(() => prepaidContracts.contractId),
    ownerId: text('owner_id').notNull(),
    organizationId: text('organization_id'),
    workspaceId: text('workspace_id'),
    previousSubscriptionId: text('previous_subscription_id'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('prepaid_purchase_targets_contract').on(table.contractId),
    check('prepaid_purchase_target_time', sql`${table.createdAt}>0`),
    check(
      'prepaid_purchase_target_company',
      sql`(${table.organizationId} IS NULL AND ${table.previousSubscriptionId} IS NULL) OR (${table.organizationId} IS NOT NULL AND ${table.previousSubscriptionId} IS NOT NULL)`,
    ),
  ],
);

// One initial handoff per contract; historical evidence survives cancellation
// and refunds. closed_at is set only after the complete atomic handoff.
export const prepaidPurchaseProjections = sqliteTable(
  'prepaid_purchase_projections',
  {
    periodId: text('period_id')
      .primaryKey()
      .references(() => prepaidPeriods.periodId),
    intentId: text('intent_id')
      .notNull()
      .references(() => purchaseIntents.intentId),
    contractId: text('contract_id')
      .notNull()
      .references(() => prepaidContracts.contractId),
    ownerId: text('owner_id').notNull(),
    organizationId: text('organization_id'),
    workspaceId: text('workspace_id'),
    projectedAt: integer('projected_at').notNull(),
    evidenceFingerprint: text('evidence_fingerprint').notNull(),
    scopeHash: text('scope_hash').notNull(),
    lease: text('lease').notNull(),
    closedAt: integer('closed_at'),
  },
  (table) => [
    uniqueIndex('prepaid_purchase_projection_intent').on(table.intentId),
    uniqueIndex('prepaid_purchase_projection_contract').on(table.contractId),
    check(
      'prepaid_purchase_projection_dates',
      sql`${table.projectedAt}>0 AND (${table.closedAt} IS NULL OR ${table.closedAt}>=${table.projectedAt})`,
    ),
    check(
      'prepaid_purchase_projection_evidence',
      sql`length(${table.evidenceFingerprint})=64 AND ${table.evidenceFingerprint} NOT GLOB '*[^a-f0-9]*'`,
    ),
  ],
);
