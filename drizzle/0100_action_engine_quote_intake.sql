-- Migration number: 0100 	 2026-10-10T23:57:20.695Z
-- Private preparation ownership only. No Support trigger or business write.
CREATE TABLE action_engine_quote_intake (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 160),
  organization_id TEXT NOT NULL CHECK(length(organization_id) BETWEEN 1 AND 160),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 160),
  action_kind TEXT NOT NULL CHECK(action_kind='prepare_quote_draft'),
  engine_version TEXT NOT NULL CHECK(engine_version='action-engine-quote-v1'),
  source_revision TEXT NOT NULL CHECK(length(source_revision) BETWEEN 1 AND 160),
  context_revision TEXT NOT NULL CHECK(length(context_revision) BETWEEN 1 AND 160),
  context_hash TEXT NOT NULL CHECK(length(context_hash)=64 AND context_hash NOT GLOB '*[^0-9a-f]*'),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json) AND json_type(input_json)='object' AND length(CAST(input_json AS BLOB))<=4096),
  state TEXT NOT NULL CHECK(state IN ('preparing','started','finished','uncertain')),
  owner_user_id TEXT NOT NULL CHECK(length(owner_user_id) BETWEEN 1 AND 160),
  owner_token TEXT NOT NULL CHECK(length(owner_token)=36 AND owner_token NOT GLOB '*[^0-9a-f-]*'),
  lease_until INTEGER NOT NULL CHECK(typeof(lease_until)='integer' AND lease_until BETWEEN 1 AND 253402300799),
  started_at INTEGER CHECK(started_at IS NULL OR (typeof(started_at)='integer' AND started_at BETWEEN created_at AND updated_at)),
  finished_at INTEGER CHECK(finished_at IS NULL OR (typeof(finished_at)='integer' AND finished_at BETWEEN created_at AND updated_at)),
  result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND json_type(result_json)='object' AND length(CAST(result_json AS BLOB))<=65536)),
  result_fingerprint TEXT CHECK(result_fingerprint IS NULL OR (length(result_fingerprint)=64 AND result_fingerprint NOT GLOB '*[^0-9a-f]*')),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN created_at AND 253402300799),
  CHECK(COALESCE(json_extract(input_json,'$.organizationId')=organization_id
    AND json_extract(input_json,'$.sourceId')=source_id
    AND json_extract(input_json,'$.kind')=action_kind
    AND json_extract(input_json,'$.engineVersion')=engine_version
    AND json_extract(input_json,'$.sourceRevision')=source_revision
    AND json_extract(input_json,'$.contextRevision')=context_revision
    AND json_extract(input_json,'$.contextHash')=context_hash
    AND json_remove(input_json,'$.organizationId','$.sourceId','$.kind','$.engineVersion','$.sourceRevision','$.contextRevision','$.contextHash')='{}',0)),
  CHECK((state='finished')=(result_json IS NOT NULL AND result_fingerprint IS NOT NULL AND finished_at IS NOT NULL)),
  CHECK(state='finished' OR (result_json IS NULL AND result_fingerprint IS NULL AND finished_at IS NULL)),
  CHECK((state IN ('started','uncertain'))=(started_at IS NOT NULL AND state<>'finished') OR state='finished'),
  CHECK(state<>'preparing' OR (started_at IS NULL AND lease_until>updated_at)),
  CHECK(result_json IS NULL OR COALESCE(
    json_extract(result_json,'$.schemaVersion')=1
    AND json_extract(result_json,'$.engineVersion')=engine_version
    AND json_extract(result_json,'$.kind')=action_kind
    AND json_extract(result_json,'$.organizationId')=organization_id
    AND json_extract(result_json,'$.sourceId')=source_id
    AND json_extract(result_json,'$.sourceRevision')=source_revision
    AND json_extract(result_json,'$.contextRevision')=context_revision
    AND json_extract(result_json,'$.status') IN ('ready','needs_review')
    AND json_type(result_json,'$.requiresHumanValidation')='true',0)),
  UNIQUE(organization_id,source_id,action_kind),
  UNIQUE(id,organization_id,input_hash)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE action_engine_quote_intake_events (
  id TEXT PRIMARY KEY NOT NULL,
  intake_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('claimed','started','finished','uncertain')),
  owner_token TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
  FOREIGN KEY(intake_id,organization_id,input_hash) REFERENCES action_engine_quote_intake(id,organization_id,input_hash),
  UNIQUE(intake_id,owner_token,event_type)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX action_engine_quote_intake_due ON action_engine_quote_intake(state,lease_until,updated_at,id);
--> statement-breakpoint
CREATE TRIGGER action_engine_intake_existing BEFORE INSERT ON action_engine_quote_intake
WHEN EXISTS(SELECT 1 FROM action_engine_quote_intake WHERE id=NEW.id OR
  (organization_id=NEW.organization_id AND source_id=NEW.source_id AND action_kind=NEW.action_kind))
BEGIN SELECT RAISE(ABORT,'action_engine_intake_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_intake_initial BEFORE INSERT ON action_engine_quote_intake
WHEN NEW.state<>'preparing' OR NEW.started_at IS NOT NULL OR NEW.result_json IS NOT NULL
BEGIN SELECT RAISE(ABORT,'action_engine_intake_transition'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_intake_update BEFORE UPDATE ON action_engine_quote_intake
WHEN NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.source_id IS NOT OLD.source_id
  OR NEW.action_kind IS NOT OLD.action_kind OR NEW.engine_version IS NOT OLD.engine_version
  OR NEW.source_revision IS NOT OLD.source_revision OR NEW.context_revision IS NOT OLD.context_revision
  OR NEW.context_hash IS NOT OLD.context_hash OR NEW.input_hash IS NOT OLD.input_hash OR NEW.input_json IS NOT OLD.input_json
  OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at<OLD.updated_at
  OR NOT (
    (OLD.state='preparing' AND NEW.state='preparing' AND NEW.owner_token IS NOT OLD.owner_token
      AND NEW.updated_at>=OLD.lease_until AND NEW.lease_until>NEW.updated_at
      AND NEW.started_at IS NULL)
    OR (OLD.state='preparing' AND NEW.state IN ('started','finished')
      AND NEW.owner_token IS OLD.owner_token AND NEW.owner_user_id IS OLD.owner_user_id
      AND NEW.lease_until IS OLD.lease_until AND NEW.updated_at<OLD.lease_until
      AND ((NEW.state='started' AND NEW.started_at=NEW.updated_at) OR (NEW.state='finished' AND NEW.started_at IS NULL)))
    OR (OLD.state='started' AND NEW.state IN ('finished','uncertain')
      AND NEW.owner_token IS OLD.owner_token AND NEW.owner_user_id IS OLD.owner_user_id
      AND NEW.lease_until IS OLD.lease_until AND NEW.started_at IS OLD.started_at)
  )
BEGIN SELECT RAISE(ABORT,'action_engine_intake_transition'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_intake_no_failed_result BEFORE UPDATE ON action_engine_quote_intake
WHEN NEW.result_json IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(NEW.result_json,'$.reasons') WHERE value='provider_unavailable')
BEGIN SELECT RAISE(ABORT,'action_engine_intake_invalid_result'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_intake_delete BEFORE DELETE ON action_engine_quote_intake
BEGIN SELECT RAISE(ABORT,'action_engine_intake_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_intake_event_existing BEFORE INSERT ON action_engine_quote_intake_events
WHEN EXISTS(SELECT 1 FROM action_engine_quote_intake_events WHERE id=NEW.id OR
  (intake_id=NEW.intake_id AND owner_token=NEW.owner_token AND event_type=NEW.event_type))
BEGIN SELECT RAISE(ABORT,'action_engine_intake_event_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_intake_event_source BEFORE INSERT ON action_engine_quote_intake_events
WHEN NOT EXISTS(SELECT 1 FROM action_engine_quote_intake i WHERE i.id=NEW.intake_id
  AND i.organization_id=NEW.organization_id AND i.input_hash=NEW.input_hash
  AND i.owner_token=NEW.owner_token AND i.owner_user_id=NEW.actor_user_id
  AND ((NEW.event_type='claimed' AND i.state='preparing') OR (NEW.event_type='started' AND i.state='started')
    OR (NEW.event_type='finished' AND i.state='finished') OR (NEW.event_type='uncertain' AND i.state='uncertain')))
BEGIN SELECT RAISE(ABORT,'action_engine_intake_event_source'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_intake_event_update BEFORE UPDATE ON action_engine_quote_intake_events
BEGIN SELECT RAISE(ABORT,'action_engine_intake_event_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER action_engine_intake_event_delete BEFORE DELETE ON action_engine_quote_intake_events
BEGIN SELECT RAISE(ABORT,'action_engine_intake_event_immutable'); END;
