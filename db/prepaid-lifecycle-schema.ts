import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { prepaidContracts, prepaidPeriods } from './prepaid-schema';

// The token and exact request of a monthly renewal are fixed before dispatch.
export const prepaidRenewalRequests = sqliteTable(
  'prepaid_renewal_requests',
  {
    periodId: text('period_id')
      .primaryKey()
      .references(() => prepaidPeriods.periodId),
    contractId: text('contract_id')
      .notNull()
      .references(() => prepaidContracts.contractId),
    tokenId: integer('token_id').notNull(),
    tokenVersionId: integer('token_version_id').notNull(),
    parameters: text('parameters').notNull(),
    fingerprint: text('fingerprint').notNull(),
    createScopeHash: text('create_scope_hash').notNull(),
    applyScopeHash: text('apply_scope_hash'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    check(
      'prepaid_renewal_token_ids_check',
      sql`${t.tokenId}>0 AND ${t.tokenVersionId}>0`,
    ),
    check(
      'prepaid_renewal_parameters_check',
      sql`json_valid(${t.parameters}) AND length(${t.fingerprint})=64`,
    ),
    check(
      'prepaid_renewal_scope_hashes_check',
      sql`length(${t.createScopeHash})=64 AND ${t.createScopeHash} NOT GLOB '*[^a-f0-9]*' AND (${t.applyScopeHash} IS NULL OR (length(${t.applyScopeHash})=64 AND ${t.applyScopeHash} NOT GLOB '*[^a-f0-9]*'))`,
    ),
  ],
);

// A canceled contract can have an already submitted renewal. Keep a separate
// durable queue: uncertain merchant POSTs are never replayed after a timeout.
export const prepaidFlowCancellations = sqliteTable(
  'prepaid_flow_cancellations',
  {
    periodId: text('period_id')
      .primaryKey()
      .references(() => prepaidPeriods.periodId),
    contractId: text('contract_id')
      .notNull()
      .references(() => prepaidContracts.contractId),
    transactionId: integer('transaction_id').notNull(),
    state: text('state').notNull(),
    claimToken: text('claim_token'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    check(
      'prepaid_flow_cancel_state_check',
      sql`${t.state} IN ('claimed','completed','uncertain')`,
    ),
    check(
      'prepaid_flow_cancel_ids_check',
      sql`${t.transactionId}>0 AND ${t.createdAt}>0 AND ${t.updatedAt}>=${t.createdAt}`,
    ),
  ],
);
