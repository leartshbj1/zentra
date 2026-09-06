-- Received-basis adoption keeps the original ledger and posts explicit adjustments.
CREATE TABLE IF NOT EXISTS customer_credit_recovery_tax_models (
 original_invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE RESTRICT,
 recovery_id TEXT NOT NULL UNIQUE REFERENCES customer_credit_recoveries(id) DEFERRABLE INITIALLY DEFERRED,
 model TEXT NOT NULL CHECK(model='received_v1'),
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customer_credit_recovery_postings (
 id TEXT PRIMARY KEY,
 recovery_id TEXT NOT NULL REFERENCES customer_credit_recoveries(id) DEFERRABLE INITIALLY DEFERRED,
 original_invoice_id TEXT NOT NULL REFERENCES customer_credit_recovery_tax_models(original_invoice_id),
 source_type TEXT NOT NULL CHECK(source_type IN ('credit','payment')),
 source_id TEXT NOT NULL,
 date TEXT NOT NULL,
 source_json TEXT NOT NULL CHECK(json_valid(source_json)),
 parts_json TEXT NOT NULL CHECK(json_valid(parts_json)),
 expected_vat_cents INTEGER NOT NULL,
 due_change_cents INTEGER NOT NULL,
 journal_entry_id TEXT UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 created_at TEXT NOT NULL,
 UNIQUE(source_type,source_id)
);
CREATE TRIGGER IF NOT EXISTS customer_recovery_tax_model_no_update BEFORE UPDATE ON customer_credit_recovery_tax_models BEGIN SELECT RAISE(ABORT,'La reprise TVA est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS customer_recovery_tax_model_no_delete BEFORE DELETE ON customer_credit_recovery_tax_models BEGIN SELECT RAISE(ABORT,'La reprise TVA est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS customer_recovery_posting_no_update BEFORE UPDATE ON customer_credit_recovery_postings BEGIN SELECT RAISE(ABORT,'La preuve de reprise TVA est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS customer_recovery_posting_no_delete BEFORE DELETE ON customer_credit_recovery_postings BEGIN SELECT RAISE(ABORT,'La preuve de reprise TVA est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS customer_recovery_posting_source BEFORE INSERT ON customer_credit_recovery_postings
WHEN NOT EXISTS(SELECT 1 FROM customer_credit_recovery_tax_models m WHERE m.original_invoice_id=NEW.original_invoice_id AND m.recovery_id=NEW.recovery_id)
 OR (NEW.source_type='credit' AND NOT EXISTS(SELECT 1 FROM invoices i JOIN customer_credit_documents d ON d.credit_note_id=i.id WHERE i.id=NEW.source_id AND i.original_invoice_id=NEW.original_invoice_id AND i.issue_date=NEW.date))
 OR (NEW.source_type='payment' AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.id=NEW.source_id AND p.invoice_id=NEW.original_invoice_id AND p.date=NEW.date))
 OR (NEW.journal_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entries j WHERE j.id=NEW.journal_entry_id AND j.source_type='customer_credit_recovery' AND j.source_id=NEW.id AND j.source_event=NEW.source_type AND j.entry_date=NEW.date AND j.status='posted' AND j.reversal_of IS NULL))
BEGIN SELECT RAISE(ABORT,'La correction TVA doit conserver son origine et sa date.'); END;
CREATE VIEW IF NOT EXISTS customer_cash_vat_lines AS
 SELECT p.invoice_id,p.id AS payment_id,j.id AS journal_entry_id,j.entry_date,l.account_id,l.memo,l.debit_cents,l.credit_cents
 FROM payments p JOIN journal_entries j ON j.source_type='vat_cash_reclassification' AND j.source_id=p.id JOIN journal_lines l ON l.journal_entry_id=j.id
 UNION ALL
 SELECT r.original_invoice_id,r.source_id,j.id,j.entry_date,l.account_id,l.memo,l.debit_cents,l.credit_cents
 FROM customer_credit_recovery_postings r JOIN journal_entries j ON j.id=r.journal_entry_id JOIN journal_lines l ON l.journal_entry_id=j.id WHERE r.source_type='payment'
 UNION ALL
 SELECT e.invoice_id,NULL,j.id,j.entry_date,l.account_id,l.memo,l.debit_cents,l.credit_cents
 FROM customer_credit_settlements e JOIN customer_credit_settlement_postings p ON p.settlement_id=e.id JOIN journal_entries j ON j.id=p.journal_entry_id JOIN journal_lines l ON l.journal_entry_id=j.id WHERE e.invoice_id IS NOT NULL;
-- Use actual dated applications for new-model credits; retain face value for legacy credits.
DROP TRIGGER IF EXISTS payments_invoice_issue_date_guard;
CREATE TRIGGER IF NOT EXISTS payments_invoice_issue_date_guard BEFORE INSERT ON payments
WHEN NOT EXISTS(
 SELECT 1 FROM invoices invoice WHERE invoice.id=NEW.invoice_id
 AND invoice.number IS NOT NULL AND invoice.type<>'avoir'
 AND invoice.status IN('emise','en_retard','partiellement_payee','payee')
 AND invoice.issue_date IS NOT NULL AND LENGTH(NEW.date)=10
 AND NEW.date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
 AND DATE(NEW.date) IS NOT NULL AND DATE(NEW.date)=NEW.date AND NEW.date>=invoice.issue_date
 AND invoice.total_cents>0
 AND NEW.amount_cents<=invoice.total_cents
 - COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id=invoice.id),0)
 - COALESCE((SELECT SUM(e.amount_cents) FROM customer_invoice_credit_movements e WHERE e.invoice_id=invoice.id),0)
)
BEGIN SELECT RAISE(ABORT,'payment requires an issued active invoice and cannot exceed its open balance'); END;
PRAGMA user_version=56;
