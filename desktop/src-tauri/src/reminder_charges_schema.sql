-- v64 : frais de rappel par niveau et intérêts moratoires (désactivés par
-- défaut), puis trace des réquisitions de poursuite préparées. Additif.
CREATE TABLE IF NOT EXISTS reminder_charge_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  interest_enabled INTEGER NOT NULL DEFAULT 0 CHECK(interest_enabled IN (0,1)),
  interest_rate_bp INTEGER NOT NULL DEFAULT 500 CHECK(interest_rate_bp BETWEEN 0 AND 2000),
  fees_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(fees_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS debt_collection_requests (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  claim_cents INTEGER NOT NULL CHECK(claim_cents>0),
  interest_rate_bp INTEGER NOT NULL CHECK(interest_rate_bp BETWEEN 0 AND 2000),
  interest_from TEXT,
  fees_cents INTEGER NOT NULL DEFAULT 0 CHECK(fees_cents>=0),
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL CHECK(length(file_sha256)=64),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_debt_collection_requests_invoice ON debt_collection_requests(invoice_id,created_at);
CREATE TRIGGER IF NOT EXISTS debt_collection_requests_no_update BEFORE UPDATE ON debt_collection_requests
BEGIN SELECT RAISE(ABORT,'Une réquisition préparée ne se modifie pas.'); END;
CREATE TRIGGER IF NOT EXISTS debt_collection_requests_no_delete BEFORE DELETE ON debt_collection_requests
BEGIN SELECT RAISE(ABORT,'Une réquisition préparée ne se supprime pas.'); END;
PRAGMA user_version=64;
