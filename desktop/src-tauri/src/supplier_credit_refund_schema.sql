CREATE TABLE IF NOT EXISTS supplier_credit_refunds (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  supplier_credit_note_id TEXT NOT NULL REFERENCES supplier_credit_notes(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK(event_type IN ('refund','reverse')),
  reverses_id TEXT UNIQUE REFERENCES supplier_credit_refunds(id) ON DELETE RESTRICT,
  date TEXT NOT NULL CHECK(length(date)=10 AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0 AND amount_cents<=9000000000000000),
  reference TEXT NOT NULL CHECK(length(trim(reference)) BETWEEN 1 AND 255),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 1000),
  bank_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  payable_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  journal_entry_id TEXT NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK(bank_account_id<>payable_account_id),
  CHECK((event_type='refund' AND reverses_id IS NULL) OR (event_type='reverse' AND reverses_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_supplier_credit_refunds_credit ON supplier_credit_refunds(supplier_credit_note_id,date,sequence);
CREATE VIEW IF NOT EXISTS supplier_credit_balances AS
SELECT c.id AS supplier_credit_note_id,c.total_cents,
  COALESCE(a.amount,0) AS allocated_cents,COALESCE(r.amount,0) AS refunded_cents,
  c.total_cents-COALESCE(a.amount,0)-COALESCE(r.amount,0) AS remaining_cents
FROM supplier_credit_notes c
LEFT JOIN (SELECT supplier_credit_note_id,SUM(CASE event_type WHEN 'apply' THEN amount_cents ELSE -amount_cents END) AS amount FROM supplier_credit_allocations GROUP BY supplier_credit_note_id) a ON a.supplier_credit_note_id=c.id
LEFT JOIN (SELECT supplier_credit_note_id,SUM(CASE event_type WHEN 'refund' THEN amount_cents ELSE -amount_cents END) AS amount FROM supplier_credit_refunds GROUP BY supplier_credit_note_id) r ON r.supplier_credit_note_id=c.id;
CREATE TRIGGER IF NOT EXISTS supplier_credit_refund_no_update BEFORE UPDATE ON supplier_credit_refunds
BEGIN SELECT RAISE(ABORT,'Le remboursement fournisseur comptabilisé est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS supplier_credit_refund_no_delete BEFORE DELETE ON supplier_credit_refunds
BEGIN SELECT RAISE(ABORT,'Le remboursement fournisseur comptabilisé est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS supplier_credit_refund_source BEFORE INSERT ON supplier_credit_refunds
WHEN NOT EXISTS(SELECT 1 FROM supplier_credit_notes c WHERE c.id=NEW.supplier_credit_note_id AND c.status='validated' AND c.currency='CHF' AND NEW.date>=c.document_date)
 OR date(NEW.date,'+0 days') IS NULL OR date(NEW.date,'+0 days')<>NEW.date
 OR NEW.date>date('now','localtime')
 OR NEW.date<=COALESCE((SELECT MAX(date_to) FROM accounting_periods WHERE status='closed'),'0000-00-00')
BEGIN SELECT RAISE(ABORT,'Le remboursement exige un avoir validé et une date effective dans une période ouverte.'); END;
CREATE TRIGGER IF NOT EXISTS supplier_credit_refund_reversal BEFORE INSERT ON supplier_credit_refunds
WHEN NEW.event_type='reverse' AND NOT EXISTS(SELECT 1 FROM supplier_credit_refunds r WHERE r.id=NEW.reverses_id AND r.event_type='refund'
 AND r.supplier_credit_note_id=NEW.supplier_credit_note_id AND r.amount_cents=NEW.amount_cents
 AND r.bank_account_id=NEW.bank_account_id AND r.payable_account_id=NEW.payable_account_id AND NEW.date>=r.date)
BEGIN SELECT RAISE(ABORT,'La correction doit reprendre le remboursement fournisseur d’origine.'); END;
CREATE TRIGGER IF NOT EXISTS supplier_credit_refund_balance AFTER INSERT ON supplier_credit_refunds
WHEN EXISTS(SELECT 1 FROM supplier_credit_balances WHERE supplier_credit_note_id=NEW.supplier_credit_note_id AND (remaining_cents<0 OR refunded_cents<0 OR allocated_cents<0))
BEGIN SELECT RAISE(ABORT,'Le remboursement dépasse le solde disponible de l’avoir.'); END;
CREATE TRIGGER IF NOT EXISTS supplier_credit_allocation_refund_balance AFTER INSERT ON supplier_credit_allocations
WHEN EXISTS(SELECT 1 FROM supplier_credit_balances WHERE supplier_credit_note_id=NEW.supplier_credit_note_id AND (remaining_cents<0 OR refunded_cents<0 OR allocated_cents<0))
BEGIN SELECT RAISE(ABORT,'Une part de cet avoir a déjà été remboursée ; vérifiez le solde disponible.'); END;
CREATE TRIGGER IF NOT EXISTS supplier_credit_refund_journal BEFORE INSERT ON supplier_credit_refunds
WHEN NOT EXISTS(SELECT 1 FROM journal_entries j WHERE j.id=NEW.journal_entry_id AND j.source_type='supplier_credit_refund' AND j.source_id=NEW.id AND j.source_event=NEW.event_type AND j.entry_date=NEW.date
 AND (SELECT COUNT(*) FROM journal_lines WHERE journal_entry_id=j.id)=2
 AND EXISTS(SELECT 1 FROM journal_lines l WHERE l.journal_entry_id=j.id AND l.account_id=NEW.bank_account_id AND l.currency='CHF'
   AND l.debit_cents=CASE NEW.event_type WHEN 'refund' THEN NEW.amount_cents ELSE 0 END
   AND l.credit_cents=CASE NEW.event_type WHEN 'reverse' THEN NEW.amount_cents ELSE 0 END)
 AND EXISTS(SELECT 1 FROM journal_lines l WHERE l.journal_entry_id=j.id AND l.account_id=NEW.payable_account_id AND l.currency='CHF'
   AND l.credit_cents=CASE NEW.event_type WHEN 'refund' THEN NEW.amount_cents ELSE 0 END
   AND l.debit_cents=CASE NEW.event_type WHEN 'reverse' THEN NEW.amount_cents ELSE 0 END))
BEGIN SELECT RAISE(ABORT,'Le remboursement doit correspondre exactement à son écriture bancaire.'); END;
CREATE TRIGGER IF NOT EXISTS supplier_credit_refund_payable BEFORE INSERT ON supplier_credit_refunds
WHEN NOT EXISTS (
 SELECT 1 FROM supplier_credit_notes c JOIN journal_entries j ON j.id=c.validation_journal_entry_id
 JOIN journal_lines l ON l.journal_entry_id=j.id JOIN accounts a ON a.id=l.account_id
 JOIN accounts bank ON bank.id=NEW.bank_account_id
 WHERE c.id=NEW.supplier_credit_note_id AND j.source_type='supplier_credit_note' AND j.source_id=c.id
 AND l.account_id=NEW.payable_account_id AND a.account_type='liability' AND a.active=1
 AND bank.account_type='asset' AND bank.active=1 AND l.debit_cents=c.total_cents AND l.credit_cents=0
 AND NOT EXISTS(SELECT 1 FROM journal_entries r WHERE r.reversal_of=j.id)
)
BEGIN SELECT RAISE(ABORT,'Le compte fournisseur doit reprendre celui de l’avoir comptabilisé.'); END;
CREATE VIEW IF NOT EXISTS supplier_credit_settlement_timeline AS
WITH events AS (
 SELECT supplier_credit_note_id,effective_date AS date,CASE event_type WHEN 'apply' THEN amount_cents ELSE -amount_cents END AS amount FROM supplier_credit_allocations WHERE effective_date IS NOT NULL
 UNION ALL
 SELECT supplier_credit_note_id,date,CASE event_type WHEN 'refund' THEN amount_cents ELSE -amount_cents END FROM supplier_credit_refunds
)
SELECT supplier_credit_note_id,date,SUM(amount) OVER (PARTITION BY supplier_credit_note_id ORDER BY date RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS settled_cents FROM events;
CREATE TRIGGER IF NOT EXISTS supplier_credit_refund_chronology AFTER INSERT ON supplier_credit_refunds
WHEN EXISTS(SELECT 1 FROM supplier_credit_settlement_timeline t JOIN supplier_credit_notes c ON c.id=t.supplier_credit_note_id WHERE c.id=NEW.supplier_credit_note_id AND (t.settled_cents<0 OR t.settled_cents>c.total_cents))
BEGIN SELECT RAISE(ABORT,'La chronologie des règlements dépasse le solde historique de l’avoir fournisseur.'); END;
CREATE TRIGGER IF NOT EXISTS supplier_credit_allocation_refund_chronology AFTER INSERT ON supplier_credit_allocations
WHEN EXISTS(SELECT 1 FROM supplier_credit_settlement_timeline t JOIN supplier_credit_notes c ON c.id=t.supplier_credit_note_id WHERE c.id=NEW.supplier_credit_note_id AND (t.settled_cents<0 OR t.settled_cents>c.total_cents))
BEGIN SELECT RAISE(ABORT,'La chronologie des règlements dépasse le solde historique de l’avoir fournisseur.'); END;
PRAGMA user_version=51;
