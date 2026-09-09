-- Device-private application journal. No row is published as business data.
-- The installer must persist a verified proposal before dispatching retirement.
CREATE TABLE IF NOT EXISTS business_sync_resolution_intent (
  id INTEGER PRIMARY KEY CHECK(id=1),
  resolution_id TEXT NOT NULL UNIQUE,
  proposal_sha256 TEXT NOT NULL CHECK(length(proposal_sha256)=64 AND proposal_sha256 NOT GLOB '*[^0-9a-f]*'),
  intent_json TEXT NOT NULL CHECK(json_valid(intent_json) AND json_type(intent_json)='object'),
  intent_sha256 TEXT NOT NULL CHECK(length(intent_sha256)=64 AND intent_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('prepared','retiring','retired')),
  retirement_json TEXT CHECK(retirement_json IS NULL OR (json_valid(retirement_json) AND json_type(retirement_json)='object')),
  retirement_sha256 TEXT CHECK(retirement_sha256 IS NULL OR (length(retirement_sha256)=64 AND retirement_sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK((state='retired' AND retirement_json IS NOT NULL AND retirement_sha256 IS NOT NULL)
     OR (state IN ('prepared','retiring') AND retirement_json IS NULL AND retirement_sha256 IS NULL)),
  CHECK(json_extract(intent_json,'$.resolution_id') IS resolution_id),
  CHECK(json_extract(intent_json,'$.proposal_sha256') IS proposal_sha256)
);

CREATE TABLE IF NOT EXISTS business_sync_resolutions (
  resolution_id TEXT PRIMARY KEY NOT NULL,
  intent_json TEXT NOT NULL CHECK(json_valid(intent_json) AND json_type(intent_json)='object'),
  intent_sha256 TEXT NOT NULL CHECK(length(intent_sha256)=64 AND intent_sha256 NOT GLOB '*[^0-9a-f]*'),
  retirement_json TEXT NOT NULL CHECK(json_valid(retirement_json) AND json_type(retirement_json)='object'),
  retirement_sha256 TEXT NOT NULL CHECK(length(retirement_sha256)=64 AND retirement_sha256 NOT GLOB '*[^0-9a-f]*'),
  mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json) AND json_type(mapping_json)='object'),
  mapping_sha256 TEXT NOT NULL CHECK(length(mapping_sha256)=64 AND mapping_sha256 NOT GLOB '*[^0-9a-f]*'),
  installed_at TEXT NOT NULL,
  CHECK(json_extract(intent_json,'$.resolution_id') IS resolution_id),
  CHECK(json_extract(retirement_json,'$.resolution_id') IS resolution_id),
  CHECK(json_extract(mapping_json,'$.resolution_id') IS resolution_id),
  CHECK(json_extract(retirement_json,'$.retired') IS 1),
  CHECK(json_extract(retirement_json,'$.transaction_acknowledged') IS 0),
  CHECK(json_extract(retirement_json,'$.business_revision_changed') IS 0)
);

-- The captured write and all its trigger effects roll back together. This
-- remains effective in another process and after the application restarts.
CREATE TRIGGER IF NOT EXISTS zentra_resolution_write_guard
BEFORE INSERT ON business_sync_changes
WHEN EXISTS(SELECT 1 FROM business_sync_resolution_intent)
BEGIN
  SELECT RAISE(ABORT,'Une résolution de conflit est en cours. Reprenez son application avant de modifier le dossier.');
END;

CREATE TRIGGER IF NOT EXISTS business_sync_resolution_intent_insert_guard
BEFORE INSERT ON business_sync_resolution_intent
WHEN NEW.state<>'prepared'
 OR zentra_resolution_intent_valid(NEW.intent_json) IS NOT 1
 OR NEW.intent_sha256 IS NOT zentra_sha256(NEW.intent_json)
 OR (SELECT synchronous FROM pragma_synchronous)<>2
 OR EXISTS(SELECT 1 FROM business_sync_resolution_intent)
 OR EXISTS(SELECT 1 FROM business_sync_resolutions WHERE resolution_id=NEW.resolution_id)
 OR EXISTS(SELECT 1 FROM business_sync_publication_intent)
 OR NOT EXISTS(
   SELECT 1 FROM business_sync_binding b JOIN business_sync_baseline h ON h.id=b.id
   LEFT JOIN business_sync_cursor c ON c.id=b.id
   WHERE b.capture_enabled=1 AND b.organization_id=json_extract(NEW.intent_json,'$.organization_id')
     AND b.installation_id=json_extract(NEW.intent_json,'$.installation_id')
     AND b.generation=json_extract(NEW.intent_json,'$.capture_generation')
     AND h.organization_id=b.organization_id AND h.server_generation=json_extract(NEW.intent_json,'$.generation')
     AND COALESCE(c.revision,1)=json_extract(NEW.intent_json,'$.source_revision')
     AND (c.id IS NULL OR (c.organization_id=b.organization_id AND c.generation=h.server_generation))
 )
BEGIN
  SELECT RAISE(ABORT,'La résolution ne correspond pas au dossier de travail.');
END;

CREATE TRIGGER IF NOT EXISTS business_sync_resolution_intent_update_guard
BEFORE UPDATE ON business_sync_resolution_intent
WHEN NEW.id IS NOT OLD.id OR NEW.resolution_id IS NOT OLD.resolution_id
 OR (SELECT synchronous FROM pragma_synchronous)<>2
 OR NEW.proposal_sha256 IS NOT OLD.proposal_sha256
 OR NEW.intent_json IS NOT OLD.intent_json OR NEW.intent_sha256 IS NOT OLD.intent_sha256
 OR NOT ((OLD.state='prepared' AND NEW.state='retiring')
      OR (OLD.state='retiring' AND NEW.state='retired')
      OR (NEW.state=OLD.state AND NEW.retirement_json IS OLD.retirement_json AND NEW.retirement_sha256 IS OLD.retirement_sha256))
 OR (NEW.state='retired' AND (
      zentra_resolution_retirement_valid(NEW.intent_json,NEW.retirement_json) IS NOT 1
   OR
      NEW.retirement_sha256 IS NOT zentra_sha256(NEW.retirement_json)
   OR json_extract(NEW.retirement_json,'$.resolution_id') IS NOT NEW.resolution_id
   OR json_extract(NEW.retirement_json,'$.organization_id') IS NOT json_extract(OLD.intent_json,'$.organization_id')
   OR json_extract(NEW.retirement_json,'$.installation_id') IS NOT json_extract(OLD.intent_json,'$.installation_id')
   OR json_extract(NEW.retirement_json,'$.generation') IS NOT json_extract(OLD.intent_json,'$.generation')
   OR json_extract(NEW.retirement_json,'$.capture_generation') IS NOT json_extract(OLD.intent_json,'$.capture_generation')
   OR json_extract(NEW.retirement_json,'$.base_revision') IS NOT json_extract(OLD.intent_json,'$.base_revision')
   OR json_extract(NEW.retirement_json,'$.first_sequence') IS NOT json_extract(OLD.intent_json,'$.first_sequence')
   OR json_extract(NEW.retirement_json,'$.last_sequence') IS NOT json_extract(OLD.intent_json,'$.last_sequence')
   OR json_extract(NEW.retirement_json,'$.receipt_sha256') IS NOT json_extract(OLD.intent_json,'$.receipt_sha256')
   OR json_extract(NEW.retirement_json,'$.review_id') IS NOT json_extract(OLD.intent_json,'$.review_id')
   OR json_extract(NEW.retirement_json,'$.decision_sha256') IS NOT json_extract(OLD.intent_json,'$.decision_sha256')
   OR json_extract(NEW.retirement_json,'$.retired') IS NOT 1
   OR json_extract(NEW.retirement_json,'$.transaction_acknowledged') IS NOT 0
   OR json_extract(NEW.retirement_json,'$.business_revision_changed') IS NOT 0))
BEGIN
  SELECT RAISE(ABORT,'La preuve ou l’étape de résolution ne peut pas être remplacée.');
END;

-- A possibly dispatched request cannot be undone by a timeout, a missing GET
-- response, a sign-out, or an ordinary cancellation. Only installation releases
-- this fence once the exact intent and retirement evidence have been archived.
CREATE TRIGGER IF NOT EXISTS business_sync_resolution_intent_delete_guard
BEFORE DELETE ON business_sync_resolution_intent
WHEN OLD.state<>'prepared' AND NOT EXISTS(
  SELECT 1 FROM business_sync_resolutions r JOIN business_sync_binding b ON b.id=1
  WHERE r.resolution_id=OLD.resolution_id AND r.intent_json=OLD.intent_json
    AND r.intent_sha256=OLD.intent_sha256 AND r.retirement_json=OLD.retirement_json
    AND r.retirement_sha256=OLD.retirement_sha256
    AND b.generation=json_extract(r.intent_json,'$.replacement_capture_generation')
)
BEGIN
  SELECT RAISE(ABORT,'La réservation distante doit être reprise avant de libérer ce dossier.');
END;

CREATE TRIGGER IF NOT EXISTS business_sync_resolutions_insert_guard
BEFORE INSERT ON business_sync_resolutions
WHEN EXISTS(SELECT 1 FROM business_sync_resolutions WHERE resolution_id=NEW.resolution_id)
 OR zentra_resolution_retirement_valid(NEW.intent_json,NEW.retirement_json) IS NOT 1
 OR NEW.intent_sha256 IS NOT zentra_sha256(NEW.intent_json)
 OR NEW.retirement_sha256 IS NOT zentra_sha256(NEW.retirement_json)
 OR NEW.mapping_sha256 IS NOT zentra_sha256(NEW.mapping_json)
 OR NOT EXISTS(
  SELECT 1 FROM business_sync_binding b JOIN business_sync_installed_revisions r
    ON r.organization_id=b.organization_id
  WHERE b.id=1 AND b.capture_enabled=1
    AND b.installation_id=json_extract(NEW.intent_json,'$.installation_id')
    AND b.organization_id=json_extract(NEW.intent_json,'$.organization_id')
    AND b.generation=json_extract(NEW.intent_json,'$.replacement_capture_generation')
    AND r.generation=json_extract(NEW.intent_json,'$.generation')
    AND r.revision=json_extract(NEW.intent_json,'$.base_revision')
    AND r.transaction_id=json_extract(NEW.intent_json,'$.received_transaction_id')
    AND r.receipt_sha256=json_extract(NEW.intent_json,'$.receipt_sha256')
    AND r.receipt_sha256=zentra_sha256(r.receipt_json)
)
BEGIN
  SELECT RAISE(ABORT,'La résolution exige le reçu installé et son nouveau journal.');
END;
CREATE TRIGGER IF NOT EXISTS business_sync_resolutions_no_update BEFORE UPDATE ON business_sync_resolutions
BEGIN SELECT RAISE(ABORT,'La preuve de résolution installée est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS business_sync_resolutions_no_delete BEFORE DELETE ON business_sync_resolutions
BEGIN SELECT RAISE(ABORT,'La preuve de résolution installée est immuable.'); END;
