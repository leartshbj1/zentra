-- v79 : situations SIA 118 cumulées depuis un devis accepté (Pack bâtiment).
-- Additif. Chaque situation est une facture ordinaire ; ces tables gardent
-- l'avancement cumulé par position et la retenue de garantie par taux de TVA.
-- Une situation émise est figée.
CREATE TABLE IF NOT EXISTS progress_billing_plans (
  quote_id TEXT PRIMARY KEY REFERENCES quotes(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  retention_bp INTEGER NOT NULL DEFAULT 0 CHECK(retention_bp BETWEEN 0 AND 3000),
  round_to_five INTEGER NOT NULL DEFAULT 1 CHECK(round_to_five IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS progress_bills (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES progress_billing_plans(quote_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id) ON UPDATE CASCADE ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  kind TEXT NOT NULL CHECK(kind IN ('situation','final','retention_release')),
  progress_date TEXT NOT NULL,
  retention_bp INTEGER NOT NULL CHECK(retention_bp BETWEEN 0 AND 3000),
  cumulative_net_cents INTEGER NOT NULL,
  cumulative_retention_cents INTEGER NOT NULL,
  retention_by_rate_json TEXT NOT NULL CHECK(json_valid(retention_by_rate_json)),
  previous_net_cents INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,
  exact_total_cents INTEGER NOT NULL,
  rounding_cents INTEGER NOT NULL DEFAULT 0 CHECK(rounding_cents BETWEEN -10 AND 10),
  created_at TEXT NOT NULL,
  UNIQUE(quote_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_progress_bills_quote ON progress_bills(quote_id, sequence);
CREATE TABLE IF NOT EXISTS progress_bill_lines (
  bill_id TEXT NOT NULL REFERENCES progress_bills(id) ON UPDATE CASCADE ON DELETE CASCADE,
  quote_item_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  unit TEXT NOT NULL,
  contract_quantity REAL NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  discount_bp INTEGER NOT NULL DEFAULT 0,
  vat_bp INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL CHECK(mode IN ('percent','quantity')),
  cumulative_percent_bp INTEGER CHECK(cumulative_percent_bp IS NULL OR cumulative_percent_bp BETWEEN 0 AND 10000),
  cumulative_quantity REAL NOT NULL CHECK(cumulative_quantity >= 0),
  cumulative_net_cents INTEGER NOT NULL,
  previous_net_cents INTEGER NOT NULL,
  PRIMARY KEY(bill_id, quote_item_id)
);
CREATE TRIGGER IF NOT EXISTS progress_bills_issued_no_update BEFORE UPDATE ON progress_bills
WHEN EXISTS(SELECT 1 FROM invoices WHERE id=OLD.invoice_id AND number IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'Une situation émise est figée.'); END;
CREATE TRIGGER IF NOT EXISTS progress_bills_issued_no_delete BEFORE DELETE ON progress_bills
WHEN EXISTS(SELECT 1 FROM invoices WHERE id=OLD.invoice_id AND number IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'Une situation émise est figée.'); END;
CREATE TRIGGER IF NOT EXISTS progress_bill_lines_issued_no_update BEFORE UPDATE ON progress_bill_lines
WHEN EXISTS(SELECT 1 FROM progress_bills b JOIN invoices i ON i.id=b.invoice_id WHERE b.id=OLD.bill_id AND i.number IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'Une situation émise est figée.'); END;
CREATE TRIGGER IF NOT EXISTS progress_bill_lines_issued_no_delete BEFORE DELETE ON progress_bill_lines
WHEN EXISTS(SELECT 1 FROM progress_bills b JOIN invoices i ON i.id=b.invoice_id WHERE b.id=OLD.bill_id AND i.number IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'Une situation émise est figée.'); END;
PRAGMA user_version=79;
