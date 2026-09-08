-- Local receipt of an installed shared initial revision. Future transactions
-- keep their own capture generation and acknowledgements.
CREATE TABLE IF NOT EXISTS business_sync_baseline (
  id INTEGER PRIMARY KEY CHECK(id=1),
  organization_id TEXT NOT NULL,
  server_generation TEXT NOT NULL,
  source_transfer_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  origin TEXT NOT NULL CHECK(origin IN ('published','received')),
  installed_at TEXT NOT NULL
);
