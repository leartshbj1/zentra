CREATE TABLE IF NOT EXISTS quote_invoice_pairs (
  quote_id TEXT PRIMARY KEY REFERENCES quotes(id) ON DELETE RESTRICT,
  deposit_invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  balance_invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK(deposit_invoice_id<>balance_invoice_id)
);
CREATE TRIGGER IF NOT EXISTS quote_invoice_pair_no_update BEFORE UPDATE ON quote_invoice_pairs
BEGIN SELECT RAISE(ABORT,'Le lien entre acompte et solde est permanent.'); END;
CREATE TRIGGER IF NOT EXISTS quote_invoice_pair_no_delete BEFORE DELETE ON quote_invoice_pairs
BEGIN SELECT RAISE(ABORT,'Le dossier de facturation doit être conservé.'); END;
CREATE TRIGGER IF NOT EXISTS quote_invoice_pair_item_insert BEFORE INSERT ON invoice_items
WHEN EXISTS(SELECT 1 FROM quote_invoice_pairs WHERE NEW.invoice_id IN (deposit_invoice_id,balance_invoice_id))
BEGIN SELECT RAISE(ABORT,'Les montants du dossier acompte et solde sont liés au devis.'); END;
CREATE TRIGGER IF NOT EXISTS quote_invoice_pair_item_update BEFORE UPDATE ON invoice_items
WHEN EXISTS(SELECT 1 FROM quote_invoice_pairs WHERE OLD.invoice_id IN (deposit_invoice_id,balance_invoice_id) OR NEW.invoice_id IN (deposit_invoice_id,balance_invoice_id))
BEGIN SELECT RAISE(ABORT,'Les montants du dossier acompte et solde sont liés au devis.'); END;
CREATE TRIGGER IF NOT EXISTS quote_invoice_pair_item_delete BEFORE DELETE ON invoice_items
WHEN EXISTS(SELECT 1 FROM quote_invoice_pairs WHERE OLD.invoice_id IN (deposit_invoice_id,balance_invoice_id))
BEGIN SELECT RAISE(ABORT,'Les montants du dossier acompte et solde sont liés au devis.'); END;
CREATE TRIGGER IF NOT EXISTS quote_invoice_pair_document_guard BEFORE UPDATE ON invoices
WHEN EXISTS(SELECT 1 FROM quote_invoice_pairs WHERE OLD.id IN (deposit_invoice_id,balance_invoice_id)) AND (
 NEW.id IS NOT OLD.id OR NEW.client_id IS NOT OLD.client_id OR NEW.project_id IS NOT OLD.project_id
 OR NEW.quote_id IS NOT OLD.quote_id OR NEW.type IS NOT OLD.type OR NEW.currency IS NOT OLD.currency
 OR NEW.deposit_percentage_bp IS NOT OLD.deposit_percentage_bp OR NEW.deposit_basis_json IS NOT OLD.deposit_basis_json
 OR NEW.original_invoice_id IS NOT OLD.original_invoice_id OR NEW.subtotal_cents IS NOT OLD.subtotal_cents
 OR NEW.discount_cents IS NOT OLD.discount_cents OR NEW.vat_cents IS NOT OLD.vat_cents OR NEW.total_cents IS NOT OLD.total_cents
)
BEGIN SELECT RAISE(ABORT,'Les montants et les liens du dossier acompte et solde sont protégés.'); END;
CREATE TRIGGER IF NOT EXISTS quote_invoice_pair_no_extra_invoice BEFORE INSERT ON invoices
WHEN NEW.type<>'avoir' AND EXISTS(SELECT 1 FROM quote_invoice_pairs WHERE quote_id=NEW.quote_id)
BEGIN SELECT RAISE(ABORT,'Ce devis possède déjà ses factures d’acompte et de solde.'); END;
-- A fully deducted final document is evidence of completion, with no amount to
-- post. Other zero documents still require review; only a protected pair qualifies.
CREATE VIEW IF NOT EXISTS accountable_invoices AS
SELECT invoice.* FROM invoices invoice WHERE NOT (
 invoice.type='finale' AND invoice.total_cents=0 AND invoice.vat_cents=0
 AND invoice.subtotal_cents=invoice.discount_cents
 AND EXISTS(SELECT 1 FROM quote_invoice_pairs pair WHERE pair.balance_invoice_id=invoice.id)
);
PRAGMA user_version=50;
