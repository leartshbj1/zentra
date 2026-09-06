CREATE TABLE IF NOT EXISTS bank_customer_credit_refund_matches (
 id TEXT PRIMARY KEY, movement_id TEXT NOT NULL REFERENCES bank_movements(id), refund_id TEXT NOT NULL REFERENCES customer_credit_settlements(id),
 date_difference_reason TEXT CHECK(date_difference_reason IS NULL OR length(trim(date_difference_reason)) BETWEEN 5 AND 500),
 source_json TEXT NOT NULL CHECK(json_valid(source_json)), confirmed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_customer_refund_movement ON bank_customer_credit_refund_matches(movement_id);
CREATE INDEX IF NOT EXISTS idx_bank_customer_refund_source ON bank_customer_credit_refund_matches(refund_id);
CREATE TABLE IF NOT EXISTS bank_customer_credit_refund_unlinks (
 id TEXT PRIMARY KEY, match_id TEXT NOT NULL UNIQUE REFERENCES bank_customer_credit_refund_matches(id), reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 500), unlinked_at TEXT NOT NULL
);
CREATE VIEW IF NOT EXISTS active_bank_customer_credit_refund_matches AS SELECT m.* FROM bank_customer_credit_refund_matches m WHERE NOT EXISTS(SELECT 1 FROM bank_customer_credit_refund_unlinks u WHERE u.match_id=m.id);
CREATE TABLE IF NOT EXISTS bank_customer_credit_refund_requests (
 id TEXT PRIMARY KEY, request_json TEXT NOT NULL CHECK(json_valid(request_json)), refund_id TEXT NOT NULL UNIQUE REFERENCES customer_credit_settlements(id),
 match_id TEXT NOT NULL UNIQUE REFERENCES bank_customer_credit_refund_matches(id), attachment_id TEXT REFERENCES attachments(id), created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS bank_customer_refund_match_no_update BEFORE UPDATE ON bank_customer_credit_refund_matches BEGIN SELECT RAISE(ABORT,'Le rapprochement client est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_customer_refund_match_no_delete BEFORE DELETE ON bank_customer_credit_refund_matches BEGIN SELECT RAISE(ABORT,'Le rapprochement client est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_customer_refund_unlink_no_update BEFORE UPDATE ON bank_customer_credit_refund_unlinks BEGIN SELECT RAISE(ABORT,'La dissociation est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_customer_refund_unlink_no_delete BEFORE DELETE ON bank_customer_credit_refund_unlinks BEGIN SELECT RAISE(ABORT,'La dissociation est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_customer_refund_request_no_update BEFORE UPDATE ON bank_customer_credit_refund_requests BEGIN SELECT RAISE(ABORT,'La demande bancaire est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_customer_refund_request_no_delete BEFORE DELETE ON bank_customer_credit_refund_requests BEGIN SELECT RAISE(ABORT,'La demande bancaire est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_customer_refund_unique_active BEFORE INSERT ON bank_customer_credit_refund_matches
WHEN EXISTS(SELECT 1 FROM active_bank_customer_credit_refund_matches WHERE movement_id=NEW.movement_id OR refund_id=NEW.refund_id)
 OR EXISTS(SELECT 1 FROM active_bank_expense_refund_matches WHERE movement_id=NEW.movement_id)
 OR EXISTS(SELECT 1 FROM active_bank_supplier_credit_refund_matches WHERE movement_id=NEW.movement_id)
 OR EXISTS(SELECT 1 FROM bank_reconciliations WHERE movement_id=NEW.movement_id)
 OR EXISTS(SELECT 1 FROM bank_supplier_reconciliations WHERE movement_id=NEW.movement_id)
 OR EXISTS(SELECT 1 FROM bank_expense_reconciliations WHERE movement_id=NEW.movement_id)
BEGIN SELECT RAISE(ABORT,'Le mouvement ou le remboursement est déjà rapproché.'); END;
CREATE TRIGGER IF NOT EXISTS bank_receipt_exclusive_customer_refund BEFORE INSERT ON bank_reconciliations WHEN EXISTS(SELECT 1 FROM active_bank_customer_credit_refund_matches WHERE movement_id=NEW.movement_id) BEGIN SELECT RAISE(ABORT,'Ce mouvement est lié à un remboursement client.'); END;
CREATE TRIGGER IF NOT EXISTS bank_supplier_exclusive_customer_refund BEFORE INSERT ON bank_supplier_reconciliations WHEN EXISTS(SELECT 1 FROM active_bank_customer_credit_refund_matches WHERE movement_id=NEW.movement_id) BEGIN SELECT RAISE(ABORT,'Ce mouvement est lié à un remboursement client.'); END;
CREATE TRIGGER IF NOT EXISTS bank_expense_exclusive_customer_refund BEFORE INSERT ON bank_expense_reconciliations WHEN EXISTS(SELECT 1 FROM active_bank_customer_credit_refund_matches WHERE movement_id=NEW.movement_id) BEGIN SELECT RAISE(ABORT,'Ce mouvement est lié à un remboursement client.'); END;
CREATE TRIGGER IF NOT EXISTS bank_refund_exclusive_customer_refund BEFORE INSERT ON bank_expense_refund_matches WHEN EXISTS(SELECT 1 FROM active_bank_customer_credit_refund_matches WHERE movement_id=NEW.movement_id) BEGIN SELECT RAISE(ABORT,'Ce mouvement est lié à un remboursement client.'); END;
CREATE TRIGGER IF NOT EXISTS bank_credit_refund_exclusive_customer_refund BEFORE INSERT ON bank_supplier_credit_refund_matches WHEN EXISTS(SELECT 1 FROM active_bank_customer_credit_refund_matches WHERE movement_id=NEW.movement_id) BEGIN SELECT RAISE(ABORT,'Ce mouvement est lié à un remboursement client.'); END;
CREATE TRIGGER IF NOT EXISTS bank_customer_refund_movement_frozen BEFORE UPDATE ON bank_movements WHEN EXISTS(SELECT 1 FROM bank_customer_credit_refund_matches WHERE movement_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Le mouvement lié à l’historique est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_refund_bank_correction BEFORE INSERT ON customer_credit_settlements WHEN NEW.event_type='reverse_refund' AND EXISTS(SELECT 1 FROM active_bank_customer_credit_refund_matches WHERE refund_id=NEW.reverses_id) BEGIN SELECT RAISE(ABORT,'Dissociez d’abord le remboursement du relevé dans Banque.'); END;
CREATE TRIGGER IF NOT EXISTS bank_customer_refund_match_proof BEFORE INSERT ON bank_customer_credit_refund_matches
WHEN NOT EXISTS(
 SELECT 1 FROM customer_credit_settlements r JOIN invoices c ON c.id=r.credit_note_id
 JOIN customer_credit_settlement_postings p ON p.settlement_id=r.id JOIN journal_entries j ON j.id=p.journal_entry_id
 JOIN bank_movements m ON m.id=NEW.movement_id JOIN bank_imports i ON i.id=COALESCE(m.booked_import_id,m.import_id)
 WHERE r.id=NEW.refund_id AND r.event_type='refund' AND NOT EXISTS(SELECT 1 FROM customer_credit_settlements x WHERE x.reverses_id=r.id)
 AND m.status='BOOK' AND m.credit_debit='DBIT' AND m.reversal=0 AND m.currency='CHF' AND m.account_currency='CHF' AND c.currency='CHF' AND m.amount_cents=r.amount_cents
 AND i.message_type='camt.053' AND length(m.strong_key)>0 AND COALESCE(m.booking_date,m.value_date)>=c.issue_date
 AND (COALESCE(m.booking_date,m.value_date)=r.date OR length(trim(NEW.date_difference_reason)) BETWEEN 5 AND 500)
 AND j.source_type='customer_credit_settlement' AND j.source_id=r.id AND j.source_event='refund' AND j.entry_date=r.date AND j.status='posted'
 AND NOT EXISTS(SELECT 1 FROM journal_entries x WHERE x.reversal_of=j.id)
 AND (SELECT COALESCE(SUM(l.credit_cents-l.debit_cents),0) FROM journal_lines l WHERE l.journal_entry_id=j.id AND l.account_id=r.bank_account_id AND l.currency='CHF' AND l.memo='Remboursement au client')=r.amount_cents
)
BEGIN SELECT RAISE(ABORT,'Le débit bancaire doit prouver le remboursement actif de cet avoir client.'); END;
CREATE TRIGGER IF NOT EXISTS bank_customer_refund_creation_proof BEFORE INSERT ON bank_customer_credit_refund_requests
WHEN NOT EXISTS(SELECT 1 FROM bank_customer_credit_refund_matches m JOIN customer_credit_settlements r ON r.id=m.refund_id WHERE m.id=NEW.match_id AND m.id=NEW.id AND r.id=NEW.refund_id AND r.request_id=NEW.id)
 OR (NEW.attachment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.id=NEW.attachment_id AND a.entity_type='customer_credit_settlement' AND a.entity_id=NEW.refund_id))
BEGIN SELECT RAISE(ABORT,'La demande doit conserver son rapprochement et son remboursement.'); END;
PRAGMA user_version=57;
