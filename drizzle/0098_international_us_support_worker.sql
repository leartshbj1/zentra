-- Migration number: 0098 	 2026-10-10T04:51:36.475Z
-- H4 explicit revocable company/workspace delegation. Browser/device credentials
-- remain human-only; worker contexts are trusted server attestations corroborated
-- against current delegation/run, company authority and mailbox rows.
-- Existing H3a quota, source deduplication and one-dispatch ledger are retained.
CREATE TABLE international_us_support_worker_delegations(
organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740990),delegation_id TEXT NOT NULL,actor_user_id TEXT NOT NULL,request_id TEXT NOT NULL,
request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object' AND length(CAST(request_json AS BLOB))<=4096),context_json TEXT NOT NULL CHECK(json_valid(context_json) AND json_type(context_json)='object' AND length(CAST(context_json AS BLOB))<=16384),snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json)='object' AND length(CAST(snapshot_json AS BLOB))<=16384),created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
PRIMARY KEY(organization_id,workspace_id,revision),UNIQUE(organization_id,actor_user_id,request_id),UNIQUE(organization_id,workspace_id,delegation_id,revision),
CHECK(length(delegation_id)=36 AND delegation_id GLOB '????????-????-????-????-????????????' AND replace(delegation_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(delegation_id,15,1) GLOB '[1-8]' AND substr(delegation_id,20,1) GLOB '[89ab]'),CHECK(length(request_id)=36 AND request_id GLOB '????????-????-????-????-????????????' AND replace(request_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(request_id,15,1) GLOB '[1-8]' AND substr(request_id,20,1) GLOB '[89ab]'),FOREIGN KEY(organization_id,workspace_id) REFERENCES international_us_support_workspaces(organization_id,workspace_id),FOREIGN KEY(organization_id,actor_user_id) REFERENCES international_workspace_members(organization_id,user_id));
--> statement-breakpoint
CREATE TABLE international_us_support_worker_heads(
organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740990),delegation_id TEXT,
scan_offset INTEGER NOT NULL DEFAULT 0 CHECK(typeof(scan_offset)='integer' AND scan_offset BETWEEN 0 AND 1000000),
since_at INTEGER NOT NULL DEFAULT 0 CHECK(typeof(since_at)='integer' AND since_at BETWEEN 0 AND 253402300799),
next_due_at INTEGER NOT NULL DEFAULT 0 CHECK(typeof(next_due_at)='integer' AND next_due_at BETWEEN 0 AND 253402300799),
lease_run_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0 CHECK(typeof(lease_until)='integer' AND lease_until BETWEEN 0 AND 253402300799),
PRIMARY KEY(organization_id,workspace_id),CHECK((revision=0 AND delegation_id IS NULL)OR(revision>0 AND delegation_id IS NOT NULL)),
CHECK((lease_run_id IS NULL AND lease_until=0)OR(lease_run_id IS NOT NULL AND lease_until>0)),FOREIGN KEY(organization_id,workspace_id) REFERENCES international_us_support_workspaces(organization_id,workspace_id),
FOREIGN KEY(organization_id,workspace_id,delegation_id,revision) REFERENCES international_us_support_worker_delegations(organization_id,workspace_id,delegation_id,revision),
FOREIGN KEY(lease_run_id) REFERENCES international_us_support_worker_runs(run_id));
--> statement-breakpoint
CREATE TABLE international_us_support_worker_runs(
run_id TEXT PRIMARY KEY NOT NULL,organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,delegation_id TEXT NOT NULL,delegation_revision INTEGER NOT NULL,
worker_id TEXT NOT NULL CHECK(worker_id='us-support-intake-v1'),started_at INTEGER NOT NULL CHECK(typeof(started_at)='integer' AND started_at BETWEEN 1 AND 253402300799),
expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at BETWEEN started_at+30 AND started_at+300),
CHECK(length(run_id)=36 AND run_id GLOB '????????-????-????-????-????????????' AND replace(run_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(run_id,15,1) GLOB '[1-8]' AND substr(run_id,20,1) GLOB '[89ab]'),UNIQUE(organization_id,workspace_id,run_id),
FOREIGN KEY(organization_id,workspace_id,delegation_id,delegation_revision) REFERENCES international_us_support_worker_delegations(organization_id,workspace_id,delegation_id,revision));
--> statement-breakpoint
CREATE TABLE international_us_support_worker_finishes(
run_id TEXT PRIMARY KEY NOT NULL,organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
outcome TEXT NOT NULL CHECK(outcome IN('idle','completed','partial','uncertain','budget_blocked','capacity_blocked','policy_changed','connection_changed','revoked','failed')),
next_due_at INTEGER NOT NULL CHECK(typeof(next_due_at)='integer' AND next_due_at BETWEEN 1 AND 253402300799),created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),FOREIGN KEY(organization_id,workspace_id,run_id) REFERENCES international_us_support_worker_runs(organization_id,workspace_id,run_id));
--> statement-breakpoint
CREATE TABLE international_us_support_worker_pages(
page_id TEXT PRIMARY KEY NOT NULL,run_id TEXT NOT NULL,organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,offset INTEGER NOT NULL CHECK(typeof(offset)='integer' AND offset BETWEEN 0 AND 1000000),
next_offset INTEGER CHECK(next_offset IS NULL OR(typeof(next_offset)='integer' AND next_offset>offset AND next_offset<=1000000)),
head_only INTEGER NOT NULL DEFAULT 0 CHECK(head_only IN(0,1)AND(head_only=0 OR offset=0)),
page_json TEXT NOT NULL CHECK(json_valid(page_json) AND json_type(page_json)='object' AND length(CAST(page_json AS BLOB))<=524288),context_json TEXT NOT NULL CHECK(json_valid(context_json) AND json_type(context_json)='object' AND length(CAST(context_json AS BLOB))<=16384),created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),CHECK(length(page_id)=36 AND page_id GLOB '????????-????-????-????-????????????' AND replace(page_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(page_id,15,1) GLOB '[1-8]' AND substr(page_id,20,1) GLOB '[89ab]'),
UNIQUE(organization_id,workspace_id,page_id),UNIQUE(run_id,offset,head_only),FOREIGN KEY(organization_id,workspace_id,run_id) REFERENCES international_us_support_worker_runs(organization_id,workspace_id,run_id));
--> statement-breakpoint
-- Deferred reciprocal page proof keeps discoveries and their observed page atomic.
CREATE TABLE international_us_support_worker_reference_proofs(
organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,run_id TEXT NOT NULL,uid TEXT NOT NULL,created_at INTEGER NOT NULL,page_id TEXT NOT NULL,discovery_id TEXT NOT NULL,
PRIMARY KEY(organization_id,workspace_id,run_id,uid,created_at),
FOREIGN KEY(organization_id,workspace_id,page_id) REFERENCES international_us_support_worker_pages(organization_id,workspace_id,page_id),
FOREIGN KEY(organization_id,workspace_id,discovery_id) REFERENCES international_us_support_worker_discovered(organization_id,workspace_id,id));
--> statement-breakpoint
CREATE TABLE international_us_support_worker_discovered(
id TEXT PRIMARY KEY NOT NULL,organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,provider TEXT NOT NULL CHECK(provider='infomaniak'),
mailbox_id TEXT NOT NULL CHECK(length(mailbox_id)BETWEEN 1 AND 200 AND mailbox_id=trim(mailbox_id)AND instr(mailbox_id,char(0))=0),
folder_id TEXT NOT NULL CHECK(length(folder_id)BETWEEN 1 AND 200 AND folder_id=trim(folder_id)AND instr(folder_id,char(0))=0),
uid TEXT NOT NULL CHECK(length(uid)BETWEEN 1 AND 20 AND uid NOT GLOB '*[^0-9]*'),
connection_id TEXT NOT NULL,mailbox_revision INTEGER NOT NULL CHECK(typeof(mailbox_revision)='integer' AND mailbox_revision BETWEEN 1 AND 9007199254740990),request_id TEXT NOT NULL,
version TEXT CHECK(version IS NULL OR(length(version)BETWEEN 1 AND 200 AND version=trim(version)AND instr(version,char(0))=0)),
received_at INTEGER CHECK(received_at IS NULL OR(typeof(received_at)='integer' AND received_at BETWEEN 1 AND 253402300799)),
created_run_id TEXT NOT NULL,created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),CHECK(length(id)=36 AND id GLOB '????????-????-????-????-????????????' AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(id,15,1) GLOB '[1-8]' AND substr(id,20,1) GLOB '[89ab]'),CHECK(length(request_id)=36 AND request_id GLOB '????????-????-????-????-????????????' AND replace(request_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(request_id,15,1) GLOB '[1-8]' AND substr(request_id,20,1) GLOB '[89ab]'),
UNIQUE(organization_id,workspace_id,id),UNIQUE(organization_id,workspace_id,request_id),
UNIQUE(organization_id,workspace_id,provider,mailbox_id,folder_id,uid),FOREIGN KEY(organization_id,workspace_id,created_run_id) REFERENCES international_us_support_worker_runs(organization_id,workspace_id,run_id),
FOREIGN KEY(organization_id,workspace_id,connection_id) REFERENCES international_us_support_mailbox_connections(organization_id,workspace_id,connection_id),
FOREIGN KEY(organization_id,workspace_id,created_run_id,uid,created_at) REFERENCES international_us_support_worker_reference_proofs(organization_id,workspace_id,run_id,uid,created_at) DEFERRABLE INITIALLY DEFERRED);
--> statement-breakpoint
CREATE TABLE international_us_support_worker_stages(
stage_id TEXT PRIMARY KEY NOT NULL,run_id TEXT NOT NULL,organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,discovery_id TEXT NOT NULL,
stage TEXT NOT NULL CHECK(stage IN('prepared','reserved','dispatched','completed','ticketed','uncertain','rejected')),
job_id TEXT,code TEXT CHECK(code IS NULL OR(length(code)BETWEEN 1 AND 128 AND code NOT GLOB '*[^A-Za-z0-9._:-]*')),
request_json TEXT CHECK(request_json IS NULL OR(json_valid(request_json)AND json_type(request_json)='object' AND length(CAST(request_json AS BLOB))<=16384)),
context_json TEXT NOT NULL CHECK(json_valid(context_json) AND json_type(context_json)='object' AND length(CAST(context_json AS BLOB))<=16384),created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),CHECK(length(stage_id)=36 AND stage_id GLOB '????????-????-????-????-????????????' AND replace(stage_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(stage_id,15,1) GLOB '[1-8]' AND substr(stage_id,20,1) GLOB '[89ab]'),UNIQUE(organization_id,workspace_id,discovery_id,stage),
FOREIGN KEY(organization_id,workspace_id,run_id) REFERENCES international_us_support_worker_runs(organization_id,workspace_id,run_id),FOREIGN KEY(organization_id,workspace_id,discovery_id) REFERENCES international_us_support_worker_discovered(organization_id,workspace_id,id),
FOREIGN KEY(organization_id,workspace_id,job_id) REFERENCES international_us_support_triage_jobs(organization_id,workspace_id,id));
--> statement-breakpoint
CREATE TABLE international_us_support_worker_issues(
issue_id TEXT PRIMARY KEY NOT NULL,organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,run_id TEXT NOT NULL,page_id TEXT NOT NULL,
code TEXT NOT NULL CHECK(length(code)BETWEEN 1 AND 128 AND code NOT GLOB '*[^A-Za-z0-9._:-]*'),
uid TEXT CHECK(uid IS NULL OR(length(uid)BETWEEN 1 AND 20 AND uid NOT GLOB '*[^0-9]*')),
fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),CHECK(length(issue_id)=36 AND issue_id GLOB '????????-????-????-????-????????????' AND replace(issue_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(issue_id,15,1) GLOB '[1-8]' AND substr(issue_id,20,1) GLOB '[89ab]'),
UNIQUE(organization_id,workspace_id,fingerprint),FOREIGN KEY(organization_id,workspace_id,run_id) REFERENCES international_us_support_worker_runs(organization_id,workspace_id,run_id),
FOREIGN KEY(organization_id,workspace_id,page_id) REFERENCES international_us_support_worker_pages(organization_id,workspace_id,page_id));
--> statement-breakpoint
-- A paid renewal extends current H1 periods without impersonating a human session.
CREATE VIEW international_us_support_worker_eligible AS
SELECT a.*,d.delegation_id,d.revision AS delegation_revision,d.snapshot_json,h.scan_offset,h.since_at,h.next_due_at,h.lease_run_id,h.lease_until
FROM international_us_support_worker_heads h
JOIN international_us_support_worker_delegations d ON d.organization_id=h.organization_id AND d.workspace_id=h.workspace_id AND d.delegation_id=h.delegation_id AND d.revision=h.revision
JOIN international_us_support_mailbox_admissible a ON a.organization_id=d.organization_id AND a.workspace_id=d.workspace_id AND a.user_id=d.actor_user_id AND a.role IN('owner','admin')
JOIN international_workspace_members m ON m.organization_id=d.organization_id AND m.user_id=d.actor_user_id AND m.membership_id=json_extract(d.snapshot_json,'$.grantedMembershipId') AND m.revoked_at IS NULL AND m.role=a.role
JOIN international_us_support_mailbox_heads mh ON mh.organization_id=d.organization_id AND mh.workspace_id=d.workspace_id AND mh.current_connection_id=json_extract(d.snapshot_json,'$.connectionId') AND mh.revision=json_extract(d.snapshot_json,'$.mailboxRevision')
JOIN international_us_support_mailbox_connections c ON c.organization_id=mh.organization_id AND c.workspace_id=mh.workspace_id AND c.connection_id=mh.current_connection_id AND c.revision=mh.revision
JOIN international_us_support_mailbox_secrets secret ON secret.connection_id=c.connection_id AND secret.credentials_ciphertext IS NOT NULL AND secret.cleared_by_command_id IS NULL
JOIN international_us_support_mailbox_commits committed ON committed.command_id=mh.last_command_id AND committed.command_id=c.command_id
WHERE json_extract(d.snapshot_json,'$.enabled')=1 AND json_extract(d.snapshot_json,'$.startsAt')<=unixepoch() AND json_extract(d.snapshot_json,'$.expiresAt')>unixepoch()
AND json_extract(d.snapshot_json,'$.grantedBy')=a.user_id AND json_extract(d.snapshot_json,'$.subscriptionId')=a.subscription_id
AND json_extract(d.snapshot_json,'$.environment')=a.environment AND json_extract(d.snapshot_json,'$.catalogVersion')=a.catalog_version AND json_extract(d.snapshot_json,'$.priceId')=a.price_id;
--> statement-breakpoint
CREATE VIEW international_us_support_worker_admissible AS
SELECT a.organization_id,a.user_id,a.role,a.owner_user_id,a.subscription_id,a.environment,a.catalog_version,a.seat_limit,a.price_id,a.authority_reference,a.valid_starts_at,a.valid_ends_at,a.workspace_id,
r.run_id,r.worker_id,a.delegation_id,a.delegation_revision
FROM international_us_support_worker_eligible a
JOIN international_us_support_worker_runs r ON r.organization_id=a.organization_id AND r.workspace_id=a.workspace_id AND r.delegation_id=a.delegation_id AND r.delegation_revision=a.delegation_revision AND r.run_id=a.lease_run_id AND r.expires_at=a.lease_until
WHERE r.started_at<=unixepoch() AND r.expires_at>unixepoch() AND NOT EXISTS(SELECT 1 FROM international_us_support_worker_finishes f WHERE f.run_id=r.run_id);
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_delegation_insert BEFORE INSERT ON international_us_support_worker_delegations BEGIN
-- Revocation and existing-receipt replay remain possible when pilot history is full.
SELECT CASE WHEN json_extract(NEW.request_json,'$.action')='enable' AND (SELECT count(*) FROM international_us_support_worker_delegations WHERE organization_id=NEW.organization_id)>=1000 THEN RAISE(ABORT,'us_worker_capacity_exceeded') END;
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
    THEN RAISE(ABORT,'us_worker_invalid_record') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_workspace_members m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.actor_user_id
    AND m.role=json_extract(NEW.context_json,'$.authority.role') AND m.role IN('owner','admin') AND m.revoked_at IS NULL)
    THEN RAISE(ABORT,'us_worker_forbidden') END;
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
    THEN RAISE(ABORT,'us_worker_unauthorized') END;
  SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT EXISTS(
    SELECT 1 FROM international_us_support_mailbox_admissible a WHERE a.organization_id=NEW.organization_id AND a.workspace_id=NEW.workspace_id AND a.user_id=NEW.actor_user_id
      AND a.role=json_extract(NEW.context_json,'$.authority.role') AND a.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId')
      AND a.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND a.environment=json_extract(NEW.context_json,'$.authority.environment')
      AND a.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion') AND a.price_id=json_extract(NEW.context_json,'$.authority.priceId')
      AND a.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference') AND a.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt')
      AND a.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt') AND a.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))
    THEN RAISE(ABORT,'us_worker_subscription_required') END;
SELECT CASE WHEN NEW.revision<>COALESCE((SELECT revision FROM international_us_support_worker_heads WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id),0)+1 THEN RAISE(ABORT,'us_worker_revision_conflict') END;
SELECT CASE WHEN NOT COALESCE((SELECT count(*) FROM json_each(NEW.snapshot_json))=20 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.snapshot_json) WHERE key NOT IN('schemaVersion','id','revision','enabled','grantedBy','grantedMembershipId','connectionId','mailboxRevision','subscriptionId','environment','catalogVersion','priceId','processingPolicyVersion','budgetPolicyVersion','recipeVersion','triagePolicySha256','consentVersion','startsAt','expiresAt','createdAt')) AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.snapshot_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1) AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.request_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
AND json_extract(NEW.snapshot_json,'$.schemaVersion')=1 AND json_type(NEW.snapshot_json,'$.schemaVersion')='integer'
AND json_extract(NEW.snapshot_json,'$.id')=NEW.delegation_id AND json_extract(NEW.snapshot_json,'$.revision')=NEW.revision AND json_type(NEW.snapshot_json,'$.revision')='integer'
AND json_type(NEW.snapshot_json,'$.enabled') IN('true','false') AND json_type(NEW.snapshot_json,'$.mailboxRevision')='integer'
AND json_type(NEW.snapshot_json,'$.startsAt')='integer' AND json_type(NEW.snapshot_json,'$.expiresAt')='integer'
AND json_type(NEW.snapshot_json,'$.createdAt')='integer' AND json_extract(NEW.snapshot_json,'$.createdAt')<=NEW.created_at AND json_extract(NEW.snapshot_json,'$.createdAt')>=NEW.created_at-30
AND json_extract(NEW.snapshot_json,'$.startsAt')>0 AND json_extract(NEW.snapshot_json,'$.expiresAt')>json_extract(NEW.snapshot_json,'$.startsAt')
AND json_extract(NEW.snapshot_json,'$.consentVersion')='us-support-autonomous-v1'
AND length(json_extract(NEW.snapshot_json,'$.triagePolicySha256'))=64 AND json_extract(NEW.snapshot_json,'$.triagePolicySha256') NOT GLOB '*[^0-9a-f]*'
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.snapshot_json) WHERE key IN('processingPolicyVersion','budgetPolicyVersion','recipeVersion','catalogVersion','priceId','subscriptionId') AND(type<>'text' OR length(value)<1 OR length(value)>160 OR value GLOB '*[^A-Za-z0-9._:-]*'))
AND json_extract(NEW.request_json,'$.schemaVersion')=1 AND json_type(NEW.request_json,'$.schemaVersion')='integer'
AND json_extract(NEW.request_json,'$.requestId')=NEW.request_id AND json_extract(NEW.request_json,'$.expectedRevision')=NEW.revision-1 AND json_type(NEW.request_json,'$.expectedRevision')='integer',0)
THEN RAISE(ABORT,'us_worker_invalid_record') END;
SELECT CASE WHEN json_extract(NEW.request_json,'$.action')='enable' AND NOT COALESCE(
(SELECT count(*) FROM json_each(NEW.request_json))=11 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.request_json) WHERE key NOT IN('schemaVersion','requestId','expectedRevision','action','connectionId','expectedMailboxRevision','processingPolicyVersion','recipeVersion','consentVersion','consent','expiresAt'))
AND json_type(NEW.request_json,'$.consent')='true' AND json_extract(NEW.request_json,'$.consentVersion')='us-support-autonomous-v1'
AND json_type(NEW.snapshot_json,'$.enabled')='true'
AND json_extract(NEW.snapshot_json,'$.grantedBy')=NEW.actor_user_id
AND EXISTS(SELECT 1 FROM international_workspace_members m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.actor_user_id AND m.membership_id=json_extract(NEW.snapshot_json,'$.grantedMembershipId') AND m.revoked_at IS NULL AND m.role IN('owner','admin'))
AND json_extract(NEW.snapshot_json,'$.subscriptionId')=json_extract(NEW.context_json,'$.authority.subscriptionId')
AND json_extract(NEW.snapshot_json,'$.environment')=json_extract(NEW.context_json,'$.authority.environment')
AND json_extract(NEW.snapshot_json,'$.catalogVersion')=json_extract(NEW.context_json,'$.authority.catalogVersion')
AND json_extract(NEW.snapshot_json,'$.priceId')=json_extract(NEW.context_json,'$.authority.priceId')
AND json_extract(NEW.snapshot_json,'$.connectionId')=json_extract(NEW.request_json,'$.connectionId')
AND json_extract(NEW.snapshot_json,'$.mailboxRevision')=json_extract(NEW.request_json,'$.expectedMailboxRevision')
AND json_type(NEW.request_json,'$.expectedMailboxRevision')='integer'
AND json_extract(NEW.snapshot_json,'$.processingPolicyVersion')=json_extract(NEW.request_json,'$.processingPolicyVersion')
AND json_extract(NEW.snapshot_json,'$.recipeVersion')=json_extract(NEW.request_json,'$.recipeVersion')
AND json_extract(NEW.snapshot_json,'$.startsAt')=json_extract(NEW.snapshot_json,'$.createdAt')
AND json_extract(NEW.snapshot_json,'$.expiresAt')=json_extract(NEW.request_json,'$.expiresAt')
AND json_type(NEW.request_json,'$.expiresAt')='integer' AND json_extract(NEW.request_json,'$.expiresAt')>unixepoch() AND json_extract(NEW.request_json,'$.expiresAt')<=NEW.created_at+7776000
AND NOT EXISTS(SELECT 1 FROM international_us_support_worker_delegations d WHERE d.organization_id=NEW.organization_id AND d.workspace_id=NEW.workspace_id AND d.delegation_id=NEW.delegation_id)
AND EXISTS(SELECT 1 FROM international_us_support_mailbox_heads h JOIN international_us_support_mailbox_connections c ON c.organization_id=h.organization_id AND c.workspace_id=h.workspace_id AND c.connection_id=h.current_connection_id AND c.revision=h.revision JOIN international_us_support_mailbox_secrets s ON s.connection_id=c.connection_id AND s.credentials_ciphertext IS NOT NULL AND s.cleared_by_command_id IS NULL JOIN international_us_support_mailbox_commits done ON done.command_id=h.last_command_id AND done.command_id=c.command_id WHERE h.organization_id=NEW.organization_id AND h.workspace_id=NEW.workspace_id AND h.current_connection_id=json_extract(NEW.snapshot_json,'$.connectionId') AND h.revision=json_extract(NEW.snapshot_json,'$.mailboxRevision')),0)
THEN RAISE(ABORT,'us_worker_connection_changed') END;
SELECT CASE WHEN json_extract(NEW.request_json,'$.action')='revoke' AND NOT COALESCE(
(SELECT count(*) FROM json_each(NEW.request_json))=4 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.request_json) WHERE key NOT IN('schemaVersion','requestId','expectedRevision','action')) AND json_type(NEW.snapshot_json,'$.enabled')='false'
AND EXISTS(SELECT 1 FROM international_us_support_worker_delegations d WHERE d.organization_id=NEW.organization_id AND d.workspace_id=NEW.workspace_id AND d.revision=NEW.revision-1 AND d.delegation_id=NEW.delegation_id
AND json_remove(NEW.snapshot_json,'$.revision','$.enabled','$.createdAt')=json_remove(d.snapshot_json,'$.revision','$.enabled','$.createdAt')),0)
THEN RAISE(ABORT,'us_worker_invalid_record') END;
SELECT CASE WHEN NOT COALESCE(json_type(NEW.request_json,'$.action')='text' AND json_extract(NEW.request_json,'$.action') IN('enable','revoke'),0) THEN RAISE(ABORT,'us_worker_invalid_record') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_delegation_finalize AFTER INSERT ON international_us_support_worker_delegations BEGIN
UPDATE international_us_support_worker_heads SET revision=NEW.revision,delegation_id=NEW.delegation_id,scan_offset=0,since_at=json_extract(NEW.snapshot_json,'$.startsAt'),next_due_at=0,lease_run_id=NULL,lease_until=0 WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id;
SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'us_worker_invalid_record') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_run_insert BEFORE INSERT ON international_us_support_worker_runs BEGIN
SELECT CASE WHEN (SELECT count(*) FROM international_us_support_worker_runs WHERE organization_id=NEW.organization_id)>=10000 THEN RAISE(ABORT,'us_worker_capacity_exceeded') END;
SELECT CASE WHEN NEW.started_at>unixepoch() OR NEW.started_at<unixepoch()-30 OR NOT EXISTS(
SELECT 1 FROM international_us_support_worker_eligible w WHERE w.organization_id=NEW.organization_id AND w.workspace_id=NEW.workspace_id AND w.delegation_id=NEW.delegation_id AND w.delegation_revision=NEW.delegation_revision AND w.lease_until<=unixepoch() AND w.next_due_at<=unixepoch())
THEN RAISE(ABORT,'us_worker_revoked') END;END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_run_finalize AFTER INSERT ON international_us_support_worker_runs BEGIN
UPDATE international_us_support_worker_heads SET lease_run_id=NEW.run_id,lease_until=NEW.expires_at WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id;END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_finish_insert BEFORE INSERT ON international_us_support_worker_finishes BEGIN
-- Terminal bookkeeping remains possible after revocation/expiry; it grants no rights.
SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NEW.next_due_at<NEW.created_at OR NOT EXISTS(SELECT 1 FROM international_us_support_worker_runs r WHERE r.run_id=NEW.run_id AND r.organization_id=NEW.organization_id AND r.workspace_id=NEW.workspace_id AND r.started_at<=NEW.created_at)
THEN RAISE(ABORT,'us_worker_invalid_record') END;END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_finish_finalize AFTER INSERT ON international_us_support_worker_finishes BEGIN
UPDATE international_us_support_worker_heads SET next_due_at=NEW.next_due_at,lease_run_id=NULL,lease_until=0 WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND lease_run_id=NEW.run_id;END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_page_insert BEFORE INSERT ON international_us_support_worker_pages BEGIN
SELECT CASE WHEN (SELECT count(*) FROM international_us_support_worker_pages WHERE organization_id=NEW.organization_id)>=20000 THEN RAISE(ABORT,'us_worker_capacity_exceeded') END;
SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT COALESCE((SELECT count(*) FROM json_each(NEW.context_json))=3 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json) WHERE key NOT IN('schemaVersion','authority','workspaceId'))
AND json_extract(NEW.context_json,'$.schemaVersion')=1 AND json_type(NEW.context_json,'$.schemaVersion')='integer'
AND json_extract(NEW.context_json,'$.workspaceId')=NEW.workspace_id
AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority'))=15
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority') WHERE key NOT IN('schemaVersion','organizationId','userId','role','ownerUserId','subscriptionId','environment','catalogVersion','priceId','authorityReference','validStartsAt','validEndsAt','seatLimit','checkedAt','credential'))
AND json_extract(NEW.context_json,'$.authority.schemaVersion')=1 AND json_type(NEW.context_json,'$.authority.schemaVersion')='integer'
AND json_extract(NEW.context_json,'$.authority.organizationId')=NEW.organization_id
AND json_extract(NEW.context_json,'$.authority.checkedAt')=NEW.created_at AND json_type(NEW.context_json,'$.authority.checkedAt')='integer'
AND json_type(NEW.context_json,'$.authority.validStartsAt')='integer' AND json_type(NEW.context_json,'$.authority.validEndsAt')='integer'
AND json_type(NEW.context_json,'$.authority.seatLimit')='integer' AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.context_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1) AND json_extract(NEW.context_json,'$.authority.credential.kind')='worker'
AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=5
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','workerId','delegationId','delegationRevision','runId'))
AND json_type(NEW.context_json,'$.authority.credential.delegationRevision')='integer'
AND EXISTS(SELECT 1 FROM international_us_support_worker_admissible w WHERE w.organization_id=NEW.organization_id AND w.workspace_id=NEW.workspace_id
AND w.user_id=json_extract(NEW.context_json,'$.authority.userId') AND w.role=json_extract(NEW.context_json,'$.authority.role')
AND w.run_id=json_extract(NEW.context_json,'$.authority.credential.runId') AND w.worker_id=json_extract(NEW.context_json,'$.authority.credential.workerId')
AND w.delegation_id=json_extract(NEW.context_json,'$.authority.credential.delegationId') AND w.delegation_revision=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
AND w.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId') AND w.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId')
AND w.environment=json_extract(NEW.context_json,'$.authority.environment') AND w.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion')
AND w.price_id=json_extract(NEW.context_json,'$.authority.priceId') AND w.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference')
AND w.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt') AND w.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt')
AND w.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))
AND NEW.run_id=json_extract(NEW.context_json,'$.authority.credential.runId'),0) THEN RAISE(ABORT,'us_worker_revoked') END;
SELECT CASE WHEN NOT COALESCE((SELECT count(*) FROM json_each(NEW.page_json))=CASE WHEN json_type(NEW.page_json,'$.headOnly') IS NULL THEN 4 ELSE 5 END
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.page_json) WHERE key NOT IN('offset','nextOffset','headOnly','references','issues')) AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.page_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
AND json_type(NEW.page_json,'$.offset')='integer' AND json_extract(NEW.page_json,'$.offset')=NEW.offset
AND json_type(NEW.page_json,'$.nextOffset') IN('null','integer') AND json_extract(NEW.page_json,'$.nextOffset') IS NEW.next_offset
AND (json_type(NEW.page_json,'$.headOnly') IS NULL AND NEW.head_only=0 OR json_type(NEW.page_json,'$.headOnly') IN('true','false') AND json_extract(NEW.page_json,'$.headOnly')=NEW.head_only)
AND json_type(NEW.page_json,'$.references')='array' AND json_array_length(NEW.page_json,'$.references')<=1000
AND json_type(NEW.page_json,'$.issues')='array' AND json_array_length(NEW.page_json,'$.issues')<=1000
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.page_json,'$.references') r WHERE json_type(r.value)<>'object' OR NOT COALESCE(
(SELECT count(*) FROM json_each(r.value))=3 AND NOT EXISTS(SELECT 1 FROM json_each(r.value) WHERE key NOT IN('uid','version','receivedAt'))
AND json_type(r.value,'$.uid')='text' AND length(json_extract(r.value,'$.uid')) BETWEEN 1 AND 20 AND json_extract(r.value,'$.uid') NOT GLOB '*[^0-9]*'
AND (json_type(r.value,'$.version')='null' OR json_type(r.value,'$.version')='text' AND length(json_extract(r.value,'$.version')) BETWEEN 1 AND 200 AND json_extract(r.value,'$.version')=trim(json_extract(r.value,'$.version')) AND instr(json_extract(r.value,'$.version'),char(0))=0)
AND (json_type(r.value,'$.receivedAt')='null' OR json_type(r.value,'$.receivedAt')='integer' AND json_extract(r.value,'$.receivedAt') BETWEEN 1 AND 253402300799),0))
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.page_json,'$.issues') i WHERE json_type(i.value)<>'object' OR NOT COALESCE(
(SELECT count(*) FROM json_each(i.value))=3 AND NOT EXISTS(SELECT 1 FROM json_each(i.value) WHERE key NOT IN('code','uid','fingerprint')) AND json_type(i.value,'$.fingerprint')='text' AND length(json_extract(i.value,'$.fingerprint'))=64 AND json_extract(i.value,'$.fingerprint') NOT GLOB '*[^0-9a-f]*'
AND json_type(i.value,'$.code')='text' AND length(json_extract(i.value,'$.code')) BETWEEN 1 AND 128 AND json_extract(i.value,'$.code') NOT GLOB '*[^A-Za-z0-9._:-]*'
AND (json_type(i.value,'$.uid')='null' OR json_type(i.value,'$.uid')='text' AND length(json_extract(i.value,'$.uid')) BETWEEN 1 AND 20 AND json_extract(i.value,'$.uid') NOT GLOB '*[^0-9]*'),0)),0)
THEN RAISE(ABORT,'us_worker_invalid_record') END;
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_worker_heads h WHERE h.organization_id=NEW.organization_id AND h.workspace_id=NEW.workspace_id AND h.lease_run_id=NEW.run_id AND (NEW.head_only=1 AND NEW.offset=0 OR NEW.head_only=0 AND NEW.offset=h.scan_offset))
THEN RAISE(ABORT,'us_worker_revision_conflict') END;
SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.page_json,'$.references') ref WHERE NOT EXISTS(
SELECT 1 FROM international_us_support_worker_delegations d JOIN international_us_support_worker_admissible w ON w.organization_id=d.organization_id AND w.workspace_id=d.workspace_id AND w.delegation_id=d.delegation_id AND w.delegation_revision=d.revision
JOIN international_us_support_mailbox_connections c ON c.organization_id=d.organization_id AND c.workspace_id=d.workspace_id AND c.connection_id=json_extract(d.snapshot_json,'$.connectionId') AND c.revision=json_extract(d.snapshot_json,'$.mailboxRevision')
JOIN international_us_support_worker_discovered source ON source.organization_id=c.organization_id AND source.workspace_id=c.workspace_id AND source.provider=c.provider AND source.mailbox_id=c.mailbox_id AND source.folder_id=c.folder_id AND source.uid=json_extract(ref.value,'$.uid')
WHERE w.organization_id=NEW.organization_id AND w.workspace_id=NEW.workspace_id AND w.run_id=NEW.run_id)) THEN RAISE(ABORT,'us_worker_invalid_record') END;

END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_page_finalize AFTER INSERT ON international_us_support_worker_pages WHEN NEW.head_only=0 BEGIN
UPDATE international_us_support_worker_heads SET scan_offset=coalesce(NEW.next_offset,0) WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND lease_run_id=NEW.run_id;END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_discovery_insert BEFORE INSERT ON international_us_support_worker_discovered BEGIN
SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT EXISTS(
SELECT 1 FROM international_us_support_worker_admissible w JOIN international_us_support_worker_delegations d ON d.organization_id=w.organization_id AND d.workspace_id=w.workspace_id AND d.revision=w.delegation_revision AND d.delegation_id=w.delegation_id
JOIN international_us_support_mailbox_connections c ON c.organization_id=w.organization_id AND c.workspace_id=w.workspace_id AND c.connection_id=json_extract(d.snapshot_json,'$.connectionId') AND c.revision=json_extract(d.snapshot_json,'$.mailboxRevision')
WHERE w.organization_id=NEW.organization_id AND w.workspace_id=NEW.workspace_id AND w.run_id=NEW.created_run_id AND c.connection_id=NEW.connection_id AND c.revision=NEW.mailbox_revision AND c.provider=NEW.provider AND c.mailbox_id=NEW.mailbox_id AND c.folder_id=NEW.folder_id)
THEN RAISE(ABORT,'us_worker_connection_changed') END;
SELECT CASE WHEN (SELECT count(*) FROM international_us_support_worker_discovered WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id)>=500 THEN RAISE(ABORT,'us_worker_capacity_exceeded') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_issue_insert BEFORE INSERT ON international_us_support_worker_issues BEGIN
SELECT CASE WHEN (SELECT count(*) FROM international_us_support_worker_issues WHERE organization_id=NEW.organization_id)>=2000 THEN RAISE(ABORT,'us_worker_capacity_exceeded') END;
SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT EXISTS(
SELECT 1 FROM international_us_support_worker_pages p JOIN international_us_support_worker_admissible w ON w.organization_id=p.organization_id AND w.workspace_id=p.workspace_id AND w.run_id=p.run_id
JOIN json_each(p.page_json,'$.issues') i WHERE p.organization_id=NEW.organization_id AND p.workspace_id=NEW.workspace_id AND p.page_id=NEW.page_id AND p.run_id=NEW.run_id AND p.created_at=NEW.created_at AND json_extract(i.value,'$.code')=NEW.code AND json_extract(i.value,'$.uid') IS NEW.uid)
THEN RAISE(ABORT,'us_worker_invalid_record') END;END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_stage_insert BEFORE INSERT ON international_us_support_worker_stages BEGIN
SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT COALESCE((SELECT count(*) FROM json_each(NEW.context_json))=3 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json) WHERE key NOT IN('schemaVersion','authority','workspaceId'))
AND json_extract(NEW.context_json,'$.schemaVersion')=1 AND json_type(NEW.context_json,'$.schemaVersion')='integer'
AND json_extract(NEW.context_json,'$.workspaceId')=NEW.workspace_id
AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority'))=15
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority') WHERE key NOT IN('schemaVersion','organizationId','userId','role','ownerUserId','subscriptionId','environment','catalogVersion','priceId','authorityReference','validStartsAt','validEndsAt','seatLimit','checkedAt','credential'))
AND json_extract(NEW.context_json,'$.authority.schemaVersion')=1 AND json_type(NEW.context_json,'$.authority.schemaVersion')='integer'
AND json_extract(NEW.context_json,'$.authority.organizationId')=NEW.organization_id
AND json_extract(NEW.context_json,'$.authority.checkedAt')=NEW.created_at AND json_type(NEW.context_json,'$.authority.checkedAt')='integer'
AND json_type(NEW.context_json,'$.authority.validStartsAt')='integer' AND json_type(NEW.context_json,'$.authority.validEndsAt')='integer'
AND json_type(NEW.context_json,'$.authority.seatLimit')='integer' AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.context_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1) AND json_extract(NEW.context_json,'$.authority.credential.kind')='worker'
AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=5
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','workerId','delegationId','delegationRevision','runId'))
AND json_type(NEW.context_json,'$.authority.credential.delegationRevision')='integer'
AND EXISTS(SELECT 1 FROM international_us_support_worker_admissible w WHERE w.organization_id=NEW.organization_id AND w.workspace_id=NEW.workspace_id
AND w.user_id=json_extract(NEW.context_json,'$.authority.userId') AND w.role=json_extract(NEW.context_json,'$.authority.role')
AND w.run_id=json_extract(NEW.context_json,'$.authority.credential.runId') AND w.worker_id=json_extract(NEW.context_json,'$.authority.credential.workerId')
AND w.delegation_id=json_extract(NEW.context_json,'$.authority.credential.delegationId') AND w.delegation_revision=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
AND w.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId') AND w.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId')
AND w.environment=json_extract(NEW.context_json,'$.authority.environment') AND w.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion')
AND w.price_id=json_extract(NEW.context_json,'$.authority.priceId') AND w.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference')
AND w.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt') AND w.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt')
AND w.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))
AND NEW.run_id=json_extract(NEW.context_json,'$.authority.credential.runId'),0) THEN RAISE(ABORT,'us_worker_revoked') END;
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_worker_discovered d WHERE d.organization_id=NEW.organization_id AND d.workspace_id=NEW.workspace_id AND d.id=NEW.discovery_id AND d.created_at<=NEW.created_at)
THEN RAISE(ABORT,'us_worker_invalid_record') END;
SELECT CASE WHEN NEW.stage='prepared' AND NOT COALESCE(NEW.job_id IS NULL AND NEW.code IS NULL AND NEW.request_json IS NOT NULL
AND (SELECT count(*) FROM json_each(NEW.request_json))=8 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.request_json) WHERE key NOT IN('schemaVersion','requestId','connectionId','expectedMailboxRevision','uid','expectedMessageVersion','processingPolicyVersion','consent')) AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.request_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1)
AND json_extract(NEW.request_json,'$.schemaVersion')=1 AND json_type(NEW.request_json,'$.schemaVersion')='integer'
AND json_type(NEW.request_json,'$.expectedMailboxRevision')='integer' AND json_type(NEW.request_json,'$.consent')='true'
AND json_type(NEW.request_json,'$.expectedMessageVersion')='text' AND length(json_extract(NEW.request_json,'$.expectedMessageVersion')) BETWEEN 1 AND 200
AND json_extract(NEW.request_json,'$.expectedMessageVersion')=trim(json_extract(NEW.request_json,'$.expectedMessageVersion')) AND instr(json_extract(NEW.request_json,'$.expectedMessageVersion'),char(0))=0
AND EXISTS(SELECT 1 FROM international_us_support_worker_discovered source JOIN international_us_support_worker_delegations d ON d.organization_id=source.organization_id AND d.workspace_id=source.workspace_id AND d.delegation_id=json_extract(NEW.context_json,'$.authority.credential.delegationId') AND d.revision=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
WHERE source.id=NEW.discovery_id AND source.organization_id=NEW.organization_id AND source.workspace_id=NEW.workspace_id
AND json_extract(NEW.request_json,'$.requestId')=source.request_id AND json_extract(NEW.request_json,'$.uid')=source.uid
AND json_extract(NEW.request_json,'$.connectionId')=json_extract(d.snapshot_json,'$.connectionId')
AND json_extract(NEW.request_json,'$.expectedMailboxRevision')=json_extract(d.snapshot_json,'$.mailboxRevision')
AND json_extract(NEW.request_json,'$.processingPolicyVersion')=json_extract(d.snapshot_json,'$.processingPolicyVersion')),0)
THEN RAISE(ABORT,'us_worker_invalid_record') END;
SELECT CASE WHEN NEW.stage<>'prepared' AND NEW.request_json IS NOT NULL THEN RAISE(ABORT,'us_worker_invalid_record') END;
SELECT CASE WHEN NEW.stage IN('reserved','dispatched','completed','ticketed') AND (NEW.job_id IS NULL OR NOT EXISTS(
SELECT 1 FROM international_us_support_worker_discovered source JOIN international_us_support_triage_jobs j ON j.organization_id=source.organization_id AND j.workspace_id=source.workspace_id
WHERE source.id=NEW.discovery_id AND source.organization_id=NEW.organization_id AND source.workspace_id=NEW.workspace_id AND j.id=NEW.job_id
AND json_extract(j.source_json,'$.provider')=source.provider AND json_extract(j.source_json,'$.mailboxId')=source.mailbox_id AND json_extract(j.source_json,'$.folderId')=source.folder_id AND json_extract(j.source_json,'$.uid')=source.uid))
THEN RAISE(ABORT,'us_worker_invalid_record') END;
SELECT CASE WHEN NEW.stage='dispatched' AND NOT EXISTS(SELECT 1 FROM international_us_support_triage_dispatches d WHERE d.organization_id=NEW.organization_id AND d.workspace_id=NEW.workspace_id AND d.job_id=NEW.job_id) THEN RAISE(ABORT,'us_worker_invalid_record') END;
SELECT CASE WHEN NEW.stage='completed' AND NOT EXISTS(SELECT 1 FROM international_us_support_triage_completions x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.job_id=NEW.job_id) THEN RAISE(ABORT,'us_worker_invalid_record') END;
SELECT CASE WHEN NEW.stage='ticketed' AND NOT EXISTS(SELECT 1 FROM international_us_support_tickets t WHERE t.organization_id=NEW.organization_id AND t.workspace_id=NEW.workspace_id AND t.origin_job_id=NEW.job_id) THEN RAISE(ABORT,'us_worker_invalid_record') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_head_insert BEFORE INSERT ON international_us_support_worker_heads WHEN EXISTS(SELECT 1 FROM international_us_support_worker_heads WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id) OR NEW.revision<>0 OR NEW.delegation_id IS NOT NULL OR NEW.scan_offset<>0 OR NEW.since_at<>0 OR NEW.next_due_at<>0 OR NEW.lease_run_id IS NOT NULL OR NEW.lease_until<>0
BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_head_update BEFORE UPDATE ON international_us_support_worker_heads BEGIN
SELECT CASE WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NOT(
(NEW.revision=OLD.revision+1 AND NEW.scan_offset=0 AND NEW.next_due_at=0 AND NEW.lease_run_id IS NULL AND NEW.lease_until=0
AND EXISTS(SELECT 1 FROM international_us_support_worker_delegations d WHERE d.organization_id=OLD.organization_id AND d.workspace_id=OLD.workspace_id AND d.revision=NEW.revision AND d.delegation_id=NEW.delegation_id AND json_extract(d.snapshot_json,'$.startsAt')=NEW.since_at))
OR(NEW.revision=OLD.revision AND NEW.delegation_id IS OLD.delegation_id AND NEW.scan_offset=OLD.scan_offset AND NEW.since_at=OLD.since_at AND NEW.next_due_at=OLD.next_due_at AND OLD.lease_until<=unixepoch()
AND EXISTS(SELECT 1 FROM international_us_support_worker_runs r WHERE r.run_id=NEW.lease_run_id AND r.organization_id=OLD.organization_id AND r.workspace_id=OLD.workspace_id AND r.delegation_id=OLD.delegation_id AND r.delegation_revision=OLD.revision AND r.expires_at=NEW.lease_until AND r.expires_at>unixepoch() AND NOT EXISTS(SELECT 1 FROM international_us_support_worker_finishes f WHERE f.run_id=r.run_id)))
OR(NEW.revision=OLD.revision AND NEW.delegation_id IS OLD.delegation_id AND NEW.since_at=OLD.since_at AND NEW.next_due_at=OLD.next_due_at AND NEW.lease_run_id IS OLD.lease_run_id AND NEW.lease_until=OLD.lease_until
AND EXISTS(SELECT 1 FROM international_us_support_worker_pages p WHERE p.organization_id=OLD.organization_id AND p.workspace_id=OLD.workspace_id AND p.run_id=OLD.lease_run_id AND p.offset=OLD.scan_offset AND p.head_only=0 AND coalesce(p.next_offset,0)=NEW.scan_offset))
OR(NEW.revision=OLD.revision AND NEW.delegation_id IS OLD.delegation_id AND NEW.scan_offset=OLD.scan_offset AND NEW.since_at=OLD.since_at AND NEW.lease_run_id IS NULL AND NEW.lease_until=0
AND EXISTS(SELECT 1 FROM international_us_support_worker_finishes f WHERE f.run_id=OLD.lease_run_id AND f.organization_id=OLD.organization_id AND f.workspace_id=OLD.workspace_id AND f.next_due_at=NEW.next_due_at))
)THEN RAISE(ABORT,'us_worker_revision_conflict') END;END;
--> statement-breakpoint
-- Existing actor_user_id remains the recorded human delegator for worker rows.
-- Execution provenance is explicit in the worker context and public worker audit.
DROP TRIGGER international_us_support_triage_jobs_insert;
--> statement-breakpoint
CREATE TRIGGER international_us_support_triage_jobs_insert BEFORE INSERT ON international_us_support_triage_jobs BEGIN
SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_triage_requests WHERE command_id=NEW.first_command_id) THEN RAISE(ABORT,'us_triage_invalid_record') END;
SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_triage_jobs WHERE id=NEW.id OR first_command_id=NEW.first_command_id OR (organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND source_hash=NEW.source_hash AND recipe_version=NEW.recipe_version)) THEN RAISE(ABORT,'us_triage_immutable') END;
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
    THEN RAISE(ABORT,'us_triage_invalid_record') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_workspace_members m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.actor_user_id
    AND m.role=json_extract(NEW.context_json,'$.authority.role') AND m.role IN('owner','admin') AND m.revoked_at IS NULL)
    THEN RAISE(ABORT,'us_triage_forbidden') END;
  SELECT CASE WHEN NOT COALESCE((json_extract(NEW.context_json,'$.authority.credential.kind')='browser'
    AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=1 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind')))
    OR (json_extract(NEW.context_json,'$.authority.credential.kind')='device'
      AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=3 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','sessionId','supportedSchemaVersion'))
      AND json_type(NEW.context_json,'$.authority.credential.supportedSchemaVersion')='integer'
      AND json_extract(NEW.context_json,'$.authority.credential.supportedSchemaVersion')=4
      AND EXISTS(SELECT 1 FROM international_us_device_v4_sessions s WHERE s.session_id=json_extract(NEW.context_json,'$.authority.credential.sessionId')
        AND s.organization_id=NEW.organization_id AND s.user_id=NEW.actor_user_id AND s.role=json_extract(NEW.context_json,'$.authority.role')
        AND s.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND s.supported_schema_version=4
        AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch())) OR (json_extract(NEW.context_json,'$.authority.credential.kind')='worker'
AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=5
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','workerId','delegationId','delegationRevision','runId'))
AND json_type(NEW.context_json,'$.authority.credential.delegationRevision')='integer'
AND EXISTS(SELECT 1 FROM international_us_support_worker_admissible w WHERE w.organization_id=NEW.organization_id AND w.workspace_id=NEW.workspace_id
AND w.user_id=json_extract(NEW.context_json,'$.authority.userId') AND w.role=json_extract(NEW.context_json,'$.authority.role')
AND w.run_id=json_extract(NEW.context_json,'$.authority.credential.runId') AND w.worker_id=json_extract(NEW.context_json,'$.authority.credential.workerId')
AND w.delegation_id=json_extract(NEW.context_json,'$.authority.credential.delegationId') AND w.delegation_revision=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
AND w.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId') AND w.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId')
AND w.environment=json_extract(NEW.context_json,'$.authority.environment') AND w.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion')
AND w.price_id=json_extract(NEW.context_json,'$.authority.priceId') AND w.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference')
AND w.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt') AND w.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt')
AND w.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))),0)
    THEN RAISE(ABORT,'us_triage_unauthorized') END;
  SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT EXISTS(
    SELECT 1 FROM international_us_support_mailbox_admissible a WHERE a.organization_id=NEW.organization_id AND a.workspace_id=NEW.workspace_id AND a.user_id=NEW.actor_user_id
      AND a.role=json_extract(NEW.context_json,'$.authority.role') AND a.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId')
      AND a.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND a.environment=json_extract(NEW.context_json,'$.authority.environment')
      AND a.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion') AND a.price_id=json_extract(NEW.context_json,'$.authority.priceId')
      AND a.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference') AND a.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt')
      AND a.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt') AND a.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))
    THEN RAISE(ABORT,'us_triage_subscription_required') END;

SELECT CASE WHEN NOT COALESCE(json_valid(NEW.request_json) AND json_type(NEW.request_json)='object' AND (SELECT count(*) FROM json_each(NEW.request_json))=8 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.request_json) WHERE key NOT IN('schemaVersion','requestId','connectionId','expectedMailboxRevision','uid','expectedMessageVersion','processingPolicyVersion','consent')) AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.request_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1) AND json_extract(NEW.request_json,'$.schemaVersion')=1 AND json_type(NEW.request_json,'$.schemaVersion')='integer' AND json_extract(NEW.request_json,'$.requestId')=NEW.request_id AND json_extract(NEW.request_json,'$.connectionId')=NEW.connection_id AND json_type(NEW.request_json,'$.expectedMailboxRevision')='integer' AND json_extract(NEW.request_json,'$.expectedMailboxRevision')=NEW.mailbox_revision AND json_extract(NEW.request_json,'$.uid')=json_extract(NEW.source_json,'$.uid') AND json_extract(NEW.request_json,'$.expectedMessageVersion')=json_extract(NEW.source_json,'$.messageVersion') AND json_type(NEW.request_json,'$.consent')='true' AND json_extract(NEW.request_json,'$.processingPolicyVersion')=json_extract(NEW.grant_json,'$.processingPolicyVersion') AND json_valid(NEW.source_json) AND json_type(NEW.source_json)='object' AND (SELECT count(*) FROM json_each(NEW.source_json))=9 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.source_json) WHERE key NOT IN('provider','mailboxId','folderId','uid','messageVersion','receivedAt','messageSha256','attachmentCount','bodyComplete')) AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.source_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1) AND json_extract(NEW.source_json,'$.provider')='infomaniak' AND json_type(NEW.source_json,'$.receivedAt')='integer' AND json_extract(NEW.source_json,'$.receivedAt') BETWEEN 1 AND 253402300799 AND json_type(NEW.source_json,'$.attachmentCount')='integer' AND json_extract(NEW.source_json,'$.attachmentCount') BETWEEN 0 AND 1000 AND json_type(NEW.source_json,'$.bodyComplete') IN('true','false') AND length(json_extract(NEW.source_json,'$.messageSha256'))=64 AND json_extract(NEW.source_json,'$.messageSha256') NOT GLOB '*[^0-9a-f]*' AND NOT EXISTS(SELECT 1 FROM json_each(NEW.source_json) WHERE key IN('mailboxId','folderId','uid','messageVersion','messageSha256') AND (type<>'text' OR length(value)<1 OR length(value)>200 OR trim(value)<>value)) AND length(json_extract(NEW.source_json,'$.uid')) BETWEEN 1 AND 20 AND json_extract(NEW.source_json,'$.uid') NOT GLOB '*[^0-9]*' AND json_valid(NEW.grant_json) AND json_type(NEW.grant_json)='object' AND (SELECT count(*) FROM json_each(NEW.grant_json))=15 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.grant_json) WHERE key NOT IN('schemaVersion','organizationId','workspaceId','environment','bucket','periodId','periodStart','periodEnd','limit','budgetPolicyVersion','processingPolicyVersion','catalogVersion','priceId','recipeVersion','threshold')) AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.grant_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1) AND json_type(NEW.grant_json,'$.schemaVersion')='integer' AND json_extract(NEW.grant_json,'$.schemaVersion')=1 AND json_extract(NEW.grant_json,'$.organizationId')=NEW.organization_id AND json_extract(NEW.grant_json,'$.workspaceId')=NEW.workspace_id AND json_extract(NEW.grant_json,'$.environment')=json_extract(NEW.context_json,'$.authority.environment') AND json_extract(NEW.grant_json,'$.bucket')='support_message_classify' AND json_extract(NEW.grant_json,'$.catalogVersion')=json_extract(NEW.context_json,'$.authority.catalogVersion') AND json_extract(NEW.grant_json,'$.priceId')=json_extract(NEW.context_json,'$.authority.priceId') AND json_type(NEW.grant_json,'$.limit')='integer' AND json_extract(NEW.grant_json,'$.limit') BETWEEN 1 AND 1000000 AND json_type(NEW.grant_json,'$.threshold') IN('integer','real') AND json_extract(NEW.grant_json,'$.threshold') BETWEEN 0 AND 1 AND json_extract(NEW.grant_json,'$.periodId')=strftime('%Y-%m',NEW.created_at,'unixepoch') AND json_type(NEW.grant_json,'$.periodStart')='integer' AND json_extract(NEW.grant_json,'$.periodStart')=CAST(strftime('%s',NEW.created_at,'unixepoch','start of month') AS INTEGER) AND json_type(NEW.grant_json,'$.periodEnd')='integer' AND json_extract(NEW.grant_json,'$.periodEnd')=CAST(strftime('%s',NEW.created_at,'unixepoch','start of month','+1 month') AS INTEGER) AND NOT EXISTS(SELECT 1 FROM json_each(NEW.grant_json) WHERE key IN('budgetPolicyVersion','processingPolicyVersion','recipeVersion','catalogVersion','priceId') AND (type<>'text' OR length(value)<1 OR length(value)>128 OR value GLOB '*[^A-Za-z0-9._:-]*')),0) THEN RAISE(ABORT,'us_triage_invalid_record') END;
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_mailbox_heads h JOIN international_us_support_mailbox_connections c ON c.organization_id=h.organization_id AND c.workspace_id=h.workspace_id AND c.connection_id=h.current_connection_id AND c.revision=h.revision JOIN international_us_support_mailbox_secrets s ON s.connection_id=c.connection_id AND s.credentials_ciphertext IS NOT NULL AND s.cleared_by_command_id IS NULL WHERE h.organization_id=NEW.organization_id AND h.workspace_id=NEW.workspace_id AND h.current_connection_id=NEW.connection_id AND h.revision=NEW.mailbox_revision AND c.provider=json_extract(NEW.source_json,'$.provider') AND c.mailbox_id=json_extract(NEW.source_json,'$.mailboxId') AND c.folder_id=json_extract(NEW.source_json,'$.folderId')) THEN RAISE(ABORT,'us_triage_connection_changed') END;
SELECT CASE WHEN NEW.environment<>json_extract(NEW.grant_json,'$.environment') OR NEW.period_id<>json_extract(NEW.grant_json,'$.periodId') OR NEW.recipe_version<>json_extract(NEW.grant_json,'$.recipeVersion') THEN RAISE(ABORT,'us_triage_invalid_record') END;
SELECT CASE WHEN (SELECT count(*) FROM international_us_support_triage_jobs WHERE organization_id=NEW.organization_id AND environment=NEW.environment AND period_id=NEW.period_id)>=json_extract(NEW.grant_json,'$.limit') THEN RAISE(ABORT,'us_triage_quota_exceeded') END;
SELECT CASE WHEN (SELECT count(*) FROM international_us_support_triage_jobs WHERE organization_id=NEW.organization_id)>=500 THEN RAISE(ABORT,'us_triage_capacity_exceeded') END;
END;
--> statement-breakpoint
DROP TRIGGER international_us_support_triage_requests_insert;
--> statement-breakpoint
CREATE TRIGGER international_us_support_triage_requests_insert BEFORE INSERT ON international_us_support_triage_requests BEGIN
SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_triage_requests WHERE command_id=NEW.command_id OR (organization_id=NEW.organization_id AND actor_user_id=NEW.actor_user_id AND request_id=NEW.request_id)) THEN RAISE(ABORT,'us_triage_immutable') END;
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
    THEN RAISE(ABORT,'us_triage_invalid_record') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_workspace_members m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.actor_user_id
    AND m.role=json_extract(NEW.context_json,'$.authority.role') AND m.role IN('owner','admin') AND m.revoked_at IS NULL)
    THEN RAISE(ABORT,'us_triage_forbidden') END;
  SELECT CASE WHEN NOT COALESCE((json_extract(NEW.context_json,'$.authority.credential.kind')='browser'
    AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=1 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind')))
    OR (json_extract(NEW.context_json,'$.authority.credential.kind')='device'
      AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=3 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','sessionId','supportedSchemaVersion'))
      AND json_type(NEW.context_json,'$.authority.credential.supportedSchemaVersion')='integer'
      AND json_extract(NEW.context_json,'$.authority.credential.supportedSchemaVersion')=4
      AND EXISTS(SELECT 1 FROM international_us_device_v4_sessions s WHERE s.session_id=json_extract(NEW.context_json,'$.authority.credential.sessionId')
        AND s.organization_id=NEW.organization_id AND s.user_id=NEW.actor_user_id AND s.role=json_extract(NEW.context_json,'$.authority.role')
        AND s.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND s.supported_schema_version=4
        AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch())) OR (json_extract(NEW.context_json,'$.authority.credential.kind')='worker'
AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=5
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','workerId','delegationId','delegationRevision','runId'))
AND json_type(NEW.context_json,'$.authority.credential.delegationRevision')='integer'
AND EXISTS(SELECT 1 FROM international_us_support_worker_admissible w WHERE w.organization_id=NEW.organization_id AND w.workspace_id=NEW.workspace_id
AND w.user_id=json_extract(NEW.context_json,'$.authority.userId') AND w.role=json_extract(NEW.context_json,'$.authority.role')
AND w.run_id=json_extract(NEW.context_json,'$.authority.credential.runId') AND w.worker_id=json_extract(NEW.context_json,'$.authority.credential.workerId')
AND w.delegation_id=json_extract(NEW.context_json,'$.authority.credential.delegationId') AND w.delegation_revision=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
AND w.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId') AND w.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId')
AND w.environment=json_extract(NEW.context_json,'$.authority.environment') AND w.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion')
AND w.price_id=json_extract(NEW.context_json,'$.authority.priceId') AND w.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference')
AND w.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt') AND w.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt')
AND w.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))),0)
    THEN RAISE(ABORT,'us_triage_unauthorized') END;
  SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT EXISTS(
    SELECT 1 FROM international_us_support_mailbox_admissible a WHERE a.organization_id=NEW.organization_id AND a.workspace_id=NEW.workspace_id AND a.user_id=NEW.actor_user_id
      AND a.role=json_extract(NEW.context_json,'$.authority.role') AND a.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId')
      AND a.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND a.environment=json_extract(NEW.context_json,'$.authority.environment')
      AND a.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion') AND a.price_id=json_extract(NEW.context_json,'$.authority.priceId')
      AND a.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference') AND a.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt')
      AND a.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt') AND a.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))
    THEN RAISE(ABORT,'us_triage_subscription_required') END;

SELECT CASE WHEN NOT COALESCE(json_valid(NEW.request_json) AND json_type(NEW.request_json)='object' AND (SELECT count(*) FROM json_each(NEW.request_json))=8 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.request_json) WHERE key NOT IN('schemaVersion','requestId','connectionId','expectedMailboxRevision','uid','expectedMessageVersion','processingPolicyVersion','consent')) AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.request_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1) AND json_extract(NEW.request_json,'$.schemaVersion')=1 AND json_type(NEW.request_json,'$.schemaVersion')='integer' AND json_extract(NEW.request_json,'$.requestId')=NEW.request_id AND json_extract(NEW.request_json,'$.connectionId')=NEW.connection_id AND json_type(NEW.request_json,'$.expectedMailboxRevision')='integer' AND json_extract(NEW.request_json,'$.expectedMailboxRevision')=NEW.mailbox_revision AND json_extract(NEW.request_json,'$.uid')=json_extract(NEW.source_json,'$.uid') AND json_extract(NEW.request_json,'$.expectedMessageVersion')=json_extract(NEW.source_json,'$.messageVersion') AND json_type(NEW.request_json,'$.consent')='true' AND json_extract(NEW.request_json,'$.processingPolicyVersion')=json_extract(NEW.grant_json,'$.processingPolicyVersion') AND json_valid(NEW.source_json) AND json_type(NEW.source_json)='object' AND (SELECT count(*) FROM json_each(NEW.source_json))=9 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.source_json) WHERE key NOT IN('provider','mailboxId','folderId','uid','messageVersion','receivedAt','messageSha256','attachmentCount','bodyComplete')) AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.source_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1) AND json_extract(NEW.source_json,'$.provider')='infomaniak' AND json_type(NEW.source_json,'$.receivedAt')='integer' AND json_extract(NEW.source_json,'$.receivedAt') BETWEEN 1 AND 253402300799 AND json_type(NEW.source_json,'$.attachmentCount')='integer' AND json_extract(NEW.source_json,'$.attachmentCount') BETWEEN 0 AND 1000 AND json_type(NEW.source_json,'$.bodyComplete') IN('true','false') AND length(json_extract(NEW.source_json,'$.messageSha256'))=64 AND json_extract(NEW.source_json,'$.messageSha256') NOT GLOB '*[^0-9a-f]*' AND NOT EXISTS(SELECT 1 FROM json_each(NEW.source_json) WHERE key IN('mailboxId','folderId','uid','messageVersion','messageSha256') AND (type<>'text' OR length(value)<1 OR length(value)>200 OR trim(value)<>value)) AND length(json_extract(NEW.source_json,'$.uid')) BETWEEN 1 AND 20 AND json_extract(NEW.source_json,'$.uid') NOT GLOB '*[^0-9]*' AND json_valid(NEW.grant_json) AND json_type(NEW.grant_json)='object' AND (SELECT count(*) FROM json_each(NEW.grant_json))=15 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.grant_json) WHERE key NOT IN('schemaVersion','organizationId','workspaceId','environment','bucket','periodId','periodStart','periodEnd','limit','budgetPolicyVersion','processingPolicyVersion','catalogVersion','priceId','recipeVersion','threshold')) AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.grant_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1) AND json_type(NEW.grant_json,'$.schemaVersion')='integer' AND json_extract(NEW.grant_json,'$.schemaVersion')=1 AND json_extract(NEW.grant_json,'$.organizationId')=NEW.organization_id AND json_extract(NEW.grant_json,'$.workspaceId')=NEW.workspace_id AND json_extract(NEW.grant_json,'$.environment')=json_extract(NEW.context_json,'$.authority.environment') AND json_extract(NEW.grant_json,'$.bucket')='support_message_classify' AND json_extract(NEW.grant_json,'$.catalogVersion')=json_extract(NEW.context_json,'$.authority.catalogVersion') AND json_extract(NEW.grant_json,'$.priceId')=json_extract(NEW.context_json,'$.authority.priceId') AND json_type(NEW.grant_json,'$.limit')='integer' AND json_extract(NEW.grant_json,'$.limit') BETWEEN 1 AND 1000000 AND json_type(NEW.grant_json,'$.threshold') IN('integer','real') AND json_extract(NEW.grant_json,'$.threshold') BETWEEN 0 AND 1 AND json_extract(NEW.grant_json,'$.periodId')=strftime('%Y-%m',NEW.created_at,'unixepoch') AND json_type(NEW.grant_json,'$.periodStart')='integer' AND json_extract(NEW.grant_json,'$.periodStart')=CAST(strftime('%s',NEW.created_at,'unixepoch','start of month') AS INTEGER) AND json_type(NEW.grant_json,'$.periodEnd')='integer' AND json_extract(NEW.grant_json,'$.periodEnd')=CAST(strftime('%s',NEW.created_at,'unixepoch','start of month','+1 month') AS INTEGER) AND NOT EXISTS(SELECT 1 FROM json_each(NEW.grant_json) WHERE key IN('budgetPolicyVersion','processingPolicyVersion','recipeVersion','catalogVersion','priceId') AND (type<>'text' OR length(value)<1 OR length(value)>128 OR value GLOB '*[^A-Za-z0-9._:-]*')),0) THEN RAISE(ABORT,'us_triage_invalid_record') END;
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_mailbox_heads h JOIN international_us_support_mailbox_connections c ON c.organization_id=h.organization_id AND c.workspace_id=h.workspace_id AND c.connection_id=h.current_connection_id AND c.revision=h.revision JOIN international_us_support_mailbox_secrets s ON s.connection_id=c.connection_id AND s.credentials_ciphertext IS NOT NULL AND s.cleared_by_command_id IS NULL WHERE h.organization_id=NEW.organization_id AND h.workspace_id=NEW.workspace_id AND h.current_connection_id=NEW.connection_id AND h.revision=NEW.mailbox_revision AND c.provider=json_extract(NEW.source_json,'$.provider') AND c.mailbox_id=json_extract(NEW.source_json,'$.mailboxId') AND c.folder_id=json_extract(NEW.source_json,'$.folderId')) THEN RAISE(ABORT,'us_triage_connection_changed') END;
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_triage_jobs j WHERE j.organization_id=NEW.organization_id AND j.workspace_id=NEW.workspace_id AND j.id=NEW.job_id AND j.source_json=NEW.source_json AND j.recipe_version=json_extract(NEW.grant_json,'$.recipeVersion')) THEN RAISE(ABORT,'us_triage_source_conflict') END;
SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_triage_requests WHERE organization_id=NEW.organization_id AND actor_user_id=NEW.actor_user_id AND request_id=NEW.request_id) THEN RAISE(ABORT,'us_triage_idempotency_conflict') END;
SELECT CASE WHEN (SELECT count(*) FROM international_us_support_triage_requests WHERE organization_id=NEW.organization_id)>=2000 THEN RAISE(ABORT,'us_triage_capacity_exceeded') END;
SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_triage_jobs j WHERE j.first_command_id=NEW.command_id AND (j.id<>NEW.job_id OR j.organization_id<>NEW.organization_id OR j.workspace_id<>NEW.workspace_id OR j.actor_user_id<>NEW.actor_user_id OR j.request_id<>NEW.request_id OR j.request_json<>NEW.request_json OR j.context_json<>NEW.context_json OR j.created_at<>NEW.created_at)) THEN RAISE(ABORT,'us_triage_invalid_record') END;
END;
--> statement-breakpoint
DROP TRIGGER international_us_support_triage_dispatches_insert;
--> statement-breakpoint
CREATE TRIGGER international_us_support_triage_dispatches_insert BEFORE INSERT ON international_us_support_triage_dispatches BEGIN
SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_triage_dispatches WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND job_id=NEW.job_id) THEN RAISE(ABORT,'us_triage_immutable') END;
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
    THEN RAISE(ABORT,'us_triage_invalid_record') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_workspace_members m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.actor_user_id
    AND m.role=json_extract(NEW.context_json,'$.authority.role') AND m.role IN('owner','admin') AND m.revoked_at IS NULL)
    THEN RAISE(ABORT,'us_triage_forbidden') END;
  SELECT CASE WHEN NOT COALESCE((json_extract(NEW.context_json,'$.authority.credential.kind')='browser'
    AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=1 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind')))
    OR (json_extract(NEW.context_json,'$.authority.credential.kind')='device'
      AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=3 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','sessionId','supportedSchemaVersion'))
      AND json_type(NEW.context_json,'$.authority.credential.supportedSchemaVersion')='integer'
      AND json_extract(NEW.context_json,'$.authority.credential.supportedSchemaVersion')=4
      AND EXISTS(SELECT 1 FROM international_us_device_v4_sessions s WHERE s.session_id=json_extract(NEW.context_json,'$.authority.credential.sessionId')
        AND s.organization_id=NEW.organization_id AND s.user_id=NEW.actor_user_id AND s.role=json_extract(NEW.context_json,'$.authority.role')
        AND s.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND s.supported_schema_version=4
        AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch())) OR (json_extract(NEW.context_json,'$.authority.credential.kind')='worker'
AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=5
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','workerId','delegationId','delegationRevision','runId'))
AND json_type(NEW.context_json,'$.authority.credential.delegationRevision')='integer'
AND EXISTS(SELECT 1 FROM international_us_support_worker_admissible w WHERE w.organization_id=NEW.organization_id AND w.workspace_id=NEW.workspace_id
AND w.user_id=json_extract(NEW.context_json,'$.authority.userId') AND w.role=json_extract(NEW.context_json,'$.authority.role')
AND w.run_id=json_extract(NEW.context_json,'$.authority.credential.runId') AND w.worker_id=json_extract(NEW.context_json,'$.authority.credential.workerId')
AND w.delegation_id=json_extract(NEW.context_json,'$.authority.credential.delegationId') AND w.delegation_revision=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
AND w.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId') AND w.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId')
AND w.environment=json_extract(NEW.context_json,'$.authority.environment') AND w.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion')
AND w.price_id=json_extract(NEW.context_json,'$.authority.priceId') AND w.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference')
AND w.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt') AND w.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt')
AND w.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))),0)
    THEN RAISE(ABORT,'us_triage_unauthorized') END;
  SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT EXISTS(
    SELECT 1 FROM international_us_support_mailbox_admissible a WHERE a.organization_id=NEW.organization_id AND a.workspace_id=NEW.workspace_id AND a.user_id=NEW.actor_user_id
      AND a.role=json_extract(NEW.context_json,'$.authority.role') AND a.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId')
      AND a.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND a.environment=json_extract(NEW.context_json,'$.authority.environment')
      AND a.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion') AND a.price_id=json_extract(NEW.context_json,'$.authority.priceId')
      AND a.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference') AND a.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt')
      AND a.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt') AND a.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))
    THEN RAISE(ABORT,'us_triage_subscription_required') END;

SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_triage_requests r WHERE r.command_id=NEW.command_id AND r.organization_id=NEW.organization_id AND r.workspace_id=NEW.workspace_id AND r.job_id=NEW.job_id AND r.actor_user_id=NEW.actor_user_id AND r.created_at<=NEW.created_at) THEN RAISE(ABORT,'us_triage_invalid_record') END;SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_triage_jobs j WHERE j.organization_id=NEW.organization_id AND j.workspace_id=NEW.workspace_id AND j.id=NEW.job_id AND j.environment=json_extract(NEW.context_json,'$.authority.environment') AND json_extract(j.grant_json,'$.periodStart')<=unixepoch() AND json_extract(j.grant_json,'$.periodEnd')>unixepoch()) THEN RAISE(ABORT,'us_triage_grant_expired') END;
END;
--> statement-breakpoint
DROP TRIGGER international_us_support_triage_completions_insert;
--> statement-breakpoint
CREATE TRIGGER international_us_support_triage_completions_insert BEFORE INSERT ON international_us_support_triage_completions BEGIN
SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_triage_completions WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND job_id=NEW.job_id) THEN RAISE(ABORT,'us_triage_immutable') END;
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
    THEN RAISE(ABORT,'us_triage_invalid_record') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_workspace_members m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.actor_user_id
    AND m.role=json_extract(NEW.context_json,'$.authority.role') AND m.role IN('owner','admin') AND m.revoked_at IS NULL)
    THEN RAISE(ABORT,'us_triage_forbidden') END;
  SELECT CASE WHEN NOT COALESCE((json_extract(NEW.context_json,'$.authority.credential.kind')='browser'
    AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=1 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind')))
    OR (json_extract(NEW.context_json,'$.authority.credential.kind')='device'
      AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=3 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','sessionId','supportedSchemaVersion'))
      AND json_type(NEW.context_json,'$.authority.credential.supportedSchemaVersion')='integer'
      AND json_extract(NEW.context_json,'$.authority.credential.supportedSchemaVersion')=4
      AND EXISTS(SELECT 1 FROM international_us_device_v4_sessions s WHERE s.session_id=json_extract(NEW.context_json,'$.authority.credential.sessionId')
        AND s.organization_id=NEW.organization_id AND s.user_id=NEW.actor_user_id AND s.role=json_extract(NEW.context_json,'$.authority.role')
        AND s.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND s.supported_schema_version=4
        AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch())) OR (json_extract(NEW.context_json,'$.authority.credential.kind')='worker'
AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=5
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','workerId','delegationId','delegationRevision','runId'))
AND json_type(NEW.context_json,'$.authority.credential.delegationRevision')='integer'
AND EXISTS(SELECT 1 FROM international_us_support_worker_admissible w WHERE w.organization_id=NEW.organization_id AND w.workspace_id=NEW.workspace_id
AND w.user_id=json_extract(NEW.context_json,'$.authority.userId') AND w.role=json_extract(NEW.context_json,'$.authority.role')
AND w.run_id=json_extract(NEW.context_json,'$.authority.credential.runId') AND w.worker_id=json_extract(NEW.context_json,'$.authority.credential.workerId')
AND w.delegation_id=json_extract(NEW.context_json,'$.authority.credential.delegationId') AND w.delegation_revision=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
AND w.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId') AND w.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId')
AND w.environment=json_extract(NEW.context_json,'$.authority.environment') AND w.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion')
AND w.price_id=json_extract(NEW.context_json,'$.authority.priceId') AND w.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference')
AND w.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt') AND w.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt')
AND w.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))),0)
    THEN RAISE(ABORT,'us_triage_unauthorized') END;
  SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT EXISTS(
    SELECT 1 FROM international_us_support_mailbox_admissible a WHERE a.organization_id=NEW.organization_id AND a.workspace_id=NEW.workspace_id AND a.user_id=NEW.actor_user_id
      AND a.role=json_extract(NEW.context_json,'$.authority.role') AND a.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId')
      AND a.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND a.environment=json_extract(NEW.context_json,'$.authority.environment')
      AND a.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion') AND a.price_id=json_extract(NEW.context_json,'$.authority.priceId')
      AND a.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference') AND a.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt')
      AND a.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt') AND a.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))
    THEN RAISE(ABORT,'us_triage_subscription_required') END;

SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_triage_requests r WHERE r.command_id=NEW.command_id AND r.organization_id=NEW.organization_id AND r.workspace_id=NEW.workspace_id AND r.job_id=NEW.job_id AND r.actor_user_id=NEW.actor_user_id AND r.created_at<=NEW.created_at) THEN RAISE(ABORT,'us_triage_invalid_record') END;SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_triage_dispatches d WHERE d.organization_id=NEW.organization_id AND d.workspace_id=NEW.workspace_id AND d.job_id=NEW.job_id AND d.dispatch_id=NEW.dispatch_id AND d.created_at<=NEW.created_at) THEN RAISE(ABORT,'us_triage_invalid_record') END;SELECT CASE WHEN NOT COALESCE(json_valid(NEW.decision_json) AND json_type(NEW.decision_json)='object' AND (SELECT count(*) FROM json_each(NEW.decision_json))=13 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.decision_json) WHERE key NOT IN('schemaVersion','category','priority','categoryConfidence','priorityConfidence','confidence','language','languageConfidence','humanRequested','reviewReasons','needsReview','model','recipeVersion')) AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.decision_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1) AND json_type(NEW.decision_json,'$.schemaVersion')='integer' AND json_extract(NEW.decision_json,'$.schemaVersion')=1 AND json_extract(NEW.decision_json,'$.category') IN('bug','billing','supplier_invoice','appointment','order','after_sales','complaint','administration','human_resources','spam','solicitation','quote','credit_note','payment_reminder','receipt','product','refund','shipping','account','other') AND json_extract(NEW.decision_json,'$.priority') IN('low','normal','high','urgent') AND json_extract(NEW.decision_json,'$.language') IN('fr','de','it','en','other') AND json_type(NEW.decision_json,'$.categoryConfidence') IN('integer','real') AND json_extract(NEW.decision_json,'$.categoryConfidence') BETWEEN 0 AND 1 AND json_type(NEW.decision_json,'$.priorityConfidence') IN('integer','real') AND json_extract(NEW.decision_json,'$.priorityConfidence') BETWEEN 0 AND 1 AND json_type(NEW.decision_json,'$.confidence') IN('integer','real') AND json_extract(NEW.decision_json,'$.confidence') BETWEEN 0 AND 1 AND json_type(NEW.decision_json,'$.languageConfidence') IN('integer','real') AND json_extract(NEW.decision_json,'$.languageConfidence') BETWEEN 0 AND 1 AND json_type(NEW.decision_json,'$.humanRequested') IN('integer','real') AND json_extract(NEW.decision_json,'$.humanRequested') BETWEEN 0 AND 1 AND json_extract(NEW.decision_json,'$.confidence')=min(json_extract(NEW.decision_json,'$.categoryConfidence'),json_extract(NEW.decision_json,'$.priorityConfidence')) AND json_extract(NEW.decision_json,'$.model')='jev-1.13.0' AND json_type(NEW.decision_json,'$.reviewReasons')='array' AND json_type(NEW.decision_json,'$.needsReview') IN('true','false') AND EXISTS(SELECT 1 FROM international_us_support_triage_jobs j WHERE j.organization_id=NEW.organization_id AND j.workspace_id=NEW.workspace_id AND j.id=NEW.job_id AND json_extract(NEW.decision_json,'$.recipeVersion')=j.recipe_version AND json_extract(NEW.decision_json,'$.reviewReasons')=(SELECT json_group_array(reason) FROM (SELECT 1 AS n,'low_confidence' AS reason WHERE min(json_extract(NEW.decision_json,'$.confidence'),json_extract(NEW.decision_json,'$.languageConfidence'))<json_extract(j.grant_json,'$.threshold') UNION ALL SELECT 2,'human_requested' WHERE json_extract(NEW.decision_json,'$.humanRequested')>=0.2 UNION ALL SELECT 3,'other_category' WHERE json_extract(NEW.decision_json,'$.category')='other' UNION ALL SELECT 4,'unread_attachments' WHERE json_extract(j.source_json,'$.attachmentCount')>0 UNION ALL SELECT 5,'incomplete_body' WHERE json_extract(j.source_json,'$.bodyComplete')=0 ORDER BY n)) AND json_extract(NEW.decision_json,'$.needsReview')=(json_array_length(NEW.decision_json,'$.reviewReasons')>0)),0) THEN RAISE(ABORT,'us_triage_invalid_record') END;
END;
--> statement-breakpoint
DROP TRIGGER international_us_support_triage_uncertain_insert;
--> statement-breakpoint
CREATE TRIGGER international_us_support_triage_uncertain_insert BEFORE INSERT ON international_us_support_triage_uncertain BEGIN
SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_triage_uncertain WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND job_id=NEW.job_id) THEN RAISE(ABORT,'us_triage_immutable') END;
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
    THEN RAISE(ABORT,'us_triage_invalid_record') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_workspace_members m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.actor_user_id
    AND m.role=json_extract(NEW.context_json,'$.authority.role') AND m.role IN('owner','admin') AND m.revoked_at IS NULL)
    THEN RAISE(ABORT,'us_triage_forbidden') END;
  SELECT CASE WHEN NOT COALESCE((json_extract(NEW.context_json,'$.authority.credential.kind')='browser'
    AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=1 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind')))
    OR (json_extract(NEW.context_json,'$.authority.credential.kind')='device'
      AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=3 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','sessionId','supportedSchemaVersion'))
      AND json_type(NEW.context_json,'$.authority.credential.supportedSchemaVersion')='integer'
      AND json_extract(NEW.context_json,'$.authority.credential.supportedSchemaVersion')=4
      AND EXISTS(SELECT 1 FROM international_us_device_v4_sessions s WHERE s.session_id=json_extract(NEW.context_json,'$.authority.credential.sessionId')
        AND s.organization_id=NEW.organization_id AND s.user_id=NEW.actor_user_id AND s.role=json_extract(NEW.context_json,'$.authority.role')
        AND s.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND s.supported_schema_version=4
        AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch())) OR (json_extract(NEW.context_json,'$.authority.credential.kind')='worker'
AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=5
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','workerId','delegationId','delegationRevision','runId'))
AND json_type(NEW.context_json,'$.authority.credential.delegationRevision')='integer'
AND EXISTS(SELECT 1 FROM international_us_support_worker_admissible w WHERE w.organization_id=NEW.organization_id AND w.workspace_id=NEW.workspace_id
AND w.user_id=json_extract(NEW.context_json,'$.authority.userId') AND w.role=json_extract(NEW.context_json,'$.authority.role')
AND w.run_id=json_extract(NEW.context_json,'$.authority.credential.runId') AND w.worker_id=json_extract(NEW.context_json,'$.authority.credential.workerId')
AND w.delegation_id=json_extract(NEW.context_json,'$.authority.credential.delegationId') AND w.delegation_revision=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
AND w.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId') AND w.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId')
AND w.environment=json_extract(NEW.context_json,'$.authority.environment') AND w.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion')
AND w.price_id=json_extract(NEW.context_json,'$.authority.priceId') AND w.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference')
AND w.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt') AND w.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt')
AND w.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))),0)
    THEN RAISE(ABORT,'us_triage_unauthorized') END;
  SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT EXISTS(
    SELECT 1 FROM international_us_support_mailbox_admissible a WHERE a.organization_id=NEW.organization_id AND a.workspace_id=NEW.workspace_id AND a.user_id=NEW.actor_user_id
      AND a.role=json_extract(NEW.context_json,'$.authority.role') AND a.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId')
      AND a.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND a.environment=json_extract(NEW.context_json,'$.authority.environment')
      AND a.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion') AND a.price_id=json_extract(NEW.context_json,'$.authority.priceId')
      AND a.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference') AND a.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt')
      AND a.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt') AND a.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))
    THEN RAISE(ABORT,'us_triage_subscription_required') END;

SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_triage_requests r WHERE r.command_id=NEW.command_id AND r.organization_id=NEW.organization_id AND r.workspace_id=NEW.workspace_id AND r.job_id=NEW.job_id AND r.actor_user_id=NEW.actor_user_id AND r.created_at<=NEW.created_at) THEN RAISE(ABORT,'us_triage_invalid_record') END;SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_triage_dispatches d WHERE d.organization_id=NEW.organization_id AND d.workspace_id=NEW.workspace_id AND d.job_id=NEW.job_id AND d.dispatch_id=NEW.dispatch_id AND d.created_at<=NEW.created_at) THEN RAISE(ABORT,'us_triage_invalid_record') END;
END;
--> statement-breakpoint
DROP TRIGGER international_us_support_ticket_command_insert;
--> statement-breakpoint
CREATE TRIGGER international_us_support_ticket_command_insert BEFORE INSERT ON international_us_support_ticket_commands BEGIN
SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_ticket_commands WHERE command_id=NEW.command_id OR(organization_id=NEW.organization_id AND actor_user_id=NEW.actor_user_id AND request_id=NEW.request_id))THEN RAISE(ABORT,'us_ticket_idempotency_conflict')END;
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
    THEN RAISE(ABORT,'us_ticket_invalid_record') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_workspace_members m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.actor_user_id
    AND m.role=json_extract(NEW.context_json,'$.authority.role') AND m.role IN('owner','admin','accountant','member','read_only') AND m.revoked_at IS NULL)
    THEN RAISE(ABORT,'us_ticket_forbidden') END;
  SELECT CASE WHEN NOT COALESCE((json_extract(NEW.context_json,'$.authority.credential.kind')='browser'
    AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=1 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind')))
    OR (json_extract(NEW.context_json,'$.authority.credential.kind')='device'
      AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=3 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','sessionId','supportedSchemaVersion'))
      AND json_type(NEW.context_json,'$.authority.credential.supportedSchemaVersion')='integer'
      AND json_extract(NEW.context_json,'$.authority.credential.supportedSchemaVersion')=4
      AND EXISTS(SELECT 1 FROM international_us_device_v4_sessions s WHERE s.session_id=json_extract(NEW.context_json,'$.authority.credential.sessionId')
        AND s.organization_id=NEW.organization_id AND s.user_id=NEW.actor_user_id AND s.role=json_extract(NEW.context_json,'$.authority.role')
        AND s.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND s.supported_schema_version=4
        AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch())) OR (json_extract(NEW.context_json,'$.authority.credential.kind')='worker'
AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=5
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','workerId','delegationId','delegationRevision','runId'))
AND json_type(NEW.context_json,'$.authority.credential.delegationRevision')='integer'
AND EXISTS(SELECT 1 FROM international_us_support_worker_admissible w WHERE w.organization_id=NEW.organization_id AND w.workspace_id=NEW.workspace_id
AND w.user_id=json_extract(NEW.context_json,'$.authority.userId') AND w.role=json_extract(NEW.context_json,'$.authority.role')
AND w.run_id=json_extract(NEW.context_json,'$.authority.credential.runId') AND w.worker_id=json_extract(NEW.context_json,'$.authority.credential.workerId')
AND w.delegation_id=json_extract(NEW.context_json,'$.authority.credential.delegationId') AND w.delegation_revision=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
AND w.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId') AND w.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId')
AND w.environment=json_extract(NEW.context_json,'$.authority.environment') AND w.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion')
AND w.price_id=json_extract(NEW.context_json,'$.authority.priceId') AND w.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference')
AND w.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt') AND w.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt')
AND w.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))),0)
    THEN RAISE(ABORT,'us_ticket_unauthorized') END;
  SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT EXISTS(
    SELECT 1 FROM international_us_support_mailbox_admissible a WHERE a.organization_id=NEW.organization_id AND a.workspace_id=NEW.workspace_id AND a.user_id=NEW.actor_user_id
      AND a.role=json_extract(NEW.context_json,'$.authority.role') AND a.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId')
      AND a.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND a.environment=json_extract(NEW.context_json,'$.authority.environment')
      AND a.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion') AND a.price_id=json_extract(NEW.context_json,'$.authority.priceId')
      AND a.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference') AND a.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt')
      AND a.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt') AND a.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))
    THEN RAISE(ABORT,'us_ticket_subscription_required') END;


SELECT CASE WHEN(SELECT count(*)FROM international_us_support_ticket_commands WHERE organization_id=NEW.organization_id)>=52000 THEN RAISE(ABORT,'us_ticket_command_capacity_exceeded')END;
SELECT CASE WHEN NEW.revision<>COALESCE((SELECT revision FROM international_us_support_ticket_heads WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id),0)+1 THEN RAISE(ABORT,'us_ticket_revision_conflict')END;
SELECT CASE WHEN NEW.action<>'set_status' AND json_extract(NEW.context_json,'$.authority.role') NOT IN('owner','admin')THEN RAISE(ABORT,'us_ticket_forbidden')END;
SELECT CASE WHEN NOT COALESCE(json_extract(NEW.request_json,'$.schemaVersion')=1 AND json_type(NEW.request_json,'$.schemaVersion')='integer' AND json_extract(NEW.request_json,'$.requestId')=NEW.request_id AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.request_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1),0)THEN RAISE(ABORT,'us_ticket_invalid_record')END;
SELECT CASE WHEN NEW.action='create' AND NOT COALESCE((SELECT count(*)FROM json_each(NEW.request_json))=4 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.request_json)WHERE key NOT IN('schemaVersion','requestId','action','jobId')),0)THEN RAISE(ABORT,'us_ticket_invalid_record')END;
SELECT CASE WHEN NEW.action='correct' AND NOT COALESCE((SELECT count(*)FROM json_each(NEW.request_json))=8 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.request_json)WHERE key NOT IN('schemaVersion','requestId','action','ticketId','expectedRevision','category','priority','language')),0)THEN RAISE(ABORT,'us_ticket_invalid_record')END;
SELECT CASE WHEN NEW.action='assign' AND NOT COALESCE((SELECT count(*)FROM json_each(NEW.request_json))=6 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.request_json)WHERE key NOT IN('schemaVersion','requestId','action','ticketId','expectedRevision','assigneeMembershipId')),0)THEN RAISE(ABORT,'us_ticket_invalid_record')END;
SELECT CASE WHEN NEW.action='set_status' AND NOT COALESCE((SELECT count(*)FROM json_each(NEW.request_json))=6 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.request_json)WHERE key NOT IN('schemaVersion','requestId','action','ticketId','expectedRevision','status')),0)THEN RAISE(ABORT,'us_ticket_invalid_record')END;
SELECT CASE WHEN NEW.action='create' AND ((NEW.applied=1 AND (typeof(NEW.routing_revision)<>'integer' OR NEW.routing_revision<0))OR(NEW.applied=0 AND NEW.routing_revision IS NOT NULL))THEN RAISE(ABORT,'us_ticket_invalid_record')END;
SELECT CASE WHEN NEW.action='save_routing' AND NOT COALESCE((SELECT count(*) FROM json_each(NEW.request_json))=6 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.request_json) WHERE key NOT IN('schemaVersion','requestId','expectedRevision','enabled','threshold','routes')) AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.request_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1) AND json_type(NEW.request_json,'$.expectedRevision')='integer' AND json_extract(NEW.request_json,'$.expectedRevision')=NEW.expected_revision AND json_type(NEW.request_json,'$.enabled')IN('true','false') AND json_type(NEW.request_json,'$.threshold')IN('integer','real') AND json_extract(NEW.request_json,'$.threshold') BETWEEN 0 AND 1 AND json_type(NEW.request_json,'$.routes')='array' AND NEW.entity_id=NEW.workspace_id AND NEW.applied=1 AND NEW.entity_revision=NEW.expected_revision+1 AND NEW.job_id IS NULL AND NEW.source_hash IS NULL AND NEW.routing_revision IS NULL,0)THEN RAISE(ABORT,'us_ticket_invalid_record')END;
SELECT CASE WHEN NEW.action='save_routing' AND (SELECT count(*) FROM international_us_support_ticket_routing WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id)>=1000 THEN RAISE(ABORT,'us_ticket_capacity_exceeded')END;
SELECT CASE WHEN NEW.action='save_routing' AND NEW.expected_revision<>COALESCE((SELECT max(revision) FROM international_us_support_ticket_routing WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id),0)THEN RAISE(ABORT,'us_ticket_revision_conflict')END;
SELECT CASE WHEN NEW.action<>'save_routing' AND NOT COALESCE((SELECT count(*) FROM json_each(NEW.request_json))=CASE NEW.action WHEN 'create'THEN 4 WHEN 'correct'THEN 8 ELSE 6 END AND NOT EXISTS(SELECT 1 FROM json_each(NEW.request_json)WHERE key NOT IN('schemaVersion','requestId','action','jobId','ticketId','expectedRevision','category','priority','language','assigneeMembershipId','status')) AND json_extract(NEW.request_json,'$.action')=NEW.action AND(NEW.action='create' OR(json_type(NEW.request_json,'$.expectedRevision')='integer' AND json_extract(NEW.request_json,'$.expectedRevision')=NEW.expected_revision AND json_extract(NEW.request_json,'$.ticketId')=NEW.entity_id)),0)THEN RAISE(ABORT,'us_ticket_invalid_record')END;
SELECT CASE WHEN NEW.action='create' AND NOT COALESCE(json_extract(NEW.request_json,'$.jobId')=NEW.job_id AND NEW.expected_revision=0 AND EXISTS(SELECT 1 FROM international_us_support_triage_jobs j JOIN international_us_support_triage_dispatches d ON d.organization_id=j.organization_id AND d.workspace_id=j.workspace_id AND d.job_id=j.id JOIN international_us_support_triage_completions x ON x.organization_id=j.organization_id AND x.workspace_id=j.workspace_id AND x.job_id=j.id AND x.dispatch_id=d.dispatch_id WHERE j.organization_id=NEW.organization_id AND j.workspace_id=NEW.workspace_id AND j.id=NEW.job_id AND j.source_hash=NEW.source_hash),0)THEN RAISE(ABORT,'us_ticket_source_not_completed')END;
SELECT CASE WHEN NEW.action='create' AND ((NEW.applied=1 AND(NEW.entity_revision<>1 OR EXISTS(SELECT 1 FROM international_us_support_tickets WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND source_hash=NEW.source_hash) OR NEW.routing_revision<>COALESCE((SELECT max(revision) FROM international_us_support_ticket_routing WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id),0)))OR(NEW.applied=0 AND NOT EXISTS(SELECT 1 FROM international_us_support_tickets t JOIN international_us_support_ticket_revisions r ON r.organization_id=t.organization_id AND r.workspace_id=t.workspace_id AND r.ticket_id=t.id WHERE t.organization_id=NEW.organization_id AND t.workspace_id=NEW.workspace_id AND t.id=NEW.entity_id AND t.source_hash=NEW.source_hash AND r.revision=NEW.entity_revision AND r.revision=(SELECT max(revision)FROM international_us_support_ticket_revisions rr WHERE rr.organization_id=t.organization_id AND rr.workspace_id=t.workspace_id AND rr.ticket_id=t.id))))THEN RAISE(ABORT,'us_ticket_source_conflict')END;
SELECT CASE WHEN NEW.action IN('correct','assign','set_status')AND(NEW.applied<>1 OR NEW.job_id IS NOT NULL OR NEW.source_hash IS NOT NULL OR NEW.routing_revision IS NOT NULL OR NEW.entity_revision<>NEW.expected_revision+1 OR NEW.expected_revision<>COALESCE((SELECT max(revision) FROM international_us_support_ticket_revisions WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND ticket_id=NEW.entity_id),0))THEN RAISE(ABORT,'us_ticket_revision_conflict')END;
SELECT CASE WHEN NEW.action='set_status' AND json_extract(NEW.context_json,'$.authority.role')NOT IN('owner','admin')AND NOT EXISTS(SELECT 1 FROM international_workspace_members m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.actor_user_id AND m.role='member' AND m.revoked_at IS NULL AND m.membership_id=json_extract((SELECT snapshot_json FROM international_us_support_ticket_revisions r WHERE r.organization_id=NEW.organization_id AND r.workspace_id=NEW.workspace_id AND r.ticket_id=NEW.entity_id ORDER BY revision DESC LIMIT 1),'$.assigneeMembershipId'))THEN RAISE(ABORT,'us_ticket_forbidden')END;
SELECT CASE WHEN NEW.action<>'save_routing' AND NEW.applied=1 AND(SELECT count(*)FROM international_us_support_ticket_audit a JOIN international_us_support_ticket_commands ac ON ac.command_id=a.command_id AND ac.applied=1 WHERE a.organization_id=NEW.organization_id AND a.workspace_id=NEW.workspace_id AND a.entity_id=NEW.entity_id AND a.action<>'save_routing')>=100 THEN RAISE(ABORT,'us_ticket_audit_capacity_exceeded')END;
END;
--> statement-breakpoint
DROP TRIGGER international_us_support_ticket_audit_insert;
--> statement-breakpoint
CREATE TRIGGER international_us_support_ticket_audit_insert BEFORE INSERT ON international_us_support_ticket_audit BEGIN
SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_ticket_audit WHERE command_id=NEW.command_id OR(organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND revision=NEW.revision))THEN RAISE(ABORT,'us_ticket_immutable')END;
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
    THEN RAISE(ABORT,'us_ticket_invalid_record') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_workspace_members m WHERE m.organization_id=NEW.organization_id AND m.user_id=NEW.actor_user_id
    AND m.role=json_extract(NEW.context_json,'$.authority.role') AND m.role IN('owner','admin','accountant','member','read_only') AND m.revoked_at IS NULL)
    THEN RAISE(ABORT,'us_ticket_forbidden') END;
  SELECT CASE WHEN NOT COALESCE((json_extract(NEW.context_json,'$.authority.credential.kind')='browser'
    AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=1 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind')))
    OR (json_extract(NEW.context_json,'$.authority.credential.kind')='device'
      AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=3 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','sessionId','supportedSchemaVersion'))
      AND json_type(NEW.context_json,'$.authority.credential.supportedSchemaVersion')='integer'
      AND json_extract(NEW.context_json,'$.authority.credential.supportedSchemaVersion')=4
      AND EXISTS(SELECT 1 FROM international_us_device_v4_sessions s WHERE s.session_id=json_extract(NEW.context_json,'$.authority.credential.sessionId')
        AND s.organization_id=NEW.organization_id AND s.user_id=NEW.actor_user_id AND s.role=json_extract(NEW.context_json,'$.authority.role')
        AND s.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND s.supported_schema_version=4
        AND s.revoked_at IS NULL AND s.expires_at>unixepoch() AND s.entitlement_valid_until>unixepoch())) OR (json_extract(NEW.context_json,'$.authority.credential.kind')='worker'
AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=5
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','workerId','delegationId','delegationRevision','runId'))
AND json_type(NEW.context_json,'$.authority.credential.delegationRevision')='integer'
AND EXISTS(SELECT 1 FROM international_us_support_worker_admissible w WHERE w.organization_id=NEW.organization_id AND w.workspace_id=NEW.workspace_id
AND w.user_id=json_extract(NEW.context_json,'$.authority.userId') AND w.role=json_extract(NEW.context_json,'$.authority.role')
AND w.run_id=json_extract(NEW.context_json,'$.authority.credential.runId') AND w.worker_id=json_extract(NEW.context_json,'$.authority.credential.workerId')
AND w.delegation_id=json_extract(NEW.context_json,'$.authority.credential.delegationId') AND w.delegation_revision=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
AND w.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId') AND w.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId')
AND w.environment=json_extract(NEW.context_json,'$.authority.environment') AND w.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion')
AND w.price_id=json_extract(NEW.context_json,'$.authority.priceId') AND w.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference')
AND w.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt') AND w.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt')
AND w.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))),0)
    THEN RAISE(ABORT,'us_ticket_unauthorized') END;
  SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT EXISTS(
    SELECT 1 FROM international_us_support_mailbox_admissible a WHERE a.organization_id=NEW.organization_id AND a.workspace_id=NEW.workspace_id AND a.user_id=NEW.actor_user_id
      AND a.role=json_extract(NEW.context_json,'$.authority.role') AND a.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId')
      AND a.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId') AND a.environment=json_extract(NEW.context_json,'$.authority.environment')
      AND a.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion') AND a.price_id=json_extract(NEW.context_json,'$.authority.priceId')
      AND a.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference') AND a.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt')
      AND a.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt') AND a.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))
    THEN RAISE(ABORT,'us_ticket_subscription_required') END;


SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_ticket_commands c WHERE c.organization_id=NEW.organization_id AND c.workspace_id=NEW.workspace_id AND c.command_id=NEW.command_id AND c.revision=NEW.revision AND c.actor_user_id=NEW.actor_user_id AND c.action=NEW.action AND c.entity_id=NEW.entity_id AND c.entity_revision=NEW.entity_revision AND c.request_hash=NEW.request_hash AND c.context_json=NEW.context_json AND c.created_at=NEW.created_at AND c.revision=(SELECT revision+1 FROM international_us_support_ticket_heads WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id))THEN RAISE(ABORT,'us_ticket_invalid_record')END;
SELECT CASE WHEN NEW.action='save_routing' AND NOT EXISTS(SELECT 1 FROM international_us_support_ticket_routing r WHERE r.organization_id=NEW.organization_id AND r.workspace_id=NEW.workspace_id AND r.command_id=NEW.command_id AND r.revision=NEW.entity_revision AND r.snapshot_json=NEW.event_json)THEN RAISE(ABORT,'us_ticket_invalid_record')END;
SELECT CASE WHEN NEW.action<>'save_routing' AND NOT COALESCE((SELECT count(*) FROM json_each(NEW.event_json))=CASE WHEN json_extract(NEW.context_json,'$.authority.credential.kind')='worker' THEN 15 ELSE 11 END AND NOT EXISTS(SELECT 1 FROM json_each(NEW.event_json) WHERE key NOT IN('revision','ticketRevision','action','actorUserId','createdAt','category','priority','language','assigneeMembershipId','status','humanCorrection','actorKind','delegationId','delegationRevision','runId')) AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.event_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1) AND json_type(NEW.event_json,'$.revision')='integer' AND json_type(NEW.event_json,'$.ticketRevision')='integer' AND json_type(NEW.event_json,'$.createdAt')='integer' AND json_type(NEW.event_json,'$.humanCorrection')IN('true','false') AND json_extract(NEW.event_json,'$.revision')=NEW.revision AND json_extract(NEW.event_json,'$.ticketRevision')=NEW.entity_revision AND json_extract(NEW.event_json,'$.action')=NEW.action AND json_extract(NEW.event_json,'$.actorUserId')=NEW.actor_user_id AND json_extract(NEW.event_json,'$.createdAt')=NEW.created_at AND EXISTS(SELECT 1 FROM international_us_support_ticket_revisions r WHERE r.organization_id=NEW.organization_id AND r.workspace_id=NEW.workspace_id AND r.ticket_id=NEW.entity_id AND r.revision=NEW.entity_revision AND json_extract(NEW.event_json,'$.category')=json_extract(r.snapshot_json,'$.category') AND json_extract(NEW.event_json,'$.priority')=json_extract(r.snapshot_json,'$.priority') AND json_extract(NEW.event_json,'$.language')=json_extract(r.snapshot_json,'$.language') AND json_extract(NEW.event_json,'$.assigneeMembershipId')IS json_extract(r.snapshot_json,'$.assigneeMembershipId') AND json_extract(NEW.event_json,'$.status')=json_extract(r.snapshot_json,'$.status') AND json_extract(NEW.event_json,'$.humanCorrection')=json_extract(r.snapshot_json,'$.humanCorrection')),0)THEN RAISE(ABORT,'us_ticket_invalid_record')END;
-- Human events retain their original exact11-key schema and cannot claim worker provenance.
SELECT CASE WHEN NEW.action<>'save_routing' AND json_extract(NEW.context_json,'$.authority.credential.kind') IS NOT 'worker' AND EXISTS(SELECT 1 FROM json_each(NEW.event_json) WHERE key IN('actorKind','delegationId','delegationRevision','runId')) THEN RAISE(ABORT,'us_ticket_invalid_record') END;
SELECT CASE WHEN json_extract(NEW.context_json,'$.authority.credential.kind')='worker' AND NOT COALESCE(NEW.action='create'
AND json_extract(NEW.event_json,'$.actorKind')='worker'
AND json_extract(NEW.event_json,'$.delegationId')=json_extract(NEW.context_json,'$.authority.credential.delegationId')
AND json_extract(NEW.event_json,'$.delegationRevision')=json_extract(NEW.context_json,'$.authority.credential.delegationRevision') AND json_type(NEW.event_json,'$.delegationRevision')='integer'
AND json_extract(NEW.event_json,'$.runId')=json_extract(NEW.context_json,'$.authority.credential.runId'),0)THEN RAISE(ABORT,'us_ticket_forbidden') END;
END;
--> statement-breakpoint
-- Worker consent is a separately persisted preparation bound to physical discovery.
CREATE TRIGGER international_us_support_triage_worker_job_insert BEFORE INSERT ON international_us_support_triage_jobs
WHEN json_extract(NEW.context_json,'$.authority.credential.kind')='worker' BEGIN
SELECT CASE WHEN NOT EXISTS(
SELECT 1 FROM international_us_support_worker_stages p
JOIN international_us_support_worker_discovered source ON source.organization_id=p.organization_id AND source.workspace_id=p.workspace_id AND source.id=p.discovery_id
JOIN international_us_support_worker_delegations d ON d.organization_id=p.organization_id AND d.workspace_id=p.workspace_id AND d.delegation_id=json_extract(NEW.context_json,'$.authority.credential.delegationId') AND d.revision=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
WHERE p.organization_id=NEW.organization_id AND p.workspace_id=NEW.workspace_id AND p.stage='prepared' AND p.request_json=NEW.request_json
AND source.request_id=NEW.request_id AND source.provider=json_extract(NEW.source_json,'$.provider') AND source.mailbox_id=json_extract(NEW.source_json,'$.mailboxId') AND source.folder_id=json_extract(NEW.source_json,'$.folderId') AND source.uid=json_extract(NEW.source_json,'$.uid')
AND json_extract(NEW.source_json,'$.receivedAt')>=json_extract(d.snapshot_json,'$.startsAt')
AND json_extract(NEW.grant_json,'$.processingPolicyVersion')=json_extract(d.snapshot_json,'$.processingPolicyVersion')
AND json_extract(NEW.grant_json,'$.budgetPolicyVersion')=json_extract(d.snapshot_json,'$.budgetPolicyVersion')
AND json_extract(NEW.grant_json,'$.recipeVersion')=json_extract(d.snapshot_json,'$.recipeVersion'))
THEN RAISE(ABORT,'us_triage_source_conflict') END;
-- A new recipe does not permit a second autonomous classifier emission for a UID.
SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_triage_jobs j WHERE j.organization_id=NEW.organization_id AND j.workspace_id=NEW.workspace_id
AND json_extract(j.source_json,'$.provider')=json_extract(NEW.source_json,'$.provider') AND json_extract(j.source_json,'$.mailboxId')=json_extract(NEW.source_json,'$.mailboxId')
AND json_extract(j.source_json,'$.folderId')=json_extract(NEW.source_json,'$.folderId') AND json_extract(j.source_json,'$.uid')=json_extract(NEW.source_json,'$.uid'))
THEN RAISE(ABORT,'us_triage_source_conflict') END;
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_triage_worker_request_insert BEFORE INSERT ON international_us_support_triage_requests
WHEN json_extract(NEW.context_json,'$.authority.credential.kind')='worker' BEGIN
SELECT CASE WHEN NOT EXISTS(
SELECT 1 FROM international_us_support_worker_stages p JOIN international_us_support_worker_discovered source ON source.organization_id=p.organization_id AND source.workspace_id=p.workspace_id AND source.id=p.discovery_id
JOIN international_us_support_worker_delegations d ON d.organization_id=p.organization_id AND d.workspace_id=p.workspace_id AND d.delegation_id=json_extract(NEW.context_json,'$.authority.credential.delegationId') AND d.revision=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
WHERE p.organization_id=NEW.organization_id AND p.workspace_id=NEW.workspace_id AND p.stage='prepared' AND p.request_json=NEW.request_json
AND source.request_id=NEW.request_id AND source.provider=json_extract(NEW.source_json,'$.provider') AND source.mailbox_id=json_extract(NEW.source_json,'$.mailboxId') AND source.folder_id=json_extract(NEW.source_json,'$.folderId') AND source.uid=json_extract(NEW.source_json,'$.uid')
AND json_extract(NEW.grant_json,'$.processingPolicyVersion')=json_extract(d.snapshot_json,'$.processingPolicyVersion') AND json_extract(NEW.grant_json,'$.budgetPolicyVersion')=json_extract(d.snapshot_json,'$.budgetPolicyVersion'))
THEN RAISE(ABORT,'us_triage_source_conflict') END;END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_triage_worker_dispatch_insert BEFORE INSERT ON international_us_support_triage_dispatches
WHEN json_extract(NEW.context_json,'$.authority.credential.kind')='worker' BEGIN
SELECT CASE WHEN NOT EXISTS(
SELECT 1 FROM international_us_support_triage_requests r JOIN international_us_support_worker_stages p ON p.organization_id=r.organization_id AND p.workspace_id=r.workspace_id AND p.stage='prepared' AND p.request_json=r.request_json
JOIN international_us_support_worker_discovered source ON source.organization_id=p.organization_id AND source.workspace_id=p.workspace_id AND source.id=p.discovery_id AND source.request_id=r.request_id
JOIN international_us_support_worker_delegations d ON d.organization_id=r.organization_id AND d.workspace_id=r.workspace_id AND d.delegation_id=json_extract(NEW.context_json,'$.authority.credential.delegationId') AND d.revision=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
JOIN international_us_support_triage_jobs j ON j.organization_id=r.organization_id AND j.workspace_id=r.workspace_id AND j.id=r.job_id AND json_extract(j.source_json,'$.receivedAt')>=json_extract(d.snapshot_json,'$.startsAt')
WHERE r.command_id=NEW.command_id AND r.organization_id=NEW.organization_id AND r.workspace_id=NEW.workspace_id AND r.job_id=NEW.job_id
AND r.connection_id=json_extract(d.snapshot_json,'$.connectionId') AND r.mailbox_revision=json_extract(d.snapshot_json,'$.mailboxRevision'))
THEN RAISE(ABORT,'us_triage_connection_changed') END;END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_triage_worker_completion_insert BEFORE INSERT ON international_us_support_triage_completions
WHEN json_extract(NEW.context_json,'$.authority.credential.kind')='worker' OR EXISTS(SELECT 1 FROM international_us_support_triage_dispatches d WHERE d.organization_id=NEW.organization_id AND d.workspace_id=NEW.workspace_id AND d.job_id=NEW.job_id AND json_extract(d.context_json,'$.authority.credential.kind')='worker') BEGIN
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_triage_dispatches d WHERE d.organization_id=NEW.organization_id AND d.workspace_id=NEW.workspace_id AND d.job_id=NEW.job_id AND d.dispatch_id=NEW.dispatch_id
AND json_extract(d.context_json,'$.authority.credential.kind')='worker'
AND json_extract(d.context_json,'$.authority.credential.workerId')=json_extract(NEW.context_json,'$.authority.credential.workerId')
AND json_extract(d.context_json,'$.authority.credential.delegationId')=json_extract(NEW.context_json,'$.authority.credential.delegationId')
AND json_extract(d.context_json,'$.authority.credential.delegationRevision')=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
AND json_extract(d.context_json,'$.authority.credential.runId')=json_extract(NEW.context_json,'$.authority.credential.runId'))
THEN RAISE(ABORT,'us_triage_invalid_record') END;END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_triage_worker_uncertain_insert BEFORE INSERT ON international_us_support_triage_uncertain
WHEN json_extract(NEW.context_json,'$.authority.credential.kind')='worker' OR EXISTS(SELECT 1 FROM international_us_support_triage_dispatches d WHERE d.organization_id=NEW.organization_id AND d.workspace_id=NEW.workspace_id AND d.job_id=NEW.job_id AND json_extract(d.context_json,'$.authority.credential.kind')='worker') BEGIN
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM international_us_support_triage_dispatches d WHERE d.organization_id=NEW.organization_id AND d.workspace_id=NEW.workspace_id AND d.job_id=NEW.job_id AND d.dispatch_id=NEW.dispatch_id
AND json_extract(d.context_json,'$.authority.credential.kind')='worker'
AND json_extract(d.context_json,'$.authority.credential.workerId')=json_extract(NEW.context_json,'$.authority.credential.workerId')
AND json_extract(d.context_json,'$.authority.credential.delegationId')=json_extract(NEW.context_json,'$.authority.credential.delegationId')
AND json_extract(d.context_json,'$.authority.credential.delegationRevision')=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
AND json_extract(d.context_json,'$.authority.credential.runId')=json_extract(NEW.context_json,'$.authority.credential.runId'))
THEN RAISE(ABORT,'us_triage_invalid_record') END;END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_ticket_worker_command_insert BEFORE INSERT ON international_us_support_ticket_commands
WHEN json_extract(NEW.context_json,'$.authority.credential.kind')='worker' BEGIN
SELECT CASE WHEN NEW.action<>'create' OR NOT EXISTS(
SELECT 1 FROM international_us_support_triage_jobs j JOIN international_us_support_triage_completions x ON x.organization_id=j.organization_id AND x.workspace_id=j.workspace_id AND x.job_id=j.id
JOIN international_us_support_worker_discovered source ON source.organization_id=j.organization_id AND source.workspace_id=j.workspace_id AND source.provider=json_extract(j.source_json,'$.provider') AND source.mailbox_id=json_extract(j.source_json,'$.mailboxId') AND source.folder_id=json_extract(j.source_json,'$.folderId') AND source.uid=json_extract(j.source_json,'$.uid')
JOIN international_us_support_worker_stages p ON p.organization_id=source.organization_id AND p.workspace_id=source.workspace_id AND p.discovery_id=source.id AND p.stage='prepared'
JOIN international_us_support_worker_delegations d ON d.organization_id=j.organization_id AND d.workspace_id=j.workspace_id AND d.delegation_id=json_extract(NEW.context_json,'$.authority.credential.delegationId') AND d.revision=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
JOIN international_us_support_mailbox_connections c ON c.organization_id=d.organization_id AND c.workspace_id=d.workspace_id AND c.connection_id=json_extract(d.snapshot_json,'$.connectionId') AND c.revision=json_extract(d.snapshot_json,'$.mailboxRevision')
WHERE j.organization_id=NEW.organization_id AND j.workspace_id=NEW.workspace_id AND j.id=NEW.job_id AND j.source_hash=NEW.source_hash
AND c.provider=source.provider AND c.mailbox_id=source.mailbox_id AND c.folder_id=source.folder_id
AND json_extract(p.request_json,'$.requestId')=source.request_id AND json_extract(p.request_json,'$.uid')=source.uid
AND json_extract(p.request_json,'$.expectedMessageVersion')=json_extract(j.source_json,'$.messageVersion')
AND json_extract(p.request_json,'$.processingPolicyVersion')=json_extract(d.snapshot_json,'$.processingPolicyVersion'))
THEN RAISE(ABORT,'us_ticket_forbidden') END;END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_delegation_no_replace BEFORE INSERT ON international_us_support_worker_delegations WHEN EXISTS(SELECT 1 FROM international_us_support_worker_delegations WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND revision=NEW.revision OR organization_id=NEW.organization_id AND actor_user_id=NEW.actor_user_id AND request_id=NEW.request_id) BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_run_no_replace BEFORE INSERT ON international_us_support_worker_runs WHEN EXISTS(SELECT 1 FROM international_us_support_worker_runs WHERE run_id=NEW.run_id) BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_finish_no_replace BEFORE INSERT ON international_us_support_worker_finishes WHEN EXISTS(SELECT 1 FROM international_us_support_worker_finishes WHERE run_id=NEW.run_id) BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_page_no_replace BEFORE INSERT ON international_us_support_worker_pages WHEN EXISTS(SELECT 1 FROM international_us_support_worker_pages WHERE page_id=NEW.page_id OR run_id=NEW.run_id AND offset=NEW.offset AND head_only=NEW.head_only) BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_discovery_no_replace BEFORE INSERT ON international_us_support_worker_discovered WHEN EXISTS(SELECT 1 FROM international_us_support_worker_discovered WHERE id=NEW.id OR organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND (request_id=NEW.request_id OR provider=NEW.provider AND mailbox_id=NEW.mailbox_id AND folder_id=NEW.folder_id AND uid=NEW.uid)) BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_stage_no_replace BEFORE INSERT ON international_us_support_worker_stages WHEN EXISTS(SELECT 1 FROM international_us_support_worker_stages WHERE stage_id=NEW.stage_id OR organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND discovery_id=NEW.discovery_id AND stage=NEW.stage) BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_issue_no_replace BEFORE INSERT ON international_us_support_worker_issues WHEN EXISTS(SELECT 1 FROM international_us_support_worker_issues WHERE issue_id=NEW.issue_id OR organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND fingerprint=NEW.fingerprint) BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_delegations_no_update BEFORE UPDATE ON international_us_support_worker_delegations BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_delegations_no_delete BEFORE DELETE ON international_us_support_worker_delegations BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_runs_no_update BEFORE UPDATE ON international_us_support_worker_runs BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_runs_no_delete BEFORE DELETE ON international_us_support_worker_runs BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_finishes_no_update BEFORE UPDATE ON international_us_support_worker_finishes BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_finishes_no_delete BEFORE DELETE ON international_us_support_worker_finishes BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_pages_no_update BEFORE UPDATE ON international_us_support_worker_pages BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_pages_no_delete BEFORE DELETE ON international_us_support_worker_pages BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_discovered_no_update BEFORE UPDATE ON international_us_support_worker_discovered BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_discovered_no_delete BEFORE DELETE ON international_us_support_worker_discovered BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_stages_no_update BEFORE UPDATE ON international_us_support_worker_stages BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_stages_no_delete BEFORE DELETE ON international_us_support_worker_stages BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_issues_no_update BEFORE UPDATE ON international_us_support_worker_issues BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_issues_no_delete BEFORE DELETE ON international_us_support_worker_issues BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_head_no_delete BEFORE DELETE ON international_us_support_worker_heads BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;

--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_page_proofs AFTER INSERT ON international_us_support_worker_pages BEGIN
INSERT INTO international_us_support_worker_reference_proofs(organization_id,workspace_id,run_id,uid,created_at,page_id,discovery_id)
SELECT DISTINCT source.organization_id,source.workspace_id,NEW.run_id,source.uid,NEW.created_at,NEW.page_id,source.id
FROM international_us_support_worker_discovered source JOIN json_each(NEW.page_json,'$.references') ref ON source.uid=json_extract(ref.value,'$.uid')
WHERE source.organization_id=NEW.organization_id AND source.workspace_id=NEW.workspace_id AND source.created_run_id=NEW.run_id AND source.created_at=NEW.created_at
AND NOT EXISTS(SELECT 1 FROM international_us_support_worker_reference_proofs p WHERE p.organization_id=source.organization_id AND p.workspace_id=source.workspace_id AND p.run_id=NEW.run_id AND p.uid=source.uid AND p.created_at=NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_proof_insert BEFORE INSERT ON international_us_support_worker_reference_proofs BEGIN
SELECT CASE WHEN EXISTS(SELECT 1 FROM international_us_support_worker_reference_proofs WHERE organization_id=NEW.organization_id AND workspace_id=NEW.workspace_id AND run_id=NEW.run_id AND uid=NEW.uid AND created_at=NEW.created_at)
OR NOT EXISTS(SELECT 1 FROM international_us_support_worker_pages page JOIN json_each(page.page_json,'$.references') ref
JOIN international_us_support_worker_discovered source ON source.organization_id=page.organization_id AND source.workspace_id=page.workspace_id AND source.created_run_id=page.run_id AND source.created_at=page.created_at AND source.uid=json_extract(ref.value,'$.uid')
WHERE page.page_id=NEW.page_id AND page.run_id=NEW.run_id AND page.organization_id=NEW.organization_id AND page.workspace_id=NEW.workspace_id AND page.created_at=NEW.created_at AND source.id=NEW.discovery_id AND source.uid=NEW.uid)
THEN RAISE(ABORT,'us_worker_invalid_record') END;END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_proof_no_update BEFORE UPDATE ON international_us_support_worker_reference_proofs BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_proof_no_delete BEFORE DELETE ON international_us_support_worker_reference_proofs BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;

--> statement-breakpoint
-- A retry delay is an immutable observation, never a terminal stage or classifier claim.
CREATE TABLE international_us_support_worker_deferrals(
run_id TEXT NOT NULL,organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,discovery_id TEXT NOT NULL,
code TEXT NOT NULL CHECK(length(code)BETWEEN 1 AND 128 AND code NOT GLOB '*[^A-Za-z0-9._:-]*'),
context_json TEXT NOT NULL CHECK(json_valid(context_json)AND json_type(context_json)='object'AND length(CAST(context_json AS BLOB))<=16384),
created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer'AND created_at BETWEEN 1 AND 253402300799),
PRIMARY KEY(run_id,discovery_id),FOREIGN KEY(organization_id,workspace_id,run_id) REFERENCES international_us_support_worker_runs(organization_id,workspace_id,run_id),
FOREIGN KEY(organization_id,workspace_id,discovery_id) REFERENCES international_us_support_worker_discovered(organization_id,workspace_id,id));
--> statement-breakpoint
CREATE INDEX international_us_support_worker_deferrals_discovery ON international_us_support_worker_deferrals(discovery_id,created_at);
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_deferral_insert BEFORE INSERT ON international_us_support_worker_deferrals BEGIN
SELECT CASE WHEN NEW.created_at>unixepoch() OR NEW.created_at<unixepoch()-30 OR NOT COALESCE((SELECT count(*) FROM json_each(NEW.context_json))=3 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json) WHERE key NOT IN('schemaVersion','authority','workspaceId'))
AND json_extract(NEW.context_json,'$.schemaVersion')=1 AND json_type(NEW.context_json,'$.schemaVersion')='integer'
AND json_extract(NEW.context_json,'$.workspaceId')=NEW.workspace_id
AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority'))=15
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority') WHERE key NOT IN('schemaVersion','organizationId','userId','role','ownerUserId','subscriptionId','environment','catalogVersion','priceId','authorityReference','validStartsAt','validEndsAt','seatLimit','checkedAt','credential'))
AND json_extract(NEW.context_json,'$.authority.schemaVersion')=1 AND json_type(NEW.context_json,'$.authority.schemaVersion')='integer'
AND json_extract(NEW.context_json,'$.authority.organizationId')=NEW.organization_id
AND json_extract(NEW.context_json,'$.authority.checkedAt')=NEW.created_at AND json_type(NEW.context_json,'$.authority.checkedAt')='integer'
AND json_type(NEW.context_json,'$.authority.validStartsAt')='integer' AND json_type(NEW.context_json,'$.authority.validEndsAt')='integer'
AND json_type(NEW.context_json,'$.authority.seatLimit')='integer' AND NOT EXISTS(SELECT 1 FROM json_tree(NEW.context_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1) AND json_extract(NEW.context_json,'$.authority.credential.kind')='worker'
AND (SELECT count(*) FROM json_each(NEW.context_json,'$.authority.credential'))=5
AND NOT EXISTS(SELECT 1 FROM json_each(NEW.context_json,'$.authority.credential') WHERE key NOT IN('kind','workerId','delegationId','delegationRevision','runId'))
AND json_type(NEW.context_json,'$.authority.credential.delegationRevision')='integer'
AND EXISTS(SELECT 1 FROM international_us_support_worker_admissible w WHERE w.organization_id=NEW.organization_id AND w.workspace_id=NEW.workspace_id
AND w.user_id=json_extract(NEW.context_json,'$.authority.userId') AND w.role=json_extract(NEW.context_json,'$.authority.role')
AND w.run_id=json_extract(NEW.context_json,'$.authority.credential.runId') AND w.worker_id=json_extract(NEW.context_json,'$.authority.credential.workerId')
AND w.delegation_id=json_extract(NEW.context_json,'$.authority.credential.delegationId') AND w.delegation_revision=json_extract(NEW.context_json,'$.authority.credential.delegationRevision')
AND w.owner_user_id=json_extract(NEW.context_json,'$.authority.ownerUserId') AND w.subscription_id=json_extract(NEW.context_json,'$.authority.subscriptionId')
AND w.environment=json_extract(NEW.context_json,'$.authority.environment') AND w.catalog_version=json_extract(NEW.context_json,'$.authority.catalogVersion')
AND w.price_id=json_extract(NEW.context_json,'$.authority.priceId') AND w.authority_reference=json_extract(NEW.context_json,'$.authority.authorityReference')
AND w.valid_starts_at=json_extract(NEW.context_json,'$.authority.validStartsAt') AND w.valid_ends_at=json_extract(NEW.context_json,'$.authority.validEndsAt')
AND w.seat_limit=json_extract(NEW.context_json,'$.authority.seatLimit'))
AND NEW.run_id=json_extract(NEW.context_json,'$.authority.credential.runId'),0) THEN RAISE(ABORT,'us_worker_revoked') END;
SELECT CASE WHEN NOT EXISTS(
SELECT 1 FROM international_us_support_worker_discovered source
JOIN international_us_support_worker_admissible w ON w.organization_id=source.organization_id AND w.workspace_id=source.workspace_id AND w.run_id=NEW.run_id
JOIN international_us_support_worker_delegations d ON d.organization_id=w.organization_id AND d.workspace_id=w.workspace_id AND d.delegation_id=w.delegation_id AND d.revision=w.delegation_revision
JOIN international_us_support_mailbox_connections c ON c.organization_id=w.organization_id AND c.workspace_id=w.workspace_id AND c.connection_id=json_extract(d.snapshot_json,'$.connectionId') AND c.revision=json_extract(d.snapshot_json,'$.mailboxRevision')
JOIN international_us_support_worker_reference_proofs proof ON proof.organization_id=source.organization_id AND proof.workspace_id=source.workspace_id AND proof.discovery_id=source.id AND proof.run_id=source.created_run_id AND proof.created_at=source.created_at AND proof.uid=source.uid
WHERE source.id=NEW.discovery_id AND source.organization_id=NEW.organization_id AND source.workspace_id=NEW.workspace_id AND source.created_at<=NEW.created_at
AND source.provider=c.provider AND source.mailbox_id=c.mailbox_id AND source.folder_id=c.folder_id)
OR EXISTS(SELECT 1 FROM international_us_support_worker_stages s WHERE s.organization_id=NEW.organization_id AND s.workspace_id=NEW.workspace_id AND s.discovery_id=NEW.discovery_id AND s.stage IN('ticketed','uncertain','rejected'))
THEN RAISE(ABORT,'us_worker_invalid_record') END;END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_deferral_no_replace BEFORE INSERT ON international_us_support_worker_deferrals WHEN EXISTS(SELECT 1 FROM international_us_support_worker_deferrals WHERE run_id=NEW.run_id AND discovery_id=NEW.discovery_id) BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_deferrals_no_update BEFORE UPDATE ON international_us_support_worker_deferrals BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
--> statement-breakpoint
CREATE TRIGGER international_us_support_worker_deferrals_no_delete BEFORE DELETE ON international_us_support_worker_deferrals BEGIN SELECT RAISE(ABORT,'us_worker_immutable');END;
