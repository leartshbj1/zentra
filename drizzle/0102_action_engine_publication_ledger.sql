-- Migration number: 0102 	 2026-10-11T01:17:47.158Z
-- Private transport witness only. PostgreSQL outcomes and current permissions
-- must be corroborated by the server caller; this table grants no authority.
CREATE TABLE action_engine_publication_attempts (
  id TEXT PRIMARY KEY NOT NULL CHECK (typeof(id)='text' AND length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND substr(id,15,1)='4' AND substr(id,20,1) IN ('8','9','a','b') AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'),
  organization_id TEXT NOT NULL CHECK (typeof(organization_id)='text' AND length(organization_id) BETWEEN 1 AND 160 AND substr(organization_id,1,1) GLOB '[A-Za-z0-9]' AND organization_id NOT GLOB '*[^A-Za-z0-9_.:@-]*'),
  snapshot_id TEXT NOT NULL CHECK (typeof(snapshot_id)='text' AND length(snapshot_id)=36 AND substr(snapshot_id,9,1)='-' AND substr(snapshot_id,14,1)='-' AND substr(snapshot_id,19,1)='-' AND substr(snapshot_id,24,1)='-' AND substr(snapshot_id,15,1)='4' AND substr(snapshot_id,20,1) IN ('8','9','a','b') AND length(replace(snapshot_id,'-',''))=32 AND replace(snapshot_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  installation_id TEXT NOT NULL CHECK (typeof(installation_id)='text' AND length(installation_id)=36 AND substr(installation_id,9,1)='-' AND substr(installation_id,14,1)='-' AND substr(installation_id,19,1)='-' AND substr(installation_id,24,1)='-' AND substr(installation_id,15,1)='4' AND substr(installation_id,20,1) IN ('8','9','a','b') AND length(replace(installation_id,'-',''))=32 AND replace(installation_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL CHECK (typeof(user_id)='text' AND length(user_id) BETWEEN 1 AND 160 AND substr(user_id,1,1) GLOB '[A-Za-z0-9]' AND user_id NOT GLOB '*[^A-Za-z0-9_.:@-]*'),
  base_revision INTEGER NOT NULL CHECK (typeof(base_revision)='integer' AND base_revision BETWEEN 0 AND 9007199254740990),
  archive_sha256 TEXT NOT NULL CHECK (typeof(archive_sha256)='text' AND length(archive_sha256)=64 AND archive_sha256 NOT GLOB '*[^0-9a-f]*'),
  manifest_sha256 TEXT NOT NULL CHECK (typeof(manifest_sha256)='text' AND length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER NOT NULL CHECK (typeof(size_bytes)='integer' AND size_bytes BETWEEN 1 AND 536870912),
  state TEXT NOT NULL CHECK (state IN ('pending','committed','cancelled')),
  result_json TEXT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
  settled_at INTEGER CHECK (settled_at IS NULL OR (typeof(settled_at)='integer' AND settled_at BETWEEN created_at AND 253402300799)),
  CHECK (
    (state='pending' AND result_json IS NULL AND settled_at IS NULL)
    OR
    (state IN ('committed','cancelled') AND settled_at IS NOT NULL AND result_json IS NOT NULL
      AND typeof(result_json)='text' AND length(result_json)<=1024 AND json_valid(result_json)
      AND json_type(result_json)='object'
      AND json_type(result_json,'$.committed') IN ('true','false')
      AND json_type(result_json,'$.revision')='integer'
      AND json_extract(result_json,'$.revision') BETWEEN 0 AND 9007199254740991
      AND (
        (json_extract(result_json,'$.revision')=0 AND json_type(result_json,'$.snapshotId')='null')
        OR (json_extract(result_json,'$.revision')>0 AND json_type(result_json,'$.snapshotId')='text'
          AND (typeof(json_extract(result_json,'$.snapshotId'))='text' AND length(json_extract(result_json,'$.snapshotId'))=36 AND substr(json_extract(result_json,'$.snapshotId'),9,1)='-' AND substr(json_extract(result_json,'$.snapshotId'),14,1)='-' AND substr(json_extract(result_json,'$.snapshotId'),19,1)='-' AND substr(json_extract(result_json,'$.snapshotId'),24,1)='-' AND substr(json_extract(result_json,'$.snapshotId'),15,1)='4' AND substr(json_extract(result_json,'$.snapshotId'),20,1) IN ('8','9','a','b') AND length(replace(json_extract(result_json,'$.snapshotId'),'-',''))=32 AND replace(json_extract(result_json,'$.snapshotId'),'-','') NOT GLOB '*[^0-9a-f]*'))
      )
      AND (
        (state='committed' AND json_extract(result_json,'$.committed')=1
          AND json_extract(result_json,'$.revision')=base_revision+1
          AND json_extract(result_json,'$.snapshotId')=snapshot_id)
        OR (state='cancelled' AND json_extract(result_json,'$.committed')=0
          AND json_extract(result_json,'$.revision')>=base_revision
          AND json_extract(result_json,'$.snapshotId') IS NOT snapshot_id)
      )
    )
  )
) WITHOUT ROWID;
CREATE UNIQUE INDEX action_engine_publication_snapshot
  ON action_engine_publication_attempts(organization_id,snapshot_id);
CREATE UNIQUE INDEX action_engine_publication_pending
  ON action_engine_publication_attempts(organization_id) WHERE state='pending';
CREATE UNIQUE INDEX action_engine_publication_committed_revision
  ON action_engine_publication_attempts(organization_id,json_extract(result_json,'$.revision')) WHERE state='committed';
CREATE INDEX action_engine_publication_company
  ON action_engine_publication_attempts(organization_id,created_at,id);

-- Explicit BEFORE guards also reject REPLACE and IGNORE; neither may erase or
-- silently suppress historical identity collisions.
CREATE TRIGGER action_engine_publication_insert
BEFORE INSERT ON action_engine_publication_attempts BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM action_engine_publication_attempts
    WHERE id=NEW.id OR (organization_id=NEW.organization_id AND snapshot_id=NEW.snapshot_id)
      OR (organization_id=NEW.organization_id AND state='pending'))
    THEN RAISE(ABORT,'action_engine_publication_conflict') END;
  SELECT CASE WHEN NEW.state IS NOT 'pending' OR NEW.result_json IS NOT NULL OR NEW.settled_at IS NOT NULL
    THEN RAISE(ABORT,'action_engine_publication_invalid') END;
END;
CREATE TRIGGER action_engine_publication_update
BEFORE UPDATE ON action_engine_publication_attempts BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id
    OR NEW.organization_id IS NOT OLD.organization_id
    OR NEW.snapshot_id IS NOT OLD.snapshot_id
    OR NEW.installation_id IS NOT OLD.installation_id
    OR NEW.user_id IS NOT OLD.user_id
    OR NEW.base_revision IS NOT OLD.base_revision
    OR NEW.archive_sha256 IS NOT OLD.archive_sha256
    OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
    OR NEW.size_bytes IS NOT OLD.size_bytes
    OR NEW.created_at IS NOT OLD.created_at
    OR OLD.state<>'pending' OR NEW.state NOT IN ('committed','cancelled')
    OR NEW.result_json IS NULL OR NEW.settled_at IS NULL
    THEN RAISE(ABORT,'action_engine_publication_immutable') END;
  SELECT CASE WHEN NOT json_valid(NEW.result_json)
    THEN RAISE(ABORT,'action_engine_publication_invalid') END;
  SELECT CASE WHEN (SELECT count(*) FROM json_each(NEW.result_json))<>3
    OR (SELECT count(*) FROM json_each(NEW.result_json) WHERE key='committed')<>1
    OR (SELECT count(*) FROM json_each(NEW.result_json) WHERE key='revision')<>1
    OR (SELECT count(*) FROM json_each(NEW.result_json) WHERE key='snapshotId')<>1
    THEN RAISE(ABORT,'action_engine_publication_invalid') END;
  SELECT CASE WHEN NEW.state='committed' AND EXISTS(
    SELECT 1 FROM action_engine_publication_attempts
    WHERE organization_id=NEW.organization_id AND state='committed'
      AND json_extract(result_json,'$.revision')=json_extract(NEW.result_json,'$.revision'))
    THEN RAISE(ABORT,'action_engine_publication_conflict') END;
END;
CREATE TRIGGER action_engine_publication_delete
BEFORE DELETE ON action_engine_publication_attempts BEGIN
  SELECT RAISE(ABORT,'action_engine_publication_immutable');
END;

-- Metadata only: no message body, catalogue prices, credentials or tokens.
CREATE TABLE action_engine_publication_events (
  attempt_id TEXT NOT NULL REFERENCES action_engine_publication_attempts(id),
  organization_id TEXT NOT NULL CHECK (typeof(organization_id)='text' AND length(organization_id) BETWEEN 1 AND 160 AND substr(organization_id,1,1) GLOB '[A-Za-z0-9]' AND organization_id NOT GLOB '*[^A-Za-z0-9_.:@-]*'),
  event_type TEXT NOT NULL CHECK (event_type IN ('pending','committed','cancelled')),
  created_at INTEGER NOT NULL CHECK (typeof(created_at)='integer' AND created_at BETWEEN 1 AND 253402300799),
  PRIMARY KEY(attempt_id,event_type)
) WITHOUT ROWID;
CREATE INDEX action_engine_publication_events_company
  ON action_engine_publication_events(organization_id,created_at,attempt_id);
CREATE TRIGGER action_engine_publication_event_insert
BEFORE INSERT ON action_engine_publication_events BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM action_engine_publication_events
    WHERE attempt_id=NEW.attempt_id AND event_type=NEW.event_type)
    THEN RAISE(ABORT,'action_engine_publication_immutable') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM action_engine_publication_attempts
    WHERE id=NEW.attempt_id AND organization_id=NEW.organization_id AND state=NEW.event_type
      AND (CASE WHEN NEW.event_type='pending' THEN created_at ELSE settled_at END)=NEW.created_at)
    THEN RAISE(ABORT,'action_engine_publication_invalid') END;
END;
CREATE TRIGGER action_engine_publication_event_update
BEFORE UPDATE ON action_engine_publication_events BEGIN
  SELECT RAISE(ABORT,'action_engine_publication_immutable');
END;
CREATE TRIGGER action_engine_publication_event_delete
BEFORE DELETE ON action_engine_publication_events BEGIN
  SELECT RAISE(ABORT,'action_engine_publication_immutable');
END;
CREATE TRIGGER action_engine_publication_created
AFTER INSERT ON action_engine_publication_attempts BEGIN
  INSERT INTO action_engine_publication_events(attempt_id,organization_id,event_type,created_at)
    VALUES(NEW.id,NEW.organization_id,'pending',NEW.created_at);
END;
CREATE TRIGGER action_engine_publication_settled
AFTER UPDATE OF state ON action_engine_publication_attempts BEGIN
  INSERT INTO action_engine_publication_events(attempt_id,organization_id,event_type,created_at)
    VALUES(NEW.id,NEW.organization_id,NEW.state,NEW.settled_at);
END;
