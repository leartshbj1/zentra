import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { prepaidContracts, prepaidSettlementProofs } from './prepaid-schema';

/** Only identifiers and verified local bindings are retained. Never store the
 * processorToken, addresses or paymentInformationHashes from TokenVersion. */
export const prepaidTokens = sqliteTable(
  'prepaid_tokens',
  {
    contractId: text('contract_id')
      .primaryKey()
      .references(() => prepaidContracts.contractId),
    initialPeriodId: text('initial_period_id')
      .notNull()
      .references(() => prepaidSettlementProofs.periodId),
    initialTransactionId: integer('initial_transaction_id').notNull(),
    initialInvoiceId: integer('initial_invoice_id').notNull(),
    settlementFingerprint: text('settlement_fingerprint').notNull(),
    ownerId: text('owner_id').notNull(),
    organizationId: text('organization_id'),
    workspaceId: text('workspace_id'),
    apiOrigin: text('api_origin').notNull(),
    spaceId: integer('space_id').notNull(),
    environment: text('environment').notNull(),
    customerReference: text('customer_reference').notNull(),
    method: text('method').notNull(),
    paymentMethodConfigurationId: integer(
      'payment_method_configuration_id',
    ).notNull(),
    connectorConfigurationId: integer('connector_configuration_id').notNull(),
    paymentMethodId: integer('payment_method_id').notNull(),
    tokenId: integer('token_id').notNull(),
    tokenVersionId: integer('token_version_id').notNull(),
    tokenObjectVersion: integer('token_object_version').notNull(),
    tokenVersionObjectVersion: integer(
      'token_version_object_version',
    ).notNull(),
    evidenceFingerprint: text('evidence_fingerprint').notNull(),
    observedAt: integer('observed_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('prepaid_tokens_initial_period_idx').on(t.initialPeriodId),
    index('prepaid_tokens_provider_idx').on(
      t.apiOrigin,
      t.spaceId,
      t.environment,
      t.tokenId,
    ),
    check(
      'prepaid_tokens_environment_check',
      sql`${t.environment} IN ('TEST','PRODUCTION')`,
    ),
    check(
      'prepaid_tokens_method_check',
      sql`${t.method} IN ('postfinance_pay','twint')`,
    ),
    check(
      'prepaid_tokens_origin_check',
      sql`${t.apiOrigin} IN ('https://checkout.postfinance.ch','https://app-wallee.com')`,
    ),
    check(
      'prepaid_tokens_ids_check',
      sql`${t.spaceId}>0 AND ${t.initialTransactionId}>0 AND ${t.initialInvoiceId}>0 AND ${t.paymentMethodConfigurationId}>0 AND ${t.connectorConfigurationId}>0 AND ${t.paymentMethodId}>0 AND ${t.tokenId}>0 AND ${t.tokenVersionId}>0`,
    ),
    check(
      'prepaid_tokens_versions_check',
      sql`${t.tokenObjectVersion}>=0 AND ${t.tokenVersionObjectVersion}>=0`,
    ),
    check(
      'prepaid_tokens_times_check',
      sql`${t.observedAt}>0 AND ${t.createdAt}>=${t.observedAt}`,
    ),
    check(
      'prepaid_tokens_hashes_check',
      sql`length(${t.settlementFingerprint})=64 AND ${t.settlementFingerprint} NOT GLOB '*[^a-f0-9]*' AND length(${t.evidenceFingerprint})=64 AND ${t.evidenceFingerprint} NOT GLOB '*[^a-f0-9]*'`,
    ),
  ],
);
