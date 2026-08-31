export type Identifier = string;

export type EntityKind =
  | 'clients'
  | 'catalogItems'
  | 'suppliers'
  | 'projects'
  | 'quotes'
  | 'invoices'
  | 'employees'
  | 'timeEntries'
  | 'expenses'
  | 'payslips';

export type Address = {
  street: string;
  buildingNumber?: string;
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
  vatNumber: string;
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
  code?: string;
  label: string;
  rateBp: number;
  effectiveFrom: string;
  annualCeilingCents?: number | null;
  sourceLabel?: string;
  sourceUrl?: string;
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

export type NogaSectionCode =
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K'
  | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V';

export type BusinessProfile = {
  nogaSection: NogaSectionCode | '';
  nogaDivision: string;
  activityDescription: string;
  nogaDetailedCode: string;
};

export type NogaDivision = { code: string; label: string };
export type NogaSection = { code: NogaSectionCode; label: string; divisions: NogaDivision[] };
export type NogaCatalog = { version: string; source: string; sections: NogaSection[] };

export type AppSettings = {
  organization: Organization;
  business: BusinessProfile;
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
  addressLine1?: string;
  addressLine2?: string;
  buildingNumber?: string;
  postalCode?: string;
  city?: string;
  canton?: string;
  country?: string;
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

export type CatalogItem = {
  id: Identifier;
  kind: 'product' | 'service';
  sku?: string | null;
  name: string;
  description: string;
  unit: string;
  salesPriceCents: number;
  purchaseCostCents: number;
  vatBp: number;
  trackStock: boolean;
  stockQuantityMilli: number;
  reorderLevelMilli: number;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DocumentLine = {
  id: Identifier;
  catalogItemId?: Identifier | null;
  description: string;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  discountBp?: number;
  vatRateBp: number;
};

export type FrozenIssuer = {
  companyName: string;
  legalForm: string;
  ownerName: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  buildingNumber: string;
  postalCode: string;
  city: string;
  canton: string;
  country: string;
  uidNumber: string;
  vatNumber: string;
  vatRegistered: boolean;
  iban: string;
  bankName: string;
  currency: string;
  logoPath: string;
};

export type FrozenCustomer = {
  id: Identifier;
  name: string;
  company: string;
  contactPerson: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  canton: string;
  country: string;
};

export type FrozenDocumentRecord = {
  id: Identifier;
  number: string;
  clientId: Identifier;
  projectId: Identifier | null;
  quoteId: Identifier | null;
  originalInvoiceId: Identifier | null;
  title: string;
  type: string;
  issueDate: string;
  validUntil: string;
  dueDate: string;
  serviceDateFrom: string;
  serviceDateTo: string;
  currency: string;
  notes: string;
  terms: string;
};

export type FrozenDocumentSnapshot = { capturedAt: string; issuer: FrozenIssuer; customer: FrozenCustomer; document: FrozenDocumentRecord; items: DocumentLine[]; qrBill?: StoredSwissQrBill | null };

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
  snapshot?: FrozenDocumentSnapshot | null;
};

export type InvoiceStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'cancelled';
export type InvoiceType = 'standard' | 'deposit' | 'progress' | 'final' | 'credit_note';

export type Invoice = {
  id: Identifier;
  number: string;
  clientId: Identifier;
  projectId: Identifier | null;
  quoteId: Identifier | null;
  originalInvoiceId: Identifier | null;
  title: string;
  type: InvoiceType;
  issueDate: string;
  dueDate: string;
  serviceDateFrom: string;
  serviceDateTo: string;
  status: InvoiceStatus;
  lines: DocumentLine[];
  notes: string;
  createdAt: string;
  snapshot?: FrozenDocumentSnapshot | null;
  qrBill?: StoredSwissQrBill | null;
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
  employeeNumber: string;
  name: string;
  role: string;
  email: string;
  phone: string;
  address: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  canton: string;
  country: string;
  birthDate: string;
  avsNumber: string;
  employmentStart: string;
  employmentEnd: string;
  /** Date confirmée par la caisse/fiduciaire; jamais déduite du sexe. */
  referenceAgeDate: string;
  /** true = renonciation confirmée, false = franchise conservée, null = à confirmer. */
  avsAllowanceWaived: boolean | null;
  employmentRate: number;
  /** Horaire contractuel explicite; utilisé pour la décision AANP de 8 h/semaine. */
  contractualWeeklyMinutes: number | null;
  /** Année pour laquelle la base AC antérieure à Elyko a été confirmée. */
  acOpeningYear: number | null;
  /** Base AC déjà acquise hors Elyko au début de l'année, y compris zéro confirmé. */
  acOpeningBasisCents: number | null;
  salaryMode: 'hourly' | 'monthly';
  grossSalaryCents: number;
  hourlyCostCents: number;
  iban: string;
  active: boolean;
  notes: string;
  archivedAt?: string | null;
};

export type TimeEntry = {
  id: Identifier;
  projectId: Identifier;
  employeeId: Identifier;
  date: string;
  minutes: number;
  breakMinutes?: number;
  billable?: boolean;
  billingRateCents?: number;
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
  billable?: boolean;
  billingRateCents?: number;
  hourlyCostCents?: number;
} | null;

export type Expense = {
  id: Identifier;
  projectId: Identifier | null;
  supplierId?: Identifier | null;
  date: string;
  dueDate?: string | null;
  supplier: string;
  category: string;
  reference: string;
  netCents: number;
  vatCents: number;
  totalCents: number;
  paymentStatus: 'pending' | 'paid';
  paidAt?: string | null;
  reimbursable?: boolean;
  note: string;
  receiptPath?: string;
  archivedAt?: string | null;
};

export type Supplier = {
  id: Identifier;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  uidNumber: string;
  iban: string;
  currency: string;
  paymentTermsDays: number;
  notes: string;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PayslipLine = {
  id: Identifier;
  label: string;
  kind: 'earning' | 'deduction' | 'reimbursement' | 'employer';
  amountCents: number;
  postingAccountId?: string;
  expenseAccountId?: string;
};

export type Payslip = {
  id: Identifier;
  employeeId: Identifier;
  period: string;
  status: 'incomplete' | 'draft' | 'validated' | 'posted' | 'paid';
  lines: PayslipLine[];
  paymentDate: string;
  paymentReference?: string;
  paymentJournalEntryId?: string;
  notes: string;
  createdAt: string;
  snapshot?: FrozenPayslipSnapshot | null;
};

export type FrozenEmployee = {
  id: Identifier;
  employeeNumber: string;
  name: string;
  role: string;
  address: string;
  avsNumber: string;
  iban: string;
  employmentRate: number;
};

export type FrozenPayslipSnapshot = {
  capturedAt: string;
  issuer: FrozenIssuer;
  employee: FrozenEmployee;
  period: string;
  paymentDate: string;
  notes: string;
  items: PayslipLine[];
  contributions: PayslipContributionSnapshot[];
};

export type PayrollImportEmployeeDraft = {
  employeeNumber: string;
  name: string;
  role: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  canton: string;
  birthDate: string;
  avsNumber: string;
  iban: string;
  employmentRate: number;
  salaryMode: 'monthly' | 'hourly';
};

export type PayrollImportLineDraft = {
  id: Identifier;
  label: string;
  kind: PayslipLine['kind'];
  amountCents: number;
  recurring: boolean;
  confidenceBp: number;
};

export type PayrollImportDraft = {
  employee: PayrollImportEmployeeDraft;
  period: string;
  paymentDate: string;
  grossCents: number;
  netCents: number;
  lines: PayrollImportLineDraft[];
  warnings: string[];
};

export type PayrollDocumentImport = {
  id: Identifier;
  sourceName: string;
  storedPath: string;
  fileSha256: string;
  mediaKind: 'pdf' | 'image';
  fileSize: number;
  extractionEngine: string;
  engineVersion: string;
  extractedText: string;
  draft: PayrollImportDraft;
  confidenceBp: number;
  status: 'needs_review' | 'confirmed' | 'rejected' | 'error';
  errorMessage: string;
  employeeId: Identifier;
  payslipId: Identifier;
  reviewedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type EmployeePayrollTemplate = {
  employeeId: Identifier;
  salaryMode: 'monthly' | 'hourly';
  baseSalaryCents: number;
  recurringEarnings: Array<{ label: string; kind: 'earning'; amountCents: number }>;
  suggestedContributionCodes: string[];
  sourceImportId: Identifier;
  reviewedAt: string;
};

export type BackupStatus = {
  lastSuccessAt: string | null;
  lastPath: string | null;
  nextScheduledAt: string | null;
};

export type LicenseState = {
  enforcementConfigured: boolean;
  status: 'not_configured' | 'missing' | 'invalid' | 'clock_error' | 'not_yet_valid' | 'expired' | 'valid';
  readOnly: boolean;
  plan: string;
  priceChfCents: number;
  licenseId: string;
  customerName: string;
  validFrom: string;
  validUntil: string;
  verifiedAt: string;
  lastSeenDate: string;
  reason: string;
  installationId: string;
  tokenVersion: number;
};

export type Workspace = {
  schemaVersion: number;
  onboardingCompleted: boolean;
  activityProfileRequired: boolean;
  settings: AppSettings | null;
  clients: Client[];
  catalogItems: CatalogItem[];
  suppliers: Supplier[];
  projects: Project[];
  quotes: Quote[];
  invoices: Invoice[];
  payments: Payment[];
  employees: Employee[];
  timeEntries: TimeEntry[];
  activeTimer: ActiveTimer;
  expenses: Expense[];
  payslips: Payslip[];
  payrollImports: PayrollDocumentImport[];
  employeePayrollTemplates: EmployeePayrollTemplate[];
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

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type NormalBalance = 'debit' | 'credit';
export type ReportSection = 'current_assets' | 'fixed_assets' | 'short_term_liabilities' | 'long_term_liabilities' | 'equity' | 'net_revenue' | 'cost_of_goods' | 'personnel_expense' | 'other_operating_expense' | 'depreciation' | 'financial_result' | 'non_operating_result' | 'exceptional_result' | 'taxes';

export type Account = {
  id: Identifier;
  code: string;
  name: string;
  accountType: AccountType;
  normalBalance: NormalBalance;
  reportSection: ReportSection;
  active: boolean;
};

export type AccountingSettings = {
  enabled: boolean;
  arAccountId: string;
  revenueAccountId: string;
  vatPayableAccountId: string;
  bankAccountId: string;
  expenseAccountId: string;
  vatReceivableAccountId: string;
  wagesExpenseAccountId: string;
  wagesPayableAccountId: string;
  socialExpenseAccountId: string;
  socialPayableAccountId: string;
};

export type AccountingFallback = {
  contribution: string;
  field: string;
  accountId: Identifier;
  reason: string;
};

export type PostPayslipResult = {
  workspace: Workspace;
  accountingFallbacks: AccountingFallback[];
};

export type PeriodFilter = { dateFrom?: string; dateTo?: string };
export type AccountingPeriod = { id: Identifier; name: string; dateFrom: string; dateTo: string; status: 'open' | 'closed'; closedAt: string; createdAt: string; updatedAt: string };

export type JournalEntry = {
  id: Identifier;
  number: string;
  entryDate: string;
  description: string;
  sourceType: string;
  sourceId: string;
  sourceEvent: string;
  status: 'posted';
  reversalOf: Identifier | null;
};

export type JournalLine = {
  id: Identifier;
  journalEntryId: Identifier;
  accountId: Identifier;
  accountCode: string;
  accountName: string;
  entryNumber: string;
  entryDate: string;
  debitCents: number;
  creditCents: number;
  currency: string;
  memo: string;
  projectId: Identifier | null;
  clientId: Identifier | null;
  employeeId: Identifier | null;
};

export type JournalReport = { entries: JournalEntry[]; lines: JournalLine[] };
export type LedgerReport = { account: Account; lines: JournalLine[]; debitCents: number; creditCents: number; netDebitCents: number };

export type TrialBalanceRow = Account & {
  debitCents: number;
  creditCents: number;
  debitBalanceCents: number;
  creditBalanceCents: number;
};
export type TrialBalanceReport = { rows: TrialBalanceRow[]; debitCents: number; creditCents: number; balanced: boolean };

export type StatementScope = { dateFrom: string; dateTo: string; previousDateFrom: string; previousDateTo: string; comparisonLabel: string; comparisonSource: 'registered_period' | 'same_dates_previous_year'; previousHasActivity: boolean };
export type ReportCurrency = { baseCurrency: string; currencies: string[]; singleCurrency: boolean; exchangeRatesApplied: boolean };
export type StatementRow = Pick<Account, 'id' | 'code' | 'name' | 'accountType' | 'reportSection'> & { normalBalance?: NormalBalance; debitCents: number; creditCents: number; amountCents: number; previousDebitCents: number; previousCreditCents: number; previousAmountCents: number };
export type BalanceSheetReport = { asOf: string; exerciseFrom: string; scope: StatementScope; currency: ReportCurrency; rows: StatementRow[]; sections: Partial<Record<ReportSection, number>>; previousSections: Partial<Record<ReportSection, number>>; assetsCents: number; liabilitiesCents: number; equityCents: number; currentResultCents: number; unallocatedPriorResultsCents: number; balanced: boolean; previousAssetsCents: number; previousLiabilitiesCents: number; previousEquityCents: number; previousCurrentResultCents: number; previousUnallocatedPriorResultsCents: number; previousBalanced: boolean };
export type IncomeStatementReport = { scope: StatementScope; currency: ReportCurrency; rows: StatementRow[]; sections: Partial<Record<ReportSection, number>>; previousSections: Partial<Record<ReportSection, number>>; revenueCents: number; expenseCents: number; profitCents: number; previousRevenueCents: number; previousExpenseCents: number; previousProfitCents: number };

export type ReminderSettings = { enabled: boolean; senderName: string };
export type ReminderTemplate = { id: Identifier; level: number; name: string; subject: string; body: string; daysAfterDue: number; active: boolean };
export type ReminderStatus = 'planned' | 'due' | 'completed' | 'cancelled';
export type Reminder = {
  id: Identifier;
  invoiceId: Identifier;
  templateId: Identifier | null;
  level: number;
  scheduledDate: string;
  status: ReminderStatus;
  subject: string;
  body: string;
  notes: string;
  invoiceNumber?: string;
  invoiceTitle?: string;
  dueDate?: string;
  clientName?: string;
  currency: string;
  invoiceTotalCents: number;
  balanceCents: number;
};
export type ReminderHistory = { id: Identifier; reminderId: Identifier; action: string; occurredAt: string; note: string };

export type ContributionCategory = 'avs_ai_apg' | 'ac' | 'lpp' | 'aanp' | 'aap' | 'ijm' | 'family_allowance' | 'source_tax' | 'other';
export type PayrollContributionDefinition = {
  id: Identifier;
  code: string;
  label: string;
  category: ContributionCategory;
  side: 'employee' | 'employer';
  calculationKind: 'rate' | 'fixed';
  rateBp: number | null;
  fixedAmountCents: number | null;
  annualCeilingCents: number | null;
  basisKind: 'gross' | 'ahv_salary' | 'coordinated' | 'custom';
  source: string;
  effectiveFrom: string;
  effectiveTo: string;
  active: boolean;
  liabilityAccountId: string;
  expenseAccountId: string;
};
export type PayrollContributionSelection = { definitionId: Identifier; basisCents?: number; yearToDateBasisCents?: number };
export type CalculatedPayrollContribution = PayrollContributionDefinition & {
  basisCents: number;
  originalBasisCents: number;
  yearToDateBasisCents: number | null;
  amountCents: number;
  statutoryAnnualCeilingCents: number | null;
  acProrationDays: number | null;
  acEmploymentFrom: string;
  acEmploymentTo: string;
  avsAllowanceAppliedCents: number | null;
  avsAllowanceWaived: boolean | null;
};
export type PayrollCalculation = { period: string; grossCents: number; employeeDeductionsCents: number; employerCostsCents: number; items: CalculatedPayrollContribution[] };
export type PayrollRegulatoryProfile = { id: string; label: string; source: string; effectiveFrom: string; effectiveTo: string; definitions: Array<Omit<PayrollContributionDefinition, 'id' | 'liabilityAccountId' | 'expenseAccountId'>>; notIncluded: ContributionCategory[] };
export type PayslipContributionSnapshot = {
  id: Identifier;
  payslipId: Identifier;
  definitionId: Identifier;
  payslipItemId: Identifier;
  label: string;
  category: ContributionCategory;
  side: 'employee' | 'employer';
  calculationKind: 'rate' | 'fixed';
  basisKind: PayrollContributionDefinition['basisKind'];
  basisCents: number;
  yearToDateBasisCents: number | null;
  rateBp: number | null;
  fixedAmountCents: number | null;
  annualCeilingCents: number | null;
  amountCents: number;
  source: string;
  effectiveFrom: string;
  effectiveTo: string;
  liabilityAccountId: string;
  expenseAccountId: string;
  createdAt: string;
};

export type SwissQrParty = { name: string; street: string; buildingNumber: string; postalCode: string; city: string; country: string };
export type SwissQrBillInput = {
  iban: string;
  creditor: SwissQrParty;
  amountCents?: number;
  currency: 'CHF' | 'EUR';
  debtor?: SwissQrParty;
  referenceType: 'QRR' | 'SCOR' | 'NON';
  reference: string;
  unstructuredMessage: string;
  billInformation: string;
  alternativeProcedures: string[];
};
export type SwissQrValidation = { valid: boolean; errors: string[]; warnings: string[]; normalized: SwissQrBillInput; isQrIban: boolean };
export type SwissQrPayload = { payload: string; lines: string[]; referenceType: SwissQrBillInput['referenceType']; isQrIban: boolean; characterCount: number; byteCount: number };
export type StoredSwissQrBill = SwissQrPayload & {
  invoiceId: Identifier;
  input: SwissQrBillInput;
  frozenAt: string;
  createdAt: string;
  updatedAt: string;
  frozen: boolean;
};

export type SecureUpdaterPolicy = {
  enabled: boolean;
  currentVersion: string;
  channel: 'stable';
  endpointHost: string | null;
  signatureRequired: true;
  transport: 'HTTPS';
  automaticInstall: false;
  reason: string;
};

export type SecureUpdateMetadata = {
  version: string;
  currentVersion: string;
  date: string | null;
  notes: string | null;
};

export type SecureUpdateEvent =
  | { event: 'preparing' }
  | { event: 'started'; data: { contentLength: number | null } }
  | { event: 'progress'; data: { downloadedBytes: number; contentLength: number | null; percent: number | null } }
  | { event: 'verifying' }
  | { event: 'installed' };
