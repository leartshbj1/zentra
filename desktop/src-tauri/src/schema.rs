pub const SCHEMA_VERSION: i64 = 5;

#[cfg(test)]
pub const BUSINESS_TABLES: &[&str] = &[
    "clients",
    "projects",
    "quotes",
    "quote_items",
    "invoices",
    "invoice_items",
    "employees",
    "time_entries",
    "expenses",
    "payslips",
    "payslip_items",
    "payments",
    "invoice_qr_bills",
    "attachments",
    "active_timers",
    "quote_conversions",
    "audit_log",
    "accounts",
    "accounting_settings",
    "accounting_periods",
    "accounting_sequences",
    "journal_entries",
    "journal_lines",
    "reminder_templates",
    "reminder_settings",
    "reminders",
    "reminder_history",
    "payroll_contribution_definitions",
    "payslip_contributions",
    "payroll_document_imports",
    "employee_payroll_templates",
    "license_state",
];

pub const SCHEMA_SQL: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  onboarding_completed INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_completed IN (0, 1)),
  company_name TEXT NOT NULL,
  legal_form TEXT,
  owner_name TEXT,
  email TEXT,
  phone TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  postal_code TEXT,
  city TEXT,
  canton TEXT,
  country TEXT NOT NULL DEFAULT 'CH',
  noga_section TEXT,
  noga_division TEXT,
  activity_description TEXT,
  noga_detailed_code TEXT,
  uid_number TEXT,
  vat_number TEXT,
  vat_registered INTEGER NOT NULL DEFAULT 0 CHECK (vat_registered IN (0, 1)),
  default_vat_bp INTEGER NOT NULL DEFAULT 0 CHECK (default_vat_bp BETWEEN 0 AND 10000),
  iban TEXT,
  bank_name TEXT,
  currency TEXT NOT NULL DEFAULT 'CHF',
  quote_prefix TEXT NOT NULL DEFAULT 'D',
  invoice_prefix TEXT NOT NULL DEFAULT 'F',
  credit_note_prefix TEXT NOT NULL DEFAULT 'A',
  quote_start_number INTEGER NOT NULL DEFAULT 1 CHECK (quote_start_number > 0),
  invoice_start_number INTEGER NOT NULL DEFAULT 1 CHECK (invoice_start_number > 0),
  credit_note_start_number INTEGER NOT NULL DEFAULT 1 CHECK (credit_note_start_number > 0),
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  quote_validity_days INTEGER NOT NULL DEFAULT 30 CHECK (quote_validity_days BETWEEN 0 AND 365),
  default_hourly_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (default_hourly_rate_cents >= 0),
  logo_path TEXT,
  extra_settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT,
  contact_person TEXT,
  email TEXT,
  phone TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  postal_code TEXT,
  city TEXT,
  canton TEXT,
  country TEXT NOT NULL DEFAULT 'CH',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id) ON UPDATE CASCADE ON DELETE SET NULL,
  code TEXT,
  name TEXT NOT NULL,
  address_line1 TEXT,
  address_line2 TEXT,
  postal_code TEXT,
  city TEXT,
  canton TEXT,
  status TEXT NOT NULL DEFAULT 'planifie',
  planned_start_date TEXT,
  planned_end_date TEXT,
  actual_start_date TEXT,
  actual_end_date TEXT,
  budget_cents INTEGER NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
  planned_minutes INTEGER NOT NULL DEFAULT 0 CHECK (planned_minutes >= 0),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  description TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id) ON UPDATE CASCADE ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  number TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'brouillon',
  issue_date TEXT,
  valid_until TEXT,
  currency TEXT NOT NULL DEFAULT 'CHF',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  vat_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  terms TEXT,
  snapshot_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quote_items (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit TEXT NOT NULL DEFAULT 'forfait',
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  discount_bp INTEGER NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
  vat_bp INTEGER NOT NULL DEFAULT 0 CHECK (vat_bp BETWEEN 0 AND 10000),
  line_net_cents INTEGER NOT NULL DEFAULT 0,
  line_vat_cents INTEGER NOT NULL DEFAULT 0,
  line_total_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id) ON UPDATE CASCADE ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  quote_id TEXT REFERENCES quotes(id) ON UPDATE CASCADE ON DELETE SET NULL,
  original_invoice_id TEXT REFERENCES invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  number TEXT,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'brouillon',
  issue_date TEXT,
  due_date TEXT,
  service_date_from TEXT,
  service_date_to TEXT,
  currency TEXT NOT NULL DEFAULT 'CHF',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  vat_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  terms TEXT,
  snapshot_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON UPDATE CASCADE ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit TEXT NOT NULL DEFAULT 'forfait',
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  discount_bp INTEGER NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
  vat_bp INTEGER NOT NULL DEFAULT 0 CHECK (vat_bp BETWEEN 0 AND 10000),
  line_net_cents INTEGER NOT NULL DEFAULT 0,
  line_vat_cents INTEGER NOT NULL DEFAULT 0,
  line_total_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  employee_number TEXT,
  name TEXT NOT NULL,
  role TEXT,
  email TEXT,
  phone TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  postal_code TEXT,
  city TEXT,
  canton TEXT,
  birth_date TEXT,
  social_security_number TEXT,
  iban TEXT,
  employment_start_date TEXT,
  employment_end_date TEXT,
  employment_rate INTEGER NOT NULL DEFAULT 100 CHECK (employment_rate BETWEEN 1 AND 100),
  hourly_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (hourly_rate_cents >= 0),
  monthly_salary_cents INTEGER NOT NULL DEFAULT 0 CHECK (monthly_salary_cents >= 0),
  status TEXT NOT NULL DEFAULT 'actif',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS time_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  employee_id TEXT REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL,
  date TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  minutes INTEGER NOT NULL CHECK (minutes >= 0),
  break_minutes INTEGER NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  billable INTEGER NOT NULL DEFAULT 1 CHECK (billable IN (0, 1)),
  billing_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (billing_rate_cents >= 0),
  cost_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_rate_cents >= 0),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'approuve',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  date TEXT NOT NULL,
  supplier TEXT,
  category TEXT,
  reference TEXT,
  currency TEXT NOT NULL DEFAULT 'CHF',
  net_cents INTEGER NOT NULL DEFAULT 0,
  vat_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  reimbursable INTEGER NOT NULL DEFAULT 0 CHECK (reimbursable IN (0, 1)),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payslips (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE CASCADE,
  period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'brouillon',
  gross_cents INTEGER NOT NULL DEFAULT 0,
  deductions_cents INTEGER NOT NULL DEFAULT 0,
  net_cents INTEGER NOT NULL DEFAULT 0,
  employer_costs_cents INTEGER NOT NULL DEFAULT 0,
  payment_date TEXT,
  notes TEXT,
  snapshot_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(employee_id, period)
);

CREATE TABLE IF NOT EXISTS payslip_items (
  id TEXT PRIMARY KEY,
  payslip_id TEXT NOT NULL REFERENCES payslips(id) ON UPDATE CASCADE ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON UPDATE CASCADE ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT,
  reference TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_qr_bills (
  invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  input_json TEXT NOT NULL,
  payload TEXT NOT NULL,
  reference_type TEXT NOT NULL CHECK (reference_type IN ('QRR','SCOR','NON')),
  is_qr_iban INTEGER NOT NULL CHECK (is_qr_iban IN (0,1)),
  character_count INTEGER NOT NULL CHECK (character_count > 0),
  byte_count INTEGER NOT NULL CHECK (byte_count > 0),
  frozen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoice_qr_bills_frozen
ON invoice_qr_bills(frozen_at, invoice_id);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  entity_type TEXT,
  entity_id TEXT,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS active_timers (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  employee_id TEXT REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  note TEXT,
  billable INTEGER NOT NULL DEFAULT 1 CHECK (billable IN (0, 1)),
  billing_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (billing_rate_cents >= 0),
  cost_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_rate_cents >= 0)
);

CREATE TABLE IF NOT EXISTS number_sequences (
  document_type TEXT NOT NULL,
  year INTEGER NOT NULL,
  next_value INTEGER NOT NULL CHECK (next_value > 0),
  PRIMARY KEY(document_type, year)
);

CREATE TABLE IF NOT EXISTS quote_conversions (
  quote_id TEXT PRIMARY KEY REFERENCES quotes(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS license_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL,
  license_id TEXT NOT NULL,
  customer_name TEXT,
  plan TEXT NOT NULL,
  price_chf_cents INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  last_seen_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  previous_hash TEXT,
  entry_hash TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit','credit')),
  report_section TEXT NOT NULL CHECK (report_section IN ('current_assets','fixed_assets','short_term_liabilities','long_term_liabilities','equity','net_revenue','cost_of_goods','personnel_expense','other_operating_expense','depreciation','financial_result','non_operating_result','exceptional_result','taxes')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  ar_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  revenue_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  vat_payable_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  bank_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  vat_receivable_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  wages_expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  wages_payable_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  social_expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  social_payable_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_sequences (
  year INTEGER PRIMARY KEY,
  next_value INTEGER NOT NULL CHECK (next_value > 0)
);

CREATE TABLE IF NOT EXISTS accounting_periods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (date_from <= date_to)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  entry_date TEXT NOT NULL,
  description TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_event TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status = 'posted'),
  reversal_of TEXT REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(source_type, source_id, source_event)
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY,
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  debit_cents INTEGER NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  currency TEXT NOT NULL,
  memo TEXT,
  project_id TEXT REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  client_id TEXT REFERENCES clients(id) ON UPDATE CASCADE ON DELETE SET NULL,
  employee_id TEXT REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  CHECK ((debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0))
);

CREATE TABLE IF NOT EXISTS reminder_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  sender_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminder_templates (
  id TEXT PRIMARY KEY,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 10),
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  days_after_due INTEGER NOT NULL CHECK (days_after_due >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(level)
);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  template_id TEXT REFERENCES reminder_templates(id) ON UPDATE CASCADE ON DELETE SET NULL,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 10),
  scheduled_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','due','completed','cancelled')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  currency TEXT NOT NULL,
  invoice_total_cents INTEGER NOT NULL,
  balance_cents INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(invoice_id, level)
);

CREATE TABLE IF NOT EXISTS reminder_history (
  id TEXT PRIMARY KEY,
  reminder_id TEXT NOT NULL REFERENCES reminders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('created','due','completed','cancelled','printed','exported','sent_manually','note')),
  occurred_at TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS payroll_contribution_definitions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('avs_ai_apg','ac','lpp','aanp','aap','ijm','family_allowance','source_tax','other')),
  side TEXT NOT NULL CHECK (side IN ('employee','employer')),
  calculation_kind TEXT NOT NULL CHECK (calculation_kind IN ('rate','fixed')),
  rate_bp INTEGER CHECK (rate_bp BETWEEN 0 AND 10000),
  fixed_amount_cents INTEGER CHECK (fixed_amount_cents >= 0),
  annual_ceiling_cents INTEGER CHECK (annual_ceiling_cents IS NULL OR annual_ceiling_cents > 0),
  basis_kind TEXT NOT NULL CHECK (basis_kind IN ('gross','ahv_salary','coordinated','custom')),
  source TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  liability_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((calculation_kind='rate' AND rate_bp IS NOT NULL AND fixed_amount_cents IS NULL) OR (calculation_kind='fixed' AND fixed_amount_cents IS NOT NULL AND rate_bp IS NULL))
);

CREATE TABLE IF NOT EXISTS payslip_contributions (
  id TEXT PRIMARY KEY,
  payslip_id TEXT NOT NULL REFERENCES payslips(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  definition_id TEXT NOT NULL REFERENCES payroll_contribution_definitions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  payslip_item_id TEXT NOT NULL UNIQUE REFERENCES payslip_items(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('employee','employer')),
  calculation_kind TEXT NOT NULL,
  basis_kind TEXT NOT NULL,
  basis_cents INTEGER NOT NULL CHECK (basis_cents >= 0),
  year_to_date_basis_cents INTEGER,
  rate_bp INTEGER,
  fixed_amount_cents INTEGER,
  annual_ceiling_cents INTEGER,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  source TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(payslip_id, definition_id)
);

CREATE TABLE IF NOT EXISTS payroll_document_imports (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  stored_path TEXT NOT NULL UNIQUE,
  file_sha256 TEXT NOT NULL UNIQUE,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('pdf','image')),
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  page_count INTEGER,
  extraction_engine TEXT NOT NULL,
  engine_version TEXT,
  extracted_text TEXT,
  draft_json TEXT NOT NULL,
  confidence_bp INTEGER NOT NULL DEFAULT 0 CHECK (confidence_bp BETWEEN 0 AND 10000),
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review','confirmed','rejected','error')),
  error_message TEXT,
  employee_id TEXT REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL,
  payslip_id TEXT REFERENCES payslips(id) ON UPDATE CASCADE ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employee_payroll_templates (
  employee_id TEXT PRIMARY KEY REFERENCES employees(id) ON UPDATE CASCADE ON DELETE CASCADE,
  salary_mode TEXT NOT NULL CHECK (salary_mode IN ('monthly','hourly')),
  base_salary_cents INTEGER NOT NULL DEFAULT 0 CHECK (base_salary_cents >= 0),
  recurring_earnings_json TEXT NOT NULL DEFAULT '[]',
  suggested_contribution_codes_json TEXT NOT NULL DEFAULT '[]',
  source_import_id TEXT REFERENCES payroll_document_imports(id) ON UPDATE CASCADE ON DELETE SET NULL,
  reviewed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_code ON projects(code) WHERE code IS NOT NULL AND code <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_number ON quotes(number) WHERE number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number ON invoices(number) WHERE number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_number ON employees(employee_number) WHERE employee_number IS NOT NULL AND employee_number <> '';
CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_quotes_client ON quotes(client_id);
CREATE INDEX IF NOT EXISTS idx_quotes_project ON quotes(project_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_quote_items_quote ON quote_items(quote_id, position);
CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_project ON invoices(project_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id, position);
CREATE INDEX IF NOT EXISTS idx_time_project_date ON time_entries(project_id, date);
CREATE INDEX IF NOT EXISTS idx_time_employee_date ON time_entries(employee_id, date);
CREATE INDEX IF NOT EXISTS idx_expenses_project_date ON expenses(project_id, date);
CREATE INDEX IF NOT EXISTS idx_payslips_employee_period ON payslips(employee_id, period);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_date ON payments(invoice_id, date);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_entries(entry_date, number);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id, journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_accounting_period_dates ON accounting_periods(date_from,date_to,status);
CREATE INDEX IF NOT EXISTS idx_reminders_status_date ON reminders(status, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_reminder_history_reminder ON reminder_history(reminder_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_contributions_payslip ON payslip_contributions(payslip_id);
CREATE INDEX IF NOT EXISTS idx_payroll_imports_status_created ON payroll_document_imports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payroll_imports_employee ON payroll_document_imports(employee_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reminder_history_no_update
BEFORE UPDATE ON reminder_history BEGIN SELECT RAISE(ABORT, 'reminder_history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reminder_history_no_delete
BEFORE DELETE ON reminder_history BEGIN SELECT RAISE(ABORT, 'reminder_history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS journal_entries_no_update
BEFORE UPDATE ON journal_entries BEGIN SELECT RAISE(ABORT, 'posted journal entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS journal_entries_no_delete
BEFORE DELETE ON journal_entries BEGIN SELECT RAISE(ABORT, 'posted journal entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS journal_lines_no_update
BEFORE UPDATE ON journal_lines BEGIN SELECT RAISE(ABORT, 'posted journal lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS journal_lines_no_delete
BEFORE DELETE ON journal_lines BEGIN SELECT RAISE(ABORT, 'posted journal lines are immutable'); END;

CREATE TRIGGER IF NOT EXISTS quotes_issued_no_delete
BEFORE DELETE ON quotes WHEN OLD.number IS NOT NULL BEGIN SELECT RAISE(ABORT, 'issued quote is immutable'); END;
CREATE TRIGGER IF NOT EXISTS quotes_issued_financial_no_update
BEFORE UPDATE ON quotes WHEN OLD.number IS NOT NULL AND (
  NEW.number IS NOT OLD.number OR NEW.client_id IS NOT OLD.client_id OR NEW.project_id IS NOT OLD.project_id OR
  NEW.title IS NOT OLD.title OR NEW.issue_date IS NOT OLD.issue_date OR NEW.valid_until IS NOT OLD.valid_until OR
  NEW.currency IS NOT OLD.currency OR NEW.subtotal_cents IS NOT OLD.subtotal_cents OR NEW.discount_cents IS NOT OLD.discount_cents OR
  NEW.vat_cents IS NOT OLD.vat_cents OR NEW.total_cents IS NOT OLD.total_cents OR NEW.notes IS NOT OLD.notes OR
  NEW.terms IS NOT OLD.terms OR NEW.snapshot_json IS NOT OLD.snapshot_json
) BEGIN SELECT RAISE(ABORT, 'issued quote financial fields are immutable'); END;
CREATE TRIGGER IF NOT EXISTS quote_items_issued_no_insert
BEFORE INSERT ON quote_items WHEN EXISTS(SELECT 1 FROM quotes WHERE id=NEW.quote_id AND number IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'issued quote lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS quote_items_issued_no_update
BEFORE UPDATE ON quote_items WHEN EXISTS(SELECT 1 FROM quotes WHERE id=OLD.quote_id AND number IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'issued quote lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS quote_items_issued_no_delete
BEFORE DELETE ON quote_items WHEN EXISTS(SELECT 1 FROM quotes WHERE id=OLD.quote_id AND number IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'issued quote lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS invoices_issued_no_delete
BEFORE DELETE ON invoices WHEN OLD.number IS NOT NULL BEGIN SELECT RAISE(ABORT, 'issued invoice is immutable'); END;
CREATE TRIGGER IF NOT EXISTS invoices_issued_financial_no_update
BEFORE UPDATE ON invoices WHEN OLD.number IS NOT NULL AND (
  NEW.number IS NOT OLD.number OR NEW.client_id IS NOT OLD.client_id OR NEW.project_id IS NOT OLD.project_id OR NEW.quote_id IS NOT OLD.quote_id OR
  NEW.original_invoice_id IS NOT OLD.original_invoice_id OR NEW.title IS NOT OLD.title OR NEW.type IS NOT OLD.type OR
  NEW.issue_date IS NOT OLD.issue_date OR NEW.due_date IS NOT OLD.due_date OR NEW.service_date_from IS NOT OLD.service_date_from OR NEW.service_date_to IS NOT OLD.service_date_to OR NEW.currency IS NOT OLD.currency OR
  NEW.subtotal_cents IS NOT OLD.subtotal_cents OR NEW.discount_cents IS NOT OLD.discount_cents OR NEW.vat_cents IS NOT OLD.vat_cents OR
  NEW.total_cents IS NOT OLD.total_cents OR NEW.notes IS NOT OLD.notes OR NEW.terms IS NOT OLD.terms OR NEW.snapshot_json IS NOT OLD.snapshot_json
) BEGIN SELECT RAISE(ABORT, 'issued invoice financial fields are immutable'); END;
CREATE TRIGGER IF NOT EXISTS invoice_items_issued_no_insert
BEFORE INSERT ON invoice_items WHEN EXISTS(SELECT 1 FROM invoices WHERE id=NEW.invoice_id AND number IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'issued invoice lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS invoice_items_issued_no_update
BEFORE UPDATE ON invoice_items WHEN EXISTS(SELECT 1 FROM invoices WHERE id=OLD.invoice_id AND number IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'issued invoice lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS invoice_items_issued_no_delete
BEFORE DELETE ON invoice_items WHEN EXISTS(SELECT 1 FROM invoices WHERE id=OLD.invoice_id AND number IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'issued invoice lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS payments_no_update
BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT, 'payments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS payments_no_delete
BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT, 'payments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS invoice_qr_bills_frozen_no_update
BEFORE UPDATE ON invoice_qr_bills
WHEN OLD.frozen_at IS NOT NULL OR EXISTS(SELECT 1 FROM invoices WHERE id=OLD.invoice_id AND number IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'issued invoice QR bill is immutable'); END;
CREATE TRIGGER IF NOT EXISTS invoice_qr_bills_frozen_no_delete
BEFORE DELETE ON invoice_qr_bills
WHEN OLD.frozen_at IS NOT NULL OR EXISTS(SELECT 1 FROM invoices WHERE id=OLD.invoice_id AND number IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'issued invoice QR bill is immutable'); END;
CREATE TRIGGER IF NOT EXISTS posted_expenses_no_update
BEFORE UPDATE ON expenses WHEN EXISTS(SELECT 1 FROM journal_entries WHERE source_type='expense' AND source_id=OLD.id) BEGIN SELECT RAISE(ABORT, 'posted expense is immutable'); END;
CREATE TRIGGER IF NOT EXISTS posted_expenses_no_delete
BEFORE DELETE ON expenses WHEN EXISTS(SELECT 1 FROM journal_entries WHERE source_type='expense' AND source_id=OLD.id) BEGIN SELECT RAISE(ABORT, 'posted expense is immutable'); END;
CREATE TRIGGER IF NOT EXISTS payslips_posted_no_delete
BEFORE DELETE ON payslips WHEN OLD.status IN ('comptabilise','paye') BEGIN SELECT RAISE(ABORT, 'posted payslip is immutable'); END;
CREATE TRIGGER IF NOT EXISTS payslips_posted_no_update
BEFORE UPDATE ON payslips WHEN OLD.status IN ('comptabilise','paye') BEGIN SELECT RAISE(ABORT, 'posted payslip is immutable'); END;
CREATE TRIGGER IF NOT EXISTS payslip_items_posted_no_insert
BEFORE INSERT ON payslip_items WHEN EXISTS(SELECT 1 FROM payslips WHERE id=NEW.payslip_id AND status IN ('comptabilise','paye')) BEGIN SELECT RAISE(ABORT, 'posted payslip lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS payslip_items_posted_no_update
BEFORE UPDATE ON payslip_items WHEN EXISTS(SELECT 1 FROM payslips WHERE id=OLD.payslip_id AND status IN ('comptabilise','paye')) BEGIN SELECT RAISE(ABORT, 'posted payslip lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS payslip_items_posted_no_delete
BEFORE DELETE ON payslip_items WHEN EXISTS(SELECT 1 FROM payslips WHERE id=OLD.payslip_id AND status IN ('comptabilise','paye')) BEGIN SELECT RAISE(ABORT, 'posted payslip lines are immutable'); END;

PRAGMA user_version = 5;
"#;

/// Migration appliquée exclusivement aux bases v1 déjà présentes. Elle ne crée aucune
/// donnée métier : uniquement des colonnes, tables, index et garde-fous.
pub const MIGRATION_V2_SQL: &str = r#"
ALTER TABLE settings ADD COLUMN credit_note_prefix TEXT NOT NULL DEFAULT 'A';
ALTER TABLE settings ADD COLUMN quote_start_number INTEGER NOT NULL DEFAULT 1 CHECK (quote_start_number > 0);
ALTER TABLE settings ADD COLUMN invoice_start_number INTEGER NOT NULL DEFAULT 1 CHECK (invoice_start_number > 0);
ALTER TABLE settings ADD COLUMN credit_note_start_number INTEGER NOT NULL DEFAULT 1 CHECK (credit_note_start_number > 0);
ALTER TABLE invoices ADD COLUMN original_invoice_id TEXT REFERENCES invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE invoices ADD COLUMN service_date_from TEXT;
ALTER TABLE invoices ADD COLUMN service_date_to TEXT;
ALTER TABLE quotes ADD COLUMN snapshot_json TEXT;
ALTER TABLE invoices ADD COLUMN snapshot_json TEXT;
ALTER TABLE payslips ADD COLUMN snapshot_json TEXT;

CREATE TABLE quote_conversions (quote_id TEXT PRIMARY KEY REFERENCES quotes(id) ON UPDATE CASCADE ON DELETE RESTRICT, invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT, created_at TEXT NOT NULL);
CREATE TABLE license_state (id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,license_id TEXT NOT NULL,customer_name TEXT,plan TEXT NOT NULL,price_chf_cents INTEGER NOT NULL,issued_at TEXT NOT NULL,valid_from TEXT NOT NULL,valid_until TEXT NOT NULL,verified_at TEXT NOT NULL,last_seen_date TEXT NOT NULL);
CREATE TABLE audit_log (id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL, previous_hash TEXT, entry_hash TEXT NOT NULL UNIQUE);
CREATE TABLE accounts (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, account_type TEXT NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense')), normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit','credit')), report_section TEXT NOT NULL CHECK(report_section IN('current_assets','fixed_assets','short_term_liabilities','long_term_liabilities','equity','net_revenue','cost_of_goods','personnel_expense','other_operating_expense','depreciation','financial_result','non_operating_result','exceptional_result','taxes')), active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE accounting_settings (id INTEGER PRIMARY KEY CHECK (id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)), ar_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT, revenue_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT, vat_payable_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT, bank_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT, expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT, vat_receivable_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT, wages_expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT, wages_payable_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT, social_expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT, social_payable_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE accounting_sequences (year INTEGER PRIMARY KEY, next_value INTEGER NOT NULL CHECK(next_value>0));
CREATE TABLE accounting_periods (id TEXT PRIMARY KEY,name TEXT NOT NULL,date_from TEXT NOT NULL,date_to TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','closed')),closed_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,CHECK(date_from<=date_to));
CREATE TABLE journal_entries (id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, entry_date TEXT NOT NULL, description TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL, source_event TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'posted' CHECK(status='posted'), reversal_of TEXT REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT, created_at TEXT NOT NULL, UNIQUE(source_type,source_id,source_event));
CREATE TABLE journal_lines (id TEXT PRIMARY KEY, journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT, account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT, debit_cents INTEGER NOT NULL DEFAULT 0 CHECK(debit_cents>=0), credit_cents INTEGER NOT NULL DEFAULT 0 CHECK(credit_cents>=0), currency TEXT NOT NULL, memo TEXT, project_id TEXT REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL, client_id TEXT REFERENCES clients(id) ON UPDATE CASCADE ON DELETE SET NULL, employee_id TEXT REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL, created_at TEXT NOT NULL, CHECK((debit_cents>0 AND credit_cents=0) OR (credit_cents>0 AND debit_cents=0)));
CREATE TABLE reminder_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)), sender_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE reminder_templates (id TEXT PRIMARY KEY, level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 10), name TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, days_after_due INTEGER NOT NULL CHECK(days_after_due>=0), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(level));
CREATE TABLE reminders (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT, template_id TEXT REFERENCES reminder_templates(id) ON UPDATE CASCADE ON DELETE SET NULL, level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 10), scheduled_date TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('planned','due','completed','cancelled')), subject TEXT NOT NULL, body TEXT NOT NULL, invoice_number TEXT NOT NULL, currency TEXT NOT NULL, invoice_total_cents INTEGER NOT NULL, balance_cents INTEGER NOT NULL, snapshot_json TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(invoice_id,level));
CREATE TABLE reminder_history (id TEXT PRIMARY KEY, reminder_id TEXT NOT NULL REFERENCES reminders(id) ON UPDATE CASCADE ON DELETE RESTRICT, action TEXT NOT NULL CHECK(action IN('created','due','completed','cancelled','printed','exported','sent_manually','note')), occurred_at TEXT NOT NULL, note TEXT);
CREATE TABLE payroll_contribution_definitions (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, label TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN('avs_ai_apg','ac','lpp','aanp','aap','ijm','family_allowance','source_tax','other')), side TEXT NOT NULL CHECK(side IN('employee','employer')), calculation_kind TEXT NOT NULL CHECK(calculation_kind IN('rate','fixed')), rate_bp INTEGER CHECK(rate_bp BETWEEN 0 AND 10000), fixed_amount_cents INTEGER CHECK(fixed_amount_cents>=0), annual_ceiling_cents INTEGER CHECK(annual_ceiling_cents IS NULL OR annual_ceiling_cents>0), basis_kind TEXT NOT NULL CHECK(basis_kind IN('gross','ahv_salary','coordinated','custom')), source TEXT NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), liability_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT, expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK((calculation_kind='rate' AND rate_bp IS NOT NULL AND fixed_amount_cents IS NULL) OR(calculation_kind='fixed' AND fixed_amount_cents IS NOT NULL AND rate_bp IS NULL)));
CREATE TABLE payslip_contributions (id TEXT PRIMARY KEY, payslip_id TEXT NOT NULL REFERENCES payslips(id) ON UPDATE CASCADE ON DELETE RESTRICT, definition_id TEXT NOT NULL REFERENCES payroll_contribution_definitions(id) ON UPDATE CASCADE ON DELETE RESTRICT, payslip_item_id TEXT NOT NULL UNIQUE REFERENCES payslip_items(id) ON UPDATE CASCADE ON DELETE RESTRICT, label TEXT NOT NULL, category TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN('employee','employer')), calculation_kind TEXT NOT NULL,basis_kind TEXT NOT NULL,basis_cents INTEGER NOT NULL CHECK(basis_cents>=0),year_to_date_basis_cents INTEGER,rate_bp INTEGER,fixed_amount_cents INTEGER,annual_ceiling_cents INTEGER,amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),source TEXT NOT NULL,effective_from TEXT NOT NULL,effective_to TEXT,created_at TEXT NOT NULL,UNIQUE(payslip_id,definition_id));

CREATE INDEX idx_audit_entity ON audit_log(entity_type,entity_id,occurred_at);
CREATE INDEX idx_journal_date ON journal_entries(entry_date,number);
CREATE INDEX idx_journal_lines_account ON journal_lines(account_id,journal_entry_id);
CREATE INDEX idx_accounting_period_dates ON accounting_periods(date_from,date_to,status);
CREATE INDEX idx_reminders_status_date ON reminders(status,scheduled_date);
CREATE INDEX idx_reminder_history_reminder ON reminder_history(reminder_id,occurred_at);
CREATE INDEX idx_contributions_payslip ON payslip_contributions(payslip_id);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is immutable'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is immutable'); END;
CREATE TRIGGER reminder_history_no_update BEFORE UPDATE ON reminder_history BEGIN SELECT RAISE(ABORT,'reminder_history is immutable'); END;
CREATE TRIGGER reminder_history_no_delete BEFORE DELETE ON reminder_history BEGIN SELECT RAISE(ABORT,'reminder_history is immutable'); END;
CREATE TRIGGER journal_entries_no_update BEFORE UPDATE ON journal_entries BEGIN SELECT RAISE(ABORT,'posted journal entries are immutable'); END;
CREATE TRIGGER journal_entries_no_delete BEFORE DELETE ON journal_entries BEGIN SELECT RAISE(ABORT,'posted journal entries are immutable'); END;
CREATE TRIGGER journal_lines_no_update BEFORE UPDATE ON journal_lines BEGIN SELECT RAISE(ABORT,'posted journal lines are immutable'); END;
CREATE TRIGGER journal_lines_no_delete BEFORE DELETE ON journal_lines BEGIN SELECT RAISE(ABORT,'posted journal lines are immutable'); END;
CREATE TRIGGER quotes_issued_no_delete BEFORE DELETE ON quotes WHEN OLD.number IS NOT NULL BEGIN SELECT RAISE(ABORT,'issued quote is immutable'); END;
CREATE TRIGGER quotes_issued_financial_no_update BEFORE UPDATE ON quotes WHEN OLD.number IS NOT NULL AND (NEW.number IS NOT OLD.number OR NEW.client_id IS NOT OLD.client_id OR NEW.project_id IS NOT OLD.project_id OR NEW.title IS NOT OLD.title OR NEW.issue_date IS NOT OLD.issue_date OR NEW.valid_until IS NOT OLD.valid_until OR NEW.currency IS NOT OLD.currency OR NEW.subtotal_cents IS NOT OLD.subtotal_cents OR NEW.discount_cents IS NOT OLD.discount_cents OR NEW.vat_cents IS NOT OLD.vat_cents OR NEW.total_cents IS NOT OLD.total_cents OR NEW.notes IS NOT OLD.notes OR NEW.terms IS NOT OLD.terms OR NEW.snapshot_json IS NOT OLD.snapshot_json) BEGIN SELECT RAISE(ABORT,'issued quote financial fields are immutable'); END;
CREATE TRIGGER quote_items_issued_no_insert BEFORE INSERT ON quote_items WHEN EXISTS(SELECT 1 FROM quotes WHERE id=NEW.quote_id AND number IS NOT NULL) BEGIN SELECT RAISE(ABORT,'issued quote lines are immutable'); END;
CREATE TRIGGER quote_items_issued_no_update BEFORE UPDATE ON quote_items WHEN EXISTS(SELECT 1 FROM quotes WHERE id=OLD.quote_id AND number IS NOT NULL) BEGIN SELECT RAISE(ABORT,'issued quote lines are immutable'); END;
CREATE TRIGGER quote_items_issued_no_delete BEFORE DELETE ON quote_items WHEN EXISTS(SELECT 1 FROM quotes WHERE id=OLD.quote_id AND number IS NOT NULL) BEGIN SELECT RAISE(ABORT,'issued quote lines are immutable'); END;
CREATE TRIGGER invoices_issued_no_delete BEFORE DELETE ON invoices WHEN OLD.number IS NOT NULL BEGIN SELECT RAISE(ABORT,'issued invoice is immutable'); END;
CREATE TRIGGER invoices_issued_financial_no_update BEFORE UPDATE ON invoices WHEN OLD.number IS NOT NULL AND (NEW.number IS NOT OLD.number OR NEW.client_id IS NOT OLD.client_id OR NEW.project_id IS NOT OLD.project_id OR NEW.quote_id IS NOT OLD.quote_id OR NEW.original_invoice_id IS NOT OLD.original_invoice_id OR NEW.title IS NOT OLD.title OR NEW.type IS NOT OLD.type OR NEW.issue_date IS NOT OLD.issue_date OR NEW.due_date IS NOT OLD.due_date OR NEW.service_date_from IS NOT OLD.service_date_from OR NEW.service_date_to IS NOT OLD.service_date_to OR NEW.currency IS NOT OLD.currency OR NEW.subtotal_cents IS NOT OLD.subtotal_cents OR NEW.discount_cents IS NOT OLD.discount_cents OR NEW.vat_cents IS NOT OLD.vat_cents OR NEW.total_cents IS NOT OLD.total_cents OR NEW.notes IS NOT OLD.notes OR NEW.terms IS NOT OLD.terms OR NEW.snapshot_json IS NOT OLD.snapshot_json) BEGIN SELECT RAISE(ABORT,'issued invoice financial fields are immutable'); END;
CREATE TRIGGER invoice_items_issued_no_insert BEFORE INSERT ON invoice_items WHEN EXISTS(SELECT 1 FROM invoices WHERE id=NEW.invoice_id AND number IS NOT NULL) BEGIN SELECT RAISE(ABORT,'issued invoice lines are immutable'); END;
CREATE TRIGGER invoice_items_issued_no_update BEFORE UPDATE ON invoice_items WHEN EXISTS(SELECT 1 FROM invoices WHERE id=OLD.invoice_id AND number IS NOT NULL) BEGIN SELECT RAISE(ABORT,'issued invoice lines are immutable'); END;
CREATE TRIGGER invoice_items_issued_no_delete BEFORE DELETE ON invoice_items WHEN EXISTS(SELECT 1 FROM invoices WHERE id=OLD.invoice_id AND number IS NOT NULL) BEGIN SELECT RAISE(ABORT,'issued invoice lines are immutable'); END;
CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT,'payments are immutable'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT,'payments are immutable'); END;
CREATE TRIGGER posted_expenses_no_update BEFORE UPDATE ON expenses WHEN EXISTS(SELECT 1 FROM journal_entries WHERE source_type='expense' AND source_id=OLD.id) BEGIN SELECT RAISE(ABORT,'posted expense is immutable'); END;
CREATE TRIGGER posted_expenses_no_delete BEFORE DELETE ON expenses WHEN EXISTS(SELECT 1 FROM journal_entries WHERE source_type='expense' AND source_id=OLD.id) BEGIN SELECT RAISE(ABORT,'posted expense is immutable'); END;
CREATE TRIGGER payslips_posted_no_delete BEFORE DELETE ON payslips WHEN OLD.status IN('comptabilise','paye') BEGIN SELECT RAISE(ABORT,'posted payslip is immutable'); END;
CREATE TRIGGER payslips_posted_no_update BEFORE UPDATE ON payslips WHEN OLD.status IN('comptabilise','paye') BEGIN SELECT RAISE(ABORT,'posted payslip is immutable'); END;
CREATE TRIGGER payslip_items_posted_no_insert BEFORE INSERT ON payslip_items WHEN EXISTS(SELECT 1 FROM payslips WHERE id=NEW.payslip_id AND status IN('comptabilise','paye')) BEGIN SELECT RAISE(ABORT,'posted payslip lines are immutable'); END;
CREATE TRIGGER payslip_items_posted_no_update BEFORE UPDATE ON payslip_items WHEN EXISTS(SELECT 1 FROM payslips WHERE id=OLD.payslip_id AND status IN('comptabilise','paye')) BEGIN SELECT RAISE(ABORT,'posted payslip lines are immutable'); END;
CREATE TRIGGER payslip_items_posted_no_delete BEFORE DELETE ON payslip_items WHEN EXISTS(SELECT 1 FROM payslips WHERE id=OLD.payslip_id AND status IN('comptabilise','paye')) BEGIN SELECT RAISE(ABORT,'posted payslip lines are immutable'); END;
PRAGMA user_version=2;
"#;

/// Migration de structure NOGA 2025. Les colonnes restent NULL pour une base
/// existante : aucun secteur ni code d'activité n'est inventé.
pub const MIGRATION_V3_SQL: &str = r#"
ALTER TABLE settings ADD COLUMN noga_section TEXT;
ALTER TABLE settings ADD COLUMN noga_division TEXT;
ALTER TABLE settings ADD COLUMN activity_description TEXT;
ALTER TABLE settings ADD COLUMN noga_detailed_code TEXT;
CREATE TABLE IF NOT EXISTS invoice_qr_bills (
  invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  input_json TEXT NOT NULL,
  payload TEXT NOT NULL,
  reference_type TEXT NOT NULL CHECK(reference_type IN('QRR','SCOR','NON')),
  is_qr_iban INTEGER NOT NULL CHECK(is_qr_iban IN(0,1)),
  character_count INTEGER NOT NULL CHECK(character_count>0),
  byte_count INTEGER NOT NULL CHECK(byte_count>0),
  frozen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS invoice_qr_bills_frozen_no_update BEFORE UPDATE ON invoice_qr_bills
WHEN OLD.frozen_at IS NOT NULL OR EXISTS(SELECT 1 FROM invoices WHERE id=OLD.invoice_id AND number IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'issued invoice QR bill is immutable'); END;
CREATE TRIGGER IF NOT EXISTS invoice_qr_bills_frozen_no_delete BEFORE DELETE ON invoice_qr_bills
WHEN OLD.frozen_at IS NOT NULL OR EXISTS(SELECT 1 FROM invoices WHERE id=OLD.invoice_id AND number IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'issued invoice QR bill is immutable'); END;
PRAGMA user_version=3;
"#;

/// Répare les bases v3 publiées avant l'ajout effectif de la persistance QR.
/// Toutes les instructions sont idempotentes afin de couvrir aussi les bases v3
/// qui possèdent déjà tout ou partie de cette structure.
pub const MIGRATION_V4_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS invoice_qr_bills (
  invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  input_json TEXT NOT NULL,
  payload TEXT NOT NULL,
  reference_type TEXT NOT NULL CHECK(reference_type IN('QRR','SCOR','NON')),
  is_qr_iban INTEGER NOT NULL CHECK(is_qr_iban IN(0,1)),
  character_count INTEGER NOT NULL CHECK(character_count>0),
  byte_count INTEGER NOT NULL CHECK(byte_count>0),
  frozen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoice_qr_bills_frozen
ON invoice_qr_bills(frozen_at, invoice_id);
CREATE TRIGGER IF NOT EXISTS invoice_qr_bills_frozen_no_update BEFORE UPDATE ON invoice_qr_bills
WHEN OLD.frozen_at IS NOT NULL OR EXISTS(SELECT 1 FROM invoices WHERE id=OLD.invoice_id AND number IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'issued invoice QR bill is immutable'); END;
CREATE TRIGGER IF NOT EXISTS invoice_qr_bills_frozen_no_delete BEFORE DELETE ON invoice_qr_bills
WHEN OLD.frozen_at IS NOT NULL OR EXISTS(SELECT 1 FROM invoices WHERE id=OLD.invoice_id AND number IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'issued invoice QR bill is immutable'); END;
PRAGMA user_version=4;
"#;

/// Ajoute le sas d'import documentaire local et les modèles de paie confirmés.
/// Aucune donnée sensible n'est créée ni envoyée hors de l'ordinateur.
pub const MIGRATION_V5_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS payroll_document_imports (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  stored_path TEXT NOT NULL UNIQUE,
  file_sha256 TEXT NOT NULL UNIQUE,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('pdf','image')),
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  page_count INTEGER,
  extraction_engine TEXT NOT NULL,
  engine_version TEXT,
  extracted_text TEXT,
  draft_json TEXT NOT NULL,
  confidence_bp INTEGER NOT NULL DEFAULT 0 CHECK (confidence_bp BETWEEN 0 AND 10000),
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review','confirmed','rejected','error')),
  error_message TEXT,
  employee_id TEXT REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL,
  payslip_id TEXT REFERENCES payslips(id) ON UPDATE CASCADE ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employee_payroll_templates (
  employee_id TEXT PRIMARY KEY REFERENCES employees(id) ON UPDATE CASCADE ON DELETE CASCADE,
  salary_mode TEXT NOT NULL CHECK (salary_mode IN ('monthly','hourly')),
  base_salary_cents INTEGER NOT NULL DEFAULT 0 CHECK (base_salary_cents >= 0),
  recurring_earnings_json TEXT NOT NULL DEFAULT '[]',
  suggested_contribution_codes_json TEXT NOT NULL DEFAULT '[]',
  source_import_id TEXT REFERENCES payroll_document_imports(id) ON UPDATE CASCADE ON DELETE SET NULL,
  reviewed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payroll_imports_status_created ON payroll_document_imports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payroll_imports_employee ON payroll_document_imports(employee_id, created_at DESC);
PRAGMA user_version=5;
"#;
