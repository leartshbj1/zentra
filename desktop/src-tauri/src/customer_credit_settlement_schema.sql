-- Empty additive ledgers. Migration never assigns settlement dates to legacy credits.
CREATE TABLE IF NOT EXISTS customer_credit_documents (
  credit_note_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE RESTRICT,
  model TEXT NOT NULL CHECK(model='dated_v1'),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS customer_credit_document_source BEFORE INSERT ON customer_credit_documents
WHEN NOT EXISTS(SELECT 1 FROM invoices WHERE id=NEW.credit_note_id AND type='avoir' AND number IS NOT NULL AND status<>'annulee' AND total_cents<0)
BEGIN SELECT RAISE(ABORT,'Le registre client exige un avoir émis.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_document_no_update BEFORE UPDATE ON customer_credit_documents
BEGIN SELECT RAISE(ABORT,'Le mode de règlement de l’avoir est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_document_no_delete BEFORE DELETE ON customer_credit_documents
BEGIN SELECT RAISE(ABORT,'Le mode de règlement de l’avoir est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_settled_document_status BEFORE UPDATE OF status ON invoices
WHEN NEW.status IN ('annulee','brouillon') AND EXISTS(SELECT 1 FROM customer_credit_settlements WHERE credit_note_id=OLD.id OR invoice_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Un document réglé par un avoir ne peut pas être annulé ou remis en brouillon.'); END;

CREATE TABLE IF NOT EXISTS customer_credit_settlements (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  credit_note_id TEXT NOT NULL REFERENCES customer_credit_documents(credit_note_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK(event_type IN ('apply','refund','reverse_apply','reverse_refund')),
  reverses_id TEXT UNIQUE REFERENCES customer_credit_settlements(id) ON DELETE RESTRICT,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE RESTRICT,
  date TEXT NOT NULL CHECK(length(date)=10 AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0 AND amount_cents<=9000000000000000),
  reference TEXT NOT NULL CHECK(length(trim(reference)) BETWEEN 1 AND 255),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 1000),
  bank_account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK((event_type IN ('apply','reverse_apply') AND invoice_id IS NOT NULL AND bank_account_id IS NULL)
     OR (event_type IN ('refund','reverse_refund') AND invoice_id IS NULL AND bank_account_id IS NOT NULL)),
  CHECK((event_type IN ('apply','refund') AND reverses_id IS NULL)
     OR (event_type IN ('reverse_apply','reverse_refund') AND reverses_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_customer_credit_settlement_credit ON customer_credit_settlements(credit_note_id,date,sequence);
CREATE INDEX IF NOT EXISTS idx_customer_credit_settlement_invoice ON customer_credit_settlements(invoice_id,date,sequence);
CREATE TABLE IF NOT EXISTS customer_credit_settlement_lines (
  settlement_id TEXT NOT NULL REFERENCES customer_credit_settlements(id) ON DELETE RESTRICT,
  side TEXT NOT NULL CHECK(side IN ('credit','invoice')),
  invoice_item_id TEXT NOT NULL REFERENCES invoice_items(id) ON DELETE RESTRICT,
  gross_cents INTEGER NOT NULL CHECK(typeof(gross_cents)='integer'),
  vat_cents INTEGER NOT NULL CHECK(typeof(vat_cents)='integer'),
  PRIMARY KEY(settlement_id,side,invoice_item_id)
);
CREATE TABLE IF NOT EXISTS customer_credit_settlement_postings (
  settlement_id TEXT PRIMARY KEY REFERENCES customer_credit_settlements(id) ON DELETE RESTRICT,
  journal_entry_id TEXT NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS customer_credit_settlement_posting_no_update BEFORE UPDATE ON customer_credit_settlement_postings
BEGIN SELECT RAISE(ABORT,'La preuve comptable du règlement client est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_settlement_posting_no_delete BEFORE DELETE ON customer_credit_settlement_postings
BEGIN SELECT RAISE(ABORT,'La preuve comptable du règlement client est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_settlement_posting_source BEFORE INSERT ON customer_credit_settlement_postings
WHEN NOT EXISTS(SELECT 1 FROM customer_credit_settlements e JOIN journal_entries j ON j.id=NEW.journal_entry_id WHERE e.id=NEW.settlement_id
 AND j.source_type='customer_credit_settlement' AND j.source_id=e.id AND j.source_event=e.event_type AND j.entry_date=e.date AND j.reversal_of IS NULL)
BEGIN SELECT RAISE(ABORT,'La preuve comptable ne correspond pas au règlement client.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_settlement_no_update BEFORE UPDATE ON customer_credit_settlements
BEGIN SELECT RAISE(ABORT,'Le règlement de l’avoir client est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_settlement_no_delete BEFORE DELETE ON customer_credit_settlements
BEGIN SELECT RAISE(ABORT,'Le règlement de l’avoir client est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_settlement_line_no_update BEFORE UPDATE ON customer_credit_settlement_lines
BEGIN SELECT RAISE(ABORT,'La ventilation du règlement client est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_settlement_line_no_delete BEFORE DELETE ON customer_credit_settlement_lines
BEGIN SELECT RAISE(ABORT,'La ventilation du règlement client est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_settlement_source BEFORE INSERT ON customer_credit_settlements
WHEN date(NEW.date,'+0 days') IS NULL OR date(NEW.date,'+0 days')<>NEW.date
 OR NEW.date>date('now','localtime')
 OR NEW.date<=COALESCE((SELECT MAX(date_to) FROM accounting_periods WHERE status='closed'),'0000-00-00')
 OR NOT EXISTS(SELECT 1 FROM invoices WHERE id=NEW.credit_note_id AND type='avoir' AND number IS NOT NULL AND status<>'annulee' AND NEW.date>=issue_date)
 OR (NEW.invoice_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM invoices i JOIN invoices c ON c.id=NEW.credit_note_id WHERE i.id=NEW.invoice_id AND i.type<>'avoir' AND i.number IS NOT NULL AND i.status<>'annulee' AND i.total_cents>0 AND NEW.date>=i.issue_date AND i.client_id=c.client_id AND i.currency=c.currency))
BEGIN SELECT RAISE(ABORT,'Le règlement exige des documents émis du même client et une date effective dans une période ouverte.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_settlement_reversal BEFORE INSERT ON customer_credit_settlements
WHEN NEW.reverses_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM customer_credit_settlements e WHERE e.id=NEW.reverses_id AND e.credit_note_id=NEW.credit_note_id
 AND e.event_type=CASE NEW.event_type WHEN 'reverse_apply' THEN 'apply' WHEN 'reverse_refund' THEN 'refund' END
 AND e.invoice_id IS NEW.invoice_id AND e.bank_account_id IS NEW.bank_account_id AND e.amount_cents=NEW.amount_cents AND e.date<=NEW.date
)
BEGIN SELECT RAISE(ABORT,'L’extourne doit reprendre le règlement client d’origine.'); END;
CREATE TRIGGER IF NOT EXISTS customer_credit_settlement_line_source BEFORE INSERT ON customer_credit_settlement_lines
WHEN NOT EXISTS(SELECT 1 FROM customer_credit_settlements e JOIN invoice_items l ON l.id=NEW.invoice_item_id
 WHERE e.id=NEW.settlement_id AND l.invoice_id=CASE NEW.side WHEN 'credit' THEN e.credit_note_id ELSE e.invoice_id END)
BEGIN SELECT RAISE(ABORT,'La ventilation doit reprendre une ligne du document réglé.'); END;

CREATE VIEW IF NOT EXISTS customer_invoice_credit_movements AS
SELECT c.id,c.original_invoice_id AS invoice_id,c.id AS credit_note_id,c.issue_date AS date,c.created_at,-c.total_cents AS amount_cents
FROM invoices c WHERE c.type='avoir' AND c.number IS NOT NULL AND c.status<>'annulee'
 AND NOT EXISTS(SELECT 1 FROM customer_credit_documents d WHERE d.credit_note_id=c.id)
UNION ALL
SELECT e.id,e.invoice_id,e.credit_note_id,e.date,e.created_at,
 CASE e.event_type WHEN 'apply' THEN e.amount_cents ELSE -e.amount_cents END
FROM customer_credit_settlements e WHERE e.event_type IN ('apply','reverse_apply');
CREATE VIEW IF NOT EXISTS customer_credit_balances AS
SELECT c.id AS credit_note_id,-c.total_cents AS total_cents,
 COALESCE(SUM(CASE e.event_type WHEN 'apply' THEN e.amount_cents WHEN 'reverse_apply' THEN -e.amount_cents ELSE 0 END),0) AS allocated_cents,
 COALESCE(SUM(CASE e.event_type WHEN 'refund' THEN e.amount_cents WHEN 'reverse_refund' THEN -e.amount_cents ELSE 0 END),0) AS refunded_cents,
 -c.total_cents-COALESCE(SUM(CASE WHEN e.event_type IN ('apply','refund') THEN e.amount_cents ELSE -e.amount_cents END),0) AS remaining_cents
FROM customer_credit_documents d JOIN invoices c ON c.id=d.credit_note_id
LEFT JOIN customer_credit_settlements e ON e.credit_note_id=c.id GROUP BY c.id;
CREATE TRIGGER IF NOT EXISTS customer_credit_settlement_balance AFTER INSERT ON customer_credit_settlements
WHEN EXISTS(SELECT 1 FROM customer_credit_balances b WHERE b.credit_note_id=NEW.credit_note_id AND (b.remaining_cents<0 OR b.allocated_cents<0 OR b.refunded_cents<0))
 OR (NEW.invoice_id IS NOT NULL AND EXISTS(SELECT 1 FROM invoices i WHERE i.id=NEW.invoice_id AND
   (COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id=i.id),0)
   +COALESCE((SELECT SUM(e.amount_cents) FROM customer_invoice_credit_movements e WHERE e.invoice_id=i.id),0)>i.total_cents
   OR COALESCE((SELECT SUM(e.amount_cents) FROM customer_invoice_credit_movements e WHERE e.invoice_id=i.id),0)<0)))
BEGIN SELECT RAISE(ABORT,'Le règlement dépasse le solde disponible de l’avoir ou de la facture.'); END;
PRAGMA user_version=53;
