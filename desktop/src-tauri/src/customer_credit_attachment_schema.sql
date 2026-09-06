CREATE VIEW IF NOT EXISTS customer_credit_settlement_projects AS
SELECT e.id AS settlement_id,CASE WHEN e.invoice_id IS NULL OR c.project_id IS i.project_id THEN c.project_id ELSE NULL END AS project_id
FROM customer_credit_settlements e JOIN invoices c ON c.id=e.credit_note_id LEFT JOIN invoices i ON i.id=e.invoice_id;

CREATE TRIGGER IF NOT EXISTS customer_credit_attachment_insert BEFORE INSERT ON attachments
WHEN NEW.entity_type='customer_credit_settlement' AND (
 NEW.entity_id IS NULL OR NOT EXISTS(SELECT 1 FROM customer_credit_settlements WHERE id=NEW.entity_id)
 OR NEW.project_id IS NOT (SELECT project_id FROM customer_credit_settlement_projects WHERE settlement_id=NEW.entity_id)
 OR NEW.mime_type IS NULL OR NEW.mime_type NOT IN ('application/pdf','image/png','image/jpeg','image/webp')
 OR NEW.size_bytes<=0 OR NEW.size_bytes>26214400
 OR NEW.sha256 IS NULL OR length(NEW.sha256)<>64 OR NEW.sha256 GLOB '*[^0-9a-f]*'
 OR (NEW.mime_type='application/pdf' AND NEW.stored_name NOT GLOB '*.pdf')
 OR (NEW.mime_type='image/png' AND NEW.stored_name NOT GLOB '*.png')
 OR (NEW.mime_type='image/jpeg' AND NEW.stored_name NOT GLOB '*.jpg')
 OR (NEW.mime_type='image/webp' AND NEW.stored_name NOT GLOB '*.webp')
 OR EXISTS(SELECT 1 FROM attachments WHERE entity_type='customer_credit_settlement' AND entity_id=NEW.entity_id AND sha256=NEW.sha256)
 OR (SELECT COUNT(*) FROM attachments WHERE entity_type='customer_credit_settlement' AND entity_id=NEW.entity_id)>=20
) BEGIN SELECT RAISE(ABORT,'Justificatif client invalide, doublon ou limite de 20 pièces atteinte.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_attachment_no_update BEFORE UPDATE ON attachments
WHEN OLD.entity_type='customer_credit_settlement' OR NEW.entity_type='customer_credit_settlement'
BEGIN SELECT RAISE(ABORT,'Le justificatif du règlement client est conservé sans modification.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_attachment_no_delete BEFORE DELETE ON attachments
WHEN OLD.entity_type='customer_credit_settlement'
BEGIN SELECT RAISE(ABORT,'Les justificatifs des règlements clients sont conservés avec leur historique.'); END;
PRAGMA user_version=54;
