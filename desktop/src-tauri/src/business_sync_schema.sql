-- The journal stays dormant until an authenticated administrator explicitly
-- prepares a validated local bootstrap. This generation identifies the local
-- capture epoch; the server assigns its separate shared-history generation.
-- Merely connecting an account must never enable capture or replication.
CREATE TABLE IF NOT EXISTS business_sync_binding (
  id INTEGER PRIMARY KEY CHECK(id=1),
  organization_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  capture_enabled INTEGER NOT NULL DEFAULT 0 CHECK(capture_enabled IN (0,1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS business_sync_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  generation TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_key_json TEXT NOT NULL CHECK(json_valid(row_key_json)),
  operation TEXT NOT NULL CHECK(operation IN ('insert','update','delete')),
  before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK(after_json IS NULL OR json_valid(after_json)),
  source_rowid TEXT,
  base_revision INTEGER,
  CHECK((operation='insert' AND before_json IS NULL AND after_json IS NOT NULL)
     OR (operation='update' AND before_json IS NOT NULL AND after_json IS NOT NULL)
     OR (operation='delete' AND before_json IS NOT NULL AND after_json IS NULL))
);
CREATE INDEX IF NOT EXISTS business_sync_changes_transaction
  ON business_sync_changes(generation,transaction_id,sequence);

-- Acknowledgements are separate from the evidence. Deleting or rewriting a
-- pending transaction is never a conflict-resolution strategy.
CREATE TABLE IF NOT EXISTS business_sync_receipts (
  generation TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  acknowledged_through INTEGER NOT NULL CHECK(acknowledged_through>0),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  server_revision INTEGER NOT NULL CHECK(server_revision>0),
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY(generation,transaction_id)
);

PRAGMA user_version=60;
