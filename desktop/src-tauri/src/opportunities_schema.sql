-- v74 : opportunités de vente (pipeline). Une opportunité peut être liée à
-- un devis : son état suit alors celui du devis. Additif.
CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id) ON UPDATE CASCADE ON DELETE SET NULL,
  prospect_name TEXT NOT NULL DEFAULT '' CHECK(LENGTH(prospect_name) <= 200),
  title TEXT NOT NULL CHECK(LENGTH(title) BETWEEN 1 AND 200),
  stage TEXT NOT NULL CHECK(stage IN ('lead','contact','quote','won','lost')),
  amount_cents INTEGER NOT NULL DEFAULT 0 CHECK(amount_cents BETWEEN 0 AND 100000000000),
  expected_close_date TEXT,
  quote_id TEXT,
  notes TEXT NOT NULL DEFAULT '' CHECK(LENGTH(notes) <= 4000),
  lost_reason TEXT NOT NULL DEFAULT '' CHECK(LENGTH(lost_reason) <= 500),
  stage_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(client_id IS NOT NULL OR LENGTH(prospect_name) > 0)
);
PRAGMA user_version=74;
