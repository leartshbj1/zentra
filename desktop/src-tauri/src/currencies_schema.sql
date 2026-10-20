-- v71 : cours de change et contre-valeur CHF des écritures en devise.
-- Le journal garde les montants exacts du document (EUR) ; la contre-valeur
-- CHF est enregistrée à côté, ligne par ligne, avec le cours appliqué. Les
-- rapports lisent la vue journal_lines_chf. Additif.
CREATE TABLE IF NOT EXISTS exchange_rates (
  currency TEXT NOT NULL CHECK(LENGTH(currency)=3 AND currency=UPPER(currency) AND currency<>'CHF'),
  rate_date TEXT NOT NULL CHECK(rate_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  chf_per_unit_micro INTEGER NOT NULL CHECK(chf_per_unit_micro BETWEEN 1 AND 1000000000),
  source TEXT NOT NULL CHECK(source IN ('manual','estv')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(currency, rate_date)
);
CREATE TABLE IF NOT EXISTS journal_line_conversions (
  journal_line_id TEXT PRIMARY KEY REFERENCES journal_lines(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  currency TEXT NOT NULL,
  rate_date TEXT NOT NULL,
  chf_per_unit_micro INTEGER NOT NULL CHECK(chf_per_unit_micro>0),
  chf_debit_cents INTEGER NOT NULL CHECK(chf_debit_cents>=0),
  chf_credit_cents INTEGER NOT NULL CHECK(chf_credit_cents>=0),
  created_at TEXT NOT NULL,
  CHECK((chf_debit_cents>0 AND chf_credit_cents=0) OR (chf_credit_cents>0 AND chf_debit_cents=0))
);
CREATE INDEX IF NOT EXISTS journal_line_conversions_entry ON journal_line_conversions(journal_entry_id);
-- Différence de change réalisée (ou arrondi) : une ligne CHF de plus pour l'écriture.
CREATE TABLE IF NOT EXISTS journal_fx_adjustments (
  id TEXT PRIMARY KEY,
  journal_entry_id TEXT NOT NULL UNIQUE REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  chf_debit_cents INTEGER NOT NULL CHECK(chf_debit_cents>=0),
  chf_credit_cents INTEGER NOT NULL CHECK(chf_credit_cents>=0),
  memo TEXT NOT NULL,
  client_id TEXT,
  created_at TEXT NOT NULL,
  CHECK((chf_debit_cents>0 AND chf_credit_cents=0) OR (chf_credit_cents>0 AND chf_debit_cents=0))
);
CREATE TRIGGER IF NOT EXISTS journal_line_conversions_no_update BEFORE UPDATE ON journal_line_conversions
BEGIN SELECT RAISE(ABORT,'La contre-valeur CHF d''une écriture ne peut pas être modifiée.'); END;
CREATE TRIGGER IF NOT EXISTS journal_line_conversions_no_delete BEFORE DELETE ON journal_line_conversions
BEGIN SELECT RAISE(ABORT,'La contre-valeur CHF d''une écriture doit être conservée.'); END;
CREATE TRIGGER IF NOT EXISTS journal_fx_adjustments_no_update BEFORE UPDATE ON journal_fx_adjustments
BEGIN SELECT RAISE(ABORT,'La différence de change d''une écriture ne peut pas être modifiée.'); END;
CREATE TRIGGER IF NOT EXISTS journal_fx_adjustments_no_delete BEFORE DELETE ON journal_fx_adjustments
BEGIN SELECT RAISE(ABORT,'La différence de change d''une écriture doit être conservée.'); END;
CREATE TRIGGER IF NOT EXISTS journal_line_conversions_closed BEFORE INSERT ON journal_line_conversions
WHEN EXISTS(SELECT 1 FROM journal_entries e JOIN accounting_periods p ON e.entry_date BETWEEN p.date_from AND p.date_to WHERE e.id=NEW.journal_entry_id AND p.status='closed')
BEGIN SELECT RAISE(ABORT,'La période de cette écriture est clôturée : sa contre-valeur CHF ne peut plus être ajoutée.'); END;
CREATE TRIGGER IF NOT EXISTS journal_fx_adjustments_closed BEFORE INSERT ON journal_fx_adjustments
WHEN EXISTS(SELECT 1 FROM journal_entries e JOIN accounting_periods p ON e.entry_date BETWEEN p.date_from AND p.date_to WHERE e.id=NEW.journal_entry_id AND p.status='closed')
BEGIN SELECT RAISE(ABORT,'La période de cette écriture est clôturée : sa différence de change ne peut plus être ajoutée.'); END;
-- Un cours déjà appliqué à une écriture reste tel quel.
CREATE TRIGGER IF NOT EXISTS exchange_rates_used_update BEFORE UPDATE ON exchange_rates
WHEN EXISTS(SELECT 1 FROM journal_line_conversions c WHERE c.currency=OLD.currency AND c.rate_date=OLD.rate_date)
BEGIN SELECT RAISE(ABORT,'Ce cours est déjà appliqué à des écritures : il ne peut plus être modifié.'); END;
CREATE TRIGGER IF NOT EXISTS exchange_rates_used_delete BEFORE DELETE ON exchange_rates
WHEN EXISTS(SELECT 1 FROM journal_line_conversions c WHERE c.currency=OLD.currency AND c.rate_date=OLD.rate_date)
BEGIN SELECT RAISE(ABORT,'Ce cours est déjà appliqué à des écritures : il ne peut plus être supprimé.'); END;
-- Lignes en CHF pour les rapports : contre-valeur si elle existe, sinon la ligne telle quelle.
CREATE VIEW IF NOT EXISTS journal_lines_chf AS
  SELECT jl.id, jl.journal_entry_id, jl.account_id,
         CASE WHEN c.journal_line_id IS NULL THEN jl.debit_cents ELSE c.chf_debit_cents END AS debit_cents,
         CASE WHEN c.journal_line_id IS NULL THEN jl.credit_cents ELSE c.chf_credit_cents END AS credit_cents,
         CASE WHEN c.journal_line_id IS NULL THEN jl.currency ELSE 'CHF' END AS currency,
         jl.memo, jl.project_id, jl.client_id, jl.employee_id, jl.created_at, jl.rowid AS line_order
    FROM journal_lines jl LEFT JOIN journal_line_conversions c ON c.journal_line_id=jl.id
  UNION ALL
  SELECT a.id, a.journal_entry_id, a.account_id, a.chf_debit_cents, a.chf_credit_cents, 'CHF',
         a.memo, NULL, a.client_id, NULL, a.created_at, 1000000000000 + a.rowid
    FROM journal_fx_adjustments a;
PRAGMA user_version=71;
