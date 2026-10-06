import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Local billing identities never masquerade as Stripe customer/subscription IDs.
export const prepaidContracts = sqliteTable(
  'prepaid_contracts',
  {
    contractId: text('contract_id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    organizationId: text('organization_id'),
    workspaceId: text('workspace_id'),
    apiOrigin: text('api_origin').notNull(),
    spaceId: integer('space_id').notNull(),
    environment: text('environment').notNull(),
    productKey: text('product_key').notNull(),
    catalogVersion: text('catalog_version').notNull(),
    catalogJson: text('catalog_json').notNull(),
    anchorStart: integer('anchor_start').notNull(),
    fingerprint: text('fingerprint').notNull(),
    cancelledAt: integer('cancelled_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('prepaid_contracts_owner_idx').on(table.ownerId, table.createdAt),
    index('prepaid_contracts_organization_idx').on(table.organizationId),
    index('prepaid_contracts_workspace_idx').on(table.workspaceId),
    check(
      'prepaid_contracts_environment_check',
      sql`${table.environment} IN ('TEST','PRODUCTION')`,
    ),
    check('prepaid_contracts_space_check', sql`${table.spaceId}>0`),
    check(
      'prepaid_contracts_anchor_check',
      sql`${table.anchorStart}>0 AND (${table.cancelledAt} IS NULL OR ${table.cancelledAt}>=${table.createdAt})`,
    ),
  ],
);

// The dates, price, product limits and identity of each period are immutable.
export const prepaidPeriods = sqliteTable(
  'prepaid_periods',
  {
    periodId: text('period_id').primaryKey(),
    contractId: text('contract_id')
      .notNull()
      .references(() => prepaidContracts.contractId),
    ordinal: integer('ordinal').notNull(),
    startsAt: integer('starts_at').notNull(),
    endsAt: integer('ends_at').notNull(),
    currency: text('currency').notNull(),
    priceChfMinor: integer('price_chf_minor').notNull(),
    catalogVersion: text('catalog_version').notNull(),
    catalogJson: text('catalog_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('prepaid_periods_ordinal_idx').on(
      table.contractId,
      table.ordinal,
    ),
    index('prepaid_periods_coverage_idx').on(
      table.contractId,
      table.startsAt,
      table.endsAt,
    ),
    check(
      'prepaid_periods_dates_check',
      sql`${table.startsAt}>0 AND ${table.endsAt}>${table.startsAt} AND ${table.ordinal}>=0`,
    ),
    check(
      'prepaid_periods_amount_check',
      sql`${table.currency}='CHF' AND ${table.priceChfMinor}>0`,
    ),
  ],
);

// A provider transaction can pay one local period only, even after a restart.
export const prepaidTransactions = sqliteTable(
  'prepaid_transactions',
  {
    periodId: text('period_id')
      .primaryKey()
      .references(() => prepaidPeriods.periodId),
    apiOrigin: text('api_origin').notNull(),
    spaceId: integer('space_id').notNull(),
    transactionId: integer('transaction_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('prepaid_transactions_provider_idx').on(
      table.apiOrigin,
      table.spaceId,
      table.transactionId,
    ),
    check(
      'prepaid_transactions_ids_check',
      sql`${table.spaceId}>0 AND ${table.transactionId}>0`,
    ),
  ],
);

// Only the private reconciliation worker may persist freshly verified provider facts.
// This is not an authenticated purchase or a substitute for staged merchant validation.
export const prepaidSettlementProofs = sqliteTable(
  'prepaid_settlement_proofs',
  {
    periodId: text('period_id')
      .primaryKey()
      .references(() => prepaidTransactions.periodId),
    invoiceId: integer('invoice_id').notNull(),
    evidenceFingerprint: text('evidence_fingerprint').notNull(),
    reconciledAt: integer('reconciled_at').notNull(),
  },
  (table) => [
    check(
      'prepaid_settlement_invoice_check',
      sql`${table.invoiceId}>0 AND ${table.reconciledAt}>0`,
    ),
  ],
);

// Revocation is additive. A delayed paid event cannot restore a refunded period.
export const prepaidPeriodRevocations = sqliteTable(
  'prepaid_period_revocations',
  {
    periodId: text('period_id')
      .primaryKey()
      .references(() => prepaidSettlementProofs.periodId),
    evidenceFingerprint: text('evidence_fingerprint').notNull(),
    revokedAt: integer('revoked_at').notNull(),
  },
);

// Frozen before dispatch: a later merchant configuration must not reinterpret
// the payer or payment method of an already-created transaction.
export const prepaidPaymentExpectations = sqliteTable(
  'prepaid_payment_expectations',
  {
    periodId: text('period_id')
      .primaryKey()
      .references(() => prepaidPeriods.periodId),
    customerReference: text('customer_reference').notNull(),
    planReference: text('plan_reference').notNull(),
    paymentMethodConfigurationId: integer(
      'payment_method_configuration_id',
    ).notNull(),
    connectorConfigurationId: integer('connector_configuration_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    check(
      'prepaid_payment_expectation_ids_check',
      sql`${table.paymentMethodConfigurationId}>0 AND ${table.connectorConfigurationId}>0 AND ${table.createdAt}>0`,
    ),
  ],
);

// A verified reversal may arrive before any positive settlement proof. Keep
// its tombstone against the bound transaction, without inventing a paid fact.
export const prepaidProviderReversals = sqliteTable(
  'prepaid_provider_reversals',
  {
    periodId: text('period_id')
      .primaryKey()
      .references(() => prepaidTransactions.periodId),
    evidenceFingerprint: text('evidence_fingerprint').notNull(),
    reversedAt: integer('reversed_at').notNull(),
  },
  (table) => [
    check('prepaid_provider_reversal_time_check', sql`${table.reversedAt}>0`),
  ],
);
