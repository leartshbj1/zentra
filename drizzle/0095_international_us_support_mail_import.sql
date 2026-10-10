-- Migration number: 0095 	 2026-10-10T02:44:31.829Z
-- H2b: immutable mail attachment provenance and reconciliation only.
-- No legacy Support, PG/R2 foreign keys, content, credentials or mail effects.
CREATE TABLE international_us_support_mail_import_requests (
  command_id TEXT PRIMARY KEY NOT NULL CHECK(length(command_id)=36 AND command_id GLOB '????????-????-????-????-????????????' AND replace(command_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(command_id,15,1) GLOB '[1-8]' AND substr(command_id,20,1) GLOB '[89ab]'),
  organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,actor_user_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id)=36 AND request_id GLOB '????????-????-????-????-????????????' AND replace(request_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(request_id,15,1) GLOB '[1-8]' AND substr(request_id,20,1) GLOB '[89ab]'),request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  connection_id TEXT NOT NULL,mailbox_revision INTEGER NOT NULL CHECK(typeof(mailbox_revision)='integer' AND mailbox_revision>0 AND mailbox_revision<9007199254740991),
  source_hash TEXT NOT NULL CHECK(length(source_hash)=64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object' AND length(CAST(request_json AS BLOB))<=4096),
  source_json TEXT NOT NULL CHECK(json_valid(source_json) AND json_type(source_json)='object' AND length(CAST(source_json AS BLOB))<=4096),
  context_json TEXT NOT NULL CHECK(json_valid(context_json) AND json_type(context_json)='object' AND length(CAST(context_json AS BLOB))<=16384),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
  FOREIGN KEY(organization_id,workspace_id) REFERENCES international_us_support_workspaces(organization_id,workspace_id),
  FOREIGN KEY(organization_id,actor_user_id) REFERENCES international_workspace_members(organization_id,user_id),
  FOREIGN KEY(organization_id,workspace_id,connection_id) REFERENCES international_us_support_mailbox_connections(organization_id,workspace_id,connection_id),
  FOREIGN KEY(organization_id,workspace_id,source_hash) REFERENCES international_us_support_mail_import_sources(organization_id,workspace_id,source_hash) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(organization_id,actor_user_id,request_id)
);
--> statement-breakpoint
CREATE TABLE international_us_support_mail_import_sources (
  organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,source_hash TEXT NOT NULL CHECK(length(source_hash)=64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
  first_command_id TEXT NOT NULL UNIQUE REFERENCES international_us_support_mail_import_requests(command_id) DEFERRABLE INITIALLY DEFERRED,
  connection_id TEXT NOT NULL,mailbox_revision INTEGER NOT NULL CHECK(typeof(mailbox_revision)='integer' AND mailbox_revision>0 AND mailbox_revision<9007199254740991),
  suggested_document_id TEXT NOT NULL CHECK(length(suggested_document_id)=36 AND suggested_document_id GLOB '????????-????-????-????-????????????' AND replace(suggested_document_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(suggested_document_id,15,1) GLOB '[1-8]' AND substr(suggested_document_id,20,1) GLOB '[89ab]'),
  provider TEXT NOT NULL CHECK(provider='infomaniak'),mailbox_id TEXT NOT NULL,folder_id TEXT NOT NULL,uid TEXT NOT NULL,attachment_id TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json) AND json_type(source_json)='object' AND length(CAST(source_json AS BLOB))<=4096),
  claimed_by TEXT NOT NULL,claimed_at INTEGER NOT NULL CHECK(typeof(claimed_at)='integer' AND claimed_at BETWEEN 1 AND 253402300799),
  PRIMARY KEY(organization_id,workspace_id,source_hash),
  UNIQUE(organization_id,workspace_id,provider,mailbox_id,folder_id,uid,attachment_id),
  FOREIGN KEY(organization_id,workspace_id) REFERENCES international_us_support_workspaces(organization_id,workspace_id),
  FOREIGN KEY(organization_id,workspace_id,connection_id) REFERENCES international_us_support_mailbox_connections(organization_id,workspace_id,connection_id),
  FOREIGN KEY(organization_id,claimed_by) REFERENCES international_workspace_members(organization_id,user_id)
);
--> statement-breakpoint
CREATE TABLE international_us_support_mail_import_completions (
  organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,source_hash TEXT NOT NULL,
  command_id TEXT NOT NULL REFERENCES international_us_support_mail_import_requests(command_id),
  document_id TEXT NOT NULL CHECK(length(document_id)=36 AND document_id GLOB '????????-????-????-????-????????????' AND replace(document_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(document_id,15,1) GLOB '[1-8]' AND substr(document_id,20,1) GLOB '[89ab]'),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER NOT NULL CHECK(typeof(size_bytes)='integer' AND size_bytes BETWEEN 1 AND 6291456),
  media_type TEXT NOT NULL CHECK(media_type IN('application/pdf','image/png','image/jpeg')),
  completed_by TEXT NOT NULL,completed_at INTEGER NOT NULL CHECK(typeof(completed_at)='integer' AND completed_at BETWEEN 1 AND 253402300799),
  context_json TEXT NOT NULL CHECK(json_valid(context_json) AND json_type(context_json)='object' AND length(CAST(context_json AS BLOB))<=16384),
  PRIMARY KEY(organization_id,workspace_id,source_hash),
  FOREIGN KEY(organization_id,workspace_id,source_hash) REFERENCES international_us_support_mail_import_sources(organization_id,workspace_id,source_hash),
  FOREIGN KEY(organization_id,completed_by) REFERENCES international_workspace_members(organization_id,user_id)
);
--> statement-breakpoint
CREATE TRIGGER international_us_support_mail_import_request_insert BEFORE INSERT ON international_us_support_mail_import_requests
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_mail_import_requests WHERE command_id=NEW.command_id OR (organization_id=NEW.organization_id AND actor_user_id=NEW.actor_user_id AND request_id=NEW.request_id))
    THEN RAISE(ABORT,'us_mail_import_idempotency_conflict') END;

  SELECT CASE WHEN NOT COALESCE(
    (SELECT count(*) FROM json_each(NEW.context_json))=3 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json) WHERE key NOT IN('schemaVersion','authority','workspaceId'))
    AND json_type(NEW.context_json,'$.schemaVersion')='integer' AND json_extract(NEW.context_json,'$.schemaVersion')=1
    AND json_extract(NEW.context_json,'$.workspaceId')=NEW.workspace_id
    AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority'))=15 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority') WHERE key NOT IN('schemaVersion','organizationId','userId','role','ownerUserId','subscriptionId','environment','catalogVersion','priceId','authorityReference','validStartsAt','validEndsAt','seatLimit','checkedAt','credential'))
    AND json_type(NEW.context_json,'$.authority.schemaVersion')='integer' AND json_extract(NEW.context_json,'$.authority.schemaVersion')=1
    AND json_extract(NEW.context_json,'$.authority.organizationId')=NEW.organization_id AND json_extract(NEW.context_json,'$.authority.userId')=NEW.actor_user_id
    AND json_type(NEW.context_json,'$.authority.checkedAt')='integer' AND json_extract(NEW.context_json,'$.authority.checkedAt')=NEW.created_at
    AND json_type(NEW.context_json,'$.authority.validStartsAt')='integer' AND json_type(NEW.context_json,'$.authority.validEndsAt')='integer'
    AND json_type(NEW.context_json,'$.authority.seatLimit')='integer'
    AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.context_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1),0)
    THEN RAISE(ABORT,'us_mail_import_invalid_record') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_workspace_members m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.actor_user_id
    AND m.role=json_extract(NEW.context_json,'$.authority.role') AND m.role IN('owner','admin') AND m.revoked_at IS NULL)
    THEN RAISE(ABORT,'us_mail_import_forbidden') END;
  SELECT CASE WHEN NOT COALESCE((json_extract(NEW.context_json,'$.authority.credential.kind')='browser'
    AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=1 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind')))
    OR (json_extract(NEW.context_json,'$.authority.credential.kind')='device'
      AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=3 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','sessionId','supportedSchemaVersion'))
      AND json_type(NEW.context_json,'$.authority.credential.supportedSchemaVersion')='integer'
      AND json_extract(NEW.context_json,'$.authority.credential.supportedSchemaVersion')=4
      AND EXISTS(SELECT 1 FROM international_us_device_v4_sessions s WHERE s.session_id=json_extract(NEW.context_json,'$.authority.credential.sessionId')
        AND s.organization_id=NEW.organization_id AND s.user_id=NEW.actor_user_id AND s.role=json_extract(NEW.context_json,'$.authority.role')
        AND s.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND s.supported_schema_version=4
        AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch())),0)
    THEN RAISE(ABORT,'us_mail_import_unauthorized') END;
  SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT EXISTS(
    SELECT 1 FROM international_us_support_mailbox_admissible a WHERE a.organization_id=NEW.organization_id AND a.workspace_id=NEW.workspace_id AND a.user_id=NEW.actor_user_id
      AND a.role=json_extract(NEW.context_json,'$.authority.role') AND a.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId')
      AND a.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND a.environment=json_extract(NEW.context_json,'$.authority.environment')
      AND a.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion') AND a.price_id=json_extract(NEW.context_json,'$.authority.priceId')
      AND a.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference') AND a.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt')
      AND a.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt') AND a.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))
    THEN RAISE(ABORT,'us_mail_import_subscription_required') END;
  SELECT CASE WHEN NOT COALESCE(
    (SELECT count(*) FROM json_each(NEW.request_json))=7 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.request_json) WHERE key NOT IN('schemaVersion','requestId','connectionId','expectedMailboxRevision','uid','attachmentId','expectedMessageVersion'))
    AND json_type(NEW.request_json,'$.schemaVersion')='integer' AND json_extract(NEW.request_json,'$.schemaVersion')=1
    AND json_extract(NEW.request_json,'$.requestId')=NEW.request_id AND json_extract(NEW.request_json,'$.connectionId')=NEW.connection_id
    AND json_type(NEW.request_json,'$.expectedMailboxRevision')='integer' AND json_extract(NEW.request_json,'$.expectedMailboxRevision')=NEW.mailbox_revision
    AND json_type(NEW.request_json,'$.uid')='text' AND length(json_extract(NEW.request_json,'$.uid')) BETWEEN 1 AND 20 AND json_extract(NEW.request_json,'$.uid') NOT GLOB '*[^0-9]*'
    AND json_type(NEW.request_json,'$.attachmentId')='text' AND length(json_extract(NEW.request_json,'$.attachmentId')) BETWEEN 1 AND 200
    AND json_type(NEW.request_json,'$.expectedMessageVersion')='text' AND length(json_extract(NEW.request_json,'$.expectedMessageVersion')) BETWEEN 1 AND 200
    AND (SELECT count(*) FROM json_each(NEW.source_json))=13 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.source_json) WHERE key NOT IN('provider','mailboxId','folderId','uid','attachmentId','messageVersion','messageSha256','sourceName','documentName','receivedAt','contentSha256','sizeBytes','mediaType'))
    AND json_extract(NEW.source_json,'$.provider')='infomaniak'
    AND json_type(NEW.source_json,'$.mailboxId')='text' AND length(json_extract(NEW.source_json,'$.mailboxId')) BETWEEN 1 AND 200
    AND json_type(NEW.source_json,'$.folderId')='text' AND length(json_extract(NEW.source_json,'$.folderId')) BETWEEN 1 AND 200
    AND json_extract(NEW.source_json,'$.uid')=json_extract(NEW.request_json,'$.uid')
    AND json_extract(NEW.source_json,'$.attachmentId')=json_extract(NEW.request_json,'$.attachmentId')
    AND json_extract(NEW.source_json,'$.messageVersion')=json_extract(NEW.request_json,'$.expectedMessageVersion')
    AND json_type(NEW.source_json,'$.messageSha256')='text' AND length(json_extract(NEW.source_json,'$.messageSha256'))=64 AND json_extract(NEW.source_json,'$.messageSha256') NOT GLOB '*[^0-9a-f]*'
    AND json_type(NEW.source_json,'$.contentSha256')='text' AND length(json_extract(NEW.source_json,'$.contentSha256'))=64 AND json_extract(NEW.source_json,'$.contentSha256') NOT GLOB '*[^0-9a-f]*'
    AND json_type(NEW.source_json,'$.sourceName')='text' AND length(json_extract(NEW.source_json,'$.sourceName')) BETWEEN 1 AND 180
    AND json_type(NEW.source_json,'$.documentName')='text' AND length(json_extract(NEW.source_json,'$.documentName')) BETWEEN 1 AND 160
    AND json_type(NEW.source_json,'$.receivedAt')='integer' AND json_extract(NEW.source_json,'$.receivedAt') BETWEEN 1 AND 253402300799
    AND json_type(NEW.source_json,'$.sizeBytes')='integer' AND json_extract(NEW.source_json,'$.sizeBytes') BETWEEN 1 AND 6291456
    AND json_extract(NEW.source_json,'$.mediaType') IN('application/pdf','image/png','image/jpeg')
    AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.request_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
    AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.source_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1),0)
    THEN RAISE(ABORT,'us_mail_import_invalid_record') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_mailbox_heads h
    JOIN international_us_support_mailbox_connections c ON c.organization_id=h.organization_id AND c.workspace_id=h.workspace_id AND c.connection_id=h.current_connection_id AND c.revision=h.revision
    JOIN international_us_support_mailbox_secrets s ON s.connection_id=c.connection_id AND s.credentials_ciphertext IS NOT NULL AND s.cleared_by_command_id IS NULL
    JOIN international_us_support_mailbox_commits done ON done.command_id=h.last_command_id AND done.command_id=c.command_id
    WHERE h.organization_id=NEW.organization_id AND h.workspace_id=NEW.workspace_id AND h.current_connection_id=NEW.connection_id AND h.revision=NEW.mailbox_revision
      AND c.provider=json_extract(NEW.source_json,'$.provider') AND c.mailbox_id=json_extract(NEW.source_json,'$.mailboxId') AND c.folder_id=json_extract(NEW.source_json,'$.folderId'))
    THEN RAISE(ABORT,'us_mail_import_connection_changed') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_mail_import_sources s WHERE s.organization_id=NEW.organization_id AND s.workspace_id=NEW.workspace_id
    AND (s.source_hash=NEW.source_hash OR (s.provider=json_extract(NEW.source_json,'$.provider') AND s.mailbox_id=json_extract(NEW.source_json,'$.mailboxId')
      AND s.folder_id=json_extract(NEW.source_json,'$.folderId') AND s.uid=json_extract(NEW.source_json,'$.uid') AND s.attachment_id=json_extract(NEW.source_json,'$.attachmentId')))
    AND (s.source_hash<>NEW.source_hash OR s.source_json<>NEW.source_json))
    THEN RAISE(ABORT,'us_mail_import_source_conflict') END;
  SELECT CASE WHEN (SELECT count(*) FROM international_us_support_mail_import_requests WHERE organization_id=NEW.organization_id)>=2000
    OR (NOT EXISTS(SELECT 1 FROM international_us_support_mail_import_sources WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND source_hash=NEW.source_hash)
      AND (SELECT count(*) FROM international_us_support_mail_import_sources WHERE organization_id=NEW.organization_id)>=500)
    THEN RAISE(ABORT,'us_mail_import_capacity_exceeded') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mail_import_source_insert BEFORE INSERT ON international_us_support_mail_import_sources
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_mail_import_sources WHERE (organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND source_hash=NEW.source_hash) OR first_command_id=NEW.first_command_id)
    THEN RAISE(ABORT,'us_mail_import_immutable') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_mail_import_requests r WHERE r.command_id=NEW.first_command_id
    AND r.organization_id=NEW.organization_id AND r.workspace_id=NEW.workspace_id AND r.source_hash=NEW.source_hash AND r.source_json=NEW.source_json
    AND r.connection_id=NEW.connection_id AND r.mailbox_revision=NEW.mailbox_revision AND r.actor_user_id=NEW.claimed_by AND r.created_at=NEW.claimed_at
    AND NEW.provider=json_extract(r.source_json,'$.provider') AND NEW.mailbox_id=json_extract(r.source_json,'$.mailboxId') AND NEW.folder_id=json_extract(r.source_json,'$.folderId')
    AND NEW.uid=json_extract(r.source_json,'$.uid') AND NEW.attachment_id=json_extract(r.source_json,'$.attachmentId'))
    THEN RAISE(ABORT,'us_mail_import_invalid_record') END;
  SELECT CASE WHEN (SELECT count(*) FROM international_us_support_mail_import_sources WHERE organization_id=NEW.organization_id)>=500
    THEN RAISE(ABORT,'us_mail_import_capacity_exceeded') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mail_import_completion_insert BEFORE INSERT ON international_us_support_mail_import_completions
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_mail_import_completions WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND source_hash=NEW.source_hash)
    THEN RAISE(ABORT,'us_mail_import_immutable') END;

  SELECT CASE WHEN NOT COALESCE(
    (SELECT count(*) FROM json_each(NEW.context_json))=3 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json) WHERE key NOT IN('schemaVersion','authority','workspaceId'))
    AND json_type(NEW.context_json,'$.schemaVersion')='integer' AND json_extract(NEW.context_json,'$.schemaVersion')=1
    AND json_extract(NEW.context_json,'$.workspaceId')=NEW.workspace_id
    AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority'))=15 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority') WHERE key NOT IN('schemaVersion','organizationId','userId','role','ownerUserId','subscriptionId','environment','catalogVersion','priceId','authorityReference','validStartsAt','validEndsAt','seatLimit','checkedAt','credential'))
    AND json_type(NEW.context_json,'$.authority.schemaVersion')='integer' AND json_extract(NEW.context_json,'$.authority.schemaVersion')=1
    AND json_extract(NEW.context_json,'$.authority.organizationId')=NEW.organization_id AND json_extract(NEW.context_json,'$.authority.userId')=NEW.completed_by
    AND json_type(NEW.context_json,'$.authority.checkedAt')='integer' AND json_extract(NEW.context_json,'$.authority.checkedAt')=NEW.completed_at
    AND json_type(NEW.context_json,'$.authority.validStartsAt')='integer' AND json_type(NEW.context_json,'$.authority.validEndsAt')='integer'
    AND json_type(NEW.context_json,'$.authority.seatLimit')='integer'
    AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.context_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1),0)
    THEN RAISE(ABORT,'us_mail_import_invalid_record') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_workspace_members m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.completed_by
    AND m.role=json_extract(NEW.context_json,'$.authority.role') AND m.role IN('owner','admin') AND m.revoked_at IS NULL)
    THEN RAISE(ABORT,'us_mail_import_forbidden') END;
  SELECT CASE WHEN NOT COALESCE((json_extract(NEW.context_json,'$.authority.credential.kind')='browser'
    AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=1 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind')))
    OR (json_extract(NEW.context_json,'$.authority.credential.kind')='device'
      AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=3 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','sessionId','supportedSchemaVersion'))
      AND json_type(NEW.context_json,'$.authority.credential.supportedSchemaVersion')='integer'
      AND json_extract(NEW.context_json,'$.authority.credential.supportedSchemaVersion')=4
      AND EXISTS(SELECT 1 FROM international_us_device_v4_sessions s WHERE s.session_id=json_extract(NEW.context_json,'$.authority.credential.sessionId')
        AND s.organization_id=NEW.organization_id AND s.user_id=NEW.completed_by AND s.role=json_extract(NEW.context_json,'$.authority.role')
        AND s.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND s.supported_schema_version=4
        AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch())),0)
    THEN RAISE(ABORT,'us_mail_import_unauthorized') END;
  SELECT CASE WHEN NEW.completed_at>unixepoch() OR NEW.completed_at<unixepoch()-30 OR NOT EXISTS(
    SELECT 1 FROM international_us_support_mailbox_admissible a WHERE a.organization_id=NEW.organization_id AND a.workspace_id=NEW.workspace_id AND a.user_id=NEW.completed_by
      AND a.role=json_extract(NEW.context_json,'$.authority.role') AND a.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId')
      AND a.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND a.environment=json_extract(NEW.context_json,'$.authority.environment')
      AND a.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion') AND a.price_id=json_extract(NEW.context_json,'$.authority.priceId')
      AND a.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference') AND a.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt')
      AND a.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt') AND a.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))
    THEN RAISE(ABORT,'us_mail_import_subscription_required') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_mail_import_sources s
    JOIN international_us_support_mail_import_requests r ON r.command_id=NEW.command_id AND r.organization_id=s.organization_id AND r.workspace_id=s.workspace_id AND r.source_hash=s.source_hash
    WHERE s.organization_id=NEW.organization_id AND s.workspace_id=NEW.workspace_id AND s.source_hash=NEW.source_hash
      AND r.actor_user_id=NEW.completed_by AND NEW.completed_at>=r.created_at AND NEW.completed_at>=s.claimed_at
      AND json_extract(s.source_json,'$.contentSha256')=NEW.content_sha256 AND json_extract(s.source_json,'$.sizeBytes')=NEW.size_bytes AND json_extract(s.source_json,'$.mediaType')=NEW.media_type)
    THEN RAISE(ABORT,'us_mail_import_invalid_record') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mail_import_requests_update BEFORE UPDATE ON international_us_support_mail_import_requests BEGIN SELECT RAISE(ABORT,'us_mail_import_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mail_import_requests_delete BEFORE DELETE ON international_us_support_mail_import_requests BEGIN SELECT RAISE(ABORT,'us_mail_import_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mail_import_sources_update BEFORE UPDATE ON international_us_support_mail_import_sources BEGIN SELECT RAISE(ABORT,'us_mail_import_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mail_import_sources_delete BEFORE DELETE ON international_us_support_mail_import_sources BEGIN SELECT RAISE(ABORT,'us_mail_import_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mail_import_completions_update BEFORE UPDATE ON international_us_support_mail_import_completions BEGIN SELECT RAISE(ABORT,'us_mail_import_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mail_import_completions_delete BEFORE DELETE ON international_us_support_mail_import_completions BEGIN SELECT RAISE(ABORT,'us_mail_import_immutable'); END;
