import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { organizations } from './schema';
import { supportWorkspaces } from './support-schema';

export const supportGestionLinks = sqliteTable(
  'support_gestion_links',
  {
    workspaceId: text('workspace_id')
      .primaryKey()
      .references(() => supportWorkspaces.id),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.organizationId),
    enabled: integer('enabled').notNull().default(1),
    autoPost: integer('auto_post').notNull().default(0),
    connectedBy: text('connected_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('support_gestion_organization').on(t.organizationId)],
);
export const supplierInbox = sqliteTable(
  'supplier_inbox',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.organizationId),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => supportWorkspaces.id),
    connectionId: text('connection_id').notNull(),
    messageId: text('message_id').notNull(),
    sourceSha256: text('source_sha256').notNull(),
    fileName: text('file_name').notNull(),
    mediaType: text('media_type').notNull(),
    objectKey: text('object_key').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sender: text('sender').notNull(),
    subject: text('subject').notNull(),
    extraction: text('extraction').notNull(),
    state: text('state').notNull().default('review'),
    claimedInstallation: text('claimed_installation'),
    claimToken: text('claim_token'),
    invoiceId: text('invoice_id'),
    automatic: integer('automatic').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    importedAt: integer('imported_at'),
  },
  (t) => [
    uniqueIndex('supplier_inbox_document').on(t.organizationId, t.sourceSha256),
    index('supplier_inbox_org_state').on(
      t.organizationId,
      t.state,
      t.createdAt,
    ),
    index('supplier_inbox_message').on(t.connectionId, t.messageId),
  ],
);
export const supplierMailReceipts = sqliteTable('supplier_mail_receipts', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  createdAt: integer('created_at').notNull(),
});
