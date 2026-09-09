-- Device-local evidence of an applied canonical revision. The receipt and cursor
-- commit with the business rows; filesystem recovery reads this decision.
CREATE TABLE IF NOT EXISTS business_sync_installed_revisions (
  organization_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>1),
  transaction_id TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256)=64),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  installed_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,generation,revision),
  UNIQUE(organization_id,generation,transaction_id)
);
