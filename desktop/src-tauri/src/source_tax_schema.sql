-- v70 : barèmes de l'impôt à la source importés des fichiers de l'ESTV.
-- Données publiques et volumineuses : gardées sur l'appareil (company_local_),
-- jamais synchronisées. Additif.
CREATE TABLE IF NOT EXISTS company_local_source_tax_tariffs (
  canton TEXT NOT NULL CHECK(LENGTH(canton)=2),
  code TEXT NOT NULL CHECK(LENGTH(code) BETWEEN 1 AND 10),
  valid_from TEXT NOT NULL CHECK(LENGTH(valid_from)=10),
  income_from_cents INTEGER NOT NULL CHECK(income_from_cents>=0),
  step_cents INTEGER NOT NULL CHECK(step_cents>=0),
  children INTEGER NOT NULL DEFAULT 0,
  min_tax_cents INTEGER NOT NULL DEFAULT 0 CHECK(min_tax_cents>=0),
  rate_bp INTEGER NOT NULL CHECK(rate_bp BETWEEN 0 AND 10000),
  PRIMARY KEY(canton, code, valid_from, income_from_cents)
) WITHOUT ROWID;
PRAGMA user_version=70;
