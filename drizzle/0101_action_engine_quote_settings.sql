-- Migration number: 0101 	 2026-10-11T00:00:17.357Z
-- Additive, disabled by default. No endpoint or seed enables this capability.
-- Separate consent covers quote DRAFT preparation and conditional creation of
-- its customer. It never authorizes issuing/sending a document or a payment.
CREATE TABLE action_engine_quote_settings (
  organization_id TEXT PRIMARY KEY NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 2147483647),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(typeof(enabled)='integer' AND enabled IN (0,1)),
  consent_version TEXT,
  granted_by TEXT,
  granted_at INTEGER,
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 1 AND 253402300799),
  CHECK((consent_version IS NULL AND granted_by IS NULL AND granted_at IS NULL)
    OR (typeof(consent_version)='text' AND length(consent_version) BETWEEN 1 AND 160
      AND typeof(granted_by)='text' AND length(granted_by) BETWEEN 1 AND 160
      AND typeof(granted_at)='integer' AND granted_at BETWEEN 1 AND 253402300799)),
  CHECK(enabled=0 OR (consent_version IS NOT NULL AND granted_by IS NOT NULL AND granted_at IS NOT NULL))
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TRIGGER action_engine_quote_settings_revision
BEFORE UPDATE ON action_engine_quote_settings
WHEN NEW.organization_id<>OLD.organization_id OR NEW.revision<>OLD.revision+1
BEGIN
  SELECT RAISE(ABORT,'action_engine_quote_settings_revision');
END;
