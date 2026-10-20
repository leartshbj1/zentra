-- v69 : absences et vacances avec soldes, puis notes de frais des
-- collaborateurs (justificatif, validation, remboursement par le salaire). Additif.
CREATE TABLE IF NOT EXISTS employee_leave_settings (
  employee_id TEXT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  vacation_days_per_year REAL NOT NULL DEFAULT 20 CHECK(vacation_days_per_year BETWEEN 0 AND 60),
  carried_over_days REAL NOT NULL DEFAULT 0 CHECK(carried_over_days BETWEEN -60 AND 60),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS absences (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('vacation','sick','accident','military','maternity','paternity','training','other')),
  start_date TEXT NOT NULL CHECK(LENGTH(start_date)=10 AND DATE(start_date)=start_date),
  end_date TEXT NOT NULL CHECK(LENGTH(end_date)=10 AND DATE(end_date)=end_date AND end_date>=start_date),
  -- Jours ouvrés comptés (demi-journées possibles).
  days REAL NOT NULL CHECK(days>0 AND days<=366),
  incapacity_percent INTEGER NOT NULL DEFAULT 100 CHECK(incapacity_percent BETWEEN 1 AND 100),
  certificate INTEGER NOT NULL DEFAULT 0 CHECK(certificate IN (0,1)),
  note TEXT CHECK(note IS NULL OR LENGTH(note)<=1000),
  ijm_declared_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_absences_employee ON absences(employee_id,start_date);

CREATE TABLE IF NOT EXISTS expense_claims (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  claim_date TEXT NOT NULL CHECK(LENGTH(claim_date)=10 AND DATE(claim_date)=claim_date),
  category TEXT NOT NULL CHECK(LENGTH(TRIM(category)) BETWEEN 1 AND 80),
  description TEXT NOT NULL CHECK(LENGTH(TRIM(description)) BETWEEN 1 AND 500),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0 AND amount_cents<=10000000),
  attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','approved','rejected','reimbursed')),
  decided_at TEXT,
  decision_note TEXT CHECK(decision_note IS NULL OR LENGTH(decision_note)<=500),
  payslip_id TEXT REFERENCES payslips(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(status<>'reimbursed' OR payslip_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_expense_claims_employee ON expense_claims(employee_id,status);
CREATE TRIGGER IF NOT EXISTS expense_claims_reimbursed_frozen BEFORE UPDATE ON expense_claims
WHEN OLD.status='reimbursed'
BEGIN SELECT RAISE(ABORT,'Une note de frais remboursée ne se modifie pas.'); END;
CREATE TRIGGER IF NOT EXISTS expense_claims_decided_no_delete BEFORE DELETE ON expense_claims
WHEN OLD.status IN ('approved','reimbursed')
BEGIN SELECT RAISE(ABORT,'Une note de frais validée ne se supprime pas.'); END;
PRAGMA user_version=69;
