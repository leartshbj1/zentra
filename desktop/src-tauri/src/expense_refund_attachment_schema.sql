CREATE TRIGGER IF NOT EXISTS expense_refund_attachment_insert_guard BEFORE INSERT ON attachments
WHEN NEW.entity_type='expense_refund' AND (
  NEW.entity_id IS NULL OR NOT EXISTS(SELECT 1 FROM expense_refunds WHERE id=NEW.entity_id) OR
  COALESCE(NEW.project_id,'')<>COALESCE((SELECT e.project_id FROM expense_refunds r JOIN expenses e ON e.id=r.expense_id WHERE r.id=NEW.entity_id),'') OR
  NEW.mime_type IS NULL OR NEW.mime_type NOT IN ('application/pdf','image/png','image/jpeg','image/webp') OR
  NEW.size_bytes<=0 OR NEW.size_bytes>26214400 OR
  NEW.sha256 IS NULL OR LENGTH(NEW.sha256)<>64 OR NEW.sha256 GLOB '*[^0-9a-f]*' OR
  (NEW.mime_type='application/pdf' AND NEW.stored_name NOT GLOB '*.pdf') OR
  (NEW.mime_type='image/png' AND NEW.stored_name NOT GLOB '*.png') OR
  (NEW.mime_type='image/jpeg' AND NEW.stored_name NOT GLOB '*.jpg') OR
  (NEW.mime_type='image/webp' AND NEW.stored_name NOT GLOB '*.webp') OR
  EXISTS(SELECT 1 FROM attachments WHERE entity_type='expense_refund' AND entity_id=NEW.entity_id AND sha256=NEW.sha256) OR
  (SELECT COUNT(*) FROM attachments WHERE entity_type='expense_refund' AND entity_id=NEW.entity_id)>=20
) BEGIN SELECT RAISE(ABORT,'Justificatif de remboursement invalide, doublon ou limite de 20 pièces atteinte.'); END;
CREATE TRIGGER IF NOT EXISTS expense_refund_attachment_no_delete BEFORE DELETE ON attachments
WHEN OLD.entity_type='expense_refund'
BEGIN SELECT RAISE(ABORT,'Les justificatifs des remboursements comptabilisés sont conservés.'); END;
PRAGMA user_version=49;
