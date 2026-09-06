CREATE TABLE IF NOT EXISTS bank_supplier_credit_refund_matches (
 id TEXT PRIMARY KEY, movement_id TEXT NOT NULL REFERENCES bank_movements(id), refund_id TEXT NOT NULL REFERENCES supplier_credit_refunds(id),
 date_difference_reason TEXT CHECK(date_difference_reason IS NULL OR length(trim(date_difference_reason)) BETWEEN 5 AND 500), confirmed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_credit_refund_movement ON bank_supplier_credit_refund_matches(movement_id);
CREATE INDEX IF NOT EXISTS idx_bank_credit_refund_source ON bank_supplier_credit_refund_matches(refund_id);
CREATE TABLE IF NOT EXISTS bank_supplier_credit_refund_unlinks (
 id TEXT PRIMARY KEY, match_id TEXT NOT NULL UNIQUE REFERENCES bank_supplier_credit_refund_matches(id), reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 500), unlinked_at TEXT NOT NULL
);
CREATE VIEW IF NOT EXISTS active_bank_supplier_credit_refund_matches AS SELECT m.* FROM bank_supplier_credit_refund_matches m WHERE NOT EXISTS(SELECT 1 FROM bank_supplier_credit_refund_unlinks u WHERE u.match_id=m.id);
CREATE TABLE IF NOT EXISTS bank_supplier_credit_refund_requests (
 id TEXT PRIMARY KEY, request_json TEXT NOT NULL CHECK(json_valid(request_json)), refund_id TEXT NOT NULL UNIQUE REFERENCES supplier_credit_refunds(id), match_id TEXT NOT NULL UNIQUE REFERENCES bank_supplier_credit_refund_matches(id), attachment_id TEXT NOT NULL REFERENCES attachments(id), created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS bank_credit_refund_match_no_update BEFORE UPDATE ON bank_supplier_credit_refund_matches BEGIN SELECT RAISE(ABORT,'Le rapprochement est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_credit_refund_match_no_delete BEFORE DELETE ON bank_supplier_credit_refund_matches BEGIN SELECT RAISE(ABORT,'Le rapprochement est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_credit_refund_unlink_no_update BEFORE UPDATE ON bank_supplier_credit_refund_unlinks BEGIN SELECT RAISE(ABORT,'La dissociation est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_credit_refund_unlink_no_delete BEFORE DELETE ON bank_supplier_credit_refund_unlinks BEGIN SELECT RAISE(ABORT,'La dissociation est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_credit_refund_request_no_update BEFORE UPDATE ON bank_supplier_credit_refund_requests BEGIN SELECT RAISE(ABORT,'La demande bancaire est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_credit_refund_request_no_delete BEFORE DELETE ON bank_supplier_credit_refund_requests BEGIN SELECT RAISE(ABORT,'La demande bancaire est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_credit_refund_unique_active BEFORE INSERT ON bank_supplier_credit_refund_matches
WHEN EXISTS(SELECT 1 FROM active_bank_supplier_credit_refund_matches WHERE movement_id=NEW.movement_id OR refund_id=NEW.refund_id)
 OR EXISTS(SELECT 1 FROM active_bank_expense_refund_matches WHERE movement_id=NEW.movement_id)
 OR EXISTS(SELECT 1 FROM bank_reconciliations WHERE movement_id=NEW.movement_id)
 OR EXISTS(SELECT 1 FROM bank_supplier_reconciliations WHERE movement_id=NEW.movement_id)
 OR EXISTS(SELECT 1 FROM bank_expense_reconciliations WHERE movement_id=NEW.movement_id)
BEGIN SELECT RAISE(ABORT,'Le mouvement ou le remboursement est déjà rapproché.'); END;
CREATE TRIGGER IF NOT EXISTS bank_customer_exclusive_credit_refund BEFORE INSERT ON bank_reconciliations WHEN EXISTS(SELECT 1 FROM active_bank_supplier_credit_refund_matches WHERE movement_id=NEW.movement_id) BEGIN SELECT RAISE(ABORT,'Ce mouvement est lié à un remboursement fournisseur.'); END;
CREATE TRIGGER IF NOT EXISTS bank_supplier_exclusive_credit_refund BEFORE INSERT ON bank_supplier_reconciliations WHEN EXISTS(SELECT 1 FROM active_bank_supplier_credit_refund_matches WHERE movement_id=NEW.movement_id) BEGIN SELECT RAISE(ABORT,'Ce mouvement est lié à un remboursement fournisseur.'); END;
CREATE TRIGGER IF NOT EXISTS bank_expense_exclusive_credit_refund BEFORE INSERT ON bank_expense_reconciliations WHEN EXISTS(SELECT 1 FROM active_bank_supplier_credit_refund_matches WHERE movement_id=NEW.movement_id) BEGIN SELECT RAISE(ABORT,'Ce mouvement est lié à un remboursement fournisseur.'); END;
CREATE TRIGGER IF NOT EXISTS bank_refund_exclusive_credit_refund BEFORE INSERT ON bank_expense_refund_matches WHEN EXISTS(SELECT 1 FROM active_bank_supplier_credit_refund_matches WHERE movement_id=NEW.movement_id) BEGIN SELECT RAISE(ABORT,'Ce mouvement est lié à un remboursement fournisseur.'); END;
CREATE TRIGGER IF NOT EXISTS bank_credit_refund_movement_frozen BEFORE UPDATE ON bank_movements WHEN EXISTS(SELECT 1 FROM bank_supplier_credit_refund_matches WHERE movement_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Le mouvement lié à l’historique est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS supplier_credit_refund_bank_correction BEFORE INSERT ON supplier_credit_refunds WHEN NEW.event_type='reverse' AND EXISTS(SELECT 1 FROM active_bank_supplier_credit_refund_matches WHERE refund_id=NEW.reverses_id) BEGIN SELECT RAISE(ABORT,'Dissociez d’abord le remboursement du relevé dans Banque.'); END;
CREATE TRIGGER IF NOT EXISTS bank_credit_refund_match_proof BEFORE INSERT ON bank_supplier_credit_refund_matches
WHEN NOT EXISTS(
 SELECT 1 FROM supplier_credit_refunds r JOIN supplier_credit_notes c ON c.id=r.supplier_credit_note_id
 JOIN bank_movements m ON m.id=NEW.movement_id JOIN bank_imports i ON i.id=COALESCE(m.booked_import_id,m.import_id)
 JOIN journal_entries j ON j.id=r.journal_entry_id
 WHERE r.id=NEW.refund_id AND r.event_type='refund' AND NOT EXISTS(SELECT 1 FROM supplier_credit_refunds x WHERE x.reverses_id=r.id)
 AND m.status='BOOK' AND m.credit_debit='CRDT' AND m.reversal=0 AND m.currency='CHF' AND m.account_currency='CHF' AND m.amount_cents=r.amount_cents
 AND i.message_type='camt.053' AND length(m.strong_key)>0 AND COALESCE(m.booking_date,m.value_date)>=c.document_date
 AND (COALESCE(m.booking_date,m.value_date)=r.date OR length(trim(NEW.date_difference_reason)) BETWEEN 5 AND 500)
 AND j.source_type='supplier_credit_refund' AND j.source_id=r.id AND j.source_event='refund' AND j.entry_date=r.date
 AND NOT EXISTS(SELECT 1 FROM journal_entries x WHERE x.reversal_of=j.id)
)
BEGIN SELECT RAISE(ABORT,'Le crédit bancaire doit prouver le remboursement actif de cet avoir.'); END;
CREATE TRIGGER IF NOT EXISTS bank_credit_refund_creation_proof BEFORE INSERT ON bank_supplier_credit_refund_requests
WHEN NOT EXISTS(SELECT 1 FROM bank_supplier_credit_refund_matches m JOIN supplier_credit_refunds r ON r.id=m.refund_id JOIN attachments a ON a.id=NEW.attachment_id WHERE m.id=NEW.match_id AND m.id=NEW.id AND r.id=NEW.refund_id AND r.request_id=NEW.id AND a.entity_type='supplier_credit_refund' AND a.entity_id=r.id)
BEGIN SELECT RAISE(ABORT,'La demande doit conserver son rapprochement, remboursement et justificatif.'); END;
CREATE VIEW IF NOT EXISTS supplier_credit_refund_projects AS
SELECT r.id AS refund_id,CASE WHEN COUNT(i.id)>0 AND COUNT(i.project_id)=COUNT(i.id) AND COUNT(DISTINCT i.project_id)=1 THEN MIN(i.project_id) ELSE NULL END AS project_id FROM supplier_credit_refunds r LEFT JOIN supplier_credit_note_items i ON i.supplier_credit_note_id=r.supplier_credit_note_id GROUP BY r.id;
CREATE TRIGGER IF NOT EXISTS supplier_credit_refund_attachment_insert BEFORE INSERT ON attachments
WHEN NEW.entity_type='supplier_credit_refund' AND (
 NEW.entity_id IS NULL OR NOT EXISTS(SELECT 1 FROM supplier_credit_refunds WHERE id=NEW.entity_id)
 OR COALESCE(NEW.project_id,'')<>COALESCE((SELECT project_id FROM supplier_credit_refund_projects WHERE refund_id=NEW.entity_id),'')
 OR NEW.mime_type IS NULL OR NEW.mime_type NOT IN ('application/pdf','image/png','image/jpeg','image/webp') OR NEW.size_bytes<=0 OR NEW.size_bytes>26214400
 OR NEW.sha256 IS NULL OR LENGTH(NEW.sha256)<>64 OR NEW.sha256 GLOB '*[^0-9a-f]*'
 OR (NEW.mime_type='application/pdf' AND NEW.stored_name NOT GLOB '*.pdf') OR (NEW.mime_type='image/png' AND NEW.stored_name NOT GLOB '*.png')
 OR (NEW.mime_type='image/jpeg' AND NEW.stored_name NOT GLOB '*.jpg') OR (NEW.mime_type='image/webp' AND NEW.stored_name NOT GLOB '*.webp')
 OR EXISTS(SELECT 1 FROM attachments WHERE entity_type='supplier_credit_refund' AND entity_id=NEW.entity_id AND sha256=NEW.sha256)
 OR (SELECT COUNT(*) FROM attachments WHERE entity_type='supplier_credit_refund' AND entity_id=NEW.entity_id)>=20
)
BEGIN SELECT RAISE(ABORT,'Justificatif de remboursement invalide, doublon ou limite de 20 pièces atteinte.'); END;
CREATE TRIGGER IF NOT EXISTS supplier_credit_refund_attachment_no_delete BEFORE DELETE ON attachments WHEN OLD.entity_type='supplier_credit_refund' BEGIN SELECT RAISE(ABORT,'Les justificatifs des remboursements comptabilisés sont conservés.'); END;
PRAGMA user_version=52;
