pub const SCHEMA_VERSION: i64 = 1;

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
    "attachments",
    "active_timers",
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
  uid_number TEXT,
  vat_number TEXT,
  vat_registered INTEGER NOT NULL DEFAULT 0 CHECK (vat_registered IN (0, 1)),
  default_vat_bp INTEGER NOT NULL DEFAULT 0 CHECK (default_vat_bp BETWEEN 0 AND 10000),
  iban TEXT,
  bank_name TEXT,
  currency TEXT NOT NULL DEFAULT 'CHF',
  quote_prefix TEXT NOT NULL DEFAULT 'D',
  invoice_prefix TEXT NOT NULL DEFAULT 'F',
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
  number TEXT,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'brouillon',
  issue_date TEXT,
  due_date TEXT,
  currency TEXT NOT NULL DEFAULT 'CHF',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  vat_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  terms TEXT,
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

PRAGMA user_version = 1;
"#;
