-- v68 : rapports de régie / d'intervention signés sur place. Un rapport signé
-- ne se modifie plus ; il devient une facture en brouillon au clic. Additif.
CREATE TABLE IF NOT EXISTS work_reports (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  report_date TEXT NOT NULL CHECK(LENGTH(report_date)=10 AND DATE(report_date)=report_date),
  site TEXT CHECK(site IS NULL OR LENGTH(site)<=300),
  description TEXT NOT NULL CHECK(LENGTH(TRIM(description)) BETWEEN 1 AND 4000),
  technician TEXT CHECK(technician IS NULL OR LENGTH(technician)<=200),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','signed','invoiced')),
  signer_name TEXT CHECK(signer_name IS NULL OR LENGTH(TRIM(signer_name)) BETWEEN 1 AND 200),
  -- Trait de signature en chemin SVG (coordonnées sur 600 × 200).
  signature_path TEXT CHECK(signature_path IS NULL OR (LENGTH(signature_path) BETWEEN 10 AND 60000 AND signature_path NOT GLOB '*[^MLml0-9 .,-]*')),
  signed_at TEXT,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(status='draft' OR (signer_name IS NOT NULL AND signature_path IS NOT NULL AND signed_at IS NOT NULL)),
  CHECK(status<>'invoiced' OR invoice_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_work_reports_client ON work_reports(client_id,report_date);

CREATE TABLE IF NOT EXISTS work_report_lines (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES work_reports(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK(kind IN ('labor','material')),
  catalog_item_id TEXT REFERENCES catalog_items(id) ON DELETE SET NULL,
  description TEXT NOT NULL CHECK(LENGTH(TRIM(description)) BETWEEN 1 AND 500),
  quantity REAL NOT NULL CHECK(quantity>0 AND quantity<=100000),
  unit TEXT NOT NULL CHECK(LENGTH(TRIM(unit)) BETWEEN 1 AND 32),
  unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents BETWEEN 0 AND 100000000000),
  vat_bp INTEGER NOT NULL DEFAULT 0 CHECK(vat_bp BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_report_lines_report ON work_report_lines(report_id,position);

-- Signé : le contenu et la signature sont figés ; seul le lien vers la facture s'ajoute.
CREATE TRIGGER IF NOT EXISTS work_reports_signed_frozen BEFORE UPDATE ON work_reports
WHEN OLD.status<>'draft' AND (
  NEW.client_id IS NOT OLD.client_id OR NEW.project_id IS NOT OLD.project_id OR NEW.report_date IS NOT OLD.report_date
  OR NEW.site IS NOT OLD.site OR NEW.description IS NOT OLD.description OR NEW.technician IS NOT OLD.technician
  OR NEW.signer_name IS NOT OLD.signer_name OR NEW.signature_path IS NOT OLD.signature_path OR NEW.signed_at IS NOT OLD.signed_at
  OR (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS NOT OLD.invoice_id)
  OR NEW.status='draft'
)
BEGIN SELECT RAISE(ABORT,'Un rapport signé ne se modifie pas.'); END;
CREATE TRIGGER IF NOT EXISTS work_reports_signed_no_delete BEFORE DELETE ON work_reports
WHEN OLD.status<>'draft'
BEGIN SELECT RAISE(ABORT,'Un rapport signé ne se supprime pas.'); END;
CREATE TRIGGER IF NOT EXISTS work_report_lines_signed_frozen_insert BEFORE INSERT ON work_report_lines
WHEN EXISTS(SELECT 1 FROM work_reports r WHERE r.id=NEW.report_id AND r.status<>'draft')
BEGIN SELECT RAISE(ABORT,'Un rapport signé ne se modifie pas.'); END;
CREATE TRIGGER IF NOT EXISTS work_report_lines_signed_frozen_update BEFORE UPDATE ON work_report_lines
WHEN EXISTS(SELECT 1 FROM work_reports r WHERE r.id=OLD.report_id AND r.status<>'draft')
BEGIN SELECT RAISE(ABORT,'Un rapport signé ne se modifie pas.'); END;
CREATE TRIGGER IF NOT EXISTS work_report_lines_signed_frozen_delete BEFORE DELETE ON work_report_lines
WHEN EXISTS(SELECT 1 FROM work_reports r WHERE r.id=OLD.report_id AND r.status<>'draft')
BEGIN SELECT RAISE(ABORT,'Un rapport signé ne se modifie pas.'); END;
PRAGMA user_version=68;
