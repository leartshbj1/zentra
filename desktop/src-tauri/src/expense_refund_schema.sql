CREATE TABLE IF NOT EXISTS expense_refunds (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK(event_type IN ('refund','reverse')),
  reverses_id TEXT UNIQUE REFERENCES expense_refunds(id) ON DELETE RESTRICT,
  credit_date TEXT NOT NULL CHECK(length(credit_date)=10),
  payment_date TEXT NOT NULL CHECK(length(payment_date)=10 AND payment_date>=credit_date),
  reference TEXT NOT NULL CHECK(length(trim(reference)) BETWEEN 1 AND 255),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 1000),
  net_cents INTEGER NOT NULL CHECK(net_cents>=0),
  vat_cents INTEGER NOT NULL CHECK(vat_cents>=0),
  total_cents INTEGER NOT NULL CHECK(total_cents>0 AND total_cents=net_cents+vat_cents),
  cost_cents INTEGER NOT NULL CHECK(cost_cents>=net_cents AND cost_cents<=total_cents),
  treatment TEXT NOT NULL CHECK(treatment IN ('input_materials','input_investments','non_deductible')),
  expense_account_id TEXT REFERENCES accounts(id),
  vat_account_id TEXT REFERENCES accounts(id),
  bank_account_id TEXT NOT NULL REFERENCES accounts(id),
  clearing_account_id TEXT NOT NULL REFERENCES accounts(id),
  credit_journal_id TEXT NOT NULL UNIQUE REFERENCES journal_entries(id),
  payment_journal_id TEXT NOT NULL UNIQUE REFERENCES journal_entries(id),
  created_at TEXT NOT NULL,
  CHECK((event_type='refund' AND reverses_id IS NULL) OR (event_type='reverse' AND reverses_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_expense_refunds_expense ON expense_refunds(expense_id,credit_date,id);
CREATE TRIGGER IF NOT EXISTS expense_refund_immutable_update BEFORE UPDATE ON expense_refunds
BEGIN SELECT RAISE(ABORT,'Le remboursement comptabilisé est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS expense_refund_immutable_delete BEFORE DELETE ON expense_refunds
BEGIN SELECT RAISE(ABORT,'Le remboursement comptabilisé est immuable.'); END;
CREATE TRIGGER IF NOT EXISTS expense_refund_bounds AFTER INSERT ON expense_refunds
WHEN NOT EXISTS(SELECT 1 FROM expenses e WHERE e.id=NEW.expense_id AND e.payment_status='paid' AND e.currency='CHF'
  AND (SELECT SUM(CASE event_type WHEN 'refund' THEN net_cents ELSE -net_cents END) FROM expense_refunds WHERE expense_id=e.id) BETWEEN 0 AND e.net_cents
  AND (SELECT SUM(CASE event_type WHEN 'refund' THEN vat_cents ELSE -vat_cents END) FROM expense_refunds WHERE expense_id=e.id) BETWEEN 0 AND e.vat_cents)
BEGIN SELECT RAISE(ABORT,'Le remboursement dépasse le solde de la dépense.'); END;
-- Check both daily histories: a later correction cannot fund an earlier credit
-- or receipt. RANGE groups same-day corrections without relying on random IDs.
CREATE TRIGGER IF NOT EXISTS expense_refund_timeline_bounds AFTER INSERT ON expense_refunds
WHEN EXISTS(
  WITH dated_events AS (
    SELECT 'credit' AS timeline,credit_date AS event_date,
      CASE event_type WHEN 'refund' THEN net_cents ELSE -net_cents END AS net,
      CASE event_type WHEN 'refund' THEN vat_cents ELSE -vat_cents END AS vat
    FROM expense_refunds WHERE expense_id=NEW.expense_id
    UNION ALL
    SELECT 'payment',payment_date,
      CASE event_type WHEN 'refund' THEN net_cents ELSE -net_cents END,
      CASE event_type WHEN 'refund' THEN vat_cents ELSE -vat_cents END
    FROM expense_refunds WHERE expense_id=NEW.expense_id
  ), balances AS (
    SELECT SUM(net) OVER (PARTITION BY timeline ORDER BY event_date RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS net,
      SUM(vat) OVER (PARTITION BY timeline ORDER BY event_date RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS vat
    FROM dated_events
  )
  SELECT 1 FROM balances b JOIN expenses e ON e.id=NEW.expense_id
  WHERE b.net<0 OR b.net>e.net_cents OR b.vat<0 OR b.vat>e.vat_cents
)
BEGIN SELECT RAISE(ABORT,'Cette date dépasse le solde historique de la dépense. Une correction ultérieure ne peut pas financer un remboursement antérieur.'); END;
CREATE TRIGGER IF NOT EXISTS expense_refund_reversal_guard BEFORE INSERT ON expense_refunds
WHEN NEW.event_type='reverse' AND NOT EXISTS(SELECT 1 FROM expense_refunds r WHERE r.id=NEW.reverses_id AND r.event_type='refund'
  AND r.expense_id=NEW.expense_id AND r.net_cents=NEW.net_cents AND r.vat_cents=NEW.vat_cents AND r.cost_cents=NEW.cost_cents AND r.treatment=NEW.treatment
  AND NEW.credit_date>=r.credit_date AND NEW.payment_date>=r.payment_date)
BEGIN SELECT RAISE(ABORT,'La correction doit reprendre le remboursement d’origine.'); END;
CREATE TRIGGER IF NOT EXISTS expense_refund_vat_history_guard BEFORE UPDATE OF treatment ON vat_source_classifications
WHEN OLD.source_type='expense' AND NEW.treatment<>OLD.treatment AND EXISTS(SELECT 1 FROM expense_refunds WHERE expense_id=OLD.source_id)
BEGIN SELECT RAISE(ABORT,'Cette TVA est liée à un remboursement comptabilisé ; utilisez une correction datée.'); END;
CREATE TRIGGER IF NOT EXISTS expense_refund_vat_history_delete_guard BEFORE DELETE ON vat_source_classifications
WHEN OLD.source_type='expense' AND EXISTS(SELECT 1 FROM expense_refunds WHERE expense_id=OLD.source_id)
BEGIN SELECT RAISE(ABORT,'La classification historique utilisée par le remboursement doit être conservée.'); END;
PRAGMA user_version=47;
