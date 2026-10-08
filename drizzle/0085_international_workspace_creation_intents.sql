-- Additive preparation only. Do not apply in production before admission review.
-- Pending intentions deliberately have NO organizations FK: no account-space or
-- membership is exposed until a separate, verified US entitlement can finalize it.
CREATE TABLE international_workspace_creation_intents (
  creation_id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL UNIQUE,
  actor_user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  country_code TEXT NOT NULL CHECK(country_code='US'),
  confirmation_version INTEGER NOT NULL CHECK(confirmation_version=1),
  company_name TEXT NOT NULL CHECK(length(company_name) BETWEEN 1 AND 160),
  configuration_fingerprint TEXT NOT NULL CHECK(length(configuration_fingerprint)=64 AND configuration_fingerprint NOT GLOB '*[^0-9a-f]*'),
  configuration_json TEXT NOT NULL CHECK(COALESCE(json_valid(configuration_json) AND json_type(configuration_json)='object'
    AND json_extract(configuration_json,'$.organizationId')=organization_id
    AND json_extract(configuration_json,'$.country')='US'
    AND json_extract(configuration_json,'$.currency')='USD'
    AND json_extract(configuration_json,'$.taxConfiguration.status')='unconfigured',0)),
  state TEXT NOT NULL CHECK(state IN ('reserved','postgres_confirmed','ready')),
  pg_receipt_json TEXT CHECK(pg_receipt_json IS NULL OR COALESCE(json_valid(pg_receipt_json) AND json_type(pg_receipt_json)='object'
    AND json_extract(pg_receipt_json,'$.creationId')=creation_id
    AND json_extract(pg_receipt_json,'$.organizationId')=organization_id
    AND json_extract(pg_receipt_json,'$.actorUserId')=actor_user_id
    AND json_extract(pg_receipt_json,'$.requestId')=request_id
    AND json_extract(pg_receipt_json,'$.configurationFingerprint')=configuration_fingerprint
    AND json_extract(pg_receipt_json,'$.revision')=1,0)),
  own_subscription_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(actor_user_id,request_id),
  CHECK((state='reserved' AND pg_receipt_json IS NULL AND own_subscription_id IS NULL)
    OR (state='postgres_confirmed' AND pg_receipt_json IS NOT NULL AND own_subscription_id IS NULL)
    OR (state='ready' AND pg_receipt_json IS NOT NULL AND own_subscription_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TRIGGER international_intent_identity_immutable BEFORE UPDATE ON international_workspace_creation_intents
WHEN NEW.creation_id IS NOT OLD.creation_id OR NEW.organization_id IS NOT OLD.organization_id
 OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.request_id IS NOT OLD.request_id
 OR NEW.country_code IS NOT OLD.country_code OR NEW.confirmation_version IS NOT OLD.confirmation_version
 OR NEW.company_name IS NOT OLD.company_name OR NEW.configuration_fingerprint IS NOT OLD.configuration_fingerprint
 OR NEW.configuration_json IS NOT OLD.configuration_json OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.pg_receipt_json IS NOT NULL AND NEW.pg_receipt_json IS NOT OLD.pg_receipt_json)
 OR (OLD.state='postgres_confirmed' AND NEW.state='reserved')
 OR OLD.state='ready'
BEGIN SELECT RAISE(ABORT,'international_intent_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_intent_no_delete BEFORE DELETE ON international_workspace_creation_intents
BEGIN SELECT RAISE(ABORT,'international_intent_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER international_intent_strict_reservation BEFORE INSERT ON international_workspace_creation_intents
WHEN NEW.state<>'reserved' OR EXISTS(SELECT 1 FROM organizations WHERE organization_id=NEW.organization_id)
 OR EXISTS(SELECT 1 FROM international_workspace_creation_intents WHERE creation_id=NEW.creation_id OR organization_id=NEW.organization_id)
BEGIN SELECT RAISE(ABORT,'international_intent_not_new'); END;
--> statement-breakpoint
-- No US entitlement catalog/device dispatch is admitted by this phase. A later
-- reviewed migration can replace this fence only after the ready contract exists.
CREATE TRIGGER international_intent_ready_unavailable BEFORE UPDATE ON international_workspace_creation_intents
WHEN NEW.state='ready'
BEGIN SELECT RAISE(ABORT,'international_us_ready_not_admitted'); END;
--> statement-breakpoint
-- Reject attributable legacy traces even if an inconsistent fixture/admin path
-- left data without its organizations row. Descendants without tenant or parent
-- cannot be reliably attributed; they are not asserted to be empty by this check.
CREATE TRIGGER international_intent_no_legacy_traces BEFORE INSERT ON international_workspace_creation_intents
WHEN EXISTS(SELECT 1 FROM business_sync_audit_branches WHERE organization_id=NEW.organization_id)
 OR EXISTS(SELECT 1 FROM business_sync_number_floors WHERE organization_id=NEW.organization_id)
 OR EXISTS(SELECT 1 FROM business_sync_publications WHERE organization_id=NEW.organization_id)
 OR EXISTS(SELECT 1 FROM business_sync_retirement_cancellations WHERE organization_id=NEW.organization_id)
 OR EXISTS(SELECT 1 FROM business_sync_retirements WHERE organization_id=NEW.organization_id)
 OR EXISTS(SELECT 1 FROM business_sync_spaces WHERE organization_id=NEW.organization_id)
 OR EXISTS(SELECT 1 FROM business_sync_transaction_changes WHERE organization_id=NEW.organization_id)
 OR EXISTS(SELECT 1 FROM business_sync_transaction_commits WHERE organization_id=NEW.organization_id)
 OR EXISTS(SELECT 1 FROM business_sync_transfers WHERE organization_id=NEW.organization_id)
 OR EXISTS(SELECT 1 FROM business_sync_versions WHERE organization_id=NEW.organization_id)
 OR EXISTS(SELECT 1 FROM company_copies WHERE organization_id=NEW.organization_id)
 OR EXISTS(SELECT 1 FROM document_number_reservations WHERE organization_id=NEW.organization_id)
 OR EXISTS(SELECT 1 FROM workspace_backups WHERE organization_id=NEW.organization_id)
 OR EXISTS(SELECT 1 FROM business_sync_transfer_chunks WHERE substr(object_key,1,length('business-sync/'||NEW.organization_id||'/'))='business-sync/'||NEW.organization_id||'/')
 OR EXISTS(SELECT 1 FROM business_sync_transaction_parts WHERE substr(object_key,1,length('business-sync/'||NEW.organization_id||'/'))='business-sync/'||NEW.organization_id||'/')
 OR EXISTS(SELECT 1 FROM business_sync_file_parts WHERE substr(object_key,1,length('business-sync/'||NEW.organization_id||'/'))='business-sync/'||NEW.organization_id||'/')
 OR EXISTS(SELECT 1 FROM business_sync_transaction_delivery_parts WHERE substr(object_key,1,length('business-sync/'||NEW.organization_id||'/'))='business-sync/'||NEW.organization_id||'/')
BEGIN SELECT RAISE(ABORT,'international_intent_not_new'); END;
