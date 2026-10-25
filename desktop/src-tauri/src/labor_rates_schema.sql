-- v80 : tarifs de régie (Pack bâtiment). Une table de tarifs par association
-- ou par année (chef d'équipe, ouvrier qualifié, aide, apprenti, machines),
-- importée du fichier de l'association. Un rapport de régie peut indiquer le
-- tarif de chaque ligne d'heures. Additif.
CREATE TABLE IF NOT EXISTS labor_rate_tables (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(LENGTH(name) BETWEEN 1 AND 120),
  source TEXT CHECK(source IS NULL OR LENGTH(source) <= 160),
  valid_from TEXT CHECK(valid_from IS NULL OR valid_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS labor_rates (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES labor_rate_tables(id) ON UPDATE CASCADE ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK(kind IN ('personnel','machine')),
  code TEXT CHECK(code IS NULL OR LENGTH(code) BETWEEN 1 AND 40),
  label TEXT NOT NULL CHECK(LENGTH(label) BETWEEN 1 AND 160),
  unit TEXT NOT NULL DEFAULT 'h' CHECK(LENGTH(unit) BETWEEN 1 AND 32),
  rate_cents INTEGER NOT NULL CHECK(rate_cents BETWEEN 0 AND 100000000),
  cost_cents INTEGER CHECK(cost_cents IS NULL OR cost_cents BETWEEN 0 AND 100000000)
);
CREATE INDEX IF NOT EXISTS idx_labor_rates_table ON labor_rates(table_id, position);
ALTER TABLE work_report_lines ADD COLUMN labor_rate_id TEXT;
PRAGMA user_version=80;
