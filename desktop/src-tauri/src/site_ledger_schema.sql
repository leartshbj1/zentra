-- v81 : fiche chantier (Pack bâtiment). Budget prévu par nature de coût,
-- sous-traitances convenues contre devis et factures fournisseurs qui les
-- facturent. Le réel (heures, régie, achats) se lit dans les tables
-- existantes ; rien n'est recopié. Additif.
CREATE TABLE IF NOT EXISTS project_budget_lines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL CHECK(category IN ('labor','material','subcontract','machine','other')),
  label TEXT NOT NULL CHECK(LENGTH(label) BETWEEN 1 AND 160),
  amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 0 AND 100000000000),
  minutes INTEGER CHECK(minutes IS NULL OR minutes BETWEEN 0 AND 100000000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_budget_lines_project ON project_budget_lines(project_id, position);
CREATE TABLE IF NOT EXISTS project_subcontracts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  supplier_id TEXT REFERENCES suppliers(id) ON UPDATE CASCADE ON DELETE SET NULL,
  label TEXT NOT NULL CHECK(LENGTH(label) BETWEEN 1 AND 160),
  agreed_cents INTEGER NOT NULL CHECK(agreed_cents BETWEEN 0 AND 100000000000),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_subcontracts_project ON project_subcontracts(project_id);
CREATE TABLE IF NOT EXISTS supplier_invoice_subcontracts (
  supplier_invoice_id TEXT PRIMARY KEY REFERENCES supplier_invoices(id) ON UPDATE CASCADE ON DELETE CASCADE,
  subcontract_id TEXT NOT NULL REFERENCES project_subcontracts(id) ON UPDATE CASCADE ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
PRAGMA user_version=81;
