-- v78 : historique des reprises de données (bexio, WinBIZ, Crésus, Banana,
-- AbaNinja/Swiss21 ou un fichier Excel/CSV) et leur annulation. Chaque
-- import garde son rapport ligne par ligne et la liste des fiches créées ou
-- mises à jour (avec leur état d'avant), pour pouvoir l'annuler. Additif.
CREATE TABLE IF NOT EXISTS data_imports (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('bexio','winbiz','cresus','banana','abaninja','generic')),
  kind TEXT NOT NULL CHECK(kind IN ('clients','suppliers','catalog','accounts','opening_receivables','opening_balance')),
  file_name TEXT CHECK(file_name IS NULL OR LENGTH(file_name) BETWEEN 1 AND 255),
  created_count INTEGER NOT NULL DEFAULT 0 CHECK(created_count>=0),
  updated_count INTEGER NOT NULL DEFAULT 0 CHECK(updated_count>=0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK(skipped_count>=0),
  report_json TEXT NOT NULL CHECK(json_valid(report_json)),
  created_at TEXT NOT NULL,
  undone_at TEXT,
  undo_report_json TEXT CHECK(undo_report_json IS NULL OR json_valid(undo_report_json))
);
CREATE INDEX IF NOT EXISTS idx_data_imports_created ON data_imports(created_at);
-- Seule l'annulation, une fois, modifie un import.
CREATE TRIGGER IF NOT EXISTS data_imports_update_guard BEFORE UPDATE ON data_imports
WHEN OLD.undone_at IS NOT NULL OR NEW.undone_at IS NULL OR NEW.id IS NOT OLD.id OR NEW.source IS NOT OLD.source
  OR NEW.kind IS NOT OLD.kind OR NEW.file_name IS NOT OLD.file_name OR NEW.created_count IS NOT OLD.created_count
  OR NEW.updated_count IS NOT OLD.updated_count OR NEW.skipped_count IS NOT OLD.skipped_count
  OR NEW.report_json IS NOT OLD.report_json OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'Un import enregistré ne se modifie pas.'); END;
CREATE TRIGGER IF NOT EXISTS data_imports_no_delete BEFORE DELETE ON data_imports
BEGIN SELECT RAISE(ABORT,'L''historique des imports est conservé.'); END;

CREATE TABLE IF NOT EXISTS data_import_records (
  import_id TEXT NOT NULL REFERENCES data_imports(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  entity TEXT NOT NULL CHECK(entity IN ('clients','suppliers','catalog_items','accounts','invoices','journal_entries')),
  record_id TEXT NOT NULL CHECK(LENGTH(record_id) BETWEEN 1 AND 255),
  action TEXT NOT NULL CHECK(action IN ('created','updated')),
  before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
  PRIMARY KEY(import_id, entity, record_id)
);
CREATE INDEX IF NOT EXISTS idx_data_import_records_record ON data_import_records(entity, record_id);
CREATE TRIGGER IF NOT EXISTS data_import_records_no_update BEFORE UPDATE ON data_import_records
BEGIN SELECT RAISE(ABORT,'Un import enregistré ne se modifie pas.'); END;
CREATE TRIGGER IF NOT EXISTS data_import_records_no_delete BEFORE DELETE ON data_import_records
BEGIN SELECT RAISE(ABORT,'L''historique des imports est conservé.'); END;
-- Une facture reprise d'un autre logiciel (sans TVA ni produit dans Zentra)
-- peut être annulée seulement par l'annulation de son import : la ligne
-- ci-dessous, gardée pour toujours, l'autorise et en garde la trace. Toute
-- autre facture émise reste corrigée par un avoir.
CREATE TABLE IF NOT EXISTS data_import_invoice_cancellations (
  invoice_id TEXT PRIMARY KEY REFERENCES opening_receivables(invoice_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  import_id TEXT NOT NULL REFERENCES data_imports(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS data_import_invoice_cancellations_no_update BEFORE UPDATE ON data_import_invoice_cancellations
BEGIN SELECT RAISE(ABORT,'Une annulation de reprise ne se modifie pas.'); END;
CREATE TRIGGER IF NOT EXISTS data_import_invoice_cancellations_no_delete BEFORE DELETE ON data_import_invoice_cancellations
BEGIN SELECT RAISE(ABORT,'Une annulation de reprise est conservée.'); END;
PRAGMA user_version=78;
