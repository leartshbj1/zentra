-- Local housekeeping v1 only. Never changes PRAGMA user_version/shared schema62.
-- Transport links grant no creation/confirmation permission. Delete is allowed
-- for private archive stripping, joining and explicit local workspace reset.
CREATE TABLE IF NOT EXISTS company_local_action_engine_publication_schema (
  id INTEGER PRIMARY KEY CHECK(id=1),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version=1)
);
INSERT OR IGNORE INTO company_local_action_engine_publication_schema VALUES(1,1);

CREATE TABLE IF NOT EXISTS company_local_action_engine_quote_publications (
  organization_id TEXT NOT NULL CHECK(typeof(organization_id)='text' AND length(organization_id) BETWEEN 1 AND 160),
  source_id TEXT NOT NULL CHECK(typeof(source_id)='text' AND length(source_id) BETWEEN 1 AND 160),
  action_kind TEXT NOT NULL CHECK(action_kind='prepare_quote_draft'),
  proposal_id TEXT NOT NULL CHECK(typeof(proposal_id)='text' AND length(proposal_id) BETWEEN 1 AND 160),
  reservation_id TEXT NOT NULL CHECK(typeof(reservation_id)='text' AND length(reservation_id)=36),
  fingerprint TEXT NOT NULL CHECK(typeof(fingerprint)='text' AND length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  actor_user_id TEXT NOT NULL CHECK(typeof(actor_user_id)='text' AND length(actor_user_id) BETWEEN 1 AND 160),
  installation_id TEXT NOT NULL CHECK(typeof(installation_id)='text' AND length(installation_id)=36),
  customer_id TEXT NOT NULL CHECK(typeof(customer_id)='text' AND length(customer_id) BETWEEN 1 AND 160),
  quote_id TEXT NOT NULL CHECK(typeof(quote_id)='text' AND length(quote_id)=36),
  receipt_sha256 TEXT NOT NULL CHECK(typeof(receipt_sha256)='text' AND length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  snapshot_id TEXT NOT NULL CHECK(typeof(snapshot_id)='text' AND length(snapshot_id)=36
    AND substr(snapshot_id,9,1)='-' AND substr(snapshot_id,14,1)='-' AND substr(snapshot_id,19,1)='-' AND substr(snapshot_id,24,1)='-'
    AND substr(snapshot_id,15,1)='4' AND substr(snapshot_id,20,1) IN ('8','9','a','b')
    AND length(replace(snapshot_id,'-',''))=32 AND replace(snapshot_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  base_revision INTEGER NOT NULL CHECK(typeof(base_revision)='integer' AND base_revision BETWEEN 0 AND 9007199254740990),
  archive_sha256 TEXT NOT NULL CHECK(typeof(archive_sha256)='text' AND length(archive_sha256)=64 AND archive_sha256 NOT GLOB '*[^0-9a-f]*'),
  manifest_sha256 TEXT NOT NULL CHECK(typeof(manifest_sha256)='text' AND length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  manifest_json TEXT NOT NULL CHECK(typeof(manifest_json)='text' AND length(CAST(manifest_json AS BLOB))<=65536
    AND json_valid(manifest_json) AND json_type(manifest_json)='object'),
  size_bytes INTEGER NOT NULL CHECK(typeof(size_bytes)='integer' AND size_bytes BETWEEN 1 AND 536870912),
  local_clock INTEGER NOT NULL CHECK(typeof(local_clock)='integer' AND local_clock BETWEEN 0 AND 9007199254740991),
  created_at TEXT NOT NULL CHECK(typeof(created_at)='text' AND length(created_at) BETWEEN 20 AND 40),
  published_revision INTEGER CHECK(published_revision IS NULL OR (typeof(published_revision)='integer' AND published_revision=base_revision+1)),
  published_at TEXT CHECK(published_at IS NULL OR (typeof(published_at)='text' AND length(published_at) BETWEEN 20 AND 40 AND published_at>=created_at)),
  PRIMARY KEY(organization_id,proposal_id,snapshot_id),
  UNIQUE(organization_id,reservation_id,snapshot_id),
  UNIQUE(organization_id,quote_id,snapshot_id),
  FOREIGN KEY(organization_id,proposal_id) REFERENCES company_local_action_engine_quote_outbox(organization_id,proposal_id),
  CHECK((published_revision IS NULL)=(published_at IS NULL)),
  CHECK(COALESCE(json_extract(manifest_json,'$.format')='zentra-cloud-backup'
    AND json_type(manifest_json,'$.version')='integer' AND json_extract(manifest_json,'$.version')=1
    AND json_type(manifest_json,'$.app_version')='text' AND length(json_extract(manifest_json,'$.app_version')) BETWEEN 1 AND 60
    AND json_type(manifest_json,'$.sha256')='text' AND json_extract(manifest_json,'$.sha256')=archive_sha256
    AND json_type(manifest_json,'$.size_bytes')='integer' AND json_extract(manifest_json,'$.size_bytes')=size_bytes
    AND json_type(manifest_json,'$.chunks')='array' AND json_array_length(manifest_json,'$.chunks') BETWEEN 1 AND 64,0))
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS company_local_action_quote_publication_snapshot
  ON company_local_action_engine_quote_publications(organization_id,snapshot_id);

CREATE TRIGGER IF NOT EXISTS company_local_action_quote_publication_insert
BEFORE INSERT ON company_local_action_engine_quote_publications BEGIN
  -- Covers OR REPLACE/OR IGNORE before either can suppress identity conflicts.
  SELECT CASE WHEN EXISTS(SELECT 1 FROM company_local_action_engine_quote_publications
    WHERE organization_id=NEW.organization_id AND snapshot_id=NEW.snapshot_id
      AND (proposal_id=NEW.proposal_id OR reservation_id=NEW.reservation_id OR quote_id=NEW.quote_id))
    THEN RAISE(ABORT,'action_quote_publication_conflict') END;
  SELECT CASE WHEN NEW.published_revision IS NOT NULL OR NEW.published_at IS NOT NULL
    OR (SELECT count(*) FROM json_each(NEW.manifest_json))<>6
    OR (SELECT count(DISTINCT key) FROM json_each(NEW.manifest_json))<>6
    OR EXISTS(SELECT 1 FROM json_each(NEW.manifest_json) WHERE key NOT IN ('format','version','app_version','sha256','size_bytes','chunks'))
    OR EXISTS(SELECT 1 FROM json_each(NEW.manifest_json,'$.chunks') chunk
      WHERE chunk.type<>'object' OR (SELECT count(*) FROM json_each(chunk.value))<>2
        OR (SELECT count(DISTINCT key) FROM json_each(chunk.value))<>2
        OR EXISTS(SELECT 1 FROM json_each(chunk.value) WHERE key NOT IN ('sha256','size_bytes'))
        OR COALESCE(json_type(chunk.value,'$.sha256')<>'text' OR length(json_extract(chunk.value,'$.sha256'))<>64
          OR json_extract(chunk.value,'$.sha256') GLOB '*[^0-9a-f]*',1)
        OR COALESCE(json_type(chunk.value,'$.size_bytes')<>'integer' OR json_extract(chunk.value,'$.size_bytes') NOT BETWEEN 1 AND 8388608,1)
        OR (chunk.key<json_array_length(NEW.manifest_json,'$.chunks')-1 AND json_extract(chunk.value,'$.size_bytes')<>8388608))
    OR (SELECT sum(json_extract(value,'$.size_bytes')) FROM json_each(NEW.manifest_json,'$.chunks'))<>NEW.size_bytes
    THEN RAISE(ABORT,'action_quote_publication_invalid') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM company_local_action_engine_quote_outbox o
    JOIN action_engine_quote_receipts r ON r.organization_id=o.organization_id AND r.proposal_id=o.proposal_id
    WHERE o.organization_id=NEW.organization_id AND o.proposal_id=NEW.proposal_id
      AND o.quote_id=NEW.quote_id AND o.fingerprint=NEW.fingerprint
      AND r.source_id=NEW.source_id AND r.action_kind=NEW.action_kind
      AND r.reservation_id=NEW.reservation_id AND r.fingerprint=NEW.fingerprint
      AND r.actor_user_id=NEW.actor_user_id AND r.installation_id=NEW.installation_id
      AND r.customer_id=NEW.customer_id AND r.quote_id=NEW.quote_id AND r.receipt_sha256=NEW.receipt_sha256
      AND json_extract(o.payload_json,'$.reservationId')=NEW.reservation_id
      AND json_extract(o.payload_json,'$.customerId')=NEW.customer_id
      AND json_extract(o.payload_json,'$.receiptSha256')=NEW.receipt_sha256)
    THEN RAISE(ABORT,'action_quote_publication_receipt') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM company_local_action_engine_quote_publications
    WHERE organization_id=NEW.organization_id AND snapshot_id=NEW.snapshot_id
      AND (base_revision IS NOT NEW.base_revision OR archive_sha256 IS NOT NEW.archive_sha256
        OR manifest_sha256 IS NOT NEW.manifest_sha256 OR manifest_json IS NOT NEW.manifest_json
        OR size_bytes IS NOT NEW.size_bytes OR local_clock IS NOT NEW.local_clock))
    THEN RAISE(ABORT,'action_quote_publication_snapshot_conflict') END;
END;
CREATE TRIGGER IF NOT EXISTS company_local_action_quote_publication_update
BEFORE UPDATE ON company_local_action_engine_quote_publications
WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.source_id IS NOT OLD.source_id
  OR NEW.action_kind IS NOT OLD.action_kind OR NEW.proposal_id IS NOT OLD.proposal_id
  OR NEW.reservation_id IS NOT OLD.reservation_id OR NEW.fingerprint IS NOT OLD.fingerprint
  OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.installation_id IS NOT OLD.installation_id
  OR NEW.customer_id IS NOT OLD.customer_id OR NEW.quote_id IS NOT OLD.quote_id
  OR NEW.receipt_sha256 IS NOT OLD.receipt_sha256 OR NEW.snapshot_id IS NOT OLD.snapshot_id
  OR NEW.base_revision IS NOT OLD.base_revision OR NEW.archive_sha256 IS NOT OLD.archive_sha256
  OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256 OR NEW.manifest_json IS NOT OLD.manifest_json
  OR NEW.size_bytes IS NOT OLD.size_bytes OR NEW.local_clock IS NOT OLD.local_clock OR NEW.created_at IS NOT OLD.created_at
  OR NEW.published_revision IS NULL OR NEW.published_revision<>OLD.base_revision+1
  OR NEW.published_at IS NULL OR NEW.published_at<OLD.created_at
  OR (OLD.published_revision IS NOT NULL AND (NEW.published_revision IS NOT OLD.published_revision OR NEW.published_at IS NOT OLD.published_at))
BEGIN SELECT RAISE(ABORT,'action_quote_publication_immutable'); END;
