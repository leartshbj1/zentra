import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { organizations } from './schema';

export const companyMailConnections = sqliteTable('company_mail_connections', {
  organizationId: text('organization_id')
    .primaryKey()
    .references(() => organizations.organizationId, { onDelete: 'cascade' }),
  connectionId: text('connection_id').notNull(),
  provider: text('provider').notNull(),
  mailboxId: text('mailbox_id').notNull(),
  identityId: text('identity_id'),
  fromEmail: text('from_email').notNull(),
  fromName: text('from_name').notNull(),
  secretCiphertext: text('secret_ciphertext').notNull(),
  connectedBy: text('connected_by').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
export const companyMailSubmissions = sqliteTable(
  'company_mail_submissions',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.organizationId, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    connectionId: text('connection_id').notNull(),
    actorId: text('actor_id').notNull(),
    entity: text('entity').notNull(),
    documentId: text('document_id').notNull(),
    recipient: text('recipient').notNull(),
    subject: text('subject').notNull(),
    fromEmail: text('from_email').notNull(),
    attachmentHash: text('attachment_hash').notNull(),
    state: text('state').notNull(),
    draftId: text('draft_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.requestId] }),
    index('company_mail_document_idx').on(
      table.organizationId,
      table.entity,
      table.documentId,
      table.createdAt,
    ),
    index('company_mail_rate_idx').on(table.organizationId, table.createdAt),
  ],
);
