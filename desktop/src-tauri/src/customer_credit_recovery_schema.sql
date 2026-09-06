-- An explicit user-confirmed adoption, never an automatic date assignment.
CREATE TABLE IF NOT EXISTS customer_credit_recoveries (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  original_invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS customer_credit_recovery_no_update BEFORE UPDATE ON customer_credit_recoveries
BEGIN SELECT RAISE(ABORT,'La reprise documentée des avoirs est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_recovery_no_delete BEFORE DELETE ON customer_credit_recoveries
BEGIN SELECT RAISE(ABORT,'La reprise documentée des avoirs est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_recovery_source BEFORE INSERT ON customer_credit_recoveries
WHEN NOT EXISTS(SELECT 1 FROM invoices i WHERE i.id=NEW.original_invoice_id AND i.type<>'avoir' AND i.number IS NOT NULL AND i.status NOT IN ('annulee','brouillon'))
 OR json_extract(NEW.request_json,'$.original_invoice_id') IS NOT NEW.original_invoice_id
 OR json_extract(NEW.request_json,'$.no_prior_refund') IS NOT 1
 OR json_array_length(NEW.request_json,'$.credits')<1
 OR EXISTS(SELECT 1 FROM json_each(NEW.request_json,'$.credits') c WHERE NOT EXISTS(
   SELECT 1 FROM customer_credit_documents d JOIN invoices i ON i.id=d.credit_note_id
   WHERE i.id=json_extract(c.value,'$.credit_note_id') AND i.original_invoice_id=NEW.original_invoice_id))
BEGIN SELECT RAISE(ABORT,'La reprise doit conserver ses avoirs et la confirmation des règlements.'); END;
PRAGMA user_version=55;
