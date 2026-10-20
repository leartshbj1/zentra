-- v65 : reprise d'ouverture depuis bexio. Une facture client encore ouverte
-- devient une vraie facture émise, marquée ici pour être comptabilisée contre
-- le compte d'ouverture (et jamais comme un produit ni une TVA de l'exercice).
-- Le bilan d'ouverture garde la trace de son écriture. Additif.
CREATE TABLE IF NOT EXISTS opening_receivables (
  invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK(source IN ('bexio')),
  source_number TEXT NOT NULL CHECK(LENGTH(TRIM(source_number)) BETWEEN 1 AND 60),
  original_total_cents INTEGER CHECK(original_total_cents IS NULL OR original_total_cents>0),
  open_cents INTEGER NOT NULL CHECK(open_cents>0),
  created_at TEXT NOT NULL,
  UNIQUE(source, source_number)
);
CREATE TRIGGER IF NOT EXISTS opening_receivables_no_update BEFORE UPDATE ON opening_receivables
BEGIN SELECT RAISE(ABORT,'Une facture reprise ne se modifie pas.'); END;
CREATE TRIGGER IF NOT EXISTS opening_receivables_no_delete BEFORE DELETE ON opening_receivables
BEGIN SELECT RAISE(ABORT,'Une facture reprise ne se supprime pas.'); END;

CREATE TABLE IF NOT EXISTS opening_balance_imports (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('bexio')),
  entry_date TEXT NOT NULL,
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  receivables_cents INTEGER NOT NULL DEFAULT 0 CHECK(receivables_cents>=0),
  difference_cents INTEGER NOT NULL DEFAULT 0,
  lines_json TEXT NOT NULL CHECK(json_valid(lines_json)),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS opening_balance_imports_no_update BEFORE UPDATE ON opening_balance_imports
BEGIN SELECT RAISE(ABORT,'Un bilan d''ouverture repris ne se modifie pas.'); END;
CREATE TRIGGER IF NOT EXISTS opening_balance_imports_no_delete BEFORE DELETE ON opening_balance_imports
BEGIN SELECT RAISE(ABORT,'Un bilan d''ouverture repris ne se supprime pas.'); END;
PRAGMA user_version=65;
