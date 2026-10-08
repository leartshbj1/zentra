-- Additive guards for legacy D1 company transports. Requires 0085 intentions.
-- US identity is permanent from reservation, regardless of workflow state.
-- No backfill and no guard on organizations/subscriptions/memberships.
-- UPDATE checks OLD and NEW; parent/source references and REPLACE conflicts
-- are covered without relying on PRAGMA recursive_triggers.
-- Exact business-sync/<organization>/ object namespaces also preserve orphan
-- identity. The extracted organization uses its unique intention index.
-- SQL rollback does not roll back R2 uploads: API/storage admission is separate.

CREATE TRIGGER "international_legacy_business_sync_audit_branches_insert"
BEFORE INSERT ON "business_sync_audit_branches"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_audit_branches" existing WHERE existing."organization_id"=NEW."organization_id" AND existing."generation"=NEW."generation" AND existing."installation_id"=NEW."installation_id" AND existing."capture_generation"=NEW."capture_generation" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_audit_branches_update"
BEFORE UPDATE ON "business_sync_audit_branches"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_audit_branches_delete"
BEFORE DELETE ON "business_sync_audit_branches"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_audit_nodes_insert"
BEFORE INSERT ON "business_sync_audit_nodes"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_audit_nodes" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."validator_sha256"=NEW."validator_sha256" AND existing."row_key"=NEW."row_key" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
  OR EXISTS (SELECT 1 FROM "business_sync_audit_nodes" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."validator_sha256"=NEW."validator_sha256" AND existing."entry_hash"=NEW."entry_hash" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_audit_nodes_update"
BEFORE UPDATE ON "business_sync_audit_nodes"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_audit_nodes_delete"
BEFORE DELETE ON "business_sync_audit_nodes"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_candidate_order_insert"
BEFORE INSERT ON "business_sync_candidate_order"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_candidate_order" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."table_name"=NEW."table_name" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_candidate_order_update"
BEFORE UPDATE ON "business_sync_candidate_order"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_candidate_order_delete"
BEFORE DELETE ON "business_sync_candidate_order"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_credit_lines_insert"
BEFORE INSERT ON "business_sync_credit_lines"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_credit_lines" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."validator_sha256"=NEW."validator_sha256" AND existing."document_id"=NEW."document_id" AND existing."item_id"=NEW."item_id" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_credit_lines_update"
BEFORE UPDATE ON "business_sync_credit_lines"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_credit_lines_delete"
BEFORE DELETE ON "business_sync_credit_lines"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_credit_movements_insert"
BEFORE INSERT ON "business_sync_credit_movements"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_credit_movements" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."validator_sha256"=NEW."validator_sha256" AND existing."document_id"=NEW."document_id" AND existing."movement_id"=NEW."movement_id" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_credit_movements_update"
BEFORE UPDATE ON "business_sync_credit_movements"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_credit_movements_delete"
BEFORE DELETE ON "business_sync_credit_movements"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_credit_projection_insert"
BEFORE INSERT ON "business_sync_credit_projection"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_credit_projection" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."validator_sha256"=NEW."validator_sha256" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_credit_projection_update"
BEFORE UPDATE ON "business_sync_credit_projection"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_credit_projection_delete"
BEFORE DELETE ON "business_sync_credit_projection"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_file_blobs_insert"
BEFORE INSERT ON "business_sync_file_blobs"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_file_blobs" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."sha256"=NEW."sha256" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_file_blobs_update"
BEFORE UPDATE ON "business_sync_file_blobs"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_file_blobs_delete"
BEFORE DELETE ON "business_sync_file_blobs"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_file_entries_insert"
BEFORE INSERT ON "business_sync_file_entries"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_file_entries" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."path_key"=NEW."path_key" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_file_entries_update"
BEFORE UPDATE ON "business_sync_file_entries"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_file_entries_delete"
BEFORE DELETE ON "business_sync_file_entries"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_file_pages_insert"
BEFORE INSERT ON "business_sync_file_pages"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_file_pages" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."page_index"=NEW."page_index" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_file_pages_update"
BEFORE UPDATE ON "business_sync_file_pages"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_file_pages_delete"
BEFORE DELETE ON "business_sync_file_pages"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_file_parts_insert"
BEFORE INSERT ON "business_sync_file_parts"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(NEW.object_key,15,instr(substr(NEW.object_key,15),'/')-1) AND substr(NEW.object_key,1,14)='business-sync/' AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_file_parts" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."file_sha256"=NEW."file_sha256" AND existing."part_index"=NEW."part_index" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(existing.object_key,15,instr(substr(existing.object_key,15),'/')-1) AND substr(existing.object_key,1,14)='business-sync/' AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_file_parts_update"
BEFORE UPDATE ON "business_sync_file_parts"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(NEW.object_key,15,instr(substr(NEW.object_key,15),'/')-1) AND substr(NEW.object_key,1,14)='business-sync/' AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(OLD.object_key,15,instr(substr(OLD.object_key,15),'/')-1) AND substr(OLD.object_key,1,14)='business-sync/' AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_file_parts_delete"
BEFORE DELETE ON "business_sync_file_parts"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(OLD.object_key,15,instr(substr(OLD.object_key,15),'/')-1) AND substr(OLD.object_key,1,14)='business-sync/' AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_file_sets_insert"
BEFORE INSERT ON "business_sync_file_sets"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_file_sets" existing WHERE existing."transfer_id"=NEW."transfer_id" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_file_sets_update"
BEFORE UPDATE ON "business_sync_file_sets"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_file_sets_delete"
BEFORE DELETE ON "business_sync_file_sets"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_integrity_checks_insert"
BEFORE INSERT ON "business_sync_integrity_checks"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_integrity_checks" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."validator_sha256"=NEW."validator_sha256" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_integrity_checks_update"
BEFORE UPDATE ON "business_sync_integrity_checks"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_integrity_checks_delete"
BEFORE DELETE ON "business_sync_integrity_checks"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_number_floors_insert"
BEFORE INSERT ON "business_sync_number_floors"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.bootstrap_transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_number_floors" existing WHERE existing."organization_id"=NEW."organization_id" AND existing."prefix"=NEW."prefix" AND existing."year"=NEW."year" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.bootstrap_transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_number_floors_update"
BEFORE UPDATE ON "business_sync_number_floors"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.bootstrap_transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.bootstrap_transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_number_floors_delete"
BEFORE DELETE ON "business_sync_number_floors"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.bootstrap_transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_publications_insert"
BEFORE INSERT ON "business_sync_publications"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_publications" existing WHERE existing."transfer_id"=NEW."transfer_id" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_publications_update"
BEFORE UPDATE ON "business_sync_publications"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_publications_delete"
BEFORE DELETE ON "business_sync_publications"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_retirement_cancellations_insert"
BEFORE INSERT ON "business_sync_retirement_cancellations"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_retirement_cancellations" existing WHERE existing."resolution_id"=NEW."resolution_id" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_retirement_cancellations_update"
BEFORE UPDATE ON "business_sync_retirement_cancellations"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_retirement_cancellations_delete"
BEFORE DELETE ON "business_sync_retirement_cancellations"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_retirements_insert"
BEFORE INSERT ON "business_sync_retirements"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_retirements" existing WHERE existing."resolution_id"=NEW."resolution_id" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_retirements_update"
BEFORE UPDATE ON "business_sync_retirements"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_retirements_delete"
BEFORE DELETE ON "business_sync_retirements"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_row_order_insert"
BEFORE INSERT ON "business_sync_row_order"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_row_order" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."table_name"=NEW."table_name" AND existing."row_key_json"=NEW."row_key_json" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
  OR EXISTS (SELECT 1 FROM "business_sync_row_order" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."table_name"=NEW."table_name" AND existing."source_rowid"=NEW."source_rowid" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_row_order_update"
BEFORE UPDATE ON "business_sync_row_order"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_row_order_delete"
BEFORE DELETE ON "business_sync_row_order"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_spaces_insert"
BEFORE INSERT ON "business_sync_spaces"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.bootstrap_transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_spaces" existing WHERE existing."organization_id"=NEW."organization_id" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.bootstrap_transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_spaces_update"
BEFORE UPDATE ON "business_sync_spaces"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.bootstrap_transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.bootstrap_transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_spaces_delete"
BEFORE DELETE ON "business_sync_spaces"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.bootstrap_transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_structural_checks_insert"
BEFORE INSERT ON "business_sync_structural_checks"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_structural_checks" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."validator_sha256"=NEW."validator_sha256" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_structural_checks_update"
BEFORE UPDATE ON "business_sync_structural_checks"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_structural_checks_delete"
BEFORE DELETE ON "business_sync_structural_checks"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_accounting_states_insert"
BEFORE INSERT ON "business_sync_transaction_accounting_states"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_transaction_accounting_states" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."validator_sha256"=NEW."validator_sha256" AND existing."table_name"=NEW."table_name" AND existing."row_key_json"=NEW."row_key_json" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_accounting_states_update"
BEFORE UPDATE ON "business_sync_transaction_accounting_states"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_accounting_states_delete"
BEFORE DELETE ON "business_sync_transaction_accounting_states"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_canonical_order_insert"
BEFORE INSERT ON "business_sync_transaction_canonical_order"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_transaction_canonical_order" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."attempt"=NEW."attempt" AND existing."part_index"=NEW."part_index" AND existing."change_index"=NEW."change_index" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_canonical_order_update"
BEFORE UPDATE ON "business_sync_transaction_canonical_order"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_canonical_order_delete"
BEFORE DELETE ON "business_sync_transaction_canonical_order"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_changes_insert"
BEFORE INSERT ON "business_sync_transaction_changes"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transaction_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_transaction_changes" existing WHERE existing."organization_id"=NEW."organization_id" AND existing."installation_id"=NEW."installation_id" AND existing."capture_generation"=NEW."capture_generation" AND existing."sequence"=NEW."sequence" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transaction_id AND intent.country_code='US')))
  OR EXISTS (SELECT 1 FROM "business_sync_transaction_changes" existing WHERE existing."transaction_id"=NEW."transaction_id" AND existing."part_index"=NEW."part_index" AND existing."change_index"=NEW."change_index" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transaction_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_changes_update"
BEFORE UPDATE ON "business_sync_transaction_changes"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transaction_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transaction_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_changes_delete"
BEFORE DELETE ON "business_sync_transaction_changes"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transaction_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_commits_insert"
BEFORE INSERT ON "business_sync_transaction_commits"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.source_transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_transaction_commits" existing WHERE existing."transfer_id"=NEW."transfer_id" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.source_transfer_id AND intent.country_code='US')))
  OR EXISTS (SELECT 1 FROM "business_sync_transaction_commits" existing WHERE existing."organization_id"=NEW."organization_id" AND existing."revision"=NEW."revision" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.source_transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_commits_update"
BEFORE UPDATE ON "business_sync_transaction_commits"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.source_transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.source_transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_commits_delete"
BEFORE DELETE ON "business_sync_transaction_commits"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.source_transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_conflicts_insert"
BEFORE INSERT ON "business_sync_transaction_conflicts"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_transaction_conflicts" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."attempt"=NEW."attempt" AND existing."table_name"=NEW."table_name" AND existing."row_key_json"=NEW."row_key_json" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_conflicts_update"
BEFORE UPDATE ON "business_sync_transaction_conflicts"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_conflicts_delete"
BEFORE DELETE ON "business_sync_transaction_conflicts"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_delivery_parts_insert"
BEFORE INSERT ON "business_sync_transaction_delivery_parts"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(NEW.object_key,15,instr(substr(NEW.object_key,15),'/')-1) AND substr(NEW.object_key,1,14)='business-sync/' AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_transaction_delivery_parts" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."attempt"=NEW."attempt" AND existing."part_index"=NEW."part_index" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(existing.object_key,15,instr(substr(existing.object_key,15),'/')-1) AND substr(existing.object_key,1,14)='business-sync/' AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_delivery_parts_update"
BEFORE UPDATE ON "business_sync_transaction_delivery_parts"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(NEW.object_key,15,instr(substr(NEW.object_key,15),'/')-1) AND substr(NEW.object_key,1,14)='business-sync/' AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(OLD.object_key,15,instr(substr(OLD.object_key,15),'/')-1) AND substr(OLD.object_key,1,14)='business-sync/' AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_delivery_parts_delete"
BEFORE DELETE ON "business_sync_transaction_delivery_parts"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(OLD.object_key,15,instr(substr(OLD.object_key,15),'/')-1) AND substr(OLD.object_key,1,14)='business-sync/' AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_document_states_insert"
BEFORE INSERT ON "business_sync_transaction_document_states"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_transaction_document_states" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."validator_sha256"=NEW."validator_sha256" AND existing."table_name"=NEW."table_name" AND existing."row_key_json"=NEW."row_key_json" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_document_states_update"
BEFORE UPDATE ON "business_sync_transaction_document_states"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_document_states_delete"
BEFORE DELETE ON "business_sync_transaction_document_states"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_effects_insert"
BEFORE INSERT ON "business_sync_transaction_effects"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_transaction_effects" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."validator_sha256"=NEW."validator_sha256" AND existing."table_name"=NEW."table_name" AND existing."row_key_json"=NEW."row_key_json" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_effects_update"
BEFORE UPDATE ON "business_sync_transaction_effects"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_effects_delete"
BEFORE DELETE ON "business_sync_transaction_effects"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_fingerprints_insert"
BEFORE INSERT ON "business_sync_transaction_fingerprints"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_transaction_fingerprints" existing WHERE existing."transfer_id"=NEW."transfer_id" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_fingerprints_update"
BEFORE UPDATE ON "business_sync_transaction_fingerprints"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_fingerprints_delete"
BEFORE DELETE ON "business_sync_transaction_fingerprints"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_parts_insert"
BEFORE INSERT ON "business_sync_transaction_parts"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transaction_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(NEW.object_key,15,instr(substr(NEW.object_key,15),'/')-1) AND substr(NEW.object_key,1,14)='business-sync/' AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_transaction_parts" existing WHERE existing."transaction_id"=NEW."transaction_id" AND existing."part_index"=NEW."part_index" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transaction_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(existing.object_key,15,instr(substr(existing.object_key,15),'/')-1) AND substr(existing.object_key,1,14)='business-sync/' AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_parts_update"
BEFORE UPDATE ON "business_sync_transaction_parts"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transaction_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(NEW.object_key,15,instr(substr(NEW.object_key,15),'/')-1) AND substr(NEW.object_key,1,14)='business-sync/' AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transaction_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(OLD.object_key,15,instr(substr(OLD.object_key,15),'/')-1) AND substr(OLD.object_key,1,14)='business-sync/' AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_parts_delete"
BEFORE DELETE ON "business_sync_transaction_parts"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transaction_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(OLD.object_key,15,instr(substr(OLD.object_key,15),'/')-1) AND substr(OLD.object_key,1,14)='business-sync/' AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_reviews_insert"
BEFORE INSERT ON "business_sync_transaction_reviews"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.source_transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_transaction_reviews" existing WHERE existing."transfer_id"=NEW."transfer_id" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.source_transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_reviews_update"
BEFORE UPDATE ON "business_sync_transaction_reviews"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.source_transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.source_transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_reviews_delete"
BEFORE DELETE ON "business_sync_transaction_reviews"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.source_transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_validations_insert"
BEFORE INSERT ON "business_sync_transaction_validations"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_transaction_validations" existing WHERE existing."transfer_id"=NEW."transfer_id" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_validations_update"
BEFORE UPDATE ON "business_sync_transaction_validations"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transaction_validations_delete"
BEFORE DELETE ON "business_sync_transaction_validations"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transfer_chunks_insert"
BEFORE INSERT ON "business_sync_transfer_chunks"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(NEW.object_key,15,instr(substr(NEW.object_key,15),'/')-1) AND substr(NEW.object_key,1,14)='business-sync/' AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_transfer_chunks" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."chunk_index"=NEW."chunk_index" AND (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(existing.object_key,15,instr(substr(existing.object_key,15),'/')-1) AND substr(existing.object_key,1,14)='business-sync/' AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transfer_chunks_update"
BEFORE UPDATE ON "business_sync_transfer_chunks"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(NEW.object_key,15,instr(substr(NEW.object_key,15),'/')-1) AND substr(NEW.object_key,1,14)='business-sync/' AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(OLD.object_key,15,instr(substr(OLD.object_key,15),'/')-1) AND substr(OLD.object_key,1,14)='business-sync/' AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transfer_chunks_delete"
BEFORE DELETE ON "business_sync_transfer_chunks"
WHEN (EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=substr(OLD.object_key,15,instr(substr(OLD.object_key,15),'/')-1) AND substr(OLD.object_key,1,14)='business-sync/' AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transfers_insert"
BEFORE INSERT ON "business_sync_transfers"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_transfers" existing WHERE existing."transfer_id"=NEW."transfer_id" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
  OR EXISTS (SELECT 1 FROM "business_sync_transfers" existing WHERE existing."organization_id"=NEW."organization_id" AND existing."revision"=NEW."revision" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transfers_update"
BEFORE UPDATE ON "business_sync_transfers"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_transfers_delete"
BEFORE DELETE ON "business_sync_transfers"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_versions_insert"
BEFORE INSERT ON "business_sync_versions"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "business_sync_versions" existing WHERE existing."sequence"=NEW."sequence" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
  OR EXISTS (SELECT 1 FROM "business_sync_versions" existing WHERE existing."transfer_id"=NEW."transfer_id" AND existing."table_name"=NEW."table_name" AND existing."row_key_json"=NEW."row_key_json" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=existing.transfer_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_versions_update"
BEFORE UPDATE ON "business_sync_versions"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=NEW.transfer_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_business_sync_versions_delete"
BEFORE DELETE ON "business_sync_versions"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM business_sync_transfers parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.transfer_id=OLD.transfer_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_company_copies_insert"
BEFORE INSERT ON "company_copies"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM workspace_backups parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.backup_id=NEW.backup_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "company_copies" existing WHERE existing."organization_id"=NEW."organization_id" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM workspace_backups parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.backup_id=existing.backup_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_company_copies_update"
BEFORE UPDATE ON "company_copies"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM workspace_backups parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.backup_id=NEW.backup_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM workspace_backups parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.backup_id=OLD.backup_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_company_copies_delete"
BEFORE DELETE ON "company_copies"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM workspace_backups parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.backup_id=OLD.backup_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_document_number_reservations_insert"
BEFORE INSERT ON "document_number_reservations"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "document_number_reservations" existing WHERE existing."sequence"=NEW."sequence" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')))
  OR EXISTS (SELECT 1 FROM "document_number_reservations" existing WHERE existing."organization_id"=NEW."organization_id" AND existing."request_id"=NEW."request_id" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_document_number_reservations_update"
BEFORE UPDATE ON "document_number_reservations"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_document_number_reservations_delete"
BEFORE DELETE ON "document_number_reservations"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_workspace_backup_chunks_insert"
BEFORE INSERT ON "workspace_backup_chunks"
WHEN (EXISTS (SELECT 1 FROM workspace_backups parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.backup_id=NEW.backup_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "workspace_backup_chunks" existing WHERE existing."backup_id"=NEW."backup_id" AND existing."chunk_index"=NEW."chunk_index" AND (EXISTS (SELECT 1 FROM workspace_backups parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.backup_id=existing.backup_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_workspace_backup_chunks_update"
BEFORE UPDATE ON "workspace_backup_chunks"
WHEN (EXISTS (SELECT 1 FROM workspace_backups parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.backup_id=NEW.backup_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM workspace_backups parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.backup_id=OLD.backup_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_workspace_backup_chunks_delete"
BEFORE DELETE ON "workspace_backup_chunks"
WHEN (EXISTS (SELECT 1 FROM workspace_backups parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.backup_id=OLD.backup_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_workspace_backups_insert"
BEFORE INSERT ON "workspace_backups"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM workspace_backups parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.backup_id=NEW.backup_id AND intent.country_code='US'))
  OR EXISTS (SELECT 1 FROM "workspace_backups" existing WHERE existing."backup_id"=NEW."backup_id" AND (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=existing.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM workspace_backups parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.backup_id=existing.backup_id AND intent.country_code='US')))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_workspace_backups_update"
BEFORE UPDATE ON "workspace_backups"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM workspace_backups parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.backup_id=NEW.backup_id AND intent.country_code='US'))
  OR (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM workspace_backups parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.backup_id=OLD.backup_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER "international_legacy_workspace_backups_delete"
BEFORE DELETE ON "workspace_backups"
WHEN (EXISTS (SELECT 1 FROM international_workspace_creation_intents intent WHERE intent.organization_id=OLD.organization_id AND intent.country_code='US')
    OR EXISTS (SELECT 1 FROM workspace_backups parent JOIN international_workspace_creation_intents intent ON intent.organization_id=parent.organization_id WHERE parent.backup_id=OLD.backup_id AND intent.country_code='US'))
BEGIN
  SELECT RAISE(ABORT, 'international_legacy_transport_forbidden');
END;
