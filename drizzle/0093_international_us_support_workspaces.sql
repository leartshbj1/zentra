-- Migration number: 0093 	 2026-10-10T01:30:54.209Z
-- H1 US Support registry only. No mailbox, legacy parent, quota or grant is minted.
-- Auth and the approved catalogue are verified upstream. These guards only
-- corroborate retained US facts; they do not verify a provider or browser session.
CREATE TABLE international_us_support_workspaces (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL UNIQUE REFERENCES international_saas_authorities(organization_id),
  owner_user_id TEXT NOT NULL,
  connected_by TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 100 AND name=trim(name) AND instr(name,char(0))=0),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision=1),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
  created_command_id TEXT NOT NULL UNIQUE REFERENCES international_us_support_workspace_receipts(command_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(length(workspace_id)=36 AND workspace_id GLOB '????????-????-????-????-????????????' AND length(replace(workspace_id,'-',''))=32 AND replace(workspace_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(workspace_id,15,1) GLOB '[1-8]' AND substr(workspace_id,20,1) GLOB '[89ab]'),
  FOREIGN KEY(organization_id,owner_user_id) REFERENCES international_workspace_members(organization_id,user_id),
  FOREIGN KEY(organization_id,connected_by) REFERENCES international_workspace_members(organization_id,user_id),
  UNIQUE(organization_id,workspace_id)
);
--> statement-breakpoint
CREATE TABLE international_us_support_workspace_receipts (
  command_id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 100 AND name=trim(name) AND instr(name,char(0))=0),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  command_json TEXT NOT NULL CHECK(json_valid(command_json) AND json_type(command_json)='object' AND length(CAST(command_json AS BLOB))<=4096),
  context_json TEXT NOT NULL CHECK(json_valid(context_json) AND json_type(context_json)='object' AND length(CAST(context_json AS BLOB))<=16384),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object' AND length(CAST(receipt_json AS BLOB))<=2048),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
  CHECK(length(command_id)=36 AND command_id GLOB '????????-????-????-????-????????????' AND length(replace(command_id,'-',''))=32 AND replace(command_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(command_id,15,1) GLOB '[1-8]' AND substr(command_id,20,1) GLOB '[89ab]'),
  CHECK(length(request_id)=36 AND request_id GLOB '????????-????-????-????-????????????' AND length(replace(request_id,'-',''))=32 AND replace(request_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(request_id,15,1) GLOB '[1-8]' AND substr(request_id,20,1) GLOB '[89ab]'),
  FOREIGN KEY(organization_id,actor_user_id) REFERENCES international_workspace_members(organization_id,user_id),
  FOREIGN KEY(organization_id,workspace_id) REFERENCES international_us_support_workspaces(organization_id,workspace_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(organization_id,actor_user_id,request_id)
);
--> statement-breakpoint
-- Complet is the only admitted offer currently carrying both Gestion and Support.
-- The effective view preserves paid-through cancellation and current renewal.
CREATE VIEW international_us_support_admissible AS
SELECT a.organization_id,m.user_id,m.role,a.owner_user_id,a.subscription_id,a.environment,a.catalog_version,a.seat_limit,
  json_extract(a.offer_json,'$.priceId') AS price_id,
  json_extract(a.authority_json,'$.evidence.referenceId') AS authority_reference,
  json_extract(a.authority_json,'$.evidence.startsAt') AS valid_starts_at,
  json_extract(a.authority_json,'$.evidence.endsAt') AS valid_ends_at
FROM international_effective_saas_authorities a
JOIN international_workspace_creation_intents i ON i.creation_id=a.creation_id AND i.organization_id=a.organization_id AND i.own_subscription_id=a.subscription_id
JOIN international_workspace_members m ON m.organization_id=a.organization_id AND m.revoked_at IS NULL
JOIN international_workspace_members owner ON owner.organization_id=a.organization_id AND owner.user_id=a.owner_user_id AND owner.role='owner' AND owner.revoked_at IS NULL
WHERE i.state='ready' AND a.country='US' AND a.currency='USD' AND a.revoked_at IS NULL
  AND json_extract(a.offer_json,'$.module')='complet'
  AND json_extract(a.authority_json,'$.status') IN('active','past_due','canceled')
  AND json_extract(a.authority_json,'$.evidence.kind')='verified_payment'
  AND json_extract(a.authority_json,'$.evidence.revoked')=0
  AND json_extract(a.authority_json,'$.evidence.startsAt')<=unixepoch()
  AND json_extract(a.authority_json,'$.evidence.endsAt')>unixepoch()
  AND (SELECT count(*) FROM international_workspace_members seats WHERE seats.organization_id=a.organization_id AND seats.revoked_at IS NULL)<=a.seat_limit
  AND NOT EXISTS(SELECT 1 FROM organizations legacy WHERE legacy.organization_id=a.organization_id OR legacy.subscription_id=a.subscription_id)
  AND NOT EXISTS(SELECT 1 FROM subscriptions legacy WHERE legacy.subscription_id=a.subscription_id);
--> statement-breakpoint
CREATE TRIGGER international_us_support_receipt_insert BEFORE INSERT ON international_us_support_workspace_receipts
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_workspace_receipts WHERE command_id=NEW.command_id OR (organization_id=NEW.organization_id AND actor_user_id=NEW.actor_user_id AND request_id=NEW.request_id))
    THEN RAISE(ABORT,'us_support_idempotency_conflict') END;
  SELECT CASE WHEN NOT COALESCE(
    (SELECT count(*) FROM json_each(NEW.command_json))=3
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.command_json) WHERE key NOT IN('schemaVersion','requestId','name'))
    AND json_type(NEW.command_json,'$.schemaVersion')='integer' AND json_extract(NEW.command_json,'$.schemaVersion')=1
    AND json_extract(NEW.command_json,'$.requestId')=NEW.request_id AND json_extract(NEW.command_json,'$.name')=NEW.name
    AND (SELECT count(*) FROM json_each(NEW.context_json))=15
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json) WHERE key NOT IN('schemaVersion','organizationId','userId','role','ownerUserId','subscriptionId','environment','catalogVersion','priceId','authorityReference','validStartsAt','validEndsAt','seatLimit','checkedAt','credential'))
    AND json_type(NEW.context_json,'$.schemaVersion')='integer' AND json_extract(NEW.context_json,'$.schemaVersion')=1
    AND json_extract(NEW.context_json,'$.organizationId')=NEW.organization_id AND json_extract(NEW.context_json,'$.userId')=NEW.actor_user_id
    AND json_type(NEW.context_json,'$.checkedAt')='integer' AND json_extract(NEW.context_json,'$.checkedAt')=NEW.created_at
    AND json_type(NEW.context_json,'$.validStartsAt')='integer' AND json_type(NEW.context_json,'$.validEndsAt')='integer' AND json_type(NEW.context_json,'$.seatLimit')='integer'
    AND (SELECT count(*) FROM json_each(NEW.receipt_json))=6
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.receipt_json) WHERE key NOT IN('schemaVersion','organizationId','requestId','workspaceId','actorUserId','createdAt'))
    AND json_type(NEW.receipt_json,'$.schemaVersion')='integer' AND json_extract(NEW.receipt_json,'$.schemaVersion')=1
    AND json_extract(NEW.receipt_json,'$.organizationId')=NEW.organization_id AND json_extract(NEW.receipt_json,'$.requestId')=NEW.request_id
    AND json_extract(NEW.receipt_json,'$.workspaceId')=NEW.workspace_id AND json_extract(NEW.receipt_json,'$.actorUserId')=NEW.actor_user_id
    AND json_type(NEW.receipt_json,'$.createdAt')='integer' AND json_extract(NEW.receipt_json,'$.createdAt')=NEW.created_at
    AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.context_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
    AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.command_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
    AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.receipt_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1),0)
    THEN RAISE(ABORT,'us_support_invalid_record') END;
  SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT EXISTS(
    SELECT 1 FROM international_us_support_admissible a WHERE a.organization_id=NEW.organization_id AND a.user_id=NEW.actor_user_id
      AND a.owner_user_id=json_extract(NEW.context_json,'$.ownerUserId') AND a.subscription_id=json_extract(NEW.context_json,'$.subscriptionId')
      AND a.environment=json_extract(NEW.context_json,'$.environment') AND a.catalog_version=json_extract(NEW.context_json,'$.catalogVersion')
      AND a.price_id=json_extract(NEW.context_json,'$.priceId') AND a.authority_reference=json_extract(NEW.context_json,'$.authorityReference')
      AND a.valid_starts_at=json_extract(NEW.context_json,'$.validStartsAt') AND a.valid_ends_at=json_extract(NEW.context_json,'$.validEndsAt')
      AND a.seat_limit=json_extract(NEW.context_json,'$.seatLimit'))
    THEN RAISE(ABORT,'us_support_subscription_required') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_admissible a WHERE a.organization_id=NEW.organization_id AND a.user_id=NEW.actor_user_id
    AND a.role=json_extract(NEW.context_json,'$.role') AND a.role IN('owner','admin'))
    THEN RAISE(ABORT,'us_support_forbidden') END;
  SELECT CASE WHEN NOT COALESCE((json_extract(NEW.context_json,'$.credential.kind')='browser'
      AND (SELECT count(*) FROM json_each(NEW.context_json,'$.credential'))=1)
    OR (json_extract(NEW.context_json,'$.credential.kind')='device'
      AND (SELECT count(*) FROM json_each(NEW.context_json,'$.credential'))=3
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.credential') WHERE key NOT IN('kind','sessionId','supportedSchemaVersion'))
      AND json_type(NEW.context_json,'$.credential.supportedSchemaVersion')='integer'
      AND ((json_extract(NEW.context_json,'$.credential.supportedSchemaVersion') IN(1,2,3)
        AND EXISTS(SELECT 1 FROM international_us_device_sessions s WHERE s.session_id=json_extract(NEW.context_json,'$.credential.sessionId')
          AND s.organization_id=NEW.organization_id AND s.user_id=NEW.actor_user_id AND s.role=json_extract(NEW.context_json,'$.role')
          AND s.subscription_id=json_extract(NEW.context_json,'$.subscriptionId') AND s.supported_schema_version=json_extract(NEW.context_json,'$.credential.supportedSchemaVersion')
          AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch()))
        OR (json_extract(NEW.context_json,'$.credential.supportedSchemaVersion')=4
        AND EXISTS(SELECT 1 FROM international_us_device_v4_sessions s WHERE s.session_id=json_extract(NEW.context_json,'$.credential.sessionId')
          AND s.organization_id=NEW.organization_id AND s.user_id=NEW.actor_user_id AND s.role=json_extract(NEW.context_json,'$.role')
          AND s.subscription_id=json_extract(NEW.context_json,'$.subscriptionId') AND s.supported_schema_version=4
          AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch())))),0)
    THEN RAISE(ABORT,'us_support_unauthorized') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM support_workspaces WHERE id=NEW.workspace_id)
    OR EXISTS(SELECT 1 FROM international_us_support_workspaces WHERE (workspace_id=NEW.workspace_id AND organization_id<>NEW.organization_id)
      OR (organization_id=NEW.organization_id AND (workspace_id<>NEW.workspace_id OR name<>NEW.name OR owner_user_id<>json_extract(NEW.context_json,'$.ownerUserId'))))
    THEN RAISE(ABORT,'us_support_workspace_conflict') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_workspace_insert BEFORE INSERT ON international_us_support_workspaces
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_workspaces WHERE workspace_id=NEW.workspace_id OR organization_id=NEW.organization_id)
    OR EXISTS(SELECT 1 FROM support_workspaces WHERE id=NEW.workspace_id)
    THEN RAISE(ABORT,'us_support_workspace_conflict') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_workspace_receipts r
    JOIN international_us_support_admissible a ON a.organization_id=r.organization_id AND a.user_id=r.actor_user_id
    WHERE r.command_id=NEW.created_command_id AND r.organization_id=NEW.organization_id AND r.workspace_id=NEW.workspace_id
      AND r.actor_user_id=NEW.connected_by AND r.name=NEW.name AND r.created_at=NEW.created_at AND NEW.revision=1
      AND a.owner_user_id=NEW.owner_user_id AND a.role IN('owner','admin') AND a.role=json_extract(r.context_json,'$.role')
      AND json_extract(r.context_json,'$.ownerUserId')=NEW.owner_user_id AND NEW.created_at<=unixepoch() AND NEW.created_at>=unixepoch()-30)
    THEN RAISE(ABORT,'us_support_registry_receipt_required') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_workspace_no_update BEFORE UPDATE ON international_us_support_workspaces BEGIN SELECT RAISE(ABORT,'us_support_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_workspace_no_delete BEFORE DELETE ON international_us_support_workspaces BEGIN SELECT RAISE(ABORT,'us_support_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_receipt_no_update BEFORE UPDATE ON international_us_support_workspace_receipts BEGIN SELECT RAISE(ABORT,'us_support_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_receipt_no_delete BEFORE DELETE ON international_us_support_workspace_receipts BEGIN SELECT RAISE(ABORT,'us_support_immutable'); END;
