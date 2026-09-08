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

-- A user's explicit initial publication pauses business writes durably until
-- its receipt is installed or the server confirms that it was abandoned.
CREATE TABLE IF NOT EXISTS business_sync_publication_intent (
  id INTEGER PRIMARY KEY CHECK(id=1),
  organization_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  transfer_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preparing','checking','publishing')),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS zentra_publication_write_guard
BEFORE INSERT ON business_sync_changes
WHEN EXISTS(SELECT 1 FROM business_sync_publication_intent WHERE transfer_id=NEW.generation)
BEGIN
  SELECT RAISE(ABORT,'La première publication est en cours. Reprenez-la ou annulez-la dans les réglages avant de modifier le dossier.');
END;
