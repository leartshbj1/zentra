-- Preserve the decision to cancel across response loss and application restart.
ALTER TABLE business_sync_resolution_intent ADD COLUMN cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancellation_requested IN (0,1));

CREATE TABLE business_sync_resolution_cancellations (
  resolution_id TEXT PRIMARY KEY NOT NULL,
  intent_json TEXT NOT NULL CHECK(json_valid(intent_json) AND json_type(intent_json)='object'),
  intent_sha256 TEXT NOT NULL CHECK(length(intent_sha256)=64 AND intent_sha256 NOT GLOB '*[^0-9a-f]*'),
  cancellation_json TEXT NOT NULL CHECK(json_valid(cancellation_json) AND json_type(cancellation_json)='object'),
  cancellation_sha256 TEXT NOT NULL CHECK(length(cancellation_sha256)=64 AND cancellation_sha256 NOT GLOB '*[^0-9a-f]*'),
  cancelled_at TEXT NOT NULL,
  CHECK(json_extract(intent_json,'$.resolution_id') IS resolution_id),
  CHECK(json_extract(cancellation_json,'$.resolution_id') IS resolution_id)
);
CREATE TRIGGER business_sync_resolution_cancellation_requested_guard
BEFORE UPDATE ON business_sync_resolution_intent
WHEN NEW.cancellation_requested IS NOT OLD.cancellation_requested
 AND (NEW.cancellation_requested<>1 OR OLD.state='retired' OR NEW.state<>'retiring')
BEGIN SELECT RAISE(ABORT,'L’annulation demandée doit être reprise avant de résoudre ce dossier.'); END;
CREATE TRIGGER business_sync_resolution_cancellation_initial_guard
BEFORE INSERT ON business_sync_resolution_intent
WHEN NEW.cancellation_requested<>0 OR EXISTS(SELECT 1 FROM business_sync_resolution_cancellations WHERE resolution_id=NEW.resolution_id)
BEGIN SELECT RAISE(ABORT,'Cette résolution a été annulée. Préparez une nouvelle comparaison.'); END;
CREATE TRIGGER business_sync_resolution_cancelled_install_guard
BEFORE INSERT ON business_sync_resolutions
WHEN EXISTS(SELECT 1 FROM business_sync_resolution_cancellations WHERE resolution_id=NEW.resolution_id)
BEGIN SELECT RAISE(ABORT,'Une résolution annulée ne peut pas être installée.'); END;

CREATE TRIGGER business_sync_resolution_cancellations_insert_guard
BEFORE INSERT ON business_sync_resolution_cancellations
WHEN (SELECT synchronous FROM pragma_synchronous)<>2
 OR EXISTS(SELECT 1 FROM business_sync_resolution_cancellations WHERE resolution_id=NEW.resolution_id)
 OR EXISTS(SELECT 1 FROM business_sync_resolutions WHERE resolution_id=NEW.resolution_id)
 OR NEW.intent_sha256 IS NOT zentra_sha256(NEW.intent_json)
 OR NEW.cancellation_sha256 IS NOT zentra_sha256(NEW.cancellation_json)
 OR zentra_resolution_cancellation_valid(NEW.intent_json,NEW.cancellation_json) IS NOT 1
 OR NOT EXISTS(
   SELECT 1 FROM business_sync_resolution_intent i
   JOIN business_sync_binding b ON b.id=1 JOIN business_sync_baseline h ON h.id=b.id
   LEFT JOIN business_sync_cursor c ON c.id=b.id
   WHERE i.resolution_id=NEW.resolution_id AND i.state='retiring' AND i.cancellation_requested=1
     AND i.intent_json=NEW.intent_json AND i.intent_sha256=NEW.intent_sha256
     AND b.capture_enabled=1 AND b.organization_id=json_extract(i.intent_json,'$.organization_id')
     AND b.installation_id=json_extract(i.intent_json,'$.installation_id')
     AND b.generation=json_extract(i.intent_json,'$.capture_generation')
     AND h.organization_id=b.organization_id AND h.server_generation=json_extract(i.intent_json,'$.generation')
     AND COALESCE(c.revision,1)=json_extract(i.intent_json,'$.source_revision')
     AND (c.id IS NULL OR (c.organization_id=b.organization_id AND c.generation=h.server_generation))
 )
BEGIN SELECT RAISE(ABORT,'La preuve d’annulation ne correspond pas à la demande de cet appareil.'); END;
CREATE TRIGGER business_sync_resolution_cancellations_no_update BEFORE UPDATE ON business_sync_resolution_cancellations
BEGIN SELECT RAISE(ABORT,'La preuve d’annulation est immuable.'); END;
CREATE TRIGGER business_sync_resolution_cancellations_no_delete BEFORE DELETE ON business_sync_resolution_cancellations
BEGIN SELECT RAISE(ABORT,'La preuve d’annulation est immuable.'); END;

DROP TRIGGER business_sync_resolution_intent_delete_guard;
CREATE TRIGGER business_sync_resolution_intent_delete_guard
BEFORE DELETE ON business_sync_resolution_intent
WHEN OLD.state<>'prepared' AND NOT EXISTS(
  SELECT 1 FROM business_sync_resolutions r JOIN business_sync_binding b ON b.id=1
  WHERE r.resolution_id=OLD.resolution_id AND r.intent_json=OLD.intent_json
    AND r.intent_sha256=OLD.intent_sha256 AND r.retirement_json=OLD.retirement_json
    AND r.retirement_sha256=OLD.retirement_sha256
    AND b.generation=json_extract(r.intent_json,'$.replacement_capture_generation')
) AND NOT (
  OLD.state='retiring' AND OLD.cancellation_requested=1 AND (SELECT synchronous FROM pragma_synchronous)=2
  AND EXISTS(
    SELECT 1 FROM business_sync_resolution_cancellations r
    JOIN business_sync_binding b ON b.id=1 JOIN business_sync_baseline h ON h.id=b.id
    LEFT JOIN business_sync_cursor c ON c.id=b.id
    WHERE r.resolution_id=OLD.resolution_id AND r.intent_json=OLD.intent_json AND r.intent_sha256=OLD.intent_sha256
      AND zentra_resolution_cancellation_valid(r.intent_json,r.cancellation_json)=1
      AND r.cancellation_sha256=zentra_sha256(r.cancellation_json)
      AND b.capture_enabled=1 AND b.organization_id=json_extract(r.intent_json,'$.organization_id')
      AND b.installation_id=json_extract(r.intent_json,'$.installation_id')
      AND b.generation=json_extract(r.intent_json,'$.capture_generation')
      AND h.organization_id=b.organization_id AND h.server_generation=json_extract(r.intent_json,'$.generation')
      AND COALESCE(c.revision,1)=json_extract(r.intent_json,'$.source_revision')
      AND (c.id IS NULL OR (c.organization_id=b.organization_id AND c.generation=h.server_generation))
  )
)
BEGIN SELECT RAISE(ABORT,'Une confirmation de résolution ou d’annulation est requise avant de libérer ce dossier.'); END;
PRAGMA user_version=64;
