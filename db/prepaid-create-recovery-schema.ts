import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { prepaidContracts, prepaidPeriods } from './prepaid-schema';
import { purchaseIntents } from './purchase-intent-schema';
import { postfinanceMutations } from './postfinance-schema';

// Provenance for GET-only recovery, not settlement or financial permission.
export const prepaidCreateRecoveries = sqliteTable(
  'prepaid_create_recoveries',
  {
    periodId: text('period_id')
      .primaryKey()
      .references(() => prepaidPeriods.periodId),
    contractId: text('contract_id')
      .notNull()
      .references(() => prepaidContracts.contractId),
    intentId: text('intent_id')
      .notNull()
      .references(() => purchaseIntents.intentId),
    scopeHash: text('scope_hash')
      .notNull()
      .references(() => postfinanceMutations.scopeHash),
    requestFingerprint: text('request_fingerprint').notNull(),
    originalClaimToken: text('original_claim_token').notNull(),
    transactionId: integer('transaction_id').notNull(),
    observedState: text('observed_state').notNull(),
    observedVersion: integer('observed_version').notNull(),
    sourceJson: text('source_json').notNull(),
    responseJson: text('response_json').notNull(),
    evidenceFingerprint: text('evidence_fingerprint').notNull(),
    recoveredAt: integer('recovered_at').notNull(),
  },
  (t) => [
    uniqueIndex('prepaid_create_recoveries_scope').on(t.scopeHash),
    check(
      'prepaid_create_recovery_hash',
      sql`length(${t.scopeHash})=64 AND ${t.scopeHash} NOT GLOB '*[^a-f0-9]*' AND length(${t.evidenceFingerprint})=64 AND ${t.evidenceFingerprint} NOT GLOB '*[^a-f0-9]*'`,
    ),
    check(
      'prepaid_create_recovery_request',
      sql`length(${t.requestFingerprint})=43 AND ${t.requestFingerprint} NOT GLOB '*[^A-Za-z0-9_-]*' AND length(${t.originalClaimToken})=36`,
    ),
    check(
      'prepaid_create_recovery_observation',
      sql`${t.transactionId}>0 AND ${t.observedVersion}>=0 AND ${t.recoveredAt}>0 AND ${t.observedState} IN ('PENDING','CONFIRMED','PROCESSING','AUTHORIZED','COMPLETED','FULFILL','FAILED','DECLINE','VOIDED')`,
    ),
    check(
      'prepaid_create_recovery_json',
      sql`json_valid(${t.sourceJson}) AND json_type(${t.sourceJson})='object' AND length(CAST(${t.sourceJson} AS BLOB))<=65536 AND json_valid(${t.responseJson}) AND json_type(${t.responseJson})='object' AND length(CAST(${t.responseJson} AS BLOB))<=262144`,
    ),
  ],
);
