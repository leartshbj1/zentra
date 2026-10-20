-- v75 : registre des archives légales (GeBüV) créées sur cet appareil.
-- Le fichier ZIP reste sur l'appareil : le registre aussi (company_local_).
CREATE TABLE IF NOT EXISTS company_local_legal_archives (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL CHECK(year BETWEEN 2000 AND 2100),
  status TEXT NOT NULL CHECK(status IN ('final','provisional')),
  file_name TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK(LENGTH(sha256)=64),
  size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
  files_count INTEGER NOT NULL CHECK(files_count>0),
  missing_count INTEGER NOT NULL DEFAULT 0,
  retain_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_verified_at TEXT,
  last_verified_ok INTEGER
);
PRAGMA user_version=75;
