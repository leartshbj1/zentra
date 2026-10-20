-- v72 : centres de coûts et budget annuel par compte et par mois. Additif.
-- Un centre se rattache à des projets, des personnes ou des comptes : une
-- ligne du journal suit son projet, sinon sa personne, sinon son compte.
CREATE TABLE IF NOT EXISTS cost_centers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK(LENGTH(code) BETWEEN 1 AND 12),
  name TEXT NOT NULL CHECK(LENGTH(name) BETWEEN 1 AND 80),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cost_center_assignments (
  kind TEXT NOT NULL CHECK(kind IN ('project','employee','account')),
  target_id TEXT NOT NULL,
  cost_center_id TEXT NOT NULL REFERENCES cost_centers(id) ON UPDATE CASCADE ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(kind, target_id)
);
-- cost_center_id vide : budget de toute l'entreprise.
CREATE TABLE IF NOT EXISTS budget_lines (
  year INTEGER NOT NULL CHECK(year BETWEEN 2000 AND 2100),
  month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE CASCADE,
  cost_center_id TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 0 AND 100000000000),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(year, month, account_id, cost_center_id)
);
PRAGMA user_version=72;
