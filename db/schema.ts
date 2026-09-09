import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const businessSyncSpaces = sqliteTable('business_sync_spaces', {
  organizationId: text('organization_id').primaryKey().references(() => organizations.organizationId),
  generation: text('generation').notNull(),
  bootstrapTransferId: text('bootstrap_transfer_id').notNull(),
  state: text('state').notNull(),
  headRevision: integer('head_revision').notNull().default(0),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
});

// Immutable initial high-water marks survive deleted drafts and restored PCs.
// Later reservations are still append-only and cannot lower these floors.
export const businessSyncNumberFloors = sqliteTable('business_sync_number_floors', {
  organizationId: text('organization_id').notNull().references(() => organizations.organizationId),
  prefix: text('prefix').notNull(),
  year: integer('year').notNull(),
  minimum: integer('minimum').notNull(),
  bootstrapTransferId: text('bootstrap_transfer_id').notNull().references(() => businessSyncTransfers.transferId),
}, (table) => [uniqueIndex('business_sync_number_floor_identity').on(table.organizationId, table.prefix, table.year)]);

export const businessSyncPublications = sqliteTable('business_sync_publications', {
  transferId: text('transfer_id').primaryKey().references(() => businessSyncTransfers.transferId),
  organizationId: text('organization_id').notNull().references(() => organizations.organizationId),
  generation: text('generation').notNull(),
  manifestSha256: text('manifest_sha256').notNull(),
  filesManifestSha256: text('files_manifest_sha256').notNull(),
  validatorSha256: text('validator_sha256').notNull(),
  receiptJson: text('receipt_json').notNull(),
  committedAt: text('committed_at').notNull(),
});

export const businessSyncTransfers = sqliteTable('business_sync_transfers', {
  transferId: text('transfer_id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.organizationId),
  installationId: text('installation_id').notNull(),
  createdBy: text('created_by').notNull(),
  generation: text('generation').notNull(),
  kind: text('kind').notNull(),
  state: text('state').notNull(),
  baseRevision: integer('base_revision').notNull(),
  revision: integer('revision'),
  manifestJson: text('manifest_json').notNull(),
  manifestSha256: text('manifest_sha256').notNull(),
  createdAt: text('created_at').notNull(),
  committedAt: text('committed_at'),
}, (table) => [
  uniqueIndex('business_sync_transfer_revision').on(table.organizationId, table.revision),
  index('business_sync_transfer_org_state').on(table.organizationId, table.state, table.createdAt),
]);

// Structural approval is deliberately separate from canonical publication.
export const businessSyncStructuralChecks = sqliteTable('business_sync_structural_checks', {
  transferId: text('transfer_id').notNull().references(() => businessSyncTransfers.transferId),
  validatorSha256: text('validator_sha256').notNull(),
  manifestSha256: text('manifest_sha256').notNull(),
  generation: text('generation').notNull(),
  nextRule: integer('next_rule').notNull().default(0),
  state: text('state').notNull(),
  failedRule: text('failed_rule'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [uniqueIndex('business_sync_structural_identity').on(table.transferId, table.validatorSha256)]);

export const businessSyncIntegrityChecks = sqliteTable('business_sync_integrity_checks', {
  transferId: text('transfer_id').notNull().references(() => businessSyncTransfers.transferId),
  validatorSha256: text('validator_sha256').notNull(),
  manifestSha256: text('manifest_sha256').notNull(),
  generation: text('generation').notNull(),
  state: text('state').notNull(),
  lastRowKey: text('last_row_key'),
  nextAccountingRule: integer('next_accounting_rule').notNull().default(0),
  indexedEntries: integer('indexed_entries').notNull().default(0),
  walkedEntries: integer('walked_entries').notNull().default(0),
  lastHash: text('last_hash'),
  failedRule: text('failed_rule'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [uniqueIndex('business_sync_integrity_identity').on(table.transferId, table.validatorSha256)]);

export const businessSyncAuditNodes = sqliteTable('business_sync_audit_nodes', {
  transferId: text('transfer_id').notNull().references(() => businessSyncTransfers.transferId),
  validatorSha256: text('validator_sha256').notNull(),
  rowKey: text('row_key').notNull(),
  entryHash: text('entry_hash').notNull(),
  previousHash: text('previous_hash'),
}, (table) => [
  uniqueIndex('business_sync_audit_row').on(table.transferId, table.validatorSha256, table.rowKey),
  uniqueIndex('business_sync_audit_hash').on(table.transferId, table.validatorSha256, table.entryHash),
  index('business_sync_audit_previous').on(table.transferId, table.validatorSha256, table.previousHash),
]);

// Projection money is written/read through exact SQL, never through JS numbers.
export const businessSyncCreditProjection = sqliteTable('business_sync_credit_projection', {
  transferId: text('transfer_id').notNull().references(() => businessSyncTransfers.transferId),
  validatorSha256: text('validator_sha256').notNull(),
  manifestSha256: text('manifest_sha256').notNull(),
  generation: text('generation').notNull(),
  revision: integer('revision').notNull().default(0),
  stateJson: text('state_json').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [uniqueIndex('business_sync_credit_projection_identity').on(table.transferId, table.validatorSha256)]);

export const businessSyncCreditLines = sqliteTable('business_sync_credit_lines', {
  transferId: text('transfer_id').notNull().references(() => businessSyncTransfers.transferId),
  validatorSha256: text('validator_sha256').notNull(),
  documentId: text('document_id').notNull(),
  itemId: text('item_id').notNull(),
  position: integer('position').notNull(),
  gross: integer('gross').notNull(),
  vat: integer('vat').notNull(),
  remaining: integer('remaining').notNull(),
  released: integer('released').notNull().default(0),
  proposedGross: integer('proposed_gross'),
  proposedVat: integer('proposed_vat'),
  remainder: integer('remainder'),
}, (table) => [
  uniqueIndex('business_sync_credit_line_identity').on(table.transferId, table.validatorSha256, table.documentId, table.itemId),
  index('business_sync_credit_line_order').on(table.transferId, table.validatorSha256, table.documentId, table.position, table.itemId),
]);

export const businessSyncCreditMovements = sqliteTable('business_sync_credit_movements', {
  transferId: text('transfer_id').notNull().references(() => businessSyncTransfers.transferId),
  validatorSha256: text('validator_sha256').notNull(),
  documentId: text('document_id').notNull(),
  movementId: text('movement_id').notNull(),
  kind: text('kind').notNull(),
  date: text('date').notNull(),
  createdAt: text('created_at').notNull(),
  sequence: integer('sequence').notNull(),
  amount: integer('amount').notNull(),
  reversesId: text('reverses_id'),
  validated: integer('validated').notNull().default(0),
  computedVat: integer('computed_vat'),
}, (table) => [
  uniqueIndex('business_sync_credit_movement_identity').on(table.transferId, table.validatorSha256, table.documentId, table.movementId),
  index('business_sync_credit_movement_order').on(table.transferId, table.validatorSha256, table.documentId, table.date, table.createdAt, table.sequence, table.movementId),
]);

export const businessSyncTransferChunks = sqliteTable('business_sync_transfer_chunks', {
  transferId: text('transfer_id').notNull().references(() => businessSyncTransfers.transferId),
  chunkIndex: integer('chunk_index').notNull(),
  sha256: text('sha256').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  rowCount: integer('row_count').notNull(),
  objectKey: text('object_key').notNull(),
}, (table) => [uniqueIndex('business_sync_chunk_identity').on(table.transferId, table.chunkIndex)]);

export const businessSyncFileSets = sqliteTable('business_sync_file_sets', {
  transferId: text('transfer_id').primaryKey().references(() => businessSyncTransfers.transferId),
  manifestJson: text('manifest_json').notNull(),
  manifestSha256: text('manifest_sha256').notNull(),
  state: text('state').notNull(),
});

export const businessSyncTransactionParts = sqliteTable('business_sync_transaction_parts', {
  transactionId: text('transaction_id').notNull().references(() => businessSyncTransfers.transferId),
  partIndex: integer('part_index').notNull(),
  sha256: text('sha256').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  changeCount: integer('change_count').notNull(),
  firstSequence: text('first_sequence').notNull(),
  lastSequence: text('last_sequence').notNull(),
  objectKey: text('object_key').notNull(),
}, table => [uniqueIndex('business_sync_transaction_part_identity').on(table.transactionId,table.partIndex)]);

// Disposable candidate snapshots are pinned to a committed revision. They are
// never authoritative merely because every transport fragment was received.
export const businessSyncTransactionReviews = sqliteTable('business_sync_transaction_reviews', {
  transferId:text('transfer_id').primaryKey().references(()=>businessSyncTransfers.transferId),
  attempt:text('attempt').notNull(),
  generation:text('generation').notNull(),
  manifestSha256:text('manifest_sha256').notNull(),
  validatorSha256:text('validator_sha256').notNull(),
  sourceTransferId:text('source_transfer_id').notNull().references(()=>businessSyncTransfers.transferId),
  sourceRevision:integer('source_revision').notNull(),
  state:text('state').notNull(),
  lastTable:text('last_table').notNull().default(''),
  lastKey:text('last_key').notNull().default(''),
  copiedRows:integer('copied_rows').notNull().default(0),
  copiedBytes:integer('copied_bytes').notNull().default(0),
  nextChunk:integer('next_chunk').notNull().default(0),
  appliedChanges:integer('applied_changes').notNull().default(0),
  baseAuditHash:text('base_audit_hash'),
  lastAuditHash:text('last_audit_hash'),
  auditEntries:integer('audit_entries').notNull().default(0),
  failedRule:text('failed_rule'),
  updatedAt:text('updated_at').notNull(),
});
export const businessSyncTransactionValidations=sqliteTable('business_sync_transaction_validations',{
  transferId:text('transfer_id').primaryKey().references(()=>businessSyncTransfers.transferId),
  attempt:text('attempt').notNull(),
  validatorSha256:text('validator_sha256').notNull(),
  algorithmVersion:integer('algorithm_version').notNull().default(1),
  phase:text('phase').notNull(),
  tableCountsJson:text('table_counts_json').notNull(),
  nextStructuralRule:integer('next_structural_rule').notNull().default(0),
  nextAccountingRule:integer('next_accounting_rule').notNull().default(0),
  checkedChanges:integer('checked_changes').notNull().default(0),
  nextChangeChunk:integer('next_change_chunk').notNull().default(0),
  failedChange:integer('failed_change'),
  failedRule:text('failed_rule'),
  updatedAt:text('updated_at').notNull(),
});
export const businessSyncTransactionDocumentStates=sqliteTable('business_sync_transaction_document_states',{
  transferId:text('transfer_id').notNull().references(()=>businessSyncTransfers.transferId),
  validatorSha256:text('validator_sha256').notNull(),
  tableName:text('table_name').notNull(),
  rowKeyJson:text('row_key_json').notNull(),
  issued:integer('issued').notNull(),
},table=>[uniqueIndex('business_sync_transaction_document_state').on(table.transferId,table.validatorSha256,table.tableName,table.rowKeyJson)]);
export const businessSyncTransactionAccountingStates=sqliteTable('business_sync_transaction_accounting_states',{
  transferId:text('transfer_id').notNull().references(()=>businessSyncTransfers.transferId),
  validatorSha256:text('validator_sha256').notNull(),
  tableName:text('table_name').notNull(),
  rowKeyJson:text('row_key_json').notNull(),
  rowJson:text('row_json'),
},table=>[uniqueIndex('business_sync_transaction_accounting_state').on(table.transferId,table.validatorSha256,table.tableName,table.rowKeyJson)]);
export const businessSyncTransactionEffects=sqliteTable('business_sync_transaction_effects',{
  transferId:text('transfer_id').notNull().references(()=>businessSyncTransfers.transferId),
  validatorSha256:text('validator_sha256').notNull(),
  effectName:text('effect_name').notNull(),
  causePosition:integer('cause_position').notNull(),
  tableName:text('table_name').notNull(),
  rowKeyJson:text('row_key_json').notNull(),
  beforeJson:text('before_json'),
  afterJson:text('after_json').notNull(),
},table=>[uniqueIndex('business_sync_transaction_effect_identity').on(table.transferId,table.validatorSha256,table.tableName,table.rowKeyJson)]);
export const businessSyncTransactionConflicts=sqliteTable('business_sync_transaction_conflicts',{
  transferId:text('transfer_id').notNull().references(()=>businessSyncTransfers.transferId),
  attempt:text('attempt').notNull(),
  tableName:text('table_name').notNull(),
  rowKeyJson:text('row_key_json').notNull(),
  partIndex:integer('part_index').notNull(),
  changeIndex:integer('change_index').notNull(),
  expectedSha256:text('expected_sha256'),
  currentSha256:text('current_sha256'),
  incomingSha256:text('incoming_sha256'),
  reason:text('reason').notNull(),
},table=>[uniqueIndex('business_sync_transaction_conflict_identity').on(table.transferId,table.attempt,table.tableName,table.rowKeyJson)]);
export const businessSyncCandidateOrder=sqliteTable('business_sync_candidate_order',{
  transferId:text('transfer_id').notNull().references(()=>businessSyncTransfers.transferId),
  tableName:text('table_name').notNull(),
  lastValue:integer('last_value').notNull(),
},table=>[uniqueIndex('business_sync_candidate_order_identity').on(table.transferId,table.tableName)]);
// Original device chains remain distinct, even when they share the bootstrap
// audit anchor. Only canonical commitment may advance a branch's last hash.
export const businessSyncAuditBranches=sqliteTable('business_sync_audit_branches',{
  organizationId:text('organization_id').notNull().references(()=>organizations.organizationId),
  generation:text('generation').notNull(),
  installationId:text('installation_id').notNull(),
  captureGeneration:text('capture_generation').notNull(),
  lastHash:text('last_hash'),
  lastSequence:text('last_sequence').notNull(),
  revision:integer('revision').notNull(),
},table=>[uniqueIndex('business_sync_audit_branch_identity').on(table.organizationId,table.generation,table.installationId,table.captureGeneration)]);

// Images remain in the original bounded R2 chunks. Only conflict/order/file
// metadata lives here; a pair of 1 MiB images must not exceed a D1 row limit.
export const businessSyncTransactionChanges = sqliteTable('business_sync_transaction_changes', {
  transactionId: text('transaction_id').notNull().references(() => businessSyncTransfers.transferId),
  organizationId: text('organization_id').notNull().references(() => organizations.organizationId),
  installationId: text('installation_id').notNull(),
  captureGeneration: text('capture_generation').notNull(),
  sequence: text('sequence').notNull(),
  partIndex: integer('part_index').notNull(),
  changeIndex: integer('change_index').notNull(),
  tableName: text('table_name').notNull(),
  rowKeyJson: text('row_key_json').notNull(),
  operation: text('operation').notNull(),
  beforeSha256: text('before_sha256'),
  afterSha256: text('after_sha256'),
  sourceRowid: text('source_rowid').notNull(),
  filesJson: text('files_json').notNull(),
}, table => [
  uniqueIndex('business_sync_transaction_sequence').on(table.organizationId,table.installationId,table.captureGeneration,table.sequence),
  uniqueIndex('business_sync_transaction_change_index').on(table.transactionId,table.partIndex,table.changeIndex),
  index('business_sync_transaction_row_chain').on(table.transactionId,table.tableName,table.rowKeyJson),
  index('business_sync_transaction_row_timeline').on(table.transactionId,table.tableName,table.rowKeyJson,table.partIndex,table.changeIndex),
]);

export const businessSyncFilePages = sqliteTable('business_sync_file_pages', {
  transferId: text('transfer_id').notNull().references(() => businessSyncTransfers.transferId),
  pageIndex: integer('page_index').notNull(),
  sha256: text('sha256').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  fileCount: integer('file_count').notNull(),
}, (table) => [uniqueIndex('business_sync_file_page_identity').on(table.transferId, table.pageIndex)]);

export const businessSyncFileEntries = sqliteTable('business_sync_file_entries', {
  transferId: text('transfer_id').notNull().references(() => businessSyncTransfers.transferId),
  pathKey: text('path_key').notNull(),
  path: text('path').notNull(),
  sha256: text('sha256').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  pageIndex: integer('page_index').notNull(),
}, (table) => [uniqueIndex('business_sync_file_path_identity').on(table.transferId, table.pathKey)]);

export const businessSyncFileBlobs = sqliteTable('business_sync_file_blobs', {
  transferId: text('transfer_id').notNull().references(() => businessSyncTransfers.transferId),
  sha256: text('sha256').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  verifiedAt: text('verified_at'),
}, (table) => [uniqueIndex('business_sync_file_blob_identity').on(table.transferId, table.sha256)]);

export const businessSyncFileParts = sqliteTable('business_sync_file_parts', {
  transferId: text('transfer_id').notNull().references(() => businessSyncTransfers.transferId),
  fileSha256: text('file_sha256').notNull(),
  partIndex: integer('part_index').notNull(),
  sha256: text('sha256').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  objectKey: text('object_key').notNull(),
}, (table) => [uniqueIndex('business_sync_file_part_identity').on(table.transferId, table.fileSha256, table.partIndex)]);

export const businessSyncRowOrder = sqliteTable(
  'business_sync_row_order',
  {
    transferId: text('transfer_id')
      .notNull()
      .references(() => businessSyncTransfers.transferId),
    tableName: text('table_name').notNull(),
    rowKeyJson: text('row_key_json').notNull(),
    sourceRowid: text('source_rowid').notNull(),
  },
  (table) => [
    uniqueIndex('business_sync_source_order_key').on(
      table.transferId,
      table.tableName,
      table.rowKeyJson,
    ),
    uniqueIndex('business_sync_source_order_position').on(
      table.transferId,
      table.tableName,
      table.sourceRowid,
    ),
  ],
);

export const businessSyncVersions = sqliteTable('business_sync_versions', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  transferId: text('transfer_id').notNull().references(() => businessSyncTransfers.transferId),
  organizationId: text('organization_id').notNull().references(() => organizations.organizationId),
  tableName: text('table_name').notNull(),
  rowKeyJson: text('row_key_json').notNull(),
  rowJson: text('row_json'),
  rowSha256: text('row_sha256'),
  beforeSha256: text('before_sha256'),
}, (table) => [
  uniqueIndex('business_sync_transfer_row').on(table.transferId, table.tableName, table.rowKeyJson),
  index('business_sync_row_history').on(table.organizationId, table.tableName, table.rowKeyJson, table.sequence),
  index('business_sync_journal_source').on(table.transferId,table.organizationId,sql`json_extract(${table.rowJson},'$.source_type')`,sql`json_extract(${table.rowJson},'$.source_id')`).where(sql`${table.tableName}='journal_entries'`),
  index('business_sync_supplier_payment_parent').on(table.transferId,table.organizationId,sql`json_extract(${table.rowJson},'$.supplier_invoice_id')`).where(sql`${table.tableName}='supplier_payments'`),
  index('business_sync_supplier_allocation_parent').on(table.transferId,table.organizationId,sql`json_extract(${table.rowJson},'$.supplier_invoice_id')`).where(sql`${table.tableName}='supplier_credit_allocations'`),
]);

export const documentNumberReservations = sqliteTable('document_number_reservations', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  organizationId: text('organization_id').notNull().references(() => organizations.organizationId),
  requestId: text('request_id').notNull(),
  installationId: text('installation_id').notNull(),
  createdBy: text('created_by').notNull(),
  prefix: text('prefix').notNull(),
  year: integer('year').notNull(),
  minimum: integer('minimum').notNull(),
  count: integer('count').notNull(),
  startValue: integer('start_value').notNull(),
  endValue: integer('end_value').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('document_number_reservations_request').on(table.organizationId, table.requestId),
  index('document_number_reservations_range').on(table.organizationId, table.prefix, table.year, table.endValue),
]);

export const workspaceBackups = sqliteTable('workspace_backups', {
  backupId: text('backup_id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.organizationId),
  installationId: text('installation_id').notNull(),
  createdBy: text('created_by').notNull(),
  manifestJson: text('manifest_json').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  state: text('state').notNull(),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [index('workspace_backups_org_created').on(table.organizationId, table.createdAt)]);

export const workspaceBackupChunks = sqliteTable('workspace_backup_chunks', {
  backupId: text('backup_id').notNull().references(() => workspaceBackups.backupId),
  chunkIndex: integer('chunk_index').notNull(),
  sha256: text('sha256').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
}, (table) => [uniqueIndex('workspace_backup_chunk_identity').on(table.backupId, table.chunkIndex)]);

export const projectDocumentEvents = sqliteTable('project_document_events', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  organizationId: text('organization_id').notNull().references(() => organizations.organizationId),
  documentId: text('document_id').notNull(),
  projectId: text('project_id').notNull(),
  projectName: text('project_name').notNull(),
  action: text('action').notNull(),
  originalName: text('original_name').notNull(),
  mediaType: text('media_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  objectKey: text('object_key').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [
  uniqueIndex('project_document_event_identity').on(table.organizationId, table.documentId, table.action),
  index('project_document_event_feed').on(table.organizationId, table.sequence),
  index('project_document_event_project').on(table.organizationId, table.projectId),
]);

export const checkoutAttempts = sqliteTable(
  'checkout_attempts',
  {
    claimHash: text('claim_hash').primaryKey(),
    checkoutSessionId: text('checkout_session_id'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [
    uniqueIndex('checkout_attempts_session_idx').on(table.checkoutSessionId),
    index('checkout_attempts_expiry_idx').on(table.expiresAt),
  ],
);

export const subscriptions = sqliteTable(
  'subscriptions',
  {
    subscriptionId: text('subscription_id').primaryKey(),
    customerId: text('customer_id').notNull(),
    checkoutSessionId: text('checkout_session_id'),
    customerEmail: text('customer_email'),
    customerName: text('customer_name'),
    priceId: text('price_id').notNull(),
    planId: text('plan_id').notNull().default('zentra-monthly-50-chf'),
    entitlementPlanId: text('entitlement_plan_id').notNull().default('zentra-monthly-50-chf'),
    seatLimit: integer('seat_limit'),
    status: text('status').notNull(),
    currentPeriodEnd: integer('current_period_end').notNull(),
    cancelAtPeriodEnd: integer('cancel_at_period_end', { mode: 'boolean' })
      .notNull()
      .default(false),
    livemode: integer('livemode', { mode: 'boolean' }).notNull().default(false),
    entitlementValidUntil: integer('entitlement_valid_until')
      .notNull()
      .default(0),
    lastPaidInvoiceId: text('last_paid_invoice_id'),
    lastPaidAt: integer('last_paid_at'),
    lastPaymentFailureInvoiceId: text('last_payment_failure_invoice_id'),
    lastPaymentFailureAt: integer('last_payment_failure_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('subscriptions_checkout_session_idx').on(
      table.checkoutSessionId,
    ),
    index('subscriptions_customer_idx').on(table.customerId),
    index('subscriptions_status_idx').on(table.status, table.currentPeriodEnd),
  ],
);

export const licenseActivations = sqliteTable(
  'license_activations',
  {
    licenseId: text('license_id').primaryKey(),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => subscriptions.subscriptionId, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    installationId: text('installation_id').notNull(),
    activatedAt: integer('activated_at').notNull(),
    lastIssuedAt: integer('last_issued_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    uniqueIndex('license_activations_subscription_installation_idx').on(
      table.subscriptionId,
      table.installationId,
    ),
    index('license_activations_subscription_idx').on(table.subscriptionId),
  ],
);

export const stripeEvents = sqliteTable(
  'stripe_events',
  {
    eventId: text('event_id').primaryKey(),
    eventType: text('event_type').notNull(),
    livemode: integer('livemode', { mode: 'boolean' }).notNull(),
    eventCreatedAt: integer('event_created_at').notNull().default(0),
    receivedAt: integer('received_at').notNull(),
    processingStartedAt: integer('processing_started_at'),
    processingAttempts: integer('processing_attempts').notNull().default(0),
    processedAt: integer('processed_at'),
  },
  (table) => [
    index('stripe_events_processed_idx').on(table.processedAt),
    index('stripe_events_processing_idx').on(table.processingStartedAt),
  ],
);

export const stripeWebhookProofs = sqliteTable('stripe_webhook_proofs', {
  endpointId: text('endpoint_id').primaryKey(),
  secretSha256: text('secret_sha256').notNull(),
  livemode: integer('livemode', { mode: 'boolean' }).notNull(),
  apiVersion: text('api_version').notNull(),
  lastVerifiedEventId: text('last_verified_event_id').notNull(),
  verifiedAt: integer('verified_at').notNull(),
});

export const checkoutRateLimits = sqliteTable(
  'checkout_rate_limits',
  {
    rateKey: text('rate_key').primaryKey(),
    count: integer('count').notNull().default(1),
    windowStartedAt: integer('window_started_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('checkout_rate_limits_expiry_idx').on(table.expiresAt)],
);

export const organizations = sqliteTable(
  'organizations',
  {
    organizationId: text('organization_id').primaryKey(),
    name: text('name').notNull(),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => subscriptions.subscriptionId, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    createdByUserId: text('created_by_user_id').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('organizations_subscription_idx').on(table.subscriptionId),
    index('organizations_creator_idx').on(table.createdByUserId),
  ],
);

export const organizationMembers = sqliteTable(
  'organization_members',
  {
    membershipId: text('membership_id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.organizationId, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    userId: text('user_id').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    role: text('role').notNull(),
    joinedAt: integer('joined_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    uniqueIndex('organization_members_user_idx').on(
      table.organizationId,
      table.userId,
    ),
    index('organization_members_email_idx').on(table.email),
    index('organization_members_active_idx').on(
      table.organizationId,
      table.revokedAt,
    ),
  ],
);

export const organizationInvitations = sqliteTable(
  'organization_invitations',
  {
    invitationId: text('invitation_id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.organizationId, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    tokenHash: text('token_hash').notNull(),
    invitedEmail: text('invited_email'),
    role: text('role').notNull(),
    createdByUserId: text('created_by_user_id').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    acceptedByUserId: text('accepted_by_user_id'),
    acceptedAt: integer('accepted_at'),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    uniqueIndex('organization_invitations_token_idx').on(table.tokenHash),
    index('organization_invitations_expiry_idx').on(table.expiresAt),
  ],
);

export const deviceAuthorizations = sqliteTable(
  'device_authorizations',
  {
    deviceCodeHash: text('device_code_hash').primaryKey(),
    userCode: text('user_code').notNull(),
    installationId: text('installation_id').notNull(),
    status: text('status').notNull(),
    organizationId: text('organization_id').references(
      () => organizations.organizationId,
      { onDelete: 'cascade', onUpdate: 'cascade' },
    ),
    approvedByUserId: text('approved_by_user_id'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    approvedAt: integer('approved_at'),
    consumedAt: integer('consumed_at'),
  },
  (table) => [
    uniqueIndex('device_authorizations_user_code_idx').on(table.userCode),
    index('device_authorizations_expiry_idx').on(table.expiresAt),
  ],
);

export const deviceSessions = sqliteTable(
  'device_sessions',
  {
    sessionId: text('session_id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.organizationId, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    userId: text('user_id').notNull(),
    installationId: text('installation_id').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    uniqueIndex('device_sessions_token_idx').on(table.tokenHash),
    index('device_sessions_organization_idx').on(
      table.organizationId,
      table.revokedAt,
    ),
    index('device_sessions_user_idx').on(table.userId, table.revokedAt),
  ],
);

export const invoiceArchives = sqliteTable(
  'invoice_archives',
  {
    archiveId: text('archive_id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.organizationId, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    sourceInvoiceId: text('source_invoice_id').notNull(),
    revision: integer('revision').notNull(),
    invoiceNumber: text('invoice_number').notNull(),
    issueDate: text('issue_date').notNull(),
    paidAt: text('paid_at'),
    correctionKind: text('correction_kind').notNull(),
    correctionReason: text('correction_reason'),
    supersedesArchiveId: text('supersedes_archive_id'),
    objectKey: text('object_key').notNull(),
    contentSha256: text('content_sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    mediaType: text('media_type').notNull(),
    previousChainSha256: text('previous_chain_sha256'),
    chainSha256: text('chain_sha256').notNull(),
    retentionUntil: text('retention_until').notNull(),
    storedBySessionId: text('stored_by_session_id').notNull(),
    storedAt: integer('stored_at').notNull(),
    storageStatus: text('storage_status').notNull(),
  },
  (table) => [
    uniqueIndex('invoice_archives_revision_idx').on(
      table.organizationId,
      table.sourceInvoiceId,
      table.revision,
    ),
    uniqueIndex('invoice_archives_object_idx').on(table.objectKey),
    index('invoice_archives_number_idx').on(
      table.organizationId,
      table.invoiceNumber,
    ),
    index('invoice_archives_retention_idx').on(table.retentionUntil),
  ],
);
