-- Active matches retain their existing uniqueness constraints. Removing one requires
-- an immutable, complete archival record; creation receipts refer to a stable registry.
CREATE TABLE IF NOT EXISTS bank_expense_reconciliation_registry (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO bank_expense_reconciliation_registry SELECT id,confirmed_at FROM bank_expense_reconciliations;

DROP TRIGGER IF EXISTS bank_expense_creation_immutable_update;
DROP TRIGGER IF EXISTS bank_expense_creation_immutable_delete;
DROP TRIGGER IF EXISTS bank_expense_attachment_immutable_update;
CREATE TABLE bank_expense_creation_requests_v46 (
  request_id TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  reconciliation_id TEXT NOT NULL UNIQUE REFERENCES bank_expense_reconciliation_registry(id) ON DELETE RESTRICT,
  attachment_id TEXT NOT NULL UNIQUE REFERENCES attachments(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
INSERT INTO bank_expense_creation_requests_v46 SELECT * FROM bank_expense_creation_requests;
DROP TABLE bank_expense_creation_requests;
ALTER TABLE bank_expense_creation_requests_v46 RENAME TO bank_expense_creation_requests;
CREATE TRIGGER bank_expense_creation_immutable_update BEFORE UPDATE ON bank_expense_creation_requests
BEGIN SELECT RAISE(ABORT,'La preuve de création bancaire est immuable.'); END;
CREATE TRIGGER bank_expense_creation_immutable_delete BEFORE DELETE ON bank_expense_creation_requests
BEGIN SELECT RAISE(ABORT,'La preuve de création bancaire est immuable.'); END;
CREATE TRIGGER bank_expense_attachment_immutable_update BEFORE UPDATE ON attachments
WHEN EXISTS(SELECT 1 FROM bank_expense_creation_requests WHERE attachment_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Le justificatif bancaire comptabilisé est figé.'); END;

CREATE TABLE IF NOT EXISTS bank_expense_unreconciliations (
  id TEXT PRIMARY KEY REFERENCES bank_expense_reconciliation_registry(id),
  request_id TEXT NOT NULL UNIQUE,
  movement_id TEXT NOT NULL REFERENCES bank_movements(id),
  expense_id TEXT NOT NULL REFERENCES expenses(id),
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  date_difference_reason TEXT,
  confirmed_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 500),
  unlinked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_expense_unreconciliations_movement ON bank_expense_unreconciliations(movement_id,unlinked_at DESC,id);
CREATE TRIGGER IF NOT EXISTS bank_expense_registry_no_update BEFORE UPDATE ON bank_expense_reconciliation_registry
BEGIN SELECT RAISE(ABORT,'bank expense registry is immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_expense_registry_no_delete BEFORE DELETE ON bank_expense_reconciliation_registry
BEGIN SELECT RAISE(ABORT,'bank expense registry is immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_expense_register AFTER INSERT ON bank_expense_reconciliations
BEGIN INSERT INTO bank_expense_reconciliation_registry VALUES(NEW.id,NEW.confirmed_at); END;
CREATE TRIGGER IF NOT EXISTS bank_expense_unreconciliations_no_update BEFORE UPDATE ON bank_expense_unreconciliations
BEGIN SELECT RAISE(ABORT,'bank expense correction history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_expense_unreconciliations_no_delete BEFORE DELETE ON bank_expense_unreconciliations
BEGIN SELECT RAISE(ABORT,'bank expense correction history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_expense_unreconciliations_proof BEFORE INSERT ON bank_expense_unreconciliations
WHEN NOT EXISTS (
 SELECT 1 FROM bank_expense_reconciliations r WHERE r.id=NEW.id
 AND r.movement_id=NEW.movement_id AND r.expense_id=NEW.expense_id
 AND r.journal_entry_id=NEW.journal_entry_id AND r.amount_cents=NEW.amount_cents
 AND r.date_difference_reason IS NEW.date_difference_reason AND r.confirmed_at=NEW.confirmed_at
)
BEGIN SELECT RAISE(ABORT,'bank expense correction requires the exact original match'); END;
DROP TRIGGER bank_expense_reconciliations_no_delete;
CREATE TRIGGER bank_expense_reconciliations_no_delete BEFORE DELETE ON bank_expense_reconciliations
WHEN NOT EXISTS (
 SELECT 1 FROM bank_expense_unreconciliations h WHERE h.id=OLD.id
 AND h.movement_id=OLD.movement_id AND h.expense_id=OLD.expense_id
 AND h.journal_entry_id=OLD.journal_entry_id AND h.amount_cents=OLD.amount_cents
 AND h.date_difference_reason IS OLD.date_difference_reason AND h.confirmed_at=OLD.confirmed_at
)
BEGIN SELECT RAISE(ABORT,'bank expense unlink requires an immutable correction proof'); END;
-- A corrected match is still historical evidence: neither re-import nor an isolated
-- reversal may rewrite the movement or silently invalidate its recorded payment/VAT.
DROP TRIGGER bank_movements_expense_frozen;
CREATE TRIGGER bank_movements_expense_frozen BEFORE UPDATE ON bank_movements
WHEN EXISTS(SELECT 1 FROM bank_expense_reconciliations WHERE movement_id=OLD.id)
 OR EXISTS(SELECT 1 FROM bank_expense_unreconciliations WHERE movement_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'bank expense movement with accounting history is immutable'); END;
DROP TRIGGER bank_expense_journal_no_isolated_reversal;
CREATE TRIGGER bank_expense_journal_no_isolated_reversal BEFORE INSERT ON journal_entries
WHEN EXISTS(SELECT 1 FROM bank_expense_reconciliations WHERE journal_entry_id=NEW.reversal_of)
 OR EXISTS(SELECT 1 FROM bank_expense_unreconciliations WHERE journal_entry_id=NEW.reversal_of)
BEGIN SELECT RAISE(ABORT,'recorded bank expense payment cannot be reversed in isolation'); END;
PRAGMA user_version=46;
