export type Identifier = string;

export type EntityKind =
  | 'clients'
  | 'projects'
  | 'quotes'
  | 'invoices'
  | 'employees'
  | 'timeEntries'
  | 'expenses'
  | 'payslips';

export type Address = {
  street: string;
  postalCode: string;
  city: string;
  canton: string;
  country: string;
};

export type Organization = {
  legalName: string;
  legalForm: string;
  contactName: string;
  email: string;
  phone: string;
  website: string;
  uidNumber: string;
  vatRegistered: boolean;
  address: Address;
  logoPath?: string;
};

export type BillingSettings = {
  currency: 'CHF';
  iban: string;
  accountHolder: string;
  quotePrefix: string;
  invoicePrefix: string;
  creditNotePrefix: string;
  nextQuoteNumber: number;
  nextInvoiceNumber: number;
  nextCreditNoteNumber: number;
  paymentTermsDays: number;
  quoteValidityDays: number;
  vatRatesBp: number[];
  defaultFooter: string;
};

export type WorkSettings = {
  workWeekHours: number;
  dailyHours: number;
  roundingMinutes: number;
  breakMinutes: number;
  costCategories: string[];
};

export type PayrollSettings = {
  enabled: boolean;
  fiduciaryValidated: boolean;
  avsFund: string;
  accidentInsurer: string;
  pensionFund: string;
  dailyAllowanceInsurer: string;
  familyAllowanceFund: string;
  payrollCanton: string;
  employeeRates: PayrollRate[];
  employerRates: PayrollRate[];
};

export type PayrollRate = {
  id: Identifier;
  label: string;
  rateBp: number;
  effectiveFrom: string;
};

export type BackupSettings = {
  automatic: boolean;
  folder: string;
  frequency: 'daily' | 'weekly' | 'manual';
  retentionDaily: number;
  retentionWeekly: number;
  retentionMonthly: number;
  recoveryConfirmed: boolean;
};

export type AppSettings = {
  organization: Organization;
  billing: BillingSettings;
  work: WorkSettings;
  payroll: PayrollSettings;
  backup: BackupSettings;
};

export type Client = {
  id: Identifier;
  name: string;
  company: string;
  email: string;
  phone: string;
  address: string;
  uidNumber: string;
  notes: string;
  archivedAt?: string | null;
};

export type ProjectStatus = 'planned' | 'in_progress' | 'paused' | 'completed' | 'closed';

export type Project = {
  id: Identifier;
  clientId: Identifier;
  name: string;
  address: string;
  status: ProjectStatus;
  plannedStart: string;
  plannedEnd: string;
  actualStart: string;
  actualEnd: string;
  budgetCents: number;
  plannedMinutes: number;
  notes: string;
  archivedAt?: string | null;
};

export type DocumentLine = {
  id: Identifier;
  description: string;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  vatRateBp: number;
};

export type QuoteStatus = 'draft' | 'issued' | 'accepted' | 'refused' | 'expired';

export type Quote = {
  id: Identifier;
  number: string;
  clientId: Identifier;
  projectId: Identifier | null;
  title: string;
  issueDate: string;
  validUntil: string;
  status: QuoteStatus;
  lines: DocumentLine[];
  notes: string;
  createdAt: string;
};

export type InvoiceStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'cancelled';
export type InvoiceType = 'standard' | 'deposit' | 'progress' | 'final' | 'credit_note';

export type Invoice = {
  id: Identifier;
  number: string;
  clientId: Identifier;
  projectId: Identifier | null;
  quoteId: Identifier | null;
  title: string;
  type: InvoiceType;
  issueDate: string;
  dueDate: string;
  status: InvoiceStatus;
  lines: DocumentLine[];
  notes: string;
  createdAt: string;
};

export type Payment = {
  id: Identifier;
  invoiceId: Identifier;
  date: string;
  amountCents: number;
  method: string;
  reference: string;
};

export type Employee = {
  id: Identifier;
  name: string;
  role: string;
  email: string;
  phone: string;
  address: string;
  avsNumber: string;
  employmentStart: string;
  employmentEnd: string;
  employmentRate: number;
  salaryMode: 'hourly' | 'monthly';
  grossSalaryCents: number;
  hourlyCostCents: number;
  iban: string;
  active: boolean;
  archivedAt?: string | null;
};

export type TimeEntry = {
  id: Identifier;
  projectId: Identifier;
  employeeId: Identifier;
  date: string;
  minutes: number;
  hourlyCostCents: number;
  note: string;
  status: 'entered' | 'approved' | 'locked';
  createdAt: string;
};

export type ActiveTimer = {
  projectId: Identifier;
  employeeId: Identifier;
  startedAt: string;
  note: string;
} | null;

export type Expense = {
  id: Identifier;
  projectId: Identifier;
  date: string;
  supplier: string;
  category: string;
  netCents: number;
  vatCents: number;
  totalCents: number;
  note: string;
  receiptPath?: string;
  archivedAt?: string | null;
};

export type PayslipLine = {
  id: Identifier;
  label: string;
  kind: 'earning' | 'deduction' | 'employer';
  amountCents: number;
};

export type Payslip = {
  id: Identifier;
  employeeId: Identifier;
  period: string;
  status: 'incomplete' | 'draft' | 'validated';
  lines: PayslipLine[];
  notes: string;
  createdAt: string;
};

export type BackupStatus = {
  lastSuccessAt: string | null;
  lastPath: string | null;
  nextScheduledAt: string | null;
};

export type Workspace = {
  schemaVersion: number;
  onboardingCompleted: boolean;
  settings: AppSettings | null;
  clients: Client[];
  projects: Project[];
  quotes: Quote[];
  invoices: Invoice[];
  payments: Payment[];
  employees: Employee[];
  timeEntries: TimeEntry[];
  activeTimer: ActiveTimer;
  expenses: Expense[];
  payslips: Payslip[];
  backupStatus: BackupStatus;
};

export type OnboardingPayload = AppSettings;

export type MutationResponse = {
  workspace: Workspace;
  message?: string;
};

export type RestorePreview = {
  path: string;
  organizationName: string;
  createdAt: string;
  clientsCount: number;
  projectsCount: number;
  documentsCount: number;
};

