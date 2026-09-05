CREATE TABLE IF NOT EXISTS bank_expense_refund_matches (
  id TEXT PRIMARY KEY,
  movement_id TEXT NOT NULL REFERENCES bank_movements(id),
  refund_id TEXT NOT NULL REFERENCES expense_refunds(id),
  date_difference_reason TEXT CHECK(date_difference_reason IS NULL OR length(trim(date_difference_reason)) BETWEEN 5 AND 500),
  confirmed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_refund_movement ON bank_expense_refund_matches(movement_id);
CREATE INDEX IF NOT EXISTS idx_bank_refund_source ON bank_expense_refund_matches(refund_id);
CREATE INDEX IF NOT EXISTS idx_expense_refund_bank_candidates ON expense_refunds(total_cents,payment_date DESC);
CREATE TABLE IF NOT EXISTS bank_expense_refund_unlinks (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL UNIQUE REFERENCES bank_expense_refund_matches(id),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 500),
  unlinked_at TEXT NOT NULL
);
CREATE VIEW IF NOT EXISTS active_bank_expense_refund_matches AS
SELECT m.* FROM bank_expense_refund_matches m
WHERE NOT EXISTS(SELECT 1 FROM bank_expense_refund_unlinks u WHERE u.match_id=m.id);
CREATE TRIGGER IF NOT EXISTS bank_refund_match_immutable_update BEFORE UPDATE ON bank_expense_refund_matches
BEGIN SELECT RAISE(ABORT,'Le rapprochement du remboursement est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_refund_match_immutable_delete BEFORE DELETE ON bank_expense_refund_matches
BEGIN SELECT RAISE(ABORT,'Le rapprochement du remboursement est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_refund_unlink_immutable_update BEFORE UPDATE ON bank_expense_refund_unlinks
BEGIN SELECT RAISE(ABORT,'La dissociation du remboursement est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_refund_unlink_immutable_delete BEFORE DELETE ON bank_expense_refund_unlinks
BEGIN SELECT RAISE(ABORT,'La dissociation du remboursement est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS bank_refund_unique_active BEFORE INSERT ON bank_expense_refund_matches
WHEN EXISTS(SELECT 1 FROM active_bank_expense_refund_matches WHERE movement_id=NEW.movement_id OR refund_id=NEW.refund_id)
 OR EXISTS(SELECT 1 FROM bank_reconciliations WHERE movement_id=NEW.movement_id)
 OR EXISTS(SELECT 1 FROM bank_supplier_reconciliations WHERE movement_id=NEW.movement_id)
 OR EXISTS(SELECT 1 FROM bank_expense_reconciliations WHERE movement_id=NEW.movement_id)
BEGIN SELECT RAISE(ABORT,'Le mouvement ou le remboursement est déjà rapproché.'); END;
CREATE TRIGGER IF NOT EXISTS bank_customer_exclusive_refund BEFORE INSERT ON bank_reconciliations
WHEN EXISTS(SELECT 1 FROM active_bank_expense_refund_matches WHERE movement_id=NEW.movement_id)
BEGIN SELECT RAISE(ABORT,'Ce mouvement est déjà rapproché avec un remboursement.'); END;
CREATE TRIGGER IF NOT EXISTS bank_supplier_exclusive_refund BEFORE INSERT ON bank_supplier_reconciliations
WHEN EXISTS(SELECT 1 FROM active_bank_expense_refund_matches WHERE movement_id=NEW.movement_id)
BEGIN SELECT RAISE(ABORT,'Ce mouvement est déjà rapproché avec un remboursement.'); END;
CREATE TRIGGER IF NOT EXISTS bank_expense_exclusive_refund BEFORE INSERT ON bank_expense_reconciliations
WHEN EXISTS(SELECT 1 FROM active_bank_expense_refund_matches WHERE movement_id=NEW.movement_id)
BEGIN SELECT RAISE(ABORT,'Ce mouvement est déjà rapproché avec un remboursement.'); END;
CREATE TRIGGER IF NOT EXISTS bank_refund_movement_frozen BEFORE UPDATE ON bank_movements
WHEN EXISTS(SELECT 1 FROM bank_expense_refund_matches WHERE movement_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Le mouvement lié à un historique de remboursement est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS expense_refund_bank_correction_guard BEFORE INSERT ON expense_refunds
WHEN NEW.event_type='reverse' AND EXISTS(SELECT 1 FROM active_bank_expense_refund_matches WHERE refund_id=NEW.reverses_id)
BEGIN SELECT RAISE(ABORT,'Dissociez d’abord le remboursement du relevé dans Banque avant de corriger sa saisie.'); END;
CREATE TRIGGER IF NOT EXISTS bank_refund_match_proof BEFORE INSERT ON bank_expense_refund_matches
WHEN NOT EXISTS(
 SELECT 1 FROM expense_refunds r JOIN bank_movements m ON m.id=NEW.movement_id
 JOIN journal_entries j ON j.id=r.payment_journal_id
 WHERE r.id=NEW.refund_id AND r.event_type='refund'
 AND NOT EXISTS(SELECT 1 FROM expense_refunds x WHERE x.reverses_id=r.id)
 AND m.status='BOOK' AND m.credit_debit='CRDT' AND m.reversal=0
 AND m.currency='CHF' AND m.account_currency='CHF' AND m.amount_cents=r.total_cents
 AND COALESCE(m.booking_date,m.value_date)>=r.credit_date
 AND (COALESCE(m.booking_date,m.value_date)=r.payment_date OR length(trim(NEW.date_difference_reason)) BETWEEN 5 AND 500)
 AND j.source_type='expense_refund' AND j.source_id=r.id AND j.source_event='payment' AND j.entry_date=r.payment_date
 AND NOT EXISTS(SELECT 1 FROM journal_entries x WHERE x.reversal_of=j.id)
)
BEGIN SELECT RAISE(ABORT,'Le crédit bancaire doit correspondre à un remboursement actif comptabilisé.'); END;
PRAGMA user_version=48;
