-- v67 : livre de caisse (espèces) avec comptage du soir, puis contrats et
-- abonnements avec leurs échéances de résiliation. Additif.
-- Le livre de caisse est le journal des espèces. Les encaissements de
-- factures payées en espèces y apparaissent depuis les paiements ; les
-- autres mouvements y sont saisis. Une écriture ne se modifie pas : on corrige
-- par une nouvelle ligne.
CREATE TABLE IF NOT EXISTS cash_counts (
  id TEXT PRIMARY KEY,
  count_date TEXT NOT NULL CHECK(LENGTH(count_date)=10 AND DATE(count_date)=count_date),
  counted_cents INTEGER NOT NULL CHECK(counted_cents BETWEEN 0 AND 100000000000),
  expected_cents INTEGER NOT NULL,
  difference_cents INTEGER NOT NULL,
  denominations_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(denominations_json)),
  note TEXT CHECK(note IS NULL OR LENGTH(note)<=500),
  created_at TEXT NOT NULL,
  CHECK(difference_cents=counted_cents-expected_cents)
);
CREATE INDEX IF NOT EXISTS idx_cash_counts_date ON cash_counts(count_date,created_at);
CREATE TRIGGER IF NOT EXISTS cash_counts_no_update BEFORE UPDATE ON cash_counts
BEGIN SELECT RAISE(ABORT,'Un comptage de caisse ne se modifie pas.'); END;
CREATE TRIGGER IF NOT EXISTS cash_counts_no_delete BEFORE DELETE ON cash_counts
BEGIN SELECT RAISE(ABORT,'Un comptage de caisse ne se supprime pas.'); END;

CREATE TABLE IF NOT EXISTS cash_book_entries (
  id TEXT PRIMARY KEY,
  entry_date TEXT NOT NULL CHECK(LENGTH(entry_date)=10 AND DATE(entry_date)=entry_date),
  kind TEXT NOT NULL CHECK(kind IN ('opening','receipt','expense','bank_deposit','bank_withdrawal','correction')),
  -- Signé : positif pour une entrée d'espèces, négatif pour une sortie.
  amount_cents INTEGER NOT NULL CHECK(amount_cents<>0 AND ABS(amount_cents)<=100000000000),
  description TEXT NOT NULL CHECK(LENGTH(TRIM(description)) BETWEEN 1 AND 300),
  reference TEXT CHECK(reference IS NULL OR LENGTH(reference)<=100),
  count_id TEXT REFERENCES cash_counts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK(
    (kind IN ('opening','receipt','bank_withdrawal') AND amount_cents>0)
    OR (kind IN ('expense','bank_deposit') AND amount_cents<0)
    OR kind='correction'
  ),
  CHECK(count_id IS NULL OR kind='correction')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_book_single_opening ON cash_book_entries(kind) WHERE kind='opening';
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_book_count_correction ON cash_book_entries(count_id) WHERE count_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cash_book_entries_date ON cash_book_entries(entry_date,created_at);
CREATE TRIGGER IF NOT EXISTS cash_book_entries_no_update BEFORE UPDATE ON cash_book_entries
BEGIN SELECT RAISE(ABORT,'Une écriture de caisse ne se modifie pas : ajoutez une correction.'); END;
CREATE TRIGGER IF NOT EXISTS cash_book_entries_no_delete BEFORE DELETE ON cash_book_entries
BEGIN SELECT RAISE(ABORT,'Une écriture de caisse ne se supprime pas : ajoutez une correction.'); END;

-- Contrats et abonnements : durée, préavis, reconduction et montant.
CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  side TEXT NOT NULL CHECK(side IN ('customer','supplier')),
  client_id TEXT REFERENCES clients(id) ON DELETE RESTRICT,
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE RESTRICT,
  party_name TEXT NOT NULL CHECK(LENGTH(TRIM(party_name)) BETWEEN 1 AND 200),
  title TEXT NOT NULL CHECK(LENGTH(TRIM(title)) BETWEEN 1 AND 200),
  start_date TEXT NOT NULL CHECK(LENGTH(start_date)=10 AND DATE(start_date)=start_date),
  end_date TEXT CHECK(end_date IS NULL OR (LENGTH(end_date)=10 AND DATE(end_date)=end_date AND end_date>start_date)),
  notice_months INTEGER NOT NULL DEFAULT 3 CHECK(notice_months BETWEEN 0 AND 36),
  auto_renew INTEGER NOT NULL DEFAULT 1 CHECK(auto_renew IN (0,1)),
  renewal_months INTEGER NOT NULL DEFAULT 12 CHECK(renewal_months BETWEEN 1 AND 120),
  amount_cents INTEGER NOT NULL DEFAULT 0 CHECK(amount_cents BETWEEN 0 AND 100000000000),
  currency TEXT NOT NULL DEFAULT 'CHF' CHECK(currency IN ('CHF','EUR')),
  frequency TEXT NOT NULL DEFAULT 'monthly' CHECK(frequency IN ('monthly','quarterly','yearly','once')),
  indexation TEXT CHECK(indexation IS NULL OR LENGTH(indexation)<=200),
  note TEXT CHECK(note IS NULL OR LENGTH(note)<=2000),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','terminated')),
  terminated_on TEXT CHECK(terminated_on IS NULL OR (LENGTH(terminated_on)=10 AND DATE(terminated_on)=terminated_on)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((side='customer' AND supplier_id IS NULL) OR (side='supplier' AND client_id IS NULL)),
  CHECK(status='active' OR terminated_on IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_contracts_side ON contracts(side,status);
PRAGMA user_version=67;
