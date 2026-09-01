pub const SCHEMA_VERSION: i64 = 19;

#[cfg(test)]
pub const BUSINESS_TABLES: &[&str] = &[
    "clients",
    "catalog_items",
    "suppliers",
    "projects",
    "project_milestones",
    "project_tasks",
    "quotes",
    "quote_items",
    "invoices",
    "invoice_items",
    "stock_movements",
    "employees",
    "time_entries",
    "time_billing_batches",
    "time_billing_entries",
    "expenses",
    "supplier_invoices",
    "supplier_invoice_items",
    "supplier_payments",
    "payslips",
    "payslip_items",
    "payments",
    "bank_imports",
    "bank_movements",
    "bank_movement_keys",
    "bank_reconciliations",
    "bank_supplier_reconciliations",
    "bank_account_links",
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
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('product', 'service')),
  sku TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'unité',
  sales_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (sales_price_cents >= 0),
  purchase_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (purchase_cost_cents >= 0),
  vat_bp INTEGER NOT NULL DEFAULT 0 CHECK (vat_bp BETWEEN 0 AND 10000),
  track_stock INTEGER NOT NULL DEFAULT 0 CHECK (track_stock IN (0, 1)),
  stock_quantity_milli INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity_milli >= 0),
  reorder_level_milli INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level_milli >= 0),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (track_stock=0 OR kind='product')
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  uid_number TEXT,
  iban TEXT,
  currency TEXT NOT NULL DEFAULT 'CHF' CHECK (currency = 'CHF'),
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  notes TEXT,
  archived_at TEXT,
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
  catalog_item_id TEXT REFERENCES catalog_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
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
  catalog_item_id TEXT REFERENCES catalog_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
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

CREATE TABLE IF NOT EXISTS stock_movements (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (LENGTH(id) BETWEEN 1 AND 255),
  source_key TEXT NOT NULL UNIQUE CHECK (LENGTH(source_key) BETWEEN 1 AND 300),
  request_id TEXT UNIQUE,
  request_sha256 TEXT,
  request_json TEXT,
  catalog_item_id TEXT NOT NULL REFERENCES catalog_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('entry', 'exit', 'correction')),
  quantity_delta_milli INTEGER NOT NULL CHECK (
    quantity_delta_milli <> 0 AND
    quantity_delta_milli BETWEEN -9000000000000000 AND 9000000000000000
  ),
  balance_after_milli INTEGER NOT NULL CHECK (balance_after_milli BETWEEN 0 AND 9000000000000000),
  reason TEXT NOT NULL CHECK (LENGTH(TRIM(reason)) BETWEEN 1 AND 500),
  reference TEXT CHECK (reference IS NULL OR LENGTH(reference) <= 200),
  movement_date TEXT NOT NULL CHECK (
    LENGTH(movement_date) = 10 AND
    movement_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
  ),
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'invoice', 'opening')),
  invoice_id TEXT REFERENCES invoices(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  invoice_item_id TEXT UNIQUE REFERENCES invoice_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (LENGTH(created_at) BETWEEN 1 AND 64),
  CHECK (
    (movement_type = 'entry' AND quantity_delta_milli > 0) OR
    (movement_type = 'exit' AND quantity_delta_milli < 0) OR
    movement_type = 'correction'
  ),
  CHECK (
    (source_type = 'manual' AND request_id IS NOT NULL AND request_sha256 IS NOT NULL AND request_json IS NOT NULL AND invoice_id IS NULL AND invoice_item_id IS NULL) OR
    (source_type = 'invoice' AND request_id IS NULL AND request_sha256 IS NULL AND request_json IS NULL AND invoice_id IS NOT NULL AND invoice_item_id IS NOT NULL AND movement_type = 'exit') OR
    (source_type = 'opening' AND request_id IS NULL AND request_sha256 IS NULL AND request_json IS NULL AND invoice_id IS NULL AND invoice_item_id IS NULL AND movement_type = 'correction' AND quantity_delta_milli > 0)
  )
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
  country TEXT NOT NULL DEFAULT 'CH',
  birth_date TEXT,
  social_security_number TEXT,
  iban TEXT,
  employment_start_date TEXT,
  employment_end_date TEXT,
  reference_age_date TEXT,
  avs_allowance_waived INTEGER CHECK (avs_allowance_waived IS NULL OR avs_allowance_waived IN (0, 1)),
  contractual_weekly_minutes INTEGER CHECK (contractual_weekly_minutes IS NULL OR contractual_weekly_minutes BETWEEN 0 AND 10080),
  ac_opening_year INTEGER CHECK (ac_opening_year IS NULL OR ac_opening_year BETWEEN 1900 AND 9999),
  ac_opening_basis_cents INTEGER CHECK (ac_opening_basis_cents IS NULL OR ac_opening_basis_cents >= 0),
  employment_rate INTEGER NOT NULL DEFAULT 100 CHECK (employment_rate BETWEEN 1 AND 100),
  hourly_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (hourly_rate_cents >= 0),
  monthly_salary_cents INTEGER NOT NULL DEFAULT 0 CHECK (monthly_salary_cents >= 0),
  status TEXT NOT NULL DEFAULT 'actif',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (LENGTH(TRIM(title)) BETWEEN 1 AND 200),
  description TEXT CHECK (description IS NULL OR LENGTH(description) <= 20000),
  due_date TEXT CHECK (due_date IS NULL OR (LENGTH(due_date)=10 AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 1000000),
  employee_id TEXT REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status='done' AND completed_at IS NOT NULL) OR (status<>'done' AND completed_at IS NULL))
);

CREATE TABLE IF NOT EXISTS project_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  milestone_id TEXT REFERENCES project_milestones(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (LENGTH(TRIM(title)) BETWEEN 1 AND 200),
  description TEXT CHECK (description IS NULL OR LENGTH(description) <= 20000),
  due_date TEXT CHECK (due_date IS NULL OR (LENGTH(due_date)=10 AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 1000000),
  employee_id TEXT REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status='done' AND completed_at IS NOT NULL) OR (status<>'done' AND completed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_project_milestones_project_order ON project_milestones(project_id,sort_order,created_at);
CREATE INDEX IF NOT EXISTS idx_project_milestones_due ON project_milestones(status,due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_tasks_project_order ON project_tasks(project_id,sort_order,created_at);
CREATE INDEX IF NOT EXISTS idx_project_tasks_milestone_order ON project_tasks(milestone_id,sort_order,created_at) WHERE milestone_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_tasks_assignee_status ON project_tasks(employee_id,status) WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_tasks_due ON project_tasks(status,due_date) WHERE due_date IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS project_milestones_project_immutable
BEFORE UPDATE OF project_id ON project_milestones WHEN NEW.project_id<>OLD.project_id
BEGIN SELECT RAISE(ABORT,'project milestone cannot change project'); END;
CREATE TRIGGER IF NOT EXISTS project_milestones_terminal_guard
BEFORE UPDATE OF status ON project_milestones
WHEN NEW.status IN ('done','cancelled') AND EXISTS(
  SELECT 1 FROM project_tasks task
  WHERE task.milestone_id=OLD.id AND task.status NOT IN ('done','cancelled')
)
BEGIN SELECT RAISE(ABORT,'milestone has active tasks'); END;
CREATE TRIGGER IF NOT EXISTS project_milestones_due_guard
BEFORE UPDATE OF due_date ON project_milestones
WHEN NEW.due_date IS NOT NULL AND EXISTS(
  SELECT 1 FROM project_tasks task
  WHERE task.milestone_id=OLD.id AND task.due_date IS NOT NULL AND task.due_date>NEW.due_date
)
BEGIN SELECT RAISE(ABORT,'milestone due date precedes a task due date'); END;
CREATE TRIGGER IF NOT EXISTS project_tasks_project_immutable
BEFORE UPDATE OF project_id ON project_tasks WHEN NEW.project_id<>OLD.project_id
BEGIN SELECT RAISE(ABORT,'project task cannot change project'); END;
CREATE TRIGGER IF NOT EXISTS project_tasks_milestone_insert_guard
BEFORE INSERT ON project_tasks
WHEN NEW.milestone_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM project_milestones milestone
  WHERE milestone.id=NEW.milestone_id AND milestone.project_id=NEW.project_id
    AND milestone.status IN ('todo','in_progress')
)
BEGIN SELECT RAISE(ABORT,'task milestone is invalid or closed'); END;
CREATE TRIGGER IF NOT EXISTS project_tasks_milestone_update_guard
BEFORE UPDATE OF milestone_id,project_id ON project_tasks
WHEN NEW.milestone_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM project_milestones milestone
  WHERE milestone.id=NEW.milestone_id AND milestone.project_id=NEW.project_id
    AND milestone.status IN ('todo','in_progress')
)
BEGIN SELECT RAISE(ABORT,'task milestone is invalid or closed'); END;

CREATE TABLE IF NOT EXISTS time_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  task_id TEXT REFERENCES project_tasks(id) ON UPDATE CASCADE ON DELETE SET NULL,
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

CREATE INDEX IF NOT EXISTS idx_time_entries_task_date ON time_entries(task_id,date) WHERE task_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS time_entries_task_insert_guard
BEFORE INSERT ON time_entries
WHEN NEW.task_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM project_tasks task WHERE task.id=NEW.task_id AND task.project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT,'time entry task belongs to another project'); END;
CREATE TRIGGER IF NOT EXISTS time_entries_task_update_guard
BEFORE UPDATE OF task_id,project_id ON time_entries
WHEN NEW.task_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM project_tasks task WHERE task.id=NEW.task_id AND task.project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT,'time entry task belongs to another project'); END;

CREATE TABLE IF NOT EXISTS time_billing_batches (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_sha256 TEXT NOT NULL CHECK (LENGTH(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_json TEXT NOT NULL,
  invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  client_id TEXT NOT NULL REFERENCES clients(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  vat_bp INTEGER NOT NULL CHECK (vat_bp BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS time_billing_entries (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES time_billing_batches(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  time_entry_id TEXT NOT NULL UNIQUE REFERENCES time_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  invoice_item_id TEXT NOT NULL UNIQUE REFERENCES invoice_items(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  entry_date_snapshot TEXT NOT NULL,
  minutes_snapshot INTEGER NOT NULL CHECK (minutes_snapshot > 0),
  billing_rate_cents_snapshot INTEGER NOT NULL CHECK (billing_rate_cents_snapshot > 0),
  amount_cents_snapshot INTEGER NOT NULL CHECK (amount_cents_snapshot >= 0),
  employee_name_snapshot TEXT NOT NULL,
  note_snapshot TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  supplier_id TEXT REFERENCES suppliers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  date TEXT NOT NULL,
  due_date TEXT,
  supplier TEXT,
  category TEXT,
  reference TEXT,
  currency TEXT NOT NULL DEFAULT 'CHF' CHECK (currency = 'CHF'),
  net_cents INTEGER NOT NULL DEFAULT 0,
  vat_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'paid' CHECK (payment_status IN ('pending', 'paid')),
  paid_at TEXT,
  reimbursable INTEGER NOT NULL DEFAULT 0 CHECK (reimbursable IN (0, 1)),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (payment_status <> 'pending' OR (due_date IS NOT NULL AND due_date <> '' AND paid_at IS NULL))
);

CREATE TABLE IF NOT EXISTS supplier_invoices (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  document_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  reference TEXT,
  reference_normalized TEXT,
  currency TEXT NOT NULL DEFAULT 'CHF' CHECK (currency = 'CHF'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validated')),
  net_cents INTEGER NOT NULL DEFAULT 0 CHECK (net_cents >= 0),
  vat_cents INTEGER NOT NULL DEFAULT 0 CHECK (vat_cents >= 0),
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  validated_at TEXT,
  validation_journal_entry_id TEXT REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  snapshot_json TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (total_cents = net_cents + vat_cents),
  CHECK (paid_cents <= total_cents),
  CHECK (due_date >= document_date),
  CHECK ((status='draft' AND validated_at IS NULL AND validation_journal_entry_id IS NULL AND snapshot_json IS NULL AND paid_cents=0)
    OR (status='validated' AND validated_at IS NOT NULL AND validation_journal_entry_id IS NOT NULL AND snapshot_json IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS supplier_invoice_items (
  id TEXT PRIMARY KEY,
  supplier_invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id) ON UPDATE CASCADE ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  description TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
  unit TEXT NOT NULL DEFAULT 'unité',
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  discount_bp INTEGER NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
  vat_bp INTEGER NOT NULL DEFAULT 0 CHECK (vat_bp BETWEEN 0 AND 10000),
  line_net_cents INTEGER NOT NULL CHECK (line_net_cents >= 0),
  line_vat_cents INTEGER NOT NULL CHECK (line_vat_cents >= 0),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0),
  category TEXT NOT NULL,
  expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (line_total_cents = line_net_cents + line_vat_cents)
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id TEXT PRIMARY KEY,
  supplier_invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT,
  reference TEXT,
  notes TEXT,
  journal_entry_id TEXT NOT NULL UNIQUE REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL
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
  payment_reference TEXT,
  payment_journal_entry_id TEXT REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
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
  posting_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
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

CREATE TABLE IF NOT EXISTS bank_imports (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 10485760),
  message_type TEXT NOT NULL CHECK (message_type IN ('camt.053','camt.054')),
  namespace_version TEXT NOT NULL CHECK (namespace_version IN ('001.04','001.08')),
  account_id TEXT,
  account_currency TEXT,
  entry_count INTEGER NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  imported_count INTEGER NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  ignored_count INTEGER NOT NULL DEFAULT 0 CHECK (ignored_count >= 0),
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_movements (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES bank_imports(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  booked_import_id TEXT REFERENCES bank_imports(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  entry_sequence INTEGER NOT NULL CHECK (entry_sequence > 0),
  account_id TEXT NOT NULL,
  account_currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  credit_debit TEXT NOT NULL CHECK (credit_debit IN ('CRDT','DBIT')),
  status TEXT NOT NULL CHECK (status IN ('BOOK','PDNG')),
  reversal INTEGER NOT NULL DEFAULT 0 CHECK (reversal IN (0,1)),
  booking_date TEXT,
  value_date TEXT,
  account_servicer_ref TEXT,
  reference_level TEXT CHECK (reference_level IN ('D','C')),
  end_to_end_id TEXT,
  transaction_id TEXT,
  reference_type TEXT NOT NULL DEFAULT 'NON' CHECK (reference_type IN ('QRR','SCOR','NON','CONFLICT')),
  reference TEXT,
  unstructured TEXT,
  counterparty_name TEXT,
  counterparty_iban TEXT,
  strong_key TEXT UNIQUE,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  enriched_at TEXT,
  UNIQUE(import_id, entry_sequence)
);

CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id TEXT PRIMARY KEY,
  movement_id TEXT NOT NULL UNIQUE REFERENCES bank_movements(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_supplier_reconciliations (
  id TEXT PRIMARY KEY,
  movement_id TEXT NOT NULL UNIQUE REFERENCES bank_movements(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  supplier_invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  supplier_payment_id TEXT NOT NULL UNIQUE REFERENCES supplier_payments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_movement_keys (
  strong_key TEXT PRIMARY KEY,
  movement_id TEXT NOT NULL REFERENCES bank_movements(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  account_id TEXT NOT NULL,
  reference_level TEXT NOT NULL CHECK (reference_level IN ('D','C','T')),
  account_servicer_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_account_links (
  account_id TEXT PRIMARY KEY,
  currency TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  confirmed_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((active=1 AND revoked_at IS NULL) OR (active=0 AND revoked_at IS NOT NULL))
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
  task_id TEXT REFERENCES project_tasks(id) ON UPDATE CASCADE ON DELETE SET NULL,
  employee_id TEXT REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  note TEXT,
  billable INTEGER NOT NULL DEFAULT 1 CHECK (billable IN (0, 1)),
  billing_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (billing_rate_cents >= 0),
  cost_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_rate_cents >= 0)
);

CREATE TRIGGER IF NOT EXISTS active_timers_task_insert_guard
BEFORE INSERT ON active_timers
WHEN NEW.task_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM project_tasks task
  WHERE task.id=NEW.task_id AND task.project_id=NEW.project_id
    AND task.status IN ('todo','in_progress')
)
BEGIN SELECT RAISE(ABORT,'active timer task is invalid or closed'); END;
CREATE TRIGGER IF NOT EXISTS active_timers_task_update_guard
BEFORE UPDATE OF task_id,project_id ON active_timers
WHEN NEW.task_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM project_tasks task
  WHERE task.id=NEW.task_id AND task.project_id=NEW.project_id
    AND task.status IN ('todo','in_progress')
)
BEGIN SELECT RAISE(ABORT,'active timer task is invalid or closed'); END;
CREATE TRIGGER IF NOT EXISTS project_tasks_active_timer_close_guard
BEFORE UPDATE OF status ON project_tasks
WHEN NEW.status IN ('done','cancelled') AND OLD.status NOT IN ('done','cancelled')
  AND EXISTS(SELECT 1 FROM active_timers timer WHERE timer.task_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'task has an active timer'); END;

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
  last_seen_date TEXT NOT NULL,
  clock_anchor_version INTEGER NOT NULL DEFAULT 0 CHECK (clock_anchor_version IN (0, 1))
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
  supplier_payable_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
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
  liability_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
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
CREATE INDEX IF NOT EXISTS idx_catalog_items_name ON catalog_items(name COLLATE NOCASE, created_at);
CREATE INDEX IF NOT EXISTS idx_catalog_items_sku ON catalog_items(sku COLLATE NOCASE) WHERE sku IS NOT NULL AND sku <> '';
CREATE INDEX IF NOT EXISTS idx_catalog_items_archived ON catalog_items(archived_at, kind, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name COLLATE NOCASE, created_at);
CREATE INDEX IF NOT EXISTS idx_suppliers_archived ON suppliers(archived_at, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_quotes_client ON quotes(client_id);
CREATE INDEX IF NOT EXISTS idx_quotes_project ON quotes(project_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_quote_items_quote ON quote_items(quote_id, position);
CREATE INDEX IF NOT EXISTS idx_quote_items_catalog ON quote_items(catalog_item_id) WHERE catalog_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_project ON invoices(project_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id, position);
CREATE INDEX IF NOT EXISTS idx_invoice_items_catalog ON invoice_items(catalog_item_id) WHERE catalog_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_catalog ON stock_movements(catalog_item_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements(movement_date DESC, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_invoice ON stock_movements(invoice_id, sequence) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_time_project_date ON time_entries(project_id, date);
CREATE INDEX IF NOT EXISTS idx_time_employee_date ON time_entries(employee_id, date);
CREATE INDEX IF NOT EXISTS idx_time_billing_batches_project ON time_billing_batches(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_time_billing_batches_client ON time_billing_batches(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_time_billing_entries_batch ON time_billing_entries(batch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_expenses_project_date ON expenses(project_id, date);
CREATE INDEX IF NOT EXISTS idx_expenses_supplier_date ON expenses(supplier_id, date DESC) WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_payment_due ON expenses(payment_status, due_date) WHERE payment_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_payslips_employee_period ON payslips(employee_id, period);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_date ON payments(invoice_id, date);
CREATE INDEX IF NOT EXISTS idx_bank_imports_created ON bank_imports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_movements_review ON bank_movements(status, credit_debit, reversal, booking_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_movements_import ON bank_movements(import_id, entry_sequence);
CREATE INDEX IF NOT EXISTS idx_bank_movements_booked_import ON bank_movements(booked_import_id, entry_sequence) WHERE booked_import_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_movement_keys_movement ON bank_movement_keys(movement_id, reference_level);
CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_invoice ON bank_reconciliations(invoice_id, confirmed_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_supplier_reconciliations_invoice ON bank_supplier_reconciliations(supplier_invoice_id, confirmed_at DESC);
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

CREATE TRIGGER IF NOT EXISTS attachments_supplier_insert_guard
BEFORE INSERT ON attachments
WHEN NEW.entity_type='supplier_invoice' AND (
  NEW.entity_id IS NULL OR NOT EXISTS(SELECT 1 FROM supplier_invoices invoice WHERE invoice.id=NEW.entity_id AND invoice.status='draft') OR
  COALESCE(NEW.project_id,'')<>COALESCE((SELECT invoice.project_id FROM supplier_invoices invoice WHERE invoice.id=NEW.entity_id),'') OR
  NEW.mime_type NOT IN ('application/pdf','image/png','image/jpeg','image/webp') OR
  NEW.size_bytes<=0 OR NEW.size_bytes>26214400 OR
  NEW.sha256 IS NULL OR LENGTH(NEW.sha256)<>64 OR NEW.sha256 GLOB '*[^0-9a-f]*' OR
  (NEW.mime_type='application/pdf' AND NEW.stored_name NOT GLOB '*.pdf') OR
  (NEW.mime_type='image/png' AND NEW.stored_name NOT GLOB '*.png') OR
  (NEW.mime_type='image/jpeg' AND NEW.stored_name NOT GLOB '*.jpg') OR
  (NEW.mime_type='image/webp' AND NEW.stored_name NOT GLOB '*.webp') OR
  EXISTS(SELECT 1 FROM attachments duplicate WHERE duplicate.entity_type='supplier_invoice' AND duplicate.entity_id=NEW.entity_id AND duplicate.sha256=NEW.sha256) OR
  (SELECT COUNT(*) FROM attachments existing WHERE existing.entity_type='supplier_invoice' AND existing.entity_id=NEW.entity_id)>=20
) BEGIN SELECT RAISE(ABORT, 'invalid supplier invoice attachment'); END;
CREATE TRIGGER IF NOT EXISTS attachments_no_update
BEFORE UPDATE ON attachments BEGIN SELECT RAISE(ABORT, 'attachments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS attachments_supplier_validated_no_delete
BEFORE DELETE ON attachments
WHEN OLD.entity_type='supplier_invoice' AND EXISTS(SELECT 1 FROM supplier_invoices invoice WHERE invoice.id=OLD.entity_id AND invoice.status<>'draft')
BEGIN SELECT RAISE(ABORT, 'validated supplier invoice attachments are immutable'); END;

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
CREATE TRIGGER IF NOT EXISTS time_billing_batches_insert_guard
BEFORE INSERT ON time_billing_batches
WHEN LENGTH(TRIM(NEW.request_id)) <> 36 OR
  LENGTH(NEW.request_sha256) <> 64 OR NEW.request_sha256 GLOB '*[^0-9a-f]*' OR
  NOT EXISTS(
    SELECT 1
    FROM invoices invoice
    JOIN projects project ON project.id=NEW.project_id AND project.client_id=NEW.client_id
    JOIN clients client ON client.id=NEW.client_id
    WHERE invoice.id=NEW.invoice_id
      AND invoice.project_id=NEW.project_id
      AND invoice.client_id=NEW.client_id
      AND invoice.type='standard'
      AND invoice.status='brouillon'
      AND invoice.number IS NULL
      AND invoice.currency='CHF'
  )
BEGIN SELECT RAISE(ABORT, 'invalid time billing batch'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_batches_no_update
BEFORE UPDATE ON time_billing_batches BEGIN SELECT RAISE(ABORT, 'time billing batches are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_batches_no_delete
BEFORE DELETE ON time_billing_batches
WHEN EXISTS(SELECT 1 FROM invoices invoice WHERE invoice.id=OLD.invoice_id)
BEGIN SELECT RAISE(ABORT, 'time billing batches are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_entries_insert_guard
BEFORE INSERT ON time_billing_entries
WHEN NOT EXISTS(
  SELECT 1
  FROM time_billing_batches batch
  JOIN invoices invoice ON invoice.id=batch.invoice_id
  JOIN time_entries source ON source.id=NEW.time_entry_id
  LEFT JOIN employees employee ON employee.id=source.employee_id
  JOIN invoice_items item ON item.id=NEW.invoice_item_id AND item.invoice_id=invoice.id
  WHERE batch.id=NEW.batch_id
    AND invoice.number IS NULL AND invoice.status='brouillon'
    AND source.project_id=batch.project_id
    AND source.billable=1 AND source.status='approuve'
    AND source.minutes>0 AND source.minutes<=5256000
    AND source.billing_rate_cents>0 AND source.billing_rate_cents<=100000000
    AND NEW.entry_date_snapshot=source.date
    AND NEW.minutes_snapshot=source.minutes
    AND NEW.billing_rate_cents_snapshot=source.billing_rate_cents
    AND NEW.amount_cents_snapshot=((source.minutes * source.billing_rate_cents + 30) / 60)
    AND NEW.employee_name_snapshot=COALESCE(NULLIF(TRIM(employee.name),''),'Non attribué')
    AND NEW.note_snapshot=COALESCE(source.note,'')
    AND item.unit='heure'
    AND item.unit_price_cents=NEW.billing_rate_cents_snapshot
    AND item.discount_bp=0
    AND item.vat_bp=batch.vat_bp
    AND ABS(item.quantity - (CAST(NEW.minutes_snapshot AS REAL) / 60.0)) <= 0.000000001
    AND CAST(ROUND(item.quantity * item.unit_price_cents) AS INTEGER)=NEW.amount_cents_snapshot
    AND item.line_net_cents=NEW.amount_cents_snapshot
    AND item.line_vat_cents=((NEW.amount_cents_snapshot * batch.vat_bp + 5000) / 10000)
    AND item.line_total_cents=item.line_net_cents + item.line_vat_cents
)
BEGIN SELECT RAISE(ABORT, 'invalid time billing entry'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_entries_no_update
BEFORE UPDATE ON time_billing_entries BEGIN SELECT RAISE(ABORT, 'time billing entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_entries_no_delete
BEFORE DELETE ON time_billing_entries
WHEN EXISTS(
  SELECT 1 FROM time_billing_batches batch
  JOIN invoices invoice ON invoice.id=batch.invoice_id
  WHERE batch.id=OLD.batch_id
)
BEGIN SELECT RAISE(ABORT, 'time billing entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_entries_billing_no_update
BEFORE UPDATE ON time_entries
WHEN EXISTS(SELECT 1 FROM time_billing_entries billed WHERE billed.time_entry_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'reserved or billed time entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_entries_billing_no_delete
BEFORE DELETE ON time_entries
WHEN EXISTS(SELECT 1 FROM time_billing_entries billed WHERE billed.time_entry_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'reserved or billed time entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_invoice_link_guard
BEFORE UPDATE ON invoices
WHEN EXISTS(SELECT 1 FROM time_billing_batches batch WHERE batch.invoice_id=OLD.id) AND (
  NEW.client_id IS NOT OLD.client_id OR NEW.project_id IS NOT OLD.project_id OR
  NEW.quote_id IS NOT OLD.quote_id OR NEW.original_invoice_id IS NOT OLD.original_invoice_id OR
  NEW.type IS NOT OLD.type OR NEW.currency IS NOT OLD.currency
)
BEGIN SELECT RAISE(ABORT, 'time billing invoice linkage is immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_invoice_items_no_insert
BEFORE INSERT ON invoice_items
WHEN EXISTS(SELECT 1 FROM time_billing_batches batch WHERE batch.invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT, 'time billing invoice lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_invoice_items_no_update
BEFORE UPDATE ON invoice_items
WHEN EXISTS(SELECT 1 FROM time_billing_batches batch WHERE batch.invoice_id=OLD.invoice_id)
BEGIN SELECT RAISE(ABORT, 'time billing invoice lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_invoice_items_no_delete
BEFORE DELETE ON invoice_items
WHEN EXISTS(SELECT 1 FROM time_billing_batches batch WHERE batch.invoice_id=OLD.invoice_id)
  AND EXISTS(SELECT 1 FROM invoices invoice WHERE invoice.id=OLD.invoice_id)
BEGIN SELECT RAISE(ABORT, 'time billing invoice lines are immutable'); END;

CREATE TRIGGER IF NOT EXISTS catalog_items_initial_stock_guard
BEFORE INSERT ON catalog_items
WHEN NEW.track_stock=1 AND NEW.stock_quantity_milli<>0
BEGIN SELECT RAISE(ABORT, 'tracked catalog items must start with zero stock'); END;
CREATE TRIGGER IF NOT EXISTS catalog_items_stock_kind_insert_guard
BEFORE INSERT ON catalog_items
WHEN NEW.track_stock=1 AND NEW.kind<>'product'
BEGIN SELECT RAISE(ABORT, 'only products can be tracked in stock'); END;
CREATE TRIGGER IF NOT EXISTS catalog_items_stock_kind_update_guard
BEFORE UPDATE OF kind,track_stock ON catalog_items
WHEN NEW.track_stock=1 AND NEW.kind<>'product'
BEGIN SELECT RAISE(ABORT, 'only products can be tracked in stock'); END;
CREATE TRIGGER IF NOT EXISTS catalog_items_stock_balance_guard
BEFORE UPDATE OF stock_quantity_milli ON catalog_items
WHEN NEW.track_stock=1 AND NEW.stock_quantity_milli<>COALESCE(
  (SELECT movement.balance_after_milli
   FROM stock_movements movement
   WHERE movement.catalog_item_id=NEW.id
   ORDER BY movement.sequence DESC LIMIT 1),
  0
)
BEGIN SELECT RAISE(ABORT, 'tracked stock can only change through stock movements'); END;
CREATE TRIGGER IF NOT EXISTS catalog_items_track_stock_history_guard
BEFORE UPDATE OF track_stock ON catalog_items
WHEN NEW.track_stock<>OLD.track_stock AND EXISTS(
  SELECT 1 FROM stock_movements movement WHERE movement.catalog_item_id=OLD.id
)
BEGIN SELECT RAISE(ABORT, 'stock tracking cannot change after the first movement'); END;
CREATE TRIGGER IF NOT EXISTS catalog_items_track_stock_enable_guard
BEFORE UPDATE OF track_stock ON catalog_items
WHEN OLD.track_stock=0 AND NEW.track_stock=1 AND NEW.stock_quantity_milli<>0
BEGIN SELECT RAISE(ABORT, 'stock tracking can only start from a zero balance'); END;
CREATE TRIGGER IF NOT EXISTS catalog_items_stock_history_no_delete
BEFORE DELETE ON catalog_items
WHEN EXISTS(SELECT 1 FROM stock_movements movement WHERE movement.catalog_item_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'catalog items with stock history are immutable'); END;

CREATE TRIGGER IF NOT EXISTS stock_movements_insert_guard
BEFORE INSERT ON stock_movements
WHEN
  NOT EXISTS(
    SELECT 1 FROM catalog_items item
    WHERE item.id=NEW.catalog_item_id AND item.track_stock=1 AND item.kind='product'
  ) OR
  (NEW.request_id IS NOT NULL AND LENGTH(TRIM(NEW.request_id))<>36) OR
  (NEW.request_sha256 IS NOT NULL AND (
    LENGTH(NEW.request_sha256)<>64 OR NEW.request_sha256 GLOB '*[^0-9a-f]*'
  )) OR
  (NEW.request_json IS NOT NULL AND (LENGTH(NEW.request_json)=0 OR LENGTH(NEW.request_json)>20000)) OR
  NOT (
    (
      NEW.source_type='opening' AND
      NEW.id='opening:' || NEW.catalog_item_id AND
      NEW.source_key=NEW.id AND
      NEW.quantity_delta_milli=NEW.balance_after_milli AND
      NEW.quantity_delta_milli=(SELECT item.stock_quantity_milli FROM catalog_items item WHERE item.id=NEW.catalog_item_id) AND
      NOT EXISTS(SELECT 1 FROM stock_movements prior WHERE prior.catalog_item_id=NEW.catalog_item_id)
    ) OR
    (
      NEW.source_type='manual' AND
      NEW.source_key='manual:' || NEW.request_id AND
      NEW.balance_after_milli=(SELECT item.stock_quantity_milli + NEW.quantity_delta_milli FROM catalog_items item WHERE item.id=NEW.catalog_item_id)
    ) OR
    (
      NEW.source_type='invoice' AND
      NEW.source_key='invoice:' || NEW.invoice_item_id AND
      NEW.balance_after_milli=(SELECT item.stock_quantity_milli + NEW.quantity_delta_milli FROM catalog_items item WHERE item.id=NEW.catalog_item_id) AND
      EXISTS(
        SELECT 1
        FROM invoices invoice
        JOIN invoice_items line ON line.invoice_id=invoice.id
        WHERE invoice.id=NEW.invoice_id
          AND line.id=NEW.invoice_item_id
          AND line.catalog_item_id=NEW.catalog_item_id
          AND invoice.number IS NOT NULL
          AND invoice.status IN ('emise','partiellement_payee','payee')
          AND invoice.type='standard'
          AND NEW.movement_date=invoice.issue_date
          AND NEW.reference=invoice.number
          AND line.quantity>0
          AND ABS(line.quantity * 1000.0 - CAST(-NEW.quantity_delta_milli AS REAL))<=0.000001
      )
    )
  )
BEGIN SELECT RAISE(ABORT, 'invalid stock movement'); END;
CREATE TRIGGER IF NOT EXISTS stock_movements_apply_balance
AFTER INSERT ON stock_movements
WHEN NEW.source_type<>'opening'
BEGIN
  UPDATE catalog_items
  SET stock_quantity_milli=NEW.balance_after_milli,
      updated_at=NEW.created_at
  WHERE id=NEW.catalog_item_id;
END;
CREATE TRIGGER IF NOT EXISTS stock_movements_no_update
BEFORE UPDATE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock movements are immutable'); END;
CREATE TRIGGER IF NOT EXISTS stock_movements_no_delete
BEFORE DELETE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock movements are immutable'); END;
CREATE TRIGGER IF NOT EXISTS stock_invoice_no_unsafe_cancel
BEFORE UPDATE OF status ON invoices
WHEN NEW.status='annulee' AND OLD.status<>'annulee' AND EXISTS(
  SELECT 1 FROM stock_movements movement WHERE movement.invoice_id=OLD.id
)
BEGIN SELECT RAISE(ABORT, 'stock-bearing invoices cannot be cancelled without a dedicated reversal workflow'); END;

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
CREATE TRIGGER IF NOT EXISTS bank_imports_no_update
BEFORE UPDATE ON bank_imports BEGIN SELECT RAISE(ABORT, 'bank imports are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_imports_no_delete
BEFORE DELETE ON bank_imports BEGIN SELECT RAISE(ABORT, 'bank imports are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_movements_guarded_update
BEFORE UPDATE ON bank_movements WHEN NOT (
  ((OLD.status='PDNG' AND NEW.status='BOOK'
      AND OLD.booked_import_id IS NULL AND NEW.booked_import_id IS NOT NULL)
   OR (OLD.status='BOOK' AND NEW.status='BOOK'
      AND OLD.booked_import_id IS NOT NULL AND NEW.booked_import_id IS NOT NULL
      AND OLD.booked_import_id IS NOT NEW.booked_import_id
      AND EXISTS(SELECT 1 FROM bank_imports source WHERE source.id=OLD.booked_import_id AND source.message_type='camt.054')
      AND EXISTS(SELECT 1 FROM bank_imports source WHERE source.id=NEW.booked_import_id AND source.message_type='camt.053')))
  AND NOT EXISTS(SELECT 1 FROM bank_reconciliations frozen WHERE frozen.movement_id=OLD.id)
  AND NOT EXISTS(SELECT 1 FROM bank_supplier_reconciliations frozen WHERE frozen.movement_id=OLD.id)
  AND OLD.id IS NEW.id AND OLD.import_id IS NEW.import_id
  AND OLD.entry_sequence IS NEW.entry_sequence AND OLD.account_id IS NEW.account_id
  AND OLD.account_currency IS NEW.account_currency AND OLD.amount_cents IS NEW.amount_cents
  AND OLD.currency IS NEW.currency AND OLD.credit_debit IS NEW.credit_debit
  AND OLD.reversal IS NEW.reversal
  AND (OLD.account_servicer_ref IS NEW.account_servicer_ref
    OR OLD.account_servicer_ref IS NULL OR TRIM(OLD.account_servicer_ref)=''
    OR (OLD.reference_level='C' AND NEW.reference_level='D'))
  AND (OLD.reference_level IS NEW.reference_level OR OLD.reference_level IS NULL
    OR (OLD.reference_level='C' AND NEW.reference_level='D'))
  AND (OLD.end_to_end_id IS NEW.end_to_end_id OR OLD.end_to_end_id IS NULL OR TRIM(OLD.end_to_end_id)='')
  AND (OLD.transaction_id IS NEW.transaction_id OR OLD.transaction_id IS NULL OR TRIM(OLD.transaction_id)='')
  AND (OLD.reference_type IS NEW.reference_type OR (OLD.reference_type='NON' AND (OLD.reference IS NULL OR TRIM(OLD.reference)='')))
  AND (OLD.reference IS NEW.reference OR OLD.reference IS NULL OR TRIM(OLD.reference)='')
  AND (OLD.unstructured IS NEW.unstructured OR OLD.unstructured IS NULL OR TRIM(OLD.unstructured)='')
  AND (OLD.counterparty_name IS NEW.counterparty_name OR OLD.counterparty_name IS NULL OR TRIM(OLD.counterparty_name)='')
  AND (OLD.counterparty_iban IS NEW.counterparty_iban OR OLD.counterparty_iban IS NULL OR TRIM(OLD.counterparty_iban)='')
  AND OLD.strong_key IS NEW.strong_key
  AND OLD.created_at IS NEW.created_at
  AND (OLD.booking_date IS NULL OR NEW.booking_date IS NOT NULL)
  AND (OLD.value_date IS NULL OR NEW.value_date IS NOT NULL)
  AND NEW.enriched_at IS NOT NULL
) BEGIN SELECT RAISE(ABORT, 'bank movements may only receive a controlled CAMT lifecycle enrichment'); END;
CREATE TRIGGER IF NOT EXISTS bank_movements_no_delete
BEFORE DELETE ON bank_movements BEGIN SELECT RAISE(ABORT, 'bank movements are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_movement_keys_no_update
BEFORE UPDATE ON bank_movement_keys BEGIN SELECT RAISE(ABORT, 'bank movement keys are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_movement_keys_no_delete
BEFORE DELETE ON bank_movement_keys BEGIN SELECT RAISE(ABORT, 'bank movement keys are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_reconciliations_no_update
BEFORE UPDATE ON bank_reconciliations BEGIN SELECT RAISE(ABORT, 'bank reconciliations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_reconciliations_no_delete
BEFORE DELETE ON bank_reconciliations BEGIN SELECT RAISE(ABORT, 'bank reconciliations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_reconciliations_exclusive_supplier
BEFORE INSERT ON bank_reconciliations
WHEN EXISTS(SELECT 1 FROM bank_supplier_reconciliations other WHERE other.movement_id=NEW.movement_id)
BEGIN SELECT RAISE(ABORT, 'bank movement is already reconciled with a supplier invoice'); END;
CREATE TRIGGER IF NOT EXISTS bank_supplier_reconciliations_exclusive_customer
BEFORE INSERT ON bank_supplier_reconciliations
WHEN EXISTS(SELECT 1 FROM bank_reconciliations other WHERE other.movement_id=NEW.movement_id)
BEGIN SELECT RAISE(ABORT, 'bank movement is already reconciled with a customer invoice'); END;
CREATE TRIGGER IF NOT EXISTS bank_supplier_reconciliations_no_update
BEFORE UPDATE ON bank_supplier_reconciliations BEGIN SELECT RAISE(ABORT, 'supplier bank reconciliations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_supplier_reconciliations_no_delete
BEFORE DELETE ON bank_supplier_reconciliations BEGIN SELECT RAISE(ABORT, 'supplier bank reconciliations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_account_links_guarded_update
BEFORE UPDATE ON bank_account_links WHEN NOT (
  OLD.account_id IS NEW.account_id AND OLD.created_at IS NEW.created_at
  AND ((OLD.active=1 AND NEW.active=0 AND NEW.currency IS OLD.currency AND NEW.confirmed_at IS OLD.confirmed_at AND NEW.revoked_at IS NOT NULL)
    OR (OLD.active=0 AND NEW.active=1 AND NEW.revoked_at IS NULL AND NEW.confirmed_at IS NOT NULL))
) BEGIN SELECT RAISE(ABORT, 'bank account links require an explicit association or revocation'); END;
CREATE TRIGGER IF NOT EXISTS bank_account_links_no_delete
BEFORE DELETE ON bank_account_links BEGIN SELECT RAISE(ABORT, 'bank account links cannot be deleted'); END;
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
CREATE TRIGGER IF NOT EXISTS expenses_payment_state_insert_guard
BEFORE INSERT ON expenses
WHEN NEW.payment_status='pending' AND (NEW.due_date IS NULL OR TRIM(NEW.due_date)='' OR NEW.paid_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'pending expense requires a due date and no payment date'); END;
CREATE TRIGGER IF NOT EXISTS expenses_payment_state_update_guard
BEFORE UPDATE OF payment_status,paid_at,due_date ON expenses
WHEN NEW.payment_status='pending' AND (NEW.due_date IS NULL OR TRIM(NEW.due_date)='' OR NEW.paid_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'pending expense requires a due date and no payment date'); END;
CREATE TRIGGER IF NOT EXISTS payslips_posted_no_delete
BEFORE DELETE ON payslips WHEN OLD.status IN ('comptabilise','paye') BEGIN SELECT RAISE(ABORT, 'posted payslip is immutable'); END;
CREATE TRIGGER IF NOT EXISTS payslips_posted_no_update
BEFORE UPDATE ON payslips
WHEN OLD.status IN ('comptabilise','paye')
AND NOT (
  ((OLD.status='comptabilise' AND NEW.status='paye'
    AND NEW.payment_date IS NOT NULL
    AND NEW.payment_journal_entry_id IS NOT NULL)
   OR
   (OLD.status='paye' AND NEW.status='paye'
    AND (OLD.payment_date IS NULL OR OLD.payment_journal_entry_id IS NULL)
    AND NEW.payment_date IS NOT NULL
    AND NEW.payment_journal_entry_id IS NOT NULL
    AND (OLD.payment_date IS NULL OR NEW.payment_date IS OLD.payment_date)
    AND (OLD.payment_journal_entry_id IS NULL OR NEW.payment_journal_entry_id IS OLD.payment_journal_entry_id)
    AND (OLD.payment_reference IS NEW.payment_reference OR OLD.payment_reference IS NULL)))
  AND NEW.id IS OLD.id
  AND NEW.employee_id IS OLD.employee_id
  AND NEW.period IS OLD.period
  AND NEW.gross_cents IS OLD.gross_cents
  AND NEW.deductions_cents IS OLD.deductions_cents
  AND NEW.net_cents IS OLD.net_cents
  AND NEW.employer_costs_cents IS OLD.employer_costs_cents
  AND NEW.notes IS OLD.notes
  AND NEW.snapshot_json IS OLD.snapshot_json
  AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'posted payslip is immutable'); END;
CREATE TRIGGER IF NOT EXISTS payslip_items_posted_no_insert
BEFORE INSERT ON payslip_items WHEN EXISTS(SELECT 1 FROM payslips WHERE id=NEW.payslip_id AND status IN ('comptabilise','paye')) BEGIN SELECT RAISE(ABORT, 'posted payslip lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS payslip_items_posted_no_update
BEFORE UPDATE ON payslip_items WHEN EXISTS(SELECT 1 FROM payslips WHERE id=OLD.payslip_id AND status IN ('comptabilise','paye')) BEGIN SELECT RAISE(ABORT, 'posted payslip lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS payslip_items_posted_no_delete
BEFORE DELETE ON payslip_items WHEN EXISTS(SELECT 1 FROM payslips WHERE id=OLD.payslip_id AND status IN ('comptabilise','paye')) BEGIN SELECT RAISE(ABORT, 'posted payslip lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS employees_payroll_decisions_insert_guard
BEFORE INSERT ON employees
WHEN (NEW.ac_opening_year IS NULL) <> (NEW.ac_opening_basis_cents IS NULL)
BEGIN SELECT RAISE(ABORT, 'AC opening year and basis must be confirmed together'); END;
CREATE TRIGGER IF NOT EXISTS employees_payroll_decisions_update_guard
BEFORE UPDATE OF ac_opening_year,ac_opening_basis_cents ON employees
WHEN (NEW.ac_opening_year IS NULL) <> (NEW.ac_opening_basis_cents IS NULL)
BEGIN SELECT RAISE(ABORT, 'AC opening year and basis must be confirmed together'); END;

CREATE INDEX IF NOT EXISTS idx_supplier_invoices_status_due
ON supplier_invoices(status,due_date,document_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_invoices_reference_unique
ON supplier_invoices(supplier_id,reference_normalized)
WHERE status='validated' AND reference_normalized IS NOT NULL AND reference_normalized<>'';
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_items_parent
ON supplier_invoice_items(supplier_invoice_id,position);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_parent
ON supplier_payments(supplier_invoice_id,date,created_at);
CREATE TRIGGER IF NOT EXISTS supplier_invoice_items_draft_insert
BEFORE INSERT ON supplier_invoice_items
WHEN NOT EXISTS(SELECT 1 FROM supplier_invoices WHERE id=NEW.supplier_invoice_id AND status='draft')
BEGIN SELECT RAISE(ABORT, 'supplier invoice lines require a draft'); END;
CREATE TRIGGER IF NOT EXISTS supplier_invoice_items_draft_update
BEFORE UPDATE ON supplier_invoice_items
WHEN NOT EXISTS(SELECT 1 FROM supplier_invoices WHERE id=OLD.supplier_invoice_id AND status='draft')
  OR NOT EXISTS(SELECT 1 FROM supplier_invoices WHERE id=NEW.supplier_invoice_id AND status='draft')
BEGIN SELECT RAISE(ABORT, 'validated supplier invoice lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS supplier_invoice_items_draft_delete
BEFORE DELETE ON supplier_invoice_items
WHEN NOT EXISTS(SELECT 1 FROM supplier_invoices WHERE id=OLD.supplier_invoice_id AND status='draft')
BEGIN SELECT RAISE(ABORT, 'validated supplier invoice lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS supplier_invoices_validated_no_delete
BEFORE DELETE ON supplier_invoices WHEN OLD.status<>'draft'
BEGIN SELECT RAISE(ABORT, 'validated supplier invoices are immutable'); END;
CREATE TRIGGER IF NOT EXISTS supplier_invoices_validation_guard
BEFORE UPDATE ON supplier_invoices WHEN OLD.status='draft' AND NEW.status='validated' AND NOT (
  NEW.reference_normalized IS NOT NULL AND TRIM(NEW.reference_normalized)<>''
  AND NEW.total_cents>0 AND NEW.paid_cents=0 AND NEW.due_date>=NEW.document_date
  AND EXISTS(SELECT 1 FROM supplier_invoice_items item WHERE item.supplier_invoice_id=NEW.id)
  AND NEW.net_cents=(SELECT COALESCE(SUM(item.line_net_cents),0) FROM supplier_invoice_items item WHERE item.supplier_invoice_id=NEW.id)
  AND NEW.vat_cents=(SELECT COALESCE(SUM(item.line_vat_cents),0) FROM supplier_invoice_items item WHERE item.supplier_invoice_id=NEW.id)
  AND NEW.total_cents=(SELECT COALESCE(SUM(item.line_total_cents),0) FROM supplier_invoice_items item WHERE item.supplier_invoice_id=NEW.id)
  AND EXISTS(SELECT 1 FROM journal_entries entry
    WHERE entry.id=NEW.validation_journal_entry_id AND entry.source_type='supplier_invoice'
      AND entry.source_id=NEW.id AND entry.source_event='validate' AND entry.entry_date=NEW.document_date)
)
BEGIN SELECT RAISE(ABORT, 'supplier invoice validation requires its exact journal entry'); END;
CREATE TRIGGER IF NOT EXISTS supplier_invoices_validated_guard
BEFORE UPDATE ON supplier_invoices WHEN OLD.status<>'draft' AND NOT (
  NEW.id IS OLD.id AND NEW.supplier_id IS OLD.supplier_id AND NEW.project_id IS OLD.project_id
  AND NEW.document_date IS OLD.document_date AND NEW.due_date IS OLD.due_date
  AND NEW.supplier_name IS OLD.supplier_name AND NEW.reference IS OLD.reference
  AND NEW.reference_normalized IS OLD.reference_normalized AND NEW.currency IS OLD.currency
  AND NEW.status IS OLD.status AND NEW.net_cents IS OLD.net_cents AND NEW.vat_cents IS OLD.vat_cents
  AND NEW.total_cents IS OLD.total_cents AND NEW.validated_at IS OLD.validated_at
  AND NEW.validation_journal_entry_id IS OLD.validation_journal_entry_id
  AND NEW.snapshot_json IS OLD.snapshot_json AND NEW.note IS OLD.note AND NEW.created_at IS OLD.created_at
  AND NEW.paid_cents>=OLD.paid_cents AND NEW.paid_cents<=NEW.total_cents
  AND NEW.paid_cents=(SELECT COALESCE(SUM(amount_cents),0) FROM supplier_payments WHERE supplier_invoice_id=OLD.id)
)
BEGIN SELECT RAISE(ABORT, 'validated supplier invoice fields are immutable'); END;
CREATE TRIGGER IF NOT EXISTS supplier_payments_insert_guard
BEFORE INSERT ON supplier_payments WHEN NOT EXISTS(
  SELECT 1 FROM supplier_invoices invoice
  WHERE invoice.id=NEW.supplier_invoice_id AND invoice.status='validated'
    AND NEW.date>=invoice.document_date
    AND invoice.paid_cents + NEW.amount_cents <= invoice.total_cents
    AND EXISTS(SELECT 1 FROM journal_entries entry
      WHERE entry.id=NEW.journal_entry_id AND entry.source_type='supplier_payment'
        AND entry.source_id=NEW.id AND entry.source_event='invoice:' || NEW.supplier_invoice_id
        AND entry.entry_date=NEW.date)
)
BEGIN SELECT RAISE(ABORT, 'supplier payment exceeds the open validated balance'); END;
CREATE TRIGGER IF NOT EXISTS supplier_payments_update_invoice_total
AFTER INSERT ON supplier_payments
BEGIN
  UPDATE supplier_invoices
  SET paid_cents=(SELECT COALESCE(SUM(amount_cents),0) FROM supplier_payments WHERE supplier_invoice_id=NEW.supplier_invoice_id),
      updated_at=NEW.created_at
  WHERE id=NEW.supplier_invoice_id;
END;
CREATE TRIGGER IF NOT EXISTS supplier_payments_no_update
BEFORE UPDATE ON supplier_payments BEGIN SELECT RAISE(ABORT, 'supplier payments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS supplier_payments_no_delete
BEFORE DELETE ON supplier_payments BEGIN SELECT RAISE(ABORT, 'supplier payments are immutable'); END;

PRAGMA user_version = 19;
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

/// Fige les comptes comptables utilisés par chaque cotisation et autorise la
/// seule mutation financière légitime d'une fiche comptabilisée : son paiement
/// atomique, lié à une écriture de journal immuable.
pub const MIGRATION_V6_SQL: &str = r#"
DROP TRIGGER IF EXISTS payslips_posted_no_update;
CREATE TRIGGER payslips_posted_no_update
BEFORE UPDATE ON payslips
WHEN OLD.status IN ('comptabilise','paye')
AND NOT (
  OLD.status='comptabilise' AND NEW.status='paye'
  AND NEW.id IS OLD.id
  AND NEW.employee_id IS OLD.employee_id
  AND NEW.period IS OLD.period
  AND NEW.gross_cents IS OLD.gross_cents
  AND NEW.deductions_cents IS OLD.deductions_cents
  AND NEW.net_cents IS OLD.net_cents
  AND NEW.employer_costs_cents IS OLD.employer_costs_cents
  AND NEW.notes IS OLD.notes
  AND NEW.snapshot_json IS OLD.snapshot_json
  AND NEW.created_at IS OLD.created_at
  AND NEW.payment_date IS NOT NULL
  AND NEW.payment_journal_entry_id IS NOT NULL
)
BEGIN SELECT RAISE(ABORT,'posted payslip is immutable'); END;

PRAGMA user_version=6;
"#;

/// Conserve les choix sociaux confirmés pour les collaborateurs proches ou
/// au-delà de l'âge de référence. Les colonnes restent NULL sur les bases
/// existantes : Elyko ne déduit ni le sexe, ni l'âge de référence, ni la
/// renonciation à la franchise AVS.
pub const MIGRATION_V7_SQL: &str = r#"
PRAGMA user_version=7;
"#;

/// Lie chaque ligne de paie manuelle à ses comptes explicites. Les anciennes lignes restent
/// volontairement NULL : elles doivent être classées par l'utilisateur avant comptabilisation,
/// afin qu'une avance, un impôt à la source ou un remboursement ne soit jamais ventilé au hasard.
pub const MIGRATION_V8_SQL: &str = r#"
PRAGMA user_version=8;
"#;

/// Ajoute uniquement les décisions explicites nécessaires au contrôle LAA et
/// au cumul AC. Les valeurs restent NULL sur les bases existantes : aucune
/// durée contractuelle ni base d'ouverture n'est déduite par Elyko.
pub const MIGRATION_V9_SQL: &str = r#"
DROP TRIGGER IF EXISTS employees_payroll_decisions_insert_guard;
DROP TRIGGER IF EXISTS employees_payroll_decisions_update_guard;
CREATE TRIGGER employees_payroll_decisions_insert_guard
BEFORE INSERT ON employees
WHEN (NEW.ac_opening_year IS NULL) <> (NEW.ac_opening_basis_cents IS NULL)
BEGIN SELECT RAISE(ABORT,'AC opening year and basis must be confirmed together'); END;
CREATE TRIGGER employees_payroll_decisions_update_guard
BEFORE UPDATE OF ac_opening_year,ac_opening_basis_cents ON employees
WHEN (NEW.ac_opening_year IS NULL) <> (NEW.ac_opening_basis_cents IS NULL)
BEGIN SELECT RAISE(ABORT,'AC opening year and basis must be confirmed together'); END;
PRAGMA user_version=9;
"#;

/// Ajoute un catalogue local sans créer d'article de démonstration. Les références
/// facultatives sur les lignes servent uniquement à tracer la saisie : les valeurs
/// financières restent copiées dans chaque document et ne dépendent jamais du catalogue.
pub const MIGRATION_V10_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('product', 'service')),
  sku TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'unité',
  sales_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (sales_price_cents >= 0),
  purchase_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (purchase_cost_cents >= 0),
  vat_bp INTEGER NOT NULL DEFAULT 0 CHECK (vat_bp BETWEEN 0 AND 10000),
  track_stock INTEGER NOT NULL DEFAULT 0 CHECK (track_stock IN (0, 1)),
  stock_quantity_milli INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity_milli >= 0),
  reorder_level_milli INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level_milli >= 0),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_items_name ON catalog_items(name COLLATE NOCASE, created_at);
CREATE INDEX IF NOT EXISTS idx_catalog_items_sku ON catalog_items(sku COLLATE NOCASE) WHERE sku IS NOT NULL AND sku <> '';
CREATE INDEX IF NOT EXISTS idx_catalog_items_archived ON catalog_items(archived_at, kind, name COLLATE NOCASE);
PRAGMA user_version=10;
"#;

/// Ajoute les fournisseurs et le suivi du règlement des achats sans transformer
/// les dépenses historiques : elles conservent leur libellé fournisseur et sont
/// migrées avec le statut `paid`, identique à leur comportement antérieur.
pub const MIGRATION_V11_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  uid_number TEXT,
  iban TEXT,
  currency TEXT NOT NULL DEFAULT 'CHF' CHECK (currency = 'CHF'),
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  notes TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name COLLATE NOCASE, created_at);
CREATE INDEX IF NOT EXISTS idx_suppliers_archived ON suppliers(archived_at, name COLLATE NOCASE);
PRAGMA user_version=11;
"#;

/// Ajoute l'import bancaire ISO 20022 strictement local. Elyko conserve
/// l'empreinte du fichier et les mouvements structurés immuables, mais ne copie
/// pas le XML original ; seul un rapprochement confirmé peut créer un paiement.
pub const MIGRATION_V12_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS bank_imports (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 10485760),
  message_type TEXT NOT NULL CHECK (message_type IN ('camt.053','camt.054')),
  namespace_version TEXT NOT NULL CHECK (namespace_version IN ('001.04','001.08')),
  account_id TEXT,
  account_currency TEXT,
  entry_count INTEGER NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  imported_count INTEGER NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  ignored_count INTEGER NOT NULL DEFAULT 0 CHECK (ignored_count >= 0),
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bank_movements (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES bank_imports(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  booked_import_id TEXT REFERENCES bank_imports(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  entry_sequence INTEGER NOT NULL CHECK (entry_sequence > 0),
  account_id TEXT NOT NULL,
  account_currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  credit_debit TEXT NOT NULL CHECK (credit_debit IN ('CRDT','DBIT')),
  status TEXT NOT NULL CHECK (status IN ('BOOK','PDNG')),
  reversal INTEGER NOT NULL DEFAULT 0 CHECK (reversal IN (0,1)),
  booking_date TEXT,
  value_date TEXT,
  account_servicer_ref TEXT,
  reference_level TEXT CHECK (reference_level IN ('D','C')),
  end_to_end_id TEXT,
  transaction_id TEXT,
  reference_type TEXT NOT NULL DEFAULT 'NON' CHECK (reference_type IN ('QRR','SCOR','NON','CONFLICT')),
  reference TEXT,
  unstructured TEXT,
  counterparty_name TEXT,
  strong_key TEXT UNIQUE,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  enriched_at TEXT,
  UNIQUE(import_id, entry_sequence)
);
CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id TEXT PRIMARY KEY,
  movement_id TEXT NOT NULL UNIQUE REFERENCES bank_movements(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bank_movement_keys (
  strong_key TEXT PRIMARY KEY,
  movement_id TEXT NOT NULL REFERENCES bank_movements(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  account_id TEXT NOT NULL,
  reference_level TEXT NOT NULL CHECK (reference_level IN ('D','C','T')),
  account_servicer_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bank_account_links (
  account_id TEXT PRIMARY KEY,
  currency TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  confirmed_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((active=1 AND revoked_at IS NULL) OR (active=0 AND revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_bank_imports_created ON bank_imports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_movements_review ON bank_movements(status, credit_debit, reversal, booking_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_movements_import ON bank_movements(import_id, entry_sequence);
CREATE INDEX IF NOT EXISTS idx_bank_movements_booked_import ON bank_movements(booked_import_id, entry_sequence) WHERE booked_import_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_movement_keys_movement ON bank_movement_keys(movement_id, reference_level);
CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_invoice ON bank_reconciliations(invoice_id, confirmed_at DESC);
CREATE TRIGGER IF NOT EXISTS bank_imports_no_update BEFORE UPDATE ON bank_imports BEGIN SELECT RAISE(ABORT,'bank imports are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_imports_no_delete BEFORE DELETE ON bank_imports BEGIN SELECT RAISE(ABORT,'bank imports are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_movements_guarded_update BEFORE UPDATE ON bank_movements WHEN NOT (
  ((OLD.status='PDNG' AND NEW.status='BOOK'
      AND OLD.booked_import_id IS NULL AND NEW.booked_import_id IS NOT NULL)
   OR (OLD.status='BOOK' AND NEW.status='BOOK'
      AND OLD.booked_import_id IS NOT NULL AND NEW.booked_import_id IS NOT NULL
      AND OLD.booked_import_id IS NOT NEW.booked_import_id
      AND EXISTS(SELECT 1 FROM bank_imports source WHERE source.id=OLD.booked_import_id AND source.message_type='camt.054')
      AND EXISTS(SELECT 1 FROM bank_imports source WHERE source.id=NEW.booked_import_id AND source.message_type='camt.053')))
  AND NOT EXISTS(SELECT 1 FROM bank_reconciliations frozen WHERE frozen.movement_id=OLD.id)
  AND OLD.id IS NEW.id AND OLD.import_id IS NEW.import_id
  AND OLD.entry_sequence IS NEW.entry_sequence AND OLD.account_id IS NEW.account_id
  AND OLD.account_currency IS NEW.account_currency AND OLD.amount_cents IS NEW.amount_cents
  AND OLD.currency IS NEW.currency AND OLD.credit_debit IS NEW.credit_debit
  AND OLD.reversal IS NEW.reversal
  AND (OLD.account_servicer_ref IS NEW.account_servicer_ref
    OR OLD.account_servicer_ref IS NULL OR TRIM(OLD.account_servicer_ref)=''
    OR (OLD.reference_level='C' AND NEW.reference_level='D'))
  AND (OLD.reference_level IS NEW.reference_level OR OLD.reference_level IS NULL
    OR (OLD.reference_level='C' AND NEW.reference_level='D'))
  AND (OLD.end_to_end_id IS NEW.end_to_end_id OR OLD.end_to_end_id IS NULL OR TRIM(OLD.end_to_end_id)='')
  AND (OLD.transaction_id IS NEW.transaction_id OR OLD.transaction_id IS NULL OR TRIM(OLD.transaction_id)='')
  AND (OLD.reference_type IS NEW.reference_type OR (OLD.reference_type='NON' AND (OLD.reference IS NULL OR TRIM(OLD.reference)='')))
  AND (OLD.reference IS NEW.reference OR OLD.reference IS NULL OR TRIM(OLD.reference)='')
  AND (OLD.unstructured IS NEW.unstructured OR OLD.unstructured IS NULL OR TRIM(OLD.unstructured)='')
  AND (OLD.counterparty_name IS NEW.counterparty_name OR OLD.counterparty_name IS NULL OR TRIM(OLD.counterparty_name)='')
  AND OLD.strong_key IS NEW.strong_key
  AND OLD.created_at IS NEW.created_at
  AND (OLD.booking_date IS NULL OR NEW.booking_date IS NOT NULL)
  AND (OLD.value_date IS NULL OR NEW.value_date IS NOT NULL)
  AND NEW.enriched_at IS NOT NULL
) BEGIN SELECT RAISE(ABORT,'bank movements may only receive a controlled CAMT lifecycle enrichment'); END;
CREATE TRIGGER IF NOT EXISTS bank_movements_no_delete BEFORE DELETE ON bank_movements BEGIN SELECT RAISE(ABORT,'bank movements are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_movement_keys_no_update BEFORE UPDATE ON bank_movement_keys BEGIN SELECT RAISE(ABORT,'bank movement keys are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_movement_keys_no_delete BEFORE DELETE ON bank_movement_keys BEGIN SELECT RAISE(ABORT,'bank movement keys are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_reconciliations_no_update BEFORE UPDATE ON bank_reconciliations BEGIN SELECT RAISE(ABORT,'bank reconciliations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_reconciliations_no_delete BEFORE DELETE ON bank_reconciliations BEGIN SELECT RAISE(ABORT,'bank reconciliations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_account_links_guarded_update BEFORE UPDATE ON bank_account_links WHEN NOT (
  OLD.account_id IS NEW.account_id AND OLD.created_at IS NEW.created_at
  AND ((OLD.active=1 AND NEW.active=0 AND NEW.currency IS OLD.currency AND NEW.confirmed_at IS OLD.confirmed_at AND NEW.revoked_at IS NOT NULL)
    OR (OLD.active=0 AND NEW.active=1 AND NEW.revoked_at IS NULL AND NEW.confirmed_at IS NOT NULL))
) BEGIN SELECT RAISE(ABORT,'bank account links require an explicit association or revocation'); END;
CREATE TRIGGER IF NOT EXISTS bank_account_links_no_delete BEFORE DELETE ON bank_account_links BEGIN SELECT RAISE(ABORT,'bank account links cannot be deleted'); END;
PRAGMA user_version=12;
"#;

/// Autorise uniquement la réparation atomique des anciens paiements de salaire
/// auxquels il manque la date et/ou le lien vers leur écriture. Les autres
/// champs d'une fiche comptabilisée ou payée restent immuables.
pub const MIGRATION_V13_SQL: &str = r#"
DROP TRIGGER IF EXISTS payslips_posted_no_update;
UPDATE payslips
SET payment_date=(
      SELECT je.entry_date FROM journal_entries je
      WHERE je.id=payslips.payment_journal_entry_id
        AND je.source_type='payslip' AND je.source_id=payslips.id AND je.source_event='payment'
    )
WHERE status='paye' AND payment_date IS NULL AND payment_journal_entry_id IS NOT NULL
  AND EXISTS(
    SELECT 1 FROM journal_entries je
    WHERE je.id=payslips.payment_journal_entry_id
      AND je.source_type='payslip' AND je.source_id=payslips.id AND je.source_event='payment'
  );
UPDATE payslips
SET payment_date=COALESCE(payment_date,(
      SELECT je.entry_date FROM journal_entries je
      WHERE je.source_type='payslip' AND je.source_id=payslips.id AND je.source_event='payment'
      ORDER BY je.created_at DESC LIMIT 1
    )),
    payment_journal_entry_id=(
      SELECT je.id FROM journal_entries je
      WHERE je.source_type='payslip' AND je.source_id=payslips.id AND je.source_event='payment'
        AND (payslips.payment_date IS NULL OR je.entry_date=payslips.payment_date)
      ORDER BY je.created_at DESC LIMIT 1
    )
WHERE status='paye' AND payment_journal_entry_id IS NULL
  AND EXISTS(
    SELECT 1 FROM journal_entries je
    WHERE je.source_type='payslip' AND je.source_id=payslips.id AND je.source_event='payment'
      AND (payslips.payment_date IS NULL OR je.entry_date=payslips.payment_date)
  );
CREATE TRIGGER payslips_posted_no_update
BEFORE UPDATE ON payslips
WHEN OLD.status IN ('comptabilise','paye')
AND NOT (
  ((OLD.status='comptabilise' AND NEW.status='paye'
    AND NEW.payment_date IS NOT NULL
    AND NEW.payment_journal_entry_id IS NOT NULL)
   OR
   (OLD.status='paye' AND NEW.status='paye'
    AND (OLD.payment_date IS NULL OR OLD.payment_journal_entry_id IS NULL)
    AND NEW.payment_date IS NOT NULL
    AND NEW.payment_journal_entry_id IS NOT NULL
    AND (OLD.payment_date IS NULL OR NEW.payment_date IS OLD.payment_date)
    AND (OLD.payment_journal_entry_id IS NULL OR NEW.payment_journal_entry_id IS OLD.payment_journal_entry_id)
    AND (OLD.payment_reference IS NEW.payment_reference OR OLD.payment_reference IS NULL)))
  AND NEW.id IS OLD.id
  AND NEW.employee_id IS OLD.employee_id
  AND NEW.period IS OLD.period
  AND NEW.gross_cents IS OLD.gross_cents
  AND NEW.deductions_cents IS OLD.deductions_cents
  AND NEW.net_cents IS OLD.net_cents
  AND NEW.employer_costs_cents IS OLD.employer_costs_cents
  AND NEW.notes IS OLD.notes
  AND NEW.snapshot_json IS OLD.snapshot_json
  AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT,'posted payslip is immutable'); END;
PRAGMA user_version=13;
"#;

/// Ajoute une vraie comptabilité fournisseurs sans réinterpréter les anciennes
/// dépenses au comptant. Les factures, leurs lignes et leurs règlements suivent
/// leur propre chaîne immuable.
pub const MIGRATION_V14_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS supplier_invoices (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  document_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  reference TEXT,
  reference_normalized TEXT,
  currency TEXT NOT NULL DEFAULT 'CHF' CHECK (currency = 'CHF'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validated')),
  net_cents INTEGER NOT NULL DEFAULT 0 CHECK (net_cents >= 0),
  vat_cents INTEGER NOT NULL DEFAULT 0 CHECK (vat_cents >= 0),
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  validated_at TEXT,
  validation_journal_entry_id TEXT REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  snapshot_json TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (total_cents = net_cents + vat_cents),
  CHECK (paid_cents <= total_cents),
  CHECK (due_date >= document_date),
  CHECK ((status='draft' AND validated_at IS NULL AND validation_journal_entry_id IS NULL AND snapshot_json IS NULL AND paid_cents=0)
    OR (status='validated' AND validated_at IS NOT NULL AND validation_journal_entry_id IS NOT NULL AND snapshot_json IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS supplier_invoice_items (
  id TEXT PRIMARY KEY,
  supplier_invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id) ON UPDATE CASCADE ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  description TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
  unit TEXT NOT NULL DEFAULT 'unité',
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  discount_bp INTEGER NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
  vat_bp INTEGER NOT NULL DEFAULT 0 CHECK (vat_bp BETWEEN 0 AND 10000),
  line_net_cents INTEGER NOT NULL CHECK (line_net_cents >= 0),
  line_vat_cents INTEGER NOT NULL CHECK (line_vat_cents >= 0),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0),
  category TEXT NOT NULL,
  expense_account_id TEXT REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (line_total_cents = line_net_cents + line_vat_cents)
);
CREATE TABLE IF NOT EXISTS supplier_payments (
  id TEXT PRIMARY KEY,
  supplier_invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT,
  reference TEXT,
  notes TEXT,
  journal_entry_id TEXT NOT NULL UNIQUE REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_status_due
ON supplier_invoices(status,due_date,document_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_invoices_reference_unique
ON supplier_invoices(supplier_id,reference_normalized)
WHERE status='validated' AND reference_normalized IS NOT NULL AND reference_normalized<>'';
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_items_parent
ON supplier_invoice_items(supplier_invoice_id,position);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_parent
ON supplier_payments(supplier_invoice_id,date,created_at);
CREATE TRIGGER IF NOT EXISTS supplier_invoice_items_draft_insert
BEFORE INSERT ON supplier_invoice_items
WHEN NOT EXISTS(SELECT 1 FROM supplier_invoices WHERE id=NEW.supplier_invoice_id AND status='draft')
BEGIN SELECT RAISE(ABORT, 'supplier invoice lines require a draft'); END;
CREATE TRIGGER IF NOT EXISTS supplier_invoice_items_draft_update
BEFORE UPDATE ON supplier_invoice_items
WHEN NOT EXISTS(SELECT 1 FROM supplier_invoices WHERE id=OLD.supplier_invoice_id AND status='draft')
  OR NOT EXISTS(SELECT 1 FROM supplier_invoices WHERE id=NEW.supplier_invoice_id AND status='draft')
BEGIN SELECT RAISE(ABORT, 'validated supplier invoice lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS supplier_invoice_items_draft_delete
BEFORE DELETE ON supplier_invoice_items
WHEN NOT EXISTS(SELECT 1 FROM supplier_invoices WHERE id=OLD.supplier_invoice_id AND status='draft')
BEGIN SELECT RAISE(ABORT, 'validated supplier invoice lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS supplier_invoices_validated_no_delete
BEFORE DELETE ON supplier_invoices WHEN OLD.status<>'draft'
BEGIN SELECT RAISE(ABORT, 'validated supplier invoices are immutable'); END;
CREATE TRIGGER IF NOT EXISTS supplier_invoices_validation_guard
BEFORE UPDATE ON supplier_invoices WHEN OLD.status='draft' AND NEW.status='validated' AND NOT (
  NEW.reference_normalized IS NOT NULL AND TRIM(NEW.reference_normalized)<>''
  AND NEW.total_cents>0 AND NEW.paid_cents=0 AND NEW.due_date>=NEW.document_date
  AND EXISTS(SELECT 1 FROM supplier_invoice_items item WHERE item.supplier_invoice_id=NEW.id)
  AND NEW.net_cents=(SELECT COALESCE(SUM(item.line_net_cents),0) FROM supplier_invoice_items item WHERE item.supplier_invoice_id=NEW.id)
  AND NEW.vat_cents=(SELECT COALESCE(SUM(item.line_vat_cents),0) FROM supplier_invoice_items item WHERE item.supplier_invoice_id=NEW.id)
  AND NEW.total_cents=(SELECT COALESCE(SUM(item.line_total_cents),0) FROM supplier_invoice_items item WHERE item.supplier_invoice_id=NEW.id)
  AND EXISTS(SELECT 1 FROM journal_entries entry
    WHERE entry.id=NEW.validation_journal_entry_id AND entry.source_type='supplier_invoice'
      AND entry.source_id=NEW.id AND entry.source_event='validate' AND entry.entry_date=NEW.document_date)
)
BEGIN SELECT RAISE(ABORT, 'supplier invoice validation requires its exact journal entry'); END;
CREATE TRIGGER IF NOT EXISTS supplier_invoices_validated_guard
BEFORE UPDATE ON supplier_invoices WHEN OLD.status<>'draft' AND NOT (
  NEW.id IS OLD.id AND NEW.supplier_id IS OLD.supplier_id AND NEW.project_id IS OLD.project_id
  AND NEW.document_date IS OLD.document_date AND NEW.due_date IS OLD.due_date
  AND NEW.supplier_name IS OLD.supplier_name AND NEW.reference IS OLD.reference
  AND NEW.reference_normalized IS OLD.reference_normalized AND NEW.currency IS OLD.currency
  AND NEW.status IS OLD.status AND NEW.net_cents IS OLD.net_cents AND NEW.vat_cents IS OLD.vat_cents
  AND NEW.total_cents IS OLD.total_cents AND NEW.validated_at IS OLD.validated_at
  AND NEW.validation_journal_entry_id IS OLD.validation_journal_entry_id
  AND NEW.snapshot_json IS OLD.snapshot_json AND NEW.note IS OLD.note AND NEW.created_at IS OLD.created_at
  AND NEW.paid_cents>=OLD.paid_cents AND NEW.paid_cents<=NEW.total_cents
  AND NEW.paid_cents=(SELECT COALESCE(SUM(amount_cents),0) FROM supplier_payments WHERE supplier_invoice_id=OLD.id)
)
BEGIN SELECT RAISE(ABORT, 'validated supplier invoice fields are immutable'); END;
CREATE TRIGGER IF NOT EXISTS supplier_payments_insert_guard
BEFORE INSERT ON supplier_payments WHEN NOT EXISTS(
  SELECT 1 FROM supplier_invoices invoice
  WHERE invoice.id=NEW.supplier_invoice_id AND invoice.status='validated'
    AND NEW.date>=invoice.document_date
    AND invoice.paid_cents + NEW.amount_cents <= invoice.total_cents
    AND EXISTS(SELECT 1 FROM journal_entries entry
      WHERE entry.id=NEW.journal_entry_id AND entry.source_type='supplier_payment'
        AND entry.source_id=NEW.id AND entry.source_event='invoice:' || NEW.supplier_invoice_id
        AND entry.entry_date=NEW.date)
)
BEGIN SELECT RAISE(ABORT, 'supplier payment exceeds the open validated balance'); END;
CREATE TRIGGER IF NOT EXISTS supplier_payments_update_invoice_total
AFTER INSERT ON supplier_payments
BEGIN
  UPDATE supplier_invoices
  SET paid_cents=(SELECT COALESCE(SUM(amount_cents),0) FROM supplier_payments WHERE supplier_invoice_id=NEW.supplier_invoice_id),
      updated_at=NEW.created_at
  WHERE id=NEW.supplier_invoice_id;
END;
CREATE TRIGGER IF NOT EXISTS supplier_payments_no_update
BEFORE UPDATE ON supplier_payments BEGIN SELECT RAISE(ABORT, 'supplier payments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS supplier_payments_no_delete
BEFORE DELETE ON supplier_payments BEGIN SELECT RAISE(ABORT, 'supplier payments are immutable'); END;
PRAGMA user_version=14;
"#;

/// Étend le rapprochement bancaire aux décaissements fournisseurs. La migration
/// ne rapproche rien automatiquement : elle ajoute uniquement le créancier
/// extrait du CAMT et un lien immuable créé après confirmation humaine.
pub const MIGRATION_V15_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS bank_supplier_reconciliations (
  id TEXT PRIMARY KEY,
  movement_id TEXT NOT NULL UNIQUE REFERENCES bank_movements(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  supplier_invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  supplier_payment_id TEXT NOT NULL UNIQUE REFERENCES supplier_payments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_supplier_reconciliations_invoice
ON bank_supplier_reconciliations(supplier_invoice_id,confirmed_at DESC);

DROP TRIGGER IF EXISTS bank_movements_guarded_update;
CREATE TRIGGER bank_movements_guarded_update
BEFORE UPDATE ON bank_movements WHEN NOT (
  ((OLD.status='PDNG' AND NEW.status='BOOK'
      AND OLD.booked_import_id IS NULL AND NEW.booked_import_id IS NOT NULL)
   OR (OLD.status='BOOK' AND NEW.status='BOOK'
      AND OLD.booked_import_id IS NOT NULL AND NEW.booked_import_id IS NOT NULL
      AND OLD.booked_import_id IS NOT NEW.booked_import_id
      AND EXISTS(SELECT 1 FROM bank_imports source WHERE source.id=OLD.booked_import_id AND source.message_type='camt.054')
      AND EXISTS(SELECT 1 FROM bank_imports source WHERE source.id=NEW.booked_import_id AND source.message_type='camt.053')))
  AND NOT EXISTS(SELECT 1 FROM bank_reconciliations frozen WHERE frozen.movement_id=OLD.id)
  AND NOT EXISTS(SELECT 1 FROM bank_supplier_reconciliations frozen WHERE frozen.movement_id=OLD.id)
  AND OLD.id IS NEW.id AND OLD.import_id IS NEW.import_id
  AND OLD.entry_sequence IS NEW.entry_sequence AND OLD.account_id IS NEW.account_id
  AND OLD.account_currency IS NEW.account_currency AND OLD.amount_cents IS NEW.amount_cents
  AND OLD.currency IS NEW.currency AND OLD.credit_debit IS NEW.credit_debit
  AND OLD.reversal IS NEW.reversal
  AND (OLD.account_servicer_ref IS NEW.account_servicer_ref
    OR OLD.account_servicer_ref IS NULL OR TRIM(OLD.account_servicer_ref)=''
    OR (OLD.reference_level='C' AND NEW.reference_level='D'))
  AND (OLD.reference_level IS NEW.reference_level OR OLD.reference_level IS NULL
    OR (OLD.reference_level='C' AND NEW.reference_level='D'))
  AND (OLD.end_to_end_id IS NEW.end_to_end_id OR OLD.end_to_end_id IS NULL OR TRIM(OLD.end_to_end_id)='')
  AND (OLD.transaction_id IS NEW.transaction_id OR OLD.transaction_id IS NULL OR TRIM(OLD.transaction_id)='')
  AND (OLD.reference_type IS NEW.reference_type OR (OLD.reference_type='NON' AND (OLD.reference IS NULL OR TRIM(OLD.reference)='')))
  AND (OLD.reference IS NEW.reference OR OLD.reference IS NULL OR TRIM(OLD.reference)='')
  AND (OLD.unstructured IS NEW.unstructured OR OLD.unstructured IS NULL OR TRIM(OLD.unstructured)='')
  AND (OLD.counterparty_name IS NEW.counterparty_name OR OLD.counterparty_name IS NULL OR TRIM(OLD.counterparty_name)='')
  AND (OLD.counterparty_iban IS NEW.counterparty_iban OR OLD.counterparty_iban IS NULL OR TRIM(OLD.counterparty_iban)='')
  AND OLD.strong_key IS NEW.strong_key
  AND OLD.created_at IS NEW.created_at
  AND (OLD.booking_date IS NULL OR NEW.booking_date IS NOT NULL)
  AND (OLD.value_date IS NULL OR NEW.value_date IS NOT NULL)
  AND NEW.enriched_at IS NOT NULL
) BEGIN SELECT RAISE(ABORT,'bank movements may only receive a controlled CAMT lifecycle enrichment'); END;

CREATE TRIGGER IF NOT EXISTS bank_reconciliations_exclusive_supplier
BEFORE INSERT ON bank_reconciliations
WHEN EXISTS(SELECT 1 FROM bank_supplier_reconciliations other WHERE other.movement_id=NEW.movement_id)
BEGIN SELECT RAISE(ABORT,'bank movement is already reconciled with a supplier invoice'); END;
CREATE TRIGGER IF NOT EXISTS bank_supplier_reconciliations_exclusive_customer
BEFORE INSERT ON bank_supplier_reconciliations
WHEN EXISTS(SELECT 1 FROM bank_reconciliations other WHERE other.movement_id=NEW.movement_id)
BEGIN SELECT RAISE(ABORT,'bank movement is already reconciled with a customer invoice'); END;
CREATE TRIGGER IF NOT EXISTS bank_supplier_reconciliations_no_update
BEFORE UPDATE ON bank_supplier_reconciliations BEGIN SELECT RAISE(ABORT,'supplier bank reconciliations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_supplier_reconciliations_no_delete
BEFORE DELETE ON bank_supplier_reconciliations BEGIN SELECT RAISE(ABORT,'supplier bank reconciliations are immutable'); END;
PRAGMA user_version=15;
"#;

/// Verrouille les justificatifs fournisseurs dans la base locale. Les fichiers
/// restent ajoutés uniquement par la commande métier qui vérifie leur contenu.
pub const MIGRATION_V16_SQL: &str = r#"
CREATE TRIGGER IF NOT EXISTS attachments_supplier_insert_guard
BEFORE INSERT ON attachments
WHEN NEW.entity_type='supplier_invoice' AND (
  NEW.entity_id IS NULL OR NOT EXISTS(SELECT 1 FROM supplier_invoices invoice WHERE invoice.id=NEW.entity_id AND invoice.status='draft') OR
  COALESCE(NEW.project_id,'')<>COALESCE((SELECT invoice.project_id FROM supplier_invoices invoice WHERE invoice.id=NEW.entity_id),'') OR
  NEW.mime_type NOT IN ('application/pdf','image/png','image/jpeg','image/webp') OR
  NEW.size_bytes<=0 OR NEW.size_bytes>26214400 OR
  NEW.sha256 IS NULL OR LENGTH(NEW.sha256)<>64 OR NEW.sha256 GLOB '*[^0-9a-f]*' OR
  (NEW.mime_type='application/pdf' AND NEW.stored_name NOT GLOB '*.pdf') OR
  (NEW.mime_type='image/png' AND NEW.stored_name NOT GLOB '*.png') OR
  (NEW.mime_type='image/jpeg' AND NEW.stored_name NOT GLOB '*.jpg') OR
  (NEW.mime_type='image/webp' AND NEW.stored_name NOT GLOB '*.webp') OR
  EXISTS(SELECT 1 FROM attachments duplicate WHERE duplicate.entity_type='supplier_invoice' AND duplicate.entity_id=NEW.entity_id AND duplicate.sha256=NEW.sha256) OR
  (SELECT COUNT(*) FROM attachments existing WHERE existing.entity_type='supplier_invoice' AND existing.entity_id=NEW.entity_id)>=20
) BEGIN SELECT RAISE(ABORT,'invalid supplier invoice attachment'); END;
CREATE TRIGGER IF NOT EXISTS attachments_no_update
BEFORE UPDATE ON attachments BEGIN SELECT RAISE(ABORT,'attachments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS attachments_supplier_validated_no_delete
BEFORE DELETE ON attachments
WHEN OLD.entity_type='supplier_invoice' AND EXISTS(SELECT 1 FROM supplier_invoices invoice WHERE invoice.id=OLD.entity_id AND invoice.status<>'draft')
BEGIN SELECT RAISE(ABORT,'validated supplier invoice attachments are immutable'); END;
PRAGMA user_version=16;
"#;

/// Ajoute la facturation atomique des temps, ainsi que les champs CRM/RH
/// nécessaires aux formulaires actuels. Les deux colonnes additives sont
/// créées conditionnellement par `migrate_v17` avant l'exécution de ce lot.
pub const MIGRATION_V17_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS time_billing_batches (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_sha256 TEXT NOT NULL CHECK (LENGTH(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_json TEXT NOT NULL,
  invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  client_id TEXT NOT NULL REFERENCES clients(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  vat_bp INTEGER NOT NULL CHECK (vat_bp BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS time_billing_entries (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES time_billing_batches(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  time_entry_id TEXT NOT NULL UNIQUE REFERENCES time_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  invoice_item_id TEXT NOT NULL UNIQUE REFERENCES invoice_items(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  entry_date_snapshot TEXT NOT NULL,
  minutes_snapshot INTEGER NOT NULL CHECK (minutes_snapshot > 0),
  billing_rate_cents_snapshot INTEGER NOT NULL CHECK (billing_rate_cents_snapshot > 0),
  amount_cents_snapshot INTEGER NOT NULL CHECK (amount_cents_snapshot >= 0),
  employee_name_snapshot TEXT NOT NULL,
  note_snapshot TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_time_billing_batches_project ON time_billing_batches(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_time_billing_batches_client ON time_billing_batches(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_time_billing_entries_batch ON time_billing_entries(batch_id, created_at);

CREATE TRIGGER IF NOT EXISTS time_billing_batches_insert_guard
BEFORE INSERT ON time_billing_batches
WHEN LENGTH(TRIM(NEW.request_id)) <> 36 OR
  LENGTH(NEW.request_sha256) <> 64 OR NEW.request_sha256 GLOB '*[^0-9a-f]*' OR
  NOT EXISTS(
    SELECT 1
    FROM invoices invoice
    JOIN projects project ON project.id=NEW.project_id AND project.client_id=NEW.client_id
    JOIN clients client ON client.id=NEW.client_id
    WHERE invoice.id=NEW.invoice_id
      AND invoice.project_id=NEW.project_id
      AND invoice.client_id=NEW.client_id
      AND invoice.type='standard'
      AND invoice.status='brouillon'
      AND invoice.number IS NULL
      AND invoice.currency='CHF'
  )
BEGIN SELECT RAISE(ABORT, 'invalid time billing batch'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_batches_no_update
BEFORE UPDATE ON time_billing_batches BEGIN SELECT RAISE(ABORT, 'time billing batches are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_batches_no_delete
BEFORE DELETE ON time_billing_batches
WHEN EXISTS(SELECT 1 FROM invoices invoice WHERE invoice.id=OLD.invoice_id)
BEGIN SELECT RAISE(ABORT, 'time billing batches are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_entries_insert_guard
BEFORE INSERT ON time_billing_entries
WHEN NOT EXISTS(
  SELECT 1
  FROM time_billing_batches batch
  JOIN invoices invoice ON invoice.id=batch.invoice_id
  JOIN time_entries source ON source.id=NEW.time_entry_id
  LEFT JOIN employees employee ON employee.id=source.employee_id
  JOIN invoice_items item ON item.id=NEW.invoice_item_id AND item.invoice_id=invoice.id
  WHERE batch.id=NEW.batch_id
    AND invoice.number IS NULL AND invoice.status='brouillon'
    AND source.project_id=batch.project_id
    AND source.billable=1 AND source.status='approuve'
    AND source.minutes>0 AND source.minutes<=5256000
    AND source.billing_rate_cents>0 AND source.billing_rate_cents<=100000000
    AND NEW.entry_date_snapshot=source.date
    AND NEW.minutes_snapshot=source.minutes
    AND NEW.billing_rate_cents_snapshot=source.billing_rate_cents
    AND NEW.amount_cents_snapshot=((source.minutes * source.billing_rate_cents + 30) / 60)
    AND NEW.employee_name_snapshot=COALESCE(NULLIF(TRIM(employee.name),''),'Non attribué')
    AND NEW.note_snapshot=COALESCE(source.note,'')
    AND item.unit='heure'
    AND item.unit_price_cents=NEW.billing_rate_cents_snapshot
    AND item.discount_bp=0
    AND item.vat_bp=batch.vat_bp
    AND ABS(item.quantity - (CAST(NEW.minutes_snapshot AS REAL) / 60.0)) <= 0.000000001
    AND CAST(ROUND(item.quantity * item.unit_price_cents) AS INTEGER)=NEW.amount_cents_snapshot
    AND item.line_net_cents=NEW.amount_cents_snapshot
    AND item.line_vat_cents=((NEW.amount_cents_snapshot * batch.vat_bp + 5000) / 10000)
    AND item.line_total_cents=item.line_net_cents + item.line_vat_cents
)
BEGIN SELECT RAISE(ABORT, 'invalid time billing entry'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_entries_no_update
BEFORE UPDATE ON time_billing_entries BEGIN SELECT RAISE(ABORT, 'time billing entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_entries_no_delete
BEFORE DELETE ON time_billing_entries
WHEN EXISTS(
  SELECT 1 FROM time_billing_batches batch
  JOIN invoices invoice ON invoice.id=batch.invoice_id
  WHERE batch.id=OLD.batch_id
)
BEGIN SELECT RAISE(ABORT, 'time billing entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_entries_billing_no_update
BEFORE UPDATE ON time_entries
WHEN EXISTS(SELECT 1 FROM time_billing_entries billed WHERE billed.time_entry_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'reserved or billed time entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_entries_billing_no_delete
BEFORE DELETE ON time_entries
WHEN EXISTS(SELECT 1 FROM time_billing_entries billed WHERE billed.time_entry_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'reserved or billed time entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_invoice_link_guard
BEFORE UPDATE ON invoices
WHEN EXISTS(SELECT 1 FROM time_billing_batches batch WHERE batch.invoice_id=OLD.id) AND (
  NEW.client_id IS NOT OLD.client_id OR NEW.project_id IS NOT OLD.project_id OR
  NEW.quote_id IS NOT OLD.quote_id OR NEW.original_invoice_id IS NOT OLD.original_invoice_id OR
  NEW.type IS NOT OLD.type OR NEW.currency IS NOT OLD.currency
)
BEGIN SELECT RAISE(ABORT, 'time billing invoice linkage is immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_invoice_items_no_insert
BEFORE INSERT ON invoice_items
WHEN EXISTS(SELECT 1 FROM time_billing_batches batch WHERE batch.invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT, 'time billing invoice lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_invoice_items_no_update
BEFORE UPDATE ON invoice_items
WHEN EXISTS(SELECT 1 FROM time_billing_batches batch WHERE batch.invoice_id=OLD.invoice_id)
BEGIN SELECT RAISE(ABORT, 'time billing invoice lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS time_billing_invoice_items_no_delete
BEFORE DELETE ON invoice_items
WHEN EXISTS(SELECT 1 FROM time_billing_batches batch WHERE batch.invoice_id=OLD.invoice_id)
  AND EXISTS(SELECT 1 FROM invoices invoice WHERE invoice.id=OLD.invoice_id)
BEGIN SELECT RAISE(ABORT, 'time billing invoice lines are immutable'); END;

PRAGMA user_version=17;
"#;

/// Ajoute le registre de stock immuable. Les soldes V17 des articles déjà
/// suivis sont repris par un mouvement d'ouverture déterministe avant
/// l'installation des triggers, ce qui rend cette reprise idempotente tout en
/// conservant exactement les quantités existantes.
pub const MIGRATION_V18_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS stock_movements (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (LENGTH(id) BETWEEN 1 AND 255),
  source_key TEXT NOT NULL UNIQUE CHECK (LENGTH(source_key) BETWEEN 1 AND 300),
  request_id TEXT UNIQUE,
  request_sha256 TEXT,
  request_json TEXT,
  catalog_item_id TEXT NOT NULL REFERENCES catalog_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('entry', 'exit', 'correction')),
  quantity_delta_milli INTEGER NOT NULL CHECK (
    quantity_delta_milli <> 0 AND
    quantity_delta_milli BETWEEN -9000000000000000 AND 9000000000000000
  ),
  balance_after_milli INTEGER NOT NULL CHECK (balance_after_milli BETWEEN 0 AND 9000000000000000),
  reason TEXT NOT NULL CHECK (LENGTH(TRIM(reason)) BETWEEN 1 AND 500),
  reference TEXT CHECK (reference IS NULL OR LENGTH(reference) <= 200),
  movement_date TEXT NOT NULL CHECK (
    LENGTH(movement_date) = 10 AND
    movement_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
  ),
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'invoice', 'opening')),
  invoice_id TEXT REFERENCES invoices(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  invoice_item_id TEXT UNIQUE REFERENCES invoice_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (LENGTH(created_at) BETWEEN 1 AND 64),
  CHECK (
    (movement_type = 'entry' AND quantity_delta_milli > 0) OR
    (movement_type = 'exit' AND quantity_delta_milli < 0) OR
    movement_type = 'correction'
  ),
  CHECK (
    (source_type = 'manual' AND request_id IS NOT NULL AND request_sha256 IS NOT NULL AND request_json IS NOT NULL AND invoice_id IS NULL AND invoice_item_id IS NULL) OR
    (source_type = 'invoice' AND request_id IS NULL AND request_sha256 IS NULL AND request_json IS NULL AND invoice_id IS NOT NULL AND invoice_item_id IS NOT NULL AND movement_type = 'exit') OR
    (source_type = 'opening' AND request_id IS NULL AND request_sha256 IS NULL AND request_json IS NULL AND invoice_id IS NULL AND invoice_item_id IS NULL AND movement_type = 'correction' AND quantity_delta_milli > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_catalog ON stock_movements(catalog_item_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements(movement_date DESC, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_invoice ON stock_movements(invoice_id, sequence) WHERE invoice_id IS NOT NULL;

INSERT INTO stock_movements(
  id,source_key,request_id,request_sha256,request_json,catalog_item_id,
  movement_type,quantity_delta_milli,balance_after_milli,reason,reference,
  movement_date,source_type,invoice_id,invoice_item_id,created_at
)
SELECT
  'opening:' || item.id,
  'opening:' || item.id,
  NULL,NULL,NULL,item.id,
  'correction',item.stock_quantity_milli,item.stock_quantity_milli,
  'Solde initial repris lors de la migration V18','migration-v18',
  SUBSTR(item.updated_at,1,10),'opening',NULL,NULL,item.updated_at
FROM catalog_items item
WHERE item.track_stock=1
  AND item.stock_quantity_milli>0
  AND NOT EXISTS(
    SELECT 1 FROM stock_movements movement
    WHERE movement.source_key='opening:' || item.id
  );

CREATE TRIGGER IF NOT EXISTS catalog_items_initial_stock_guard
BEFORE INSERT ON catalog_items
WHEN NEW.track_stock=1 AND NEW.stock_quantity_milli<>0
BEGIN SELECT RAISE(ABORT, 'tracked catalog items must start with zero stock'); END;
CREATE TRIGGER IF NOT EXISTS catalog_items_stock_kind_insert_guard
BEFORE INSERT ON catalog_items
WHEN NEW.track_stock=1 AND NEW.kind<>'product'
BEGIN SELECT RAISE(ABORT, 'only products can be tracked in stock'); END;
CREATE TRIGGER IF NOT EXISTS catalog_items_stock_kind_update_guard
BEFORE UPDATE OF kind,track_stock ON catalog_items
WHEN NEW.track_stock=1 AND NEW.kind<>'product'
BEGIN SELECT RAISE(ABORT, 'only products can be tracked in stock'); END;
CREATE TRIGGER IF NOT EXISTS catalog_items_stock_balance_guard
BEFORE UPDATE OF stock_quantity_milli ON catalog_items
WHEN NEW.track_stock=1 AND NEW.stock_quantity_milli<>COALESCE(
  (SELECT movement.balance_after_milli
   FROM stock_movements movement
   WHERE movement.catalog_item_id=NEW.id
   ORDER BY movement.sequence DESC LIMIT 1),
  0
)
BEGIN SELECT RAISE(ABORT, 'tracked stock can only change through stock movements'); END;
CREATE TRIGGER IF NOT EXISTS catalog_items_track_stock_history_guard
BEFORE UPDATE OF track_stock ON catalog_items
WHEN NEW.track_stock<>OLD.track_stock AND EXISTS(
  SELECT 1 FROM stock_movements movement WHERE movement.catalog_item_id=OLD.id
)
BEGIN SELECT RAISE(ABORT, 'stock tracking cannot change after the first movement'); END;
CREATE TRIGGER IF NOT EXISTS catalog_items_track_stock_enable_guard
BEFORE UPDATE OF track_stock ON catalog_items
WHEN OLD.track_stock=0 AND NEW.track_stock=1 AND NEW.stock_quantity_milli<>0
BEGIN SELECT RAISE(ABORT, 'stock tracking can only start from a zero balance'); END;
CREATE TRIGGER IF NOT EXISTS catalog_items_stock_history_no_delete
BEFORE DELETE ON catalog_items
WHEN EXISTS(SELECT 1 FROM stock_movements movement WHERE movement.catalog_item_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'catalog items with stock history are immutable'); END;

CREATE TRIGGER IF NOT EXISTS stock_movements_insert_guard
BEFORE INSERT ON stock_movements
WHEN
  NOT EXISTS(
    SELECT 1 FROM catalog_items item
    WHERE item.id=NEW.catalog_item_id AND item.track_stock=1 AND item.kind='product'
  ) OR
  (NEW.request_id IS NOT NULL AND LENGTH(TRIM(NEW.request_id))<>36) OR
  (NEW.request_sha256 IS NOT NULL AND (
    LENGTH(NEW.request_sha256)<>64 OR NEW.request_sha256 GLOB '*[^0-9a-f]*'
  )) OR
  (NEW.request_json IS NOT NULL AND (LENGTH(NEW.request_json)=0 OR LENGTH(NEW.request_json)>20000)) OR
  NOT (
    (
      NEW.source_type='opening' AND
      NEW.id='opening:' || NEW.catalog_item_id AND
      NEW.source_key=NEW.id AND
      NEW.quantity_delta_milli=NEW.balance_after_milli AND
      NEW.quantity_delta_milli=(SELECT item.stock_quantity_milli FROM catalog_items item WHERE item.id=NEW.catalog_item_id) AND
      NOT EXISTS(SELECT 1 FROM stock_movements prior WHERE prior.catalog_item_id=NEW.catalog_item_id)
    ) OR
    (
      NEW.source_type='manual' AND
      NEW.source_key='manual:' || NEW.request_id AND
      NEW.balance_after_milli=(SELECT item.stock_quantity_milli + NEW.quantity_delta_milli FROM catalog_items item WHERE item.id=NEW.catalog_item_id)
    ) OR
    (
      NEW.source_type='invoice' AND
      NEW.source_key='invoice:' || NEW.invoice_item_id AND
      NEW.balance_after_milli=(SELECT item.stock_quantity_milli + NEW.quantity_delta_milli FROM catalog_items item WHERE item.id=NEW.catalog_item_id) AND
      EXISTS(
        SELECT 1
        FROM invoices invoice
        JOIN invoice_items line ON line.invoice_id=invoice.id
        WHERE invoice.id=NEW.invoice_id
          AND line.id=NEW.invoice_item_id
          AND line.catalog_item_id=NEW.catalog_item_id
          AND invoice.number IS NOT NULL
          AND invoice.status IN ('emise','partiellement_payee','payee')
          AND invoice.type='standard'
          AND NEW.movement_date=invoice.issue_date
          AND NEW.reference=invoice.number
          AND line.quantity>0
          AND ABS(line.quantity * 1000.0 - CAST(-NEW.quantity_delta_milli AS REAL))<=0.000001
      )
    )
  )
BEGIN SELECT RAISE(ABORT, 'invalid stock movement'); END;
CREATE TRIGGER IF NOT EXISTS stock_movements_apply_balance
AFTER INSERT ON stock_movements
WHEN NEW.source_type<>'opening'
BEGIN
  UPDATE catalog_items
  SET stock_quantity_milli=NEW.balance_after_milli,
      updated_at=NEW.created_at
  WHERE id=NEW.catalog_item_id;
END;
CREATE TRIGGER IF NOT EXISTS stock_movements_no_update
BEFORE UPDATE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock movements are immutable'); END;
CREATE TRIGGER IF NOT EXISTS stock_movements_no_delete
BEFORE DELETE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock movements are immutable'); END;
CREATE TRIGGER IF NOT EXISTS stock_invoice_no_unsafe_cancel
BEFORE UPDATE OF status ON invoices
WHEN NEW.status='annulee' AND OLD.status<>'annulee' AND EXISTS(
  SELECT 1 FROM stock_movements movement WHERE movement.invoice_id=OLD.id
)
BEGIN SELECT RAISE(ABORT, 'stock-bearing invoices cannot be cancelled without a dedicated reversal workflow'); END;

PRAGMA user_version=18;
"#;

/// Ajoute la planification locale des projets sans créer de jalon, de tâche
/// ni d'affectation métier. Les ajouts de `time_entries.task_id` et
/// `active_timers.task_id` sont effectués par le migrateur Rust après la
/// création de ces tables afin de rester idempotents.
pub const MIGRATION_V19_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS project_milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (LENGTH(TRIM(title)) BETWEEN 1 AND 200),
  description TEXT CHECK (description IS NULL OR LENGTH(description) <= 20000),
  due_date TEXT CHECK (due_date IS NULL OR (LENGTH(due_date)=10 AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 1000000),
  employee_id TEXT REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status='done' AND completed_at IS NOT NULL) OR (status<>'done' AND completed_at IS NULL))
);

CREATE TABLE IF NOT EXISTS project_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  milestone_id TEXT REFERENCES project_milestones(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (LENGTH(TRIM(title)) BETWEEN 1 AND 200),
  description TEXT CHECK (description IS NULL OR LENGTH(description) <= 20000),
  due_date TEXT CHECK (due_date IS NULL OR (LENGTH(due_date)=10 AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 1000000),
  employee_id TEXT REFERENCES employees(id) ON UPDATE CASCADE ON DELETE SET NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status='done' AND completed_at IS NOT NULL) OR (status<>'done' AND completed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_project_milestones_project_order ON project_milestones(project_id,sort_order,created_at);
CREATE INDEX IF NOT EXISTS idx_project_milestones_due ON project_milestones(status,due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_tasks_project_order ON project_tasks(project_id,sort_order,created_at);
CREATE INDEX IF NOT EXISTS idx_project_tasks_milestone_order ON project_tasks(milestone_id,sort_order,created_at) WHERE milestone_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_tasks_assignee_status ON project_tasks(employee_id,status) WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_tasks_due ON project_tasks(status,due_date) WHERE due_date IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS project_milestones_project_immutable
BEFORE UPDATE OF project_id ON project_milestones WHEN NEW.project_id<>OLD.project_id
BEGIN SELECT RAISE(ABORT,'project milestone cannot change project'); END;
CREATE TRIGGER IF NOT EXISTS project_milestones_terminal_guard
BEFORE UPDATE OF status ON project_milestones
WHEN NEW.status IN ('done','cancelled') AND EXISTS(
  SELECT 1 FROM project_tasks task
  WHERE task.milestone_id=OLD.id AND task.status NOT IN ('done','cancelled')
)
BEGIN SELECT RAISE(ABORT,'milestone has active tasks'); END;
CREATE TRIGGER IF NOT EXISTS project_milestones_due_guard
BEFORE UPDATE OF due_date ON project_milestones
WHEN NEW.due_date IS NOT NULL AND EXISTS(
  SELECT 1 FROM project_tasks task
  WHERE task.milestone_id=OLD.id AND task.due_date IS NOT NULL AND task.due_date>NEW.due_date
)
BEGIN SELECT RAISE(ABORT,'milestone due date precedes a task due date'); END;
CREATE TRIGGER IF NOT EXISTS project_tasks_project_immutable
BEFORE UPDATE OF project_id ON project_tasks WHEN NEW.project_id<>OLD.project_id
BEGIN SELECT RAISE(ABORT,'project task cannot change project'); END;
CREATE TRIGGER IF NOT EXISTS project_tasks_milestone_insert_guard
BEFORE INSERT ON project_tasks
WHEN NEW.milestone_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM project_milestones milestone
  WHERE milestone.id=NEW.milestone_id AND milestone.project_id=NEW.project_id
    AND milestone.status IN ('todo','in_progress')
)
BEGIN SELECT RAISE(ABORT,'task milestone is invalid or closed'); END;
CREATE TRIGGER IF NOT EXISTS project_tasks_milestone_update_guard
BEFORE UPDATE OF milestone_id,project_id ON project_tasks
WHEN NEW.milestone_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM project_milestones milestone
  WHERE milestone.id=NEW.milestone_id AND milestone.project_id=NEW.project_id
    AND milestone.status IN ('todo','in_progress')
)
BEGIN SELECT RAISE(ABORT,'task milestone is invalid or closed'); END;
"#;

pub const MIGRATION_V19_FINALIZE_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS idx_time_entries_task_date ON time_entries(task_id,date) WHERE task_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS time_entries_task_insert_guard
BEFORE INSERT ON time_entries
WHEN NEW.task_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM project_tasks task WHERE task.id=NEW.task_id AND task.project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT,'time entry task belongs to another project'); END;
CREATE TRIGGER IF NOT EXISTS time_entries_task_update_guard
BEFORE UPDATE OF task_id,project_id ON time_entries
WHEN NEW.task_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM project_tasks task WHERE task.id=NEW.task_id AND task.project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT,'time entry task belongs to another project'); END;
CREATE TRIGGER IF NOT EXISTS active_timers_task_insert_guard
BEFORE INSERT ON active_timers
WHEN NEW.task_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM project_tasks task
  WHERE task.id=NEW.task_id AND task.project_id=NEW.project_id
    AND task.status IN ('todo','in_progress')
)
BEGIN SELECT RAISE(ABORT,'active timer task is invalid or closed'); END;
CREATE TRIGGER IF NOT EXISTS active_timers_task_update_guard
BEFORE UPDATE OF task_id,project_id ON active_timers
WHEN NEW.task_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM project_tasks task
  WHERE task.id=NEW.task_id AND task.project_id=NEW.project_id
    AND task.status IN ('todo','in_progress')
)
BEGIN SELECT RAISE(ABORT,'active timer task is invalid or closed'); END;
CREATE TRIGGER IF NOT EXISTS project_tasks_active_timer_close_guard
BEFORE UPDATE OF status ON project_tasks
WHEN NEW.status IN ('done','cancelled') AND OLD.status NOT IN ('done','cancelled')
  AND EXISTS(SELECT 1 FROM active_timers timer WHERE timer.task_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'task has an active timer'); END;

PRAGMA user_version=19;
"#;
