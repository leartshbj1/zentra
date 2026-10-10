-- Migration number: 0094 	 2026-10-10T02:07:46.032Z
-- H2a: explicit US mailbox connection/reading only. No mail intake or legacy
-- Support writes. Auth, catalogue and provider verification remain server ports.
CREATE VIEW international_us_support_mailbox_admissible AS
SELECT a.*,w.workspace_id FROM international_us_support_admissible a
JOIN international_us_support_workspaces w ON w.organization_id=a.organization_id AND w.owner_user_id=a.owner_user_id;
--> statement-breakpoint
CREATE TABLE international_us_support_mailbox_receipts (
  command_id TEXT PRIMARY KEY NOT NULL REFERENCES international_us_support_mailbox_commits(command_id) DEFERRABLE INITIALLY DEFERRED,
  organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,actor_user_id TEXT NOT NULL,request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  action TEXT NOT NULL CHECK(action IN('connect','disconnect')),
  expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision>=0),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision=expected_revision+1 AND revision<9007199254740991),
  connection_id TEXT REFERENCES international_us_support_mailbox_connections(connection_id) DEFERRABLE INITIALLY DEFERRED,
  material_json TEXT NOT NULL CHECK(json_valid(material_json) AND json_type(material_json)='object' AND length(CAST(material_json AS BLOB))<=4096),
  context_json TEXT NOT NULL CHECK(json_valid(context_json) AND json_type(context_json)='object' AND length(CAST(context_json AS BLOB))<=16384),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object' AND length(CAST(receipt_json AS BLOB))<=4096),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
  CHECK((action='connect' AND connection_id IS NOT NULL) OR (action='disconnect' AND connection_id IS NULL)),
  CHECK(length(command_id)=36 AND command_id GLOB '????????-????-????-????-????????????' AND replace(command_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(command_id,15,1) GLOB '[1-8]' AND substr(command_id,20,1) GLOB '[89ab]'),
  CHECK(length(request_id)=36 AND request_id GLOB '????????-????-????-????-????????????' AND replace(request_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(request_id,15,1) GLOB '[1-8]' AND substr(request_id,20,1) GLOB '[89ab]'),
  FOREIGN KEY(organization_id,workspace_id) REFERENCES international_us_support_workspaces(organization_id,workspace_id),
  FOREIGN KEY(organization_id,actor_user_id) REFERENCES international_workspace_members(organization_id,user_id),
  UNIQUE(organization_id,actor_user_id,request_id),UNIQUE(organization_id,workspace_id,revision),UNIQUE(command_id,organization_id,workspace_id,revision)
);
--> statement-breakpoint
CREATE TABLE international_us_support_mailbox_connections (
  connection_id TEXT PRIMARY KEY NOT NULL REFERENCES international_us_support_mailbox_secrets(connection_id) DEFERRABLE INITIALLY DEFERRED,
  organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0 AND revision<9007199254740991),
  command_id TEXT NOT NULL UNIQUE REFERENCES international_us_support_mailbox_receipts(command_id) DEFERRABLE INITIALLY DEFERRED,
  provider TEXT NOT NULL CHECK(provider='infomaniak'),email TEXT NOT NULL CHECK(length(email) BETWEEN 3 AND 254 AND email=lower(trim(email)) AND instr(email,char(0))=0),
  mailbox_id TEXT NOT NULL CHECK(length(mailbox_id) BETWEEN 1 AND 200 AND mailbox_id=trim(mailbox_id) AND instr(mailbox_id,char(0))=0),
  folder_id TEXT NOT NULL CHECK(length(folder_id) BETWEEN 1 AND 200 AND folder_id=trim(folder_id) AND instr(folder_id,char(0))=0),
  token_sha256 TEXT NOT NULL CHECK(length(token_sha256)=64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'),
  verified_at INTEGER NOT NULL CHECK(typeof(verified_at)='integer' AND verified_at BETWEEN 1 AND 253402300799),
  connected_by TEXT NOT NULL,
  CHECK(length(connection_id)=36 AND connection_id GLOB '????????-????-????-????-????????????' AND replace(connection_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(connection_id,15,1) GLOB '[1-8]' AND substr(connection_id,20,1) GLOB '[89ab]'),
  FOREIGN KEY(organization_id,workspace_id) REFERENCES international_us_support_workspaces(organization_id,workspace_id),
  FOREIGN KEY(organization_id,connected_by) REFERENCES international_workspace_members(organization_id,user_id),
  UNIQUE(organization_id,workspace_id,connection_id),UNIQUE(organization_id,workspace_id,revision)
);
--> statement-breakpoint
CREATE TABLE international_us_support_mailbox_secrets (
  connection_id TEXT PRIMARY KEY NOT NULL REFERENCES international_us_support_mailbox_connections(connection_id) DEFERRABLE INITIALLY DEFERRED,
  credentials_ciphertext TEXT CHECK(credentials_ciphertext IS NULL OR (length(credentials_ciphertext) BETWEEN 40 AND 16384 AND credentials_ciphertext GLOB 'v1.*.*')),
  cleared_by_command_id TEXT REFERENCES international_us_support_mailbox_receipts(command_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK((credentials_ciphertext IS NULL)=(cleared_by_command_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE international_us_support_mailbox_heads (
  organization_id TEXT PRIMARY KEY NOT NULL,workspace_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0 AND revision<9007199254740991),
  current_connection_id TEXT,last_command_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY(organization_id,workspace_id) REFERENCES international_us_support_workspaces(organization_id,workspace_id),
  FOREIGN KEY(organization_id,workspace_id,current_connection_id) REFERENCES international_us_support_mailbox_connections(organization_id,workspace_id,connection_id),
  FOREIGN KEY(last_command_id,organization_id,workspace_id,revision) REFERENCES international_us_support_mailbox_receipts(command_id,organization_id,workspace_id,revision) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
-- A receipt cannot commit without its final effect marker. The marker is added
-- only after head CAS, insertion of the new secret and purge of the old secret.
CREATE TABLE international_us_support_mailbox_commits (
  command_id TEXT PRIMARY KEY NOT NULL REFERENCES international_us_support_mailbox_receipts(command_id) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE TRIGGER international_us_support_mailbox_receipt_insert BEFORE INSERT ON international_us_support_mailbox_receipts
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_mailbox_receipts WHERE command_id=NEW.command_id OR (organization_id=NEW.organization_id AND actor_user_id=NEW.actor_user_id AND request_id=NEW.request_id))
    THEN RAISE(ABORT,'us_mailbox_idempotency_conflict') END;
  SELECT CASE WHEN NEW.expected_revision<>COALESCE((SELECT revision FROM international_us_support_mailbox_heads WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id),0)
    THEN RAISE(ABORT,'us_mailbox_revision_conflict') END;
  SELECT CASE WHEN NOT COALESCE(
    (SELECT count(*) FROM json_each(NEW.context_json))=3
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json) WHERE key NOT IN('schemaVersion','authority','workspaceId'))
    AND json_type(NEW.context_json,'$.schemaVersion')='integer' AND json_extract(NEW.context_json,'$.schemaVersion')=1
    AND json_extract(NEW.context_json,'$.workspaceId')=NEW.workspace_id
    AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority'))=15
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority') WHERE key NOT IN('schemaVersion','organizationId','userId','role','ownerUserId','subscriptionId','environment','catalogVersion','priceId','authorityReference','validStartsAt','validEndsAt','seatLimit','checkedAt','credential'))
    AND json_type(NEW.context_json,'$.authority.schemaVersion')='integer' AND json_extract(NEW.context_json,'$.authority.schemaVersion')=1
    AND json_extract(NEW.context_json,'$.authority.organizationId')=NEW.organization_id AND json_extract(NEW.context_json,'$.authority.userId')=NEW.actor_user_id
    AND json_type(NEW.context_json,'$.authority.checkedAt')='integer' AND json_extract(NEW.context_json,'$.authority.checkedAt')=NEW.created_at
    AND json_type(NEW.context_json,'$.authority.validStartsAt')='integer' AND json_type(NEW.context_json,'$.authority.validEndsAt')='integer' AND json_type(NEW.context_json,'$.authority.seatLimit')='integer'
    AND (SELECT count(*) FROM json_each(NEW.material_json))=CASE NEW.action WHEN 'connect' THEN 6 ELSE 4 END
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.material_json) WHERE key NOT IN('schemaVersion','requestId','expectedRevision','action','email','tokenSha256'))
    AND json_type(NEW.material_json,'$.schemaVersion')='integer' AND json_extract(NEW.material_json,'$.schemaVersion')=1
    AND json_extract(NEW.material_json,'$.requestId')=NEW.request_id AND json_extract(NEW.material_json,'$.action')=NEW.action
    AND json_type(NEW.material_json,'$.expectedRevision')='integer' AND json_extract(NEW.material_json,'$.expectedRevision')=NEW.expected_revision
    AND (NEW.action='disconnect' OR (json_type(NEW.material_json,'$.email')='text' AND json_type(NEW.material_json,'$.tokenSha256')='text'))
    AND (SELECT count(*) FROM json_each(NEW.receipt_json))=11
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.receipt_json) WHERE key NOT IN('schemaVersion','organizationId','workspaceId','actorUserId','requestId','requestHash','action','expectedRevision','revision','connectionId','createdAt'))
    AND json_type(NEW.receipt_json,'$.schemaVersion')='integer' AND json_extract(NEW.receipt_json,'$.schemaVersion')=1
    AND json_extract(NEW.receipt_json,'$.organizationId')=NEW.organization_id AND json_extract(NEW.receipt_json,'$.workspaceId')=NEW.workspace_id
    AND json_extract(NEW.receipt_json,'$.actorUserId')=NEW.actor_user_id AND json_extract(NEW.receipt_json,'$.requestId')=NEW.request_id
    AND json_extract(NEW.receipt_json,'$.requestHash')=NEW.request_hash AND json_extract(NEW.receipt_json,'$.action')=NEW.action
    AND json_type(NEW.receipt_json,'$.expectedRevision')='integer' AND json_extract(NEW.receipt_json,'$.expectedRevision')=NEW.expected_revision
    AND json_type(NEW.receipt_json,'$.revision')='integer' AND json_extract(NEW.receipt_json,'$.revision')=NEW.revision
    AND json_extract(NEW.receipt_json,'$.connectionId') IS NEW.connection_id
    AND json_type(NEW.receipt_json,'$.createdAt')='integer' AND json_extract(NEW.receipt_json,'$.createdAt')=NEW.created_at
    AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.context_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
    AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.material_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
    AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.receipt_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1),0)
    THEN RAISE(ABORT,'us_mailbox_invalid_record') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_workspace_members m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.actor_user_id
    AND m.role=json_extract(NEW.context_json,'$.authority.role') AND m.role IN('owner','admin') AND m.revoked_at IS NULL)
    THEN RAISE(ABORT,'us_mailbox_forbidden') END;
  SELECT CASE WHEN NOT COALESCE((json_extract(NEW.context_json,'$.authority.credential.kind')='browser'
    AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=1)
    OR (json_extract(NEW.context_json,'$.authority.credential.kind')='device'
      AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=3
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','sessionId','supportedSchemaVersion'))
      AND json_type(NEW.context_json,'$.authority.credential.supportedSchemaVersion')='integer'
      AND ((json_extract(NEW.context_json,'$.authority.credential.supportedSchemaVersion') IN(1,2,3)
        AND EXISTS(SELECT 1 FROM international_us_device_sessions s WHERE s.session_id=json_extract(NEW.context_json,'$.authority.credential.sessionId')
          AND s.organization_id=NEW.organization_id AND s.user_id=NEW.actor_user_id AND s.role=json_extract(NEW.context_json,'$.authority.role')
          AND s.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND s.supported_schema_version=json_extract(NEW.context_json,'$.authority.credential.supportedSchemaVersion')
          AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch()))
      OR (json_extract(NEW.context_json,'$.authority.credential.supportedSchemaVersion')=4
        AND EXISTS(SELECT 1 FROM international_us_device_v4_sessions s WHERE s.session_id=json_extract(NEW.context_json,'$.authority.credential.sessionId')
          AND s.organization_id=NEW.organization_id AND s.user_id=NEW.actor_user_id AND s.role=json_extract(NEW.context_json,'$.authority.role')
          AND s.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND s.supported_schema_version=4
          AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch())))),0)
    THEN RAISE(ABORT,'us_mailbox_unauthorized') END;
  SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT EXISTS(
    SELECT 1 FROM international_us_support_mailbox_admissible a WHERE a.organization_id=NEW.organization_id AND a.workspace_id=NEW.workspace_id AND a.user_id=NEW.actor_user_id
      AND a.role=json_extract(NEW.context_json,'$.authority.role') AND a.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId')
      AND a.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND a.environment=json_extract(NEW.context_json,'$.authority.environment')
      AND a.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion') AND a.price_id=json_extract(NEW.context_json,'$.authority.priceId')
      AND a.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference') AND a.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt')
      AND a.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt') AND a.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))
    THEN RAISE(ABORT,'us_mailbox_subscription_required') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mailbox_connection_insert BEFORE INSERT ON international_us_support_mailbox_connections
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_mailbox_connections WHERE connection_id=NEW.connection_id)
    OR NOT EXISTS(SELECT 1 FROM international_us_support_mailbox_receipts r WHERE r.command_id=NEW.command_id AND r.organization_id=NEW.organization_id
      AND r.workspace_id=NEW.workspace_id AND r.action='connect' AND r.connection_id=NEW.connection_id AND r.revision=NEW.revision
      AND r.actor_user_id=NEW.connected_by AND json_extract(r.material_json,'$.email')=NEW.email AND json_extract(r.material_json,'$.tokenSha256')=NEW.token_sha256
      AND NEW.verified_at<=unixepoch() AND NEW.verified_at>=unixepoch()-30 AND NEW.verified_at<=r.created_at)
    THEN RAISE(ABORT,'us_mailbox_invalid_record') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mailbox_secret_insert BEFORE INSERT ON international_us_support_mailbox_secrets
BEGIN
  SELECT CASE WHEN NEW.credentials_ciphertext IS NULL OR NEW.cleared_by_command_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM international_us_support_mailbox_secrets WHERE connection_id=NEW.connection_id)
    OR NOT EXISTS(SELECT 1 FROM international_us_support_mailbox_connections c JOIN international_us_support_mailbox_receipts r ON r.command_id=c.command_id
      WHERE c.connection_id=NEW.connection_id AND NOT EXISTS(SELECT 1 FROM international_us_support_mailbox_commits done WHERE done.command_id=r.command_id))
    THEN RAISE(ABORT,'us_mailbox_invalid_record') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mailbox_secret_purge BEFORE UPDATE ON international_us_support_mailbox_secrets
BEGIN
  SELECT CASE WHEN NEW.connection_id<>OLD.connection_id OR OLD.credentials_ciphertext IS NULL OR NEW.credentials_ciphertext IS NOT NULL OR NEW.cleared_by_command_id IS NULL
    OR NOT EXISTS(SELECT 1 FROM international_us_support_mailbox_connections c JOIN international_us_support_mailbox_heads h
      ON h.organization_id=c.organization_id AND h.workspace_id=c.workspace_id AND h.current_connection_id=c.connection_id
      JOIN international_us_support_mailbox_receipts r ON r.command_id=NEW.cleared_by_command_id AND r.organization_id=c.organization_id AND r.workspace_id=c.workspace_id
      WHERE c.connection_id=OLD.connection_id AND r.expected_revision=h.revision AND r.connection_id IS NOT c.connection_id
        AND NOT EXISTS(SELECT 1 FROM international_us_support_mailbox_commits done WHERE done.command_id=r.command_id))
    THEN RAISE(ABORT,'us_mailbox_immutable') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mailbox_head_insert BEFORE INSERT ON international_us_support_mailbox_heads
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_mailbox_heads WHERE organization_id=NEW.organization_id OR workspace_id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM international_us_support_mailbox_receipts r WHERE r.command_id=NEW.last_command_id AND r.organization_id=NEW.organization_id
      AND r.workspace_id=NEW.workspace_id AND r.expected_revision=0 AND r.revision=NEW.revision AND r.connection_id IS NEW.current_connection_id
      AND (r.action='disconnect' OR EXISTS(SELECT 1 FROM international_us_support_mailbox_secrets s WHERE s.connection_id=NEW.current_connection_id AND s.credentials_ciphertext IS NOT NULL)))
    THEN RAISE(ABORT,'us_mailbox_revision_conflict') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mailbox_head_update BEFORE UPDATE ON international_us_support_mailbox_heads
BEGIN
  SELECT CASE WHEN NEW.organization_id<>OLD.organization_id OR NEW.workspace_id<>OLD.workspace_id OR NEW.revision<>OLD.revision+1
    OR NOT EXISTS(SELECT 1 FROM international_us_support_mailbox_receipts r WHERE r.command_id=NEW.last_command_id AND r.organization_id=NEW.organization_id
      AND r.workspace_id=NEW.workspace_id AND r.expected_revision=OLD.revision AND r.revision=NEW.revision AND r.connection_id IS NEW.current_connection_id
      AND (r.action='disconnect' OR EXISTS(SELECT 1 FROM international_us_support_mailbox_secrets s WHERE s.connection_id=NEW.current_connection_id AND s.credentials_ciphertext IS NOT NULL))
      AND (OLD.current_connection_id IS NULL OR EXISTS(SELECT 1 FROM international_us_support_mailbox_secrets s WHERE s.connection_id=OLD.current_connection_id
        AND s.credentials_ciphertext IS NULL AND s.cleared_by_command_id=NEW.last_command_id)))
    THEN RAISE(ABORT,'us_mailbox_revision_conflict') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mailbox_commit_insert BEFORE INSERT ON international_us_support_mailbox_commits
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_mailbox_commits WHERE command_id=NEW.command_id)
    OR NOT EXISTS(SELECT 1 FROM international_us_support_mailbox_receipts r JOIN international_us_support_mailbox_heads h
      ON h.last_command_id=r.command_id AND h.organization_id=r.organization_id AND h.workspace_id=r.workspace_id AND h.revision=r.revision AND h.current_connection_id IS r.connection_id
      JOIN international_us_support_mailbox_admissible a ON a.organization_id=r.organization_id AND a.workspace_id=r.workspace_id AND a.user_id=r.actor_user_id
      WHERE r.command_id=NEW.command_id AND r.created_at<=unixepoch() AND r.created_at>=unixepoch()-30
        AND a.role IN('owner','admin') AND a.role=json_extract(r.context_json,'$.authority.role')
        AND a.authority_reference=json_extract(r.context_json,'$.authority.authorityReference') AND a.valid_starts_at=json_extract(r.context_json,'$.authority.validStartsAt')
        AND a.valid_ends_at=json_extract(r.context_json,'$.authority.validEndsAt'))
    THEN RAISE(ABORT,'us_mailbox_invalid_record') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mailbox_receipt_no_update BEFORE UPDATE ON international_us_support_mailbox_receipts BEGIN SELECT RAISE(ABORT,'us_mailbox_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mailbox_receipt_no_delete BEFORE DELETE ON international_us_support_mailbox_receipts BEGIN SELECT RAISE(ABORT,'us_mailbox_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mailbox_connection_no_update BEFORE UPDATE ON international_us_support_mailbox_connections BEGIN SELECT RAISE(ABORT,'us_mailbox_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mailbox_connection_no_delete BEFORE DELETE ON international_us_support_mailbox_connections BEGIN SELECT RAISE(ABORT,'us_mailbox_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mailbox_secret_no_delete BEFORE DELETE ON international_us_support_mailbox_secrets BEGIN SELECT RAISE(ABORT,'us_mailbox_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mailbox_head_no_delete BEFORE DELETE ON international_us_support_mailbox_heads BEGIN SELECT RAISE(ABORT,'us_mailbox_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mailbox_commit_no_update BEFORE UPDATE ON international_us_support_mailbox_commits BEGIN SELECT RAISE(ABORT,'us_mailbox_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_mailbox_commit_no_delete BEFORE DELETE ON international_us_support_mailbox_commits BEGIN SELECT RAISE(ABORT,'us_mailbox_immutable'); END;
